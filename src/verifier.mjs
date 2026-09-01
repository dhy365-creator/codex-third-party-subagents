import path from 'node:path';
import { catalogIsSafe } from './catalog.mjs';
import { PRODUCTION_CATALOG_CONTRACT, validateProductionCatalog } from './production-catalog-contract.mjs';
import { readExternalFlashEvidence } from './external-evidence-store.mjs';
import { discoverEnvironment } from './environment.mjs';
import { assertOwnerOnly, fs, lstatIfExists, sha256File } from './fs-utils.mjs';
import { credentialBackend, credentialReady as checkCredentialReady } from './credentials.mjs';
import { privatePathReady } from './platform-security.mjs';
import { extractAgentsBlock } from './templates.mjs';
import { inspectCustomAgentHost, validateCustomAgentToml } from './custom-agents.mjs';
import {
  evaluateHostCompatibility,
  HOST_COMPATIBILITY_LEVELS,
  publicHostCompatibility,
} from './host-compatibility.mjs';
import {
  DEFAULT_PROVIDER_ID as PACK_DEFAULT,
  RUNTIME_NAMESPACE,
  resolveProviderPack,
} from './provider-packs.mjs';
import { buildTransportVerification } from './transport-verification.mjs';

const NATIVE_RUNTIME_FILES = [
  'bridge.mjs',
  'bridge-cli.mjs',
  'catalog.mjs',
  'custom-agents.mjs',
  'environment.mjs',
  'fs-utils.mjs',
  'host-compatibility.mjs',
  'keychain.mjs',
  'credentials.mjs',
  'credentials/windows-credential-manager.mjs',
  'credentials/windows-credential-helper.ps1',
  'credential-runtime-blocker.mjs',
  'windows-credential-command.mjs',
  'windows-runtime-candidate.mjs',
  'platform-security.mjs',
  'preflight-runtime.mjs',
  'provider-packs.mjs',
  'routing.mjs',
];
const PHASE_2_RUNTIME_FILES = [
  'transport-contract.mjs',
  'transport-control-plane.mjs',
  'transport-selection.mjs',
];

function phase2RuntimeRequired(env, manifest) {
  const phase2Paths = new Set(PHASE_2_RUNTIME_FILES.map((name) => path.join(env.runtimeDir, name)));
  return (manifest.managedFiles ?? []).some((record) => phase2Paths.has(record.path));
}

function allowedPaths(env, profiles, manifest) {
  const runtimeFiles = phase2RuntimeRequired(env, manifest)
    ? [...NATIVE_RUNTIME_FILES, ...PHASE_2_RUNTIME_FILES]
    : NATIVE_RUNTIME_FILES;
  return new Set([
    ...runtimeFiles.map((name) => path.join(env.runtimeDir, name)),
    ...profiles.flatMap((profile) => [profile.agentPath, profile.catalogPath]),
    env.configPath,
    env.preflightPath,
    env.bridgeCliPath,
    env.agentsMarkerPath,
  ]);
}

function profileEnvironment(env, profile) {
  const found = env.profileEnvironments.find((candidate) => candidate.profile === profile.profile);
  if (!found) throw new Error(`provider profile environment is missing: ${profile.profile}`);
  return { ...profile, ...found };
}

function profilesFromManifest(manifest, providerId, env) {
  const records = Array.isArray(manifest.options?.profiles) && manifest.options.profiles.length
    ? manifest.options.profiles
    : [{
      id: manifest.options?.modelProfile,
      model: manifest.options?.model,
      providerRole: manifest.options?.providerRole,
    }];
  const profiles = records.map((record) => {
    const selection = record.id ?? record.profile ?? record.model;
    const pack = resolveProviderPack(providerId, selection);
    const role = record.providerRole ?? record.role;
    if (record.id && record.id !== pack.profile) throw new Error('manifest profile id is invalid');
    if (record.model && record.model !== pack.model) throw new Error('manifest profile model is invalid');
    if (role && role !== pack.role) throw new Error('manifest profile role is invalid');
    return profileEnvironment(env, pack);
  });
  if (!profiles.length || new Set(profiles.map((profile) => profile.role)).size !== profiles.length) {
    throw new Error('manifest profiles are invalid');
  }
  return profiles;
}

function configProfilesAreValid(config, profiles) {
  if (!Array.isArray(config.profiles) || config.profiles.length !== profiles.length) return false;
  return profiles.every((profile) => config.profiles.some((record) => (
    record.id === profile.profile
    && record.providerRole === profile.role
    && record.model === profile.model
    && record.agentPath === profile.agentPath
    && record.catalogPath === profile.catalogPath
  )));
}

function configCustomAgentsAreValid(config, profiles) {
  if (!Array.isArray(config.customAgents) || config.customAgents.length !== profiles.length) return false;
  return profiles.every((profile) => config.customAgents.some((agent) => (
    agent.name === profile.role
    && agent.model === profile.model
    && agent.modelProvider === profile.providerPack.modelProvider
  )));
}

function productionCatalogRequired(manifest, providerId, profile) {
  return manifest.options?.hostCompatibility?.version === PRODUCTION_CATALOG_CONTRACT.codexVersion
    && providerId === PRODUCTION_CATALOG_CONTRACT.providerId
    && profile.model === PRODUCTION_CATALOG_CONTRACT.model;
}

async function readManifest(env) {
  const info = await lstatIfExists(env.manifestPath);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('install manifest must be a regular owner-only file');
  }
  await assertOwnerOnly(env.manifestPath, 0o600, env.uid);
  const manifest = JSON.parse(await fs.readFile(env.manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.environment?.homeDir !== env.homeDir) {
    throw new Error('install manifest is incompatible with this home directory');
  }
  return manifest;
}

async function inspectHost(options) {
  if (options.customAgentHost) return options.customAgentHost;
  try {
    return await (options.inspectCustomAgentHostImpl ?? inspectCustomAgentHost)({
      codexPath: options.codexPath,
      commandRunner: options.commandRunner,
    });
  } catch {
    return { compatibility: evaluateHostCompatibility() };
  }
}

function hostState(host) {
  const compatibility = host.compatibility ?? evaluateHostCompatibility({
    version: host.version,
    multiAgent: host.multiAgent,
  });
  const blocked = compatibility.level === HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED;
  return {
    compatibility,
    issue: compatibility.configurationInstallAllowed
      ? null
      : `Host cross-provider subagent ${compatibility.status.toLowerCase()}: ${compatibility.reason}`,
    providerResolved: blocked ? false : null,
    taskDelivered: blocked ? false : null,
  };
}

function withTransportVerification(result, { env, host, options, providerPack }) {
  const pack = providerPack ?? env.providerPack;
  const input = {
    result,
    providerPack: pack,
    host,
    codexBinary: options.codexPath ?? null,
    externalConfigured: options.externalConfigured === true,
    externalEvidence: options.externalTransportEvidence ?? null,
    externalPrerequisitesReady: options.externalPrerequisitesReady === true,
    externalBusy: options.externalBusy === true,
  };
  try {
    return { ...result, ...buildTransportVerification(input) };
  } catch {
    const transport = buildTransportVerification({ ...input, externalEvidence: null });
    return {
      ...result,
      configured: false,
      installConfigurationReady: false,
      configurationReady: false,
      ready: false,
      issues: [...result.issues, 'External Transport evidence failed strict validation'],
      ...transport,
    };
  }
}

function incompleteResult({ env, warnings, issue, host, options }) {
  const state = hostState(host);
  const result = {
    configured: false,
    discoverable: false,
    providerResolved: state.providerResolved,
    taskDelivered: state.taskDelivered,
    runtimeExecuted: false,
    runtimeVerified: false,
    installConfigurationReady: false,
    configurationReady: false,
    ready: false,
    credentialReady: null,
    hostCompatibility: publicHostCompatibility(state.compatibility),
    issues: [issue, state.issue].filter(Boolean),
    warnings,
    environment: env,
  };
  return withTransportVerification(result, { env, host, options, providerPack: env.providerPack });
}

export async function verify(options = {}) {
  const checkedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  let env = discoverEnvironment({ provider: options.provider ?? PACK_DEFAULT, ...options, env: options.env ?? process.env });
  let storedExternalEvidence = options.externalTransportEvidence;
  if (storedExternalEvidence === undefined
    && env.providerPack?.id === 'deepseek' && env.providerPack?.model === 'deepseek-v4-flash') {
    try {
      storedExternalEvidence = await readExternalFlashEvidence(
        path.join(env.codexDir, 'external-transports', RUNTIME_NAMESPACE),
      );
    } catch {
      storedExternalEvidence = {};
    }
  }
  const transportOptions = {
    ...options,
    externalTransportEvidence: storedExternalEvidence,
    externalConfigured: options.externalConfigured ?? storedExternalEvidence != null,
    externalPrerequisitesReady: options.externalPrerequisitesReady
      ?? storedExternalEvidence?.runtimeVerified === true,
  };
  const issues = [];
  const warnings = [];
  const host = await inspectHost(transportOptions);
  const currentHost = hostState(host);
  let manifest;
  try {
    manifest = await readManifest(env);
  } catch (error) {
    return incompleteResult({ env, warnings, issue: error.message, host, options: transportOptions });
  }

  if (!manifest) {
    return incompleteResult({
      env,
      warnings,
      issue: 'install manifest is missing',
      host,
      options: transportOptions,
    });
  }

  if (!manifest.options?.hostCompatibility?.level) {
    issues.push('install manifest is missing the Host compatibility contract');
  }

  const providerId = manifest.options?.providerId ?? env.providerPack?.id ?? PACK_DEFAULT;
  if (options.provider && String(options.provider).trim().toLowerCase() !== providerId) {
    issues.push('selected provider does not match the installed provider');
  }
  let providerPack;
  try {
    providerPack = resolveProviderPack(providerId, options.model);
    env = discoverEnvironment({
      ...options,
      provider: providerId,
      model: providerPack.profile,
      env: options.env ?? process.env,
    });
  } catch {
    issues.push(`unknown provider pack in manifest: ${providerId}`);
  }

  let profiles = [];
  try {
    if (providerPack) profiles = profilesFromManifest(manifest, providerId, env);
  } catch (error) {
    issues.push(error.message);
  }
  if (providerPack && !profiles.some((profile) => profile.profile === providerPack.profile)) {
    issues.push('selected provider model profile is not installed');
  }

  const allowed = allowedPaths(env, profiles, manifest);
  const recorded = new Set();
  for (const record of manifest.managedFiles ?? []) {
    if (!allowed.has(record.path)) {
      issues.push(`manifest contains an unmanaged path: ${record.path}`);
      continue;
    }
    if (recorded.has(record.path)) {
      issues.push(`manifest contains a duplicate managed path: ${record.path}`);
      continue;
    }
    recorded.add(record.path);
    const info = await lstatIfExists(record.path);
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      issues.push(`managed file is missing or invalid: ${record.path}`);
      continue;
    }
    if (!await privatePathReady(record.path, {
      kind: 'file', mode: record.mode, uid: env.uid, platform: env.platform,
    })) {
      issues.push(`managed file security changed: ${record.path}`);
    }
    if (record.kind === 'agents-marker') {
      try {
        const source = await fs.readFile(record.path, 'utf8');
        if (extractAgentsBlock(source) !== manifest.agentsBlock) {
          issues.push('managed AGENTS.md block changed');
        }
      } catch (error) {
        issues.push(`could not validate AGENTS.md marker: ${error.message}`);
      }
    } else if (await sha256File(record.path) !== record.hash) {
      issues.push(`managed file content changed: ${record.path}`);
    }
  }
  for (const required of allowed) {
    if (!recorded.has(required)) issues.push(`manifest is missing a managed path: ${required}`);
  }

  const agentEvidence = [];
  for (const profile of profiles) {
    let agentConfigured = false;
    try {
      const agentText = await fs.readFile(profile.agentPath, 'utf8');
      const agent = validateCustomAgentToml(agentText, {
        name: profile.role,
        model: profile.model,
        modelProvider: profile.providerPack.modelProvider,
      });
      if (!agent.configured) {
        issues.push(`custom-agent definition is invalid for ${profile.role}`);
      } else {
        agentConfigured = true;
      }
    } catch {
      issues.push(`custom-agent definition is missing or invalid for ${profile.role}`);
    }
    try {
      const catalog = JSON.parse(await fs.readFile(profile.catalogPath, 'utf8'));
      if (!catalogIsSafe(catalog, profile.providerPack.catalog)) {
        issues.push(`runtime catalog is not safe for ${profile.model}`);
      } else if (productionCatalogRequired(manifest, providerId, profile)) {
        validateProductionCatalog(catalog, {
          codexVersion: PRODUCTION_CATALOG_CONTRACT.codexVersion,
          providerId,
          model: profile.model,
          requiredModalities: profile.providerPack.catalog.requiredModalities,
          outputModalities: profile.providerPack.catalog.outputModalities,
        });
      }
    } catch {
      issues.push(`runtime catalog is missing or invalid for ${profile.model}`);
    }
    agentEvidence.push({
      checkedAt,
      providerId,
      providerRole: profile.role,
      model: profile.model,
      configured: agentConfigured,
      hostRuntimeMetadata: null,
      runtimeVerified: false,
    });
  }

  try {
    const config = JSON.parse(await fs.readFile(env.configPath, 'utf8'));
    if (config.providerId !== providerId) issues.push('runtime config provider id is invalid');
    const legacyConfigMatches = profiles.length === 1
      && config.model === profiles[0]?.model
      && config.providerRole === profiles[0]?.role;
    if (!configProfilesAreValid(config, profiles) && !legacyConfigMatches) {
      issues.push('runtime config profiles are invalid');
    }
    if (!configCustomAgentsAreValid(config, profiles)) {
      issues.push('runtime config custom-agent identities are invalid');
    }
    if (!config.hostCompatibility?.level) {
      issues.push('runtime config Host compatibility contract is missing');
    }
    if (config.platform !== env.platform) issues.push('runtime config platform is invalid');
    if (config.credentialBackend !== credentialBackend(env.platform)) {
      issues.push('runtime config credential backend is invalid');
    }
    const expectedDefaultRole = providerId === 'deepseek'
      ? profiles.find((profile) => profile.profile === 'flash')?.role ?? null
      : profiles[0]?.role ?? null;
    if (config.defaultProviderRole !== undefined && config.defaultProviderRole !== expectedDefaultRole) {
      issues.push('runtime config default provider role is invalid');
    }
  } catch {
    issues.push('worker config is missing or invalid');
  }

  let credentialReady = null;
  if (options.checkKeychain !== false) {
    try {
      const check = options.credentialReadyImpl ?? options.keychainReadyImpl ?? checkCredentialReady;
      const keychainService = providerPack?.keychainService ?? (manifest.secretStorage?.service ?? null);
      if (!keychainService) {
        issues.push('cannot verify keychain service for this provider');
      } else {
        credentialReady = await check({
          account: env.keychainAccount,
          service: keychainService,
          platform: options.platform ?? process.platform,
          env: options.env ?? process.env,
          execFileImpl: options.execFileImpl,
        });
        if (!credentialReady) issues.push(`provider OS credential for ${providerId} is unavailable`);
      }
    } catch {
      issues.push('provider OS credential could not be checked');
    }
  } else {
    warnings.push('OS credential check was skipped');
  }
  warnings.push('No live Codex subagent task was run; runtime remains unverified');
  if (currentHost.issue) warnings.push(currentHost.issue);
  const selectedAgentEvidence = agentEvidence.find((evidence) => (
    evidence.providerRole === providerPack?.role && evidence.model === providerPack?.model
  )) ?? null;

  const configured = issues.length === 0;
  const discoverable = profiles.length > 0
    && agentEvidence.every((evidence) => evidence.configured)
    && host.multiAgent === true;
  const windowsConfiguration = env.platform === 'win32';
  const installConfigurationReady = configured && credentialReady === true;
  const configurationReady = configured
    && !windowsConfiguration
    && currentHost.compatibility.configurationInstallAllowed === true;
  const result = {
    configured,
    discoverable,
    providerResolved: currentHost.providerResolved,
    taskDelivered: currentHost.taskDelivered,
    runtimeExecuted: false,
    runtimeVerified: false,
    installConfigurationReady,
    configurationReady,
    ready: configurationReady && credentialReady === true,
    credentialReady,
    credentialBackend: credentialBackend(env.platform),
    providerRuntimeReady: false,
    providerRuntimeStatus: windowsConfiguration ? 'BLOCKED_PENDING_PHASE_2' : 'NOT_VERIFIED',
    hostCompatibility: publicHostCompatibility(currentHost.compatibility),
    issues: [...issues, currentHost.issue].filter(Boolean),
    warnings,
    environment: env,
    manifest,
    profile: providerPack ? {
      id: providerPack.profile,
      providerRole: providerPack.role,
      model: providerPack.model,
    } : null,
    profiles: profiles.map((profile) => ({
      id: profile.profile,
      providerRole: profile.role,
      model: profile.model,
    })),
    customAgents: profiles.map((profile) => ({
      name: profile.role,
      providerId,
      model: profile.model,
      modelProvider: profile.providerPack.modelProvider,
    })),
    agentEvidence,
    runtimeEvidence: selectedAgentEvidence ? {
      ...selectedAgentEvidence,
      evidenceSource: 'local Custom Agent configuration validation',
      discoverable,
      providerResolved: currentHost.providerResolved,
      taskDelivered: currentHost.taskDelivered,
      runtimeExecuted: false,
      runtimeVerified: false,
    } : null,
  };
  return withTransportVerification(result, {
    env,
    host,
    options: transportOptions,
    providerPack: providerPack ?? env.providerPack,
  });
}
