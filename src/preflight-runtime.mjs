import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { catalogIsSafe } from './catalog.mjs';
import {
  BridgeBusyError,
  bridgeBusy,
  createBridgeTask,
  hasArchivedBridgeTask,
} from './bridge.mjs';
import { credentialReady } from './credentials.mjs';
import {
  DEFAULT_PROVIDER_ID,
  PACKAGE_NAME,
  resolveProviderPack,
  resolveProviderPackByRole,
} from './provider-packs.mjs';
import { inspectCustomAgentHost, validateCustomAgentToml } from './custom-agents.mjs';
import { evaluateHostCompatibility, publicHostCompatibility } from './host-compatibility.mjs';
import { inspectProjectCustomAgentLayers } from './project-agent-safety.mjs';
import { chooseRoute, ROLES, validatePreflightInput } from './routing.mjs';
import { PERMISSION_PROFILES, TRANSPORTS } from './transport-contract.mjs';
import {
  evaluateTransportPreflight,
  nativeTransportEligibility,
  normalizeTransportPreference,
  productionExternalTransportEligibility,
  roleRequiresExplicitProvider,
} from './transport-control-plane.mjs';

const FALLBACK_AGENT = PACKAGE_NAME;

function codexBinary(env = process.env) {
  const candidates = [
    env.CODEX_CLI_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? 'codex';
}

export function readRateLimitsFromAppServer({ env = process.env, timeoutMs = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBinary(env), ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('rate-limit query timed out')), timeoutMs);
    child.on('error', (error) => finish(error));
    child.on('close', () => {
      if (!settled) finish(new Error('app-server exited before rate limits arrived'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== 2) continue;
          if (message.error) finish(new Error('rate-limit query failed'));
          else finish(null, message.result);
          return;
        } catch {
          // Ignore malformed lines.
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: FALLBACK_AGENT, version: '0.4.0-beta.3' } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 2 })}\n`);
  });
}

function remainingPercent(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const used = [bucket.primary, bucket.secondary]
    .map((window) => window?.usedPercent)
    .filter((value) => Number.isFinite(value));
  if (!used.length) return null;
  return Math.max(0, Math.min(100, 100 - Math.max(...used)));
}

export function quotaSnapshot(result) {
  const byId = result?.rateLimitsByLimitId ?? {};
  const buckets = Object.values(byId);
  const generalBucket = byId.codex ?? result?.rateLimits ?? null;
  const sparkBucket = buckets.find((bucket) => {
    const identity = `${bucket?.limitId ?? ''} ${bucket?.limitName ?? ''}`;
    return /spark|bengalfox/i.test(identity);
  });
  return {
    sparkRemaining: remainingPercent(sparkBucket),
    generalRemaining: remainingPercent(generalBucket),
  };
}

function configuredProfiles(config) {
  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID;
  const records = Array.isArray(config.profiles) && config.profiles.length
    ? config.profiles
    : [{
      id: config.modelProfile,
      providerRole: config.providerRole,
      model: config.model,
      agentPath: config.agentPath,
      catalogPath: config.catalogPath,
    }];
  const profiles = records.map((record) => {
    const role = record.providerRole ?? record.role;
    const providerPack = role
      ? resolveProviderPackByRole(providerId, role)
      : resolveProviderPack(providerId, record.id ?? record.model);
    if (record.id && record.id !== providerPack.profile) throw new Error('runtime profile id is invalid');
    if (record.model && record.model !== providerPack.model) throw new Error('runtime profile model is invalid');
    if (role && role !== providerPack.role) throw new Error('runtime profile role is invalid');
    if (!record.agentPath || !record.catalogPath) throw new Error('runtime profile paths are missing');
    return {
      providerPack,
      providerRole: providerPack.role,
      agentPath: record.agentPath,
      catalogPath: record.catalogPath,
    };
  });
  if (new Set(profiles.map((profile) => profile.providerRole)).size !== profiles.length) {
    throw new Error('runtime profiles contain a duplicate worker role');
  }
  return profiles;
}

function defaultProviderRole(config, profiles) {
  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID;
  const flash = profiles.find((profile) => profile.providerPack.profile === 'flash');
  const expected = providerId === 'deepseek' ? flash?.providerRole ?? null : profiles[0]?.providerRole ?? null;
  if (config.defaultProviderRole !== undefined && config.defaultProviderRole !== expected) {
    throw new Error('runtime default provider role is invalid');
  }
  return expected;
}

async function installedProviderReady(config, profile, deps = {}) {
  const providerPack = profile.providerPack;
  const filesExist = deps.existsSync ?? existsSync;
  if (![profile.agentPath, profile.catalogPath, config.configPath].every((file) => filesExist(file))) {
    return false;
  }
  try {
    const [catalogText, agentText] = await Promise.all([
      fs.readFile(profile.catalogPath, 'utf8'),
      fs.readFile(profile.agentPath, 'utf8'),
    ]);
    const catalog = JSON.parse(catalogText);
    if (!catalogIsSafe(catalog, providerPack.catalog)) return false;
    if (!validateCustomAgentToml(agentText, {
      name: providerPack.role,
      model: providerPack.model,
      modelProvider: providerPack.modelProvider,
    }).configured) return false;
  } catch {
    return false;
  }
  const check = deps.credentialReadyImpl ?? deps.keychainReadyImpl ?? credentialReady;
  return check({
    account: config.keychainAccount,
    service: providerPack.keychainService,
    platform: config.platform ?? process.platform,
    env: deps.env ?? process.env,
    execFileImpl: deps.execFileImpl,
  });
}

async function routingState(config, profiles, deps = {}) {
  let quota = { sparkRemaining: null, generalRemaining: null };
  try {
    const read = deps.readRateLimits ?? readRateLimitsFromAppServer;
    quota = quotaSnapshot(await read({ env: deps.env ?? process.env }));
  } catch {
    // Unknown quota must keep an OpenAI role.
  }
  const providerReadyByRole = Object.fromEntries(await Promise.all(profiles.map(async (profile) => {
    try {
      return [profile.providerRole, await installedProviderReady(config, profile, deps)];
    } catch {
      return [profile.providerRole, false];
    }
  })));
  let busy = true;
  try {
    busy = await (deps.bridgeBusyImpl ?? bridgeBusy)({ root: config.bridgePath });
  } catch {
    // Invalid bridge state fails closed.
  }
  return { ...quota, providerReadyByRole, bridgeBusy: busy };
}

function outputFor(
  input,
  route,
  state,
  profile,
  bridgePrepared = false,
  compatibility = null,
  transportDecision = null,
) {
  const hostCompatibility = compatibility ? publicHostCompatibility(compatibility) : null;
  if (route.decision === 'deny') {
    return {
      version: 1,
      decision: 'deny',
      action: 'deny',
      hostCompatibility,
      transportDecision,
      reason: route.reason,
    };
  }
  return {
    version: 1,
    decision: 'allow',
    action: route.action,
    agentType: route.chosenAgent,
    target: route.action === 'followup' ? input.target : null,
    taskName: route.action === 'spawn' ? input.taskName : null,
    forkTurns: route.action === 'spawn' && route.chosenAgent !== ROLES.SPARK ? 'none' : null,
    bridgePrepared,
    hostCompatibility,
    transportDecision,
    quota: {
      sparkRemaining: state.sparkRemaining,
      generalRemaining: state.generalRemaining,
    },
    worker: profile ? {
      providerId: profile.providerPack.id,
      providerRole: profile.providerRole,
      model: profile.providerPack.model,
      customAgentName: profile.providerRole,
    } : null,
    reason: route.reason,
  };
}

export async function runPreflight(input, config, deps = {}) {
  validatePreflightInput(input);
  const profiles = configuredProfiles(config);
  const defaultRole = defaultProviderRole(config, profiles);
  if (![ROLES.SPARK, ROLES.LUNA, ...profiles.map((profile) => profile.providerRole)].includes(input.requestedAgent)) {
    throw new Error('unknown requested agent');
  }
  const windowsRuntimeBlocked = config.platform === 'win32';
  let host;
  try {
    const inspect = deps.inspectCustomAgentHostImpl ?? inspectCustomAgentHost;
    host = await inspect({
      codexPath: deps.codexPath ?? codexBinary(deps.env ?? process.env),
      commandRunner: deps.commandRunner,
    });
  } catch {
    host = { compatibility: evaluateHostCompatibility() };
  }
  const compatibility = host.compatibility ?? evaluateHostCompatibility({
    version: host.version,
    multiAgent: host.multiAgent,
  });
  const requestedTransport = normalizeTransportPreference(input.transportPreference);
  const permissionProfile = input.permissionProfile ?? PERMISSION_PROFILES.READ_ONLY;
  if (!Object.values(PERMISSION_PROFILES).includes(permissionProfile)) {
    throw new Error('permissionProfile is unsupported');
  }
  if (input.billableAuthorized !== undefined && typeof input.billableAuthorized !== 'boolean') {
    throw new Error('billableAuthorized must be boolean');
  }
  const requestedProfile = profiles.find((profile) => profile.providerRole === input.requestedAgent) ?? null;
  const defaultProfile = profiles.find((profile) => profile.providerRole === defaultRole) ?? null;
  const transportProfile = requestedProfile ?? defaultProfile;
  const transportInput = transportProfile ? {
    requestedTransport,
    providerPolicy: 'allow',
    providerExplicitlyRequested: requestedProfile !== null,
    roleExplicitOnly: roleRequiresExplicitProvider(transportProfile.providerRole),
    providerId: transportProfile.providerPack.id,
    providerRole: transportProfile.providerRole,
    model: transportProfile.providerPack.model,
    permissionProfile,
    providerSuitable: input.providerSuitable ?? input.deepseekSuitable,
    billableAuthorized: input.billableAuthorized === true,
    native: nativeTransportEligibility(compatibility),
    external: productionExternalTransportEligibility({ busy: false }),
  } : null;
  const transportDecision = transportInput ? evaluateTransportPreflight(transportInput) : null;
  const transportBlocked = transportDecision && transportDecision.decision !== 'ALLOW';
  if (compatibility.automaticRoutingAllowed !== true || transportBlocked || windowsRuntimeBlocked) {
    const blockedState = {
      sparkRemaining: null,
      generalRemaining: null,
      providerReadyByRole: Object.fromEntries(profiles.map((profile) => [profile.providerRole, false])),
      bridgeBusy: true,
    };
    const hostReason = windowsRuntimeBlocked
      ? 'Windows provider runtime is disabled pending Phase 2 validation'
      : `host cross-provider subagent ${compatibility.status.toLowerCase()}: ${compatibility.reason}`;
    const transportReason = requestedTransport === TRANSPORTS.EXTERNAL_CODEX || transportBlocked
      ? transportDecision?.reason ?? hostReason
      : hostReason;
    if (profiles.some((profile) => profile.providerRole === input.requestedAgent)) {
      return outputFor(input, {
        decision: 'deny',
        action: 'deny',
        chosenAgent: null,
        reason: (compatibility.automaticRoutingAllowed !== true || windowsRuntimeBlocked)
          && requestedTransport !== TRANSPORTS.EXTERNAL_CODEX
          ? hostReason
          : transportReason,
      }, blockedState, null, false, compatibility, transportDecision);
    }
    const blockedInput = {
      operation: input.operation,
      requestedAgent: input.requestedAgent,
      existingAgentType: input.existingAgentType,
      providerSuitable: input.providerSuitable ?? input.deepseekSuitable,
      providerRole: defaultRole,
      providerRoles: profiles.map((profile) => profile.providerRole),
      defaultProviderRole: defaultRole,
      threshold: config.threshold,
      sparkAvailable: config.sparkAvailable,
      sparkRemaining: null,
      generalRemaining: null,
      lunaAvailable: config.lunaAvailable,
      providerReady: false,
      bridgeBusy: true,
    };
    const blockedRoute = chooseRoute(blockedInput);
    const route = {
      ...blockedRoute,
      reason: (compatibility.automaticRoutingAllowed !== true || windowsRuntimeBlocked) && requestedTransport !== TRANSPORTS.EXTERNAL_CODEX
        ? hostReason
        : transportReason,
    };
    const selectedProfile = profiles.find((profile) => profile.providerRole === route.chosenAgent) ?? null;
    return outputFor(input, route, blockedState, selectedProfile, false, compatibility, transportDecision);
  }
  if (transportDecision && transportDecision.selectedTransport !== TRANSPORTS.NATIVE) {
    return outputFor(input, {
      decision: 'deny',
      action: 'deny',
      chosenAgent: null,
      reason: 'Phase 2 cannot execute a non-Native Transport',
    }, {
      sparkRemaining: null,
      generalRemaining: null,
      providerReadyByRole: {},
      bridgeBusy: true,
    }, null, false, compatibility, transportDecision);
  }
  const state = await routingState(config, profiles, deps);
  const providerReady = state.providerReadyByRole[(requestedProfile ?? defaultProfile)?.providerRole] ?? false;
  const finalTransportDecision = transportInput
    ? evaluateTransportPreflight({ ...transportInput, providerReady })
    : null;
  if (requestedProfile && finalTransportDecision?.decision !== 'ALLOW') {
    return outputFor(input, {
      decision: 'deny',
      action: 'deny',
      chosenAgent: null,
      reason: finalTransportDecision?.reason ?? 'provider Transport readiness is incomplete',
    }, state, null, false, compatibility, finalTransportDecision);
  }
  const routeInput = {
    operation: input.operation,
    requestedAgent: input.requestedAgent,
    existingAgentType: input.existingAgentType,
    providerSuitable: input.providerSuitable ?? input.deepseekSuitable,
    providerRole: defaultRole,
    providerRoles: profiles.map((profile) => profile.providerRole),
    defaultProviderRole: defaultRole,
    threshold: config.threshold,
    sparkAvailable: config.sparkAvailable,
    sparkRemaining: state.sparkRemaining,
    generalRemaining: state.generalRemaining,
    lunaAvailable: config.lunaAvailable,
    providerReady,
    bridgeBusy: state.bridgeBusy,
  };
  let route = chooseRoute(routeInput);
  let selectedProfile = profiles.find((profile) => profile.providerRole === route.chosenAgent) ?? null;
  if (!selectedProfile) {
    return outputFor(input, route, state, null, false, compatibility, finalTransportDecision);
  }

  let projectAgentsSafe = false;
  try {
    const inspect = deps.inspectProjectAgentLayersImpl ?? inspectProjectCustomAgentLayers;
    projectAgentsSafe = (await inspect({ cwd: input.cwd })).safe === true;
  } catch {
    // An ambiguous Host identity must keep an OpenAI role.
  }
  if (!projectAgentsSafe) {
    route = chooseRoute({ ...routeInput, providerReady: false });
    route = {
      ...route,
      reason: 'project custom-agent layer present or unreadable; safe OpenAI fallback',
    };
    selectedProfile = profiles.find((profile) => profile.providerRole === route.chosenAgent) ?? null;
    return outputFor(input, route, state, selectedProfile, false, compatibility, finalTransportDecision);
  }

  let taskName = input.taskName;
  if (route.action === 'followup') {
    const archived = await (deps.hasArchivedImpl ?? hasArchivedBridgeTask)(
      input.target,
      { root: config.bridgePath },
    );
    if (archived) {
      taskName = input.target;
    } else {
      route = { ...route, action: 'spawn', reason: `${route.reason}; existing target is not bridge-compatible` };
    }
  }

  try {
    await (deps.createBridgeImpl ?? createBridgeTask)({
      root: config.bridgePath,
      taskName,
      cwd: input.cwd,
      message: input.message,
      providerId: selectedProfile.providerPack.id,
      providerRole: selectedProfile.providerRole,
      model: selectedProfile.providerPack.model,
    });
    return outputFor(input, route, state, selectedProfile, true, compatibility, finalTransportDecision);
  } catch (error) {
    const busy = error instanceof BridgeBusyError || error?.code === 'BRIDGE_BUSY';
    route = chooseRoute({
      ...routeInput,
      providerReady: false,
      bridgeBusy: true,
    });
    route = {
      ...route,
      reason: busy
        ? 'provider bridge is busy; safe OpenAI fallback'
        : 'provider bridge preparation failed; safe OpenAI fallback',
    };
    selectedProfile = profiles.find((profile) => profile.providerRole === route.chosenAgent) ?? null;
    return outputFor(input, route, state, selectedProfile, false, compatibility, finalTransportDecision);
  }
}

async function readStdin() {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

export async function preflightMain(configPath = process.argv[2]) {
  try {
    if (!configPath) throw new Error('worker config path is required');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(await runPreflight(input, config))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      version: 1,
      decision: 'deny',
      action: 'deny',
      reason: error?.message ?? 'preflight failed',
    })}\n`);
  }
}
