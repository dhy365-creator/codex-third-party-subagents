import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverEnvironment, DEFAULT_PROVIDER_ID } from './environment.mjs';
import { keychainReady } from './keychain.mjs';
import { resolveProviderPack } from './provider-packs.mjs';
import {
  inspectCustomAgentDefinitions,
  inspectCustomAgentHost,
} from './custom-agents.mjs';
import { verify } from './verifier.mjs';

const STATUS = Object.freeze({ PASS: 'PASS', WARN: 'WARN', BLOCKED: 'BLOCKED' });
const VALUE_FLAGS = new Set(['provider', 'model']);
const CODEX_APP_CANDIDATES = Object.freeze([
  '/Applications/Codex.app',
  '/Applications/ChatGPT.app',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
]);

function add(checks, name, status, detail) {
  checks.push({ name, status, detail });
}

function mode(info) {
  return info?.mode & 0o777;
}

function maximumStatus(checks) {
  if (checks.some((check) => check.status === STATUS.BLOCKED)) return STATUS.BLOCKED;
  if (checks.some((check) => check.status === STATUS.WARN)) return STATUS.WARN;
  return STATUS.PASS;
}

async function lstat(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validRegularFile(info) {
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function nodeMajor(version) {
  const match = String(version).match(/^v?(\d+)\./);
  return match ? Number(match[1]) : NaN;
}

async function detectCodexEnvironment(codexDirInfo, options) {
  if (typeof options.codexDetected === 'boolean') return options.codexDetected;
  if (codexDirInfo?.isDirectory() && !codexDirInfo.isSymbolicLink()) return true;
  for (const candidate of options.codexCandidates ?? CODEX_APP_CANDIDATES) {
    if (await lstat(candidate)) return true;
  }
  return false;
}

async function readInstallState(homeDir, env) {
  const info = await lstat(env.manifestPath);
  if (!info) return { installed: false, info: null, manifest: null, error: null };
  if (!validRegularFile(info)) {
    return { installed: false, info, manifest: null, error: 'install manifest is not a regular file' };
  }
  try {
    const manifest = JSON.parse(await fs.readFile(env.manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.environment?.homeDir !== homeDir) {
      throw new Error('install manifest is incompatible with this environment');
    }
    return { installed: true, info, manifest, error: null };
  } catch {
    return {
      installed: false,
      info,
      manifest: null,
      error: 'install manifest could not be parsed or validated',
    };
  }
}

function profileIsInstalled(manifest, providerPack) {
  const profiles = manifest?.options?.profiles;
  if (Array.isArray(profiles) && profiles.length) {
    return profiles.some((profile) => (
      (profile.id === providerPack.profile || profile.profile === providerPack.profile)
      && profile.model === providerPack.model
      && (profile.providerRole ?? profile.role) === providerPack.role
    ));
  }
  return manifest?.options?.model === providerPack.model;
}

export function parseDoctorArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'help') {
      parsed.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

export async function runDoctor(options = {}) {
  const checks = [];
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const platform = options.platform ?? process.platform;
  const baseEnv = discoverEnvironment({
    homeDir,
    platform,
    env: options.env ?? process.env,
    uid: options.uid,
    username: options.username,
  });
  const installState = await readInstallState(homeDir, baseEnv);
  const installedProvider = installState.manifest?.options?.providerId;
  const providerId = String(options.provider ?? installedProvider ?? DEFAULT_PROVIDER_ID).trim().toLowerCase();

  const major = nodeMajor(options.nodeVersion ?? process.version);
  add(
    checks,
    'Node.js',
    Number.isInteger(major) && major >= 20 ? STATUS.PASS : STATUS.BLOCKED,
    Number.isInteger(major) && major >= 20 ? `version ${major} satisfies >=20` : 'Node.js >=20 is required',
  );
  add(checks, 'Operating system', platform === 'darwin' ? STATUS.PASS : STATUS.BLOCKED,
    platform === 'darwin' ? 'macOS detected' : 'macOS is required');

  const codexDirInfo = await lstat(baseEnv.codexDir);
  if (!codexDirInfo) {
    add(checks, 'Codex directory', STATUS.WARN, 'Codex data directory is not present');
  } else if (!codexDirInfo.isDirectory() || codexDirInfo.isSymbolicLink()) {
    add(checks, 'Codex directory', STATUS.BLOCKED, 'Codex data directory is invalid');
  } else {
    add(checks, 'Codex directory', mode(codexDirInfo) & 0o077 ? STATUS.WARN : STATUS.PASS,
      mode(codexDirInfo) & 0o077 ? 'directory is accessible beyond its owner' : 'owner-only directory detected');
  }
  const codexDetected = await detectCodexEnvironment(codexDirInfo, options);
  add(checks, 'Codex environment', codexDetected ? STATUS.PASS : STATUS.BLOCKED,
    codexDetected ? 'Codex installation or data directory detected' : 'Codex Desktop or CLI was not detected');

  const codexConfigInfo = await lstat(path.join(baseEnv.codexDir, 'config.toml'));
  if (!codexConfigInfo) {
    add(checks, 'Codex config', STATUS.WARN, 'config.toml is not present');
  } else if (!validRegularFile(codexConfigInfo)) {
    add(checks, 'Codex config', STATUS.BLOCKED, 'config.toml is not a regular file');
  } else {
    add(checks, 'Codex config', mode(codexConfigInfo) & 0o077 ? STATUS.WARN : STATUS.PASS,
      mode(codexConfigInfo) & 0o077 ? 'config.toml is accessible beyond its owner' : 'config.toml is owner-only');
  }

  let providerPack = null;
  let providerAvailable = false;
  try {
    const basePack = resolveProviderPack(providerId);
    add(checks, 'Provider pack', STATUS.PASS, `${basePack.displayName} is reviewed and built in`);
    providerAvailable = true;
  } catch {
    add(checks, 'Provider pack', STATUS.BLOCKED, 'provider is not a reviewed built-in pack');
  }
  if (providerAvailable) {
    try {
      providerPack = resolveProviderPack(providerId, options.model);
    } catch {
      // The provider remains valid while the requested model fails closed below.
    }
  }
  const modelMatches = providerPack !== null;
  add(checks, 'Model', modelMatches ? STATUS.PASS : STATUS.BLOCKED,
    modelMatches
      ? `${providerPack.model} (${providerPack.profile}) matches the selected provider pack`
      : 'model does not match the selected provider pack');
  add(checks, 'Expected worker', providerPack ? STATUS.PASS : STATUS.BLOCKED,
    providerPack ? `${providerPack.role} is the expected worker for ${providerPack.model}` : 'expected worker is unavailable');

  let customAgentHost = null;
  try {
    customAgentHost = await (options.inspectCustomAgentHostImpl ?? inspectCustomAgentHost)({
      codexPath: options.codexPath,
      commandRunner: options.commandRunner,
    });
    add(
      checks,
      'Multi-agent availability',
      customAgentHost.multiAgent === true
        ? STATUS.PASS
        : customAgentHost.multiAgent === false ? STATUS.BLOCKED : STATUS.WARN,
      customAgentHost.multiAgent === true
        ? `Codex ${customAgentHost.version ?? 'CLI'} reports multi_agent enabled`
        : customAgentHost.multiAgent === false
          ? `Codex ${customAgentHost.version ?? 'CLI'} reports multi_agent disabled`
          : 'Codex multi_agent availability could not be established',
    );
    const compatibility = customAgentHost.compatibility;
    add(
      checks,
      'Host cross-provider subagent',
      compatibility?.configurationInstallAllowed === true
        ? STATUS.PASS
        : compatibility ? STATUS.BLOCKED : STATUS.WARN,
      compatibility?.reason ?? 'cross-provider Host compatibility could not be established',
    );
    add(
      checks,
      'Multi-agent configuration',
      customAgentHost.multiAgent !== true
        ? STATUS.WARN
        : customAgentHost.multiAgentV2 === true ? STATUS.WARN : STATUS.PASS,
      customAgentHost.multiAgent !== true
        ? 'cannot establish the active multi-agent configuration'
        : customAgentHost.multiAgentV2 === true
          ? 'multi_agent_v2 is also enabled; validate Host precedence before live dispatch'
          : 'multi_agent is active; multi_agent_v2 is not required and was not changed',
    );
  } catch {
    add(checks, 'Multi-agent availability', STATUS.WARN, 'multi-agent capability could not be inspected');
    add(checks, 'Host cross-provider subagent', STATUS.BLOCKED,
      'cross-provider Host compatibility is unknown; active installation is blocked');
    add(checks, 'Multi-agent configuration', STATUS.WARN, 'cannot establish the active multi-agent configuration');
  }

  if (providerPack) {
    try {
      const definitions = await (options.inspectCustomAgentDefinitionsImpl ?? inspectCustomAgentDefinitions)({
        homeDir,
        projectRoot: options.projectRoot,
        expected: [{
          name: providerPack.role,
          model: providerPack.model,
          modelProvider: providerPack.modelProvider,
          fileName: providerPack.agentFile,
        }],
      });
      const expected = definitions.expectedDefinitions[0];
      const invalid = definitions.issues.length > 0
        || expected?.duplicate
        || expected?.projectPresent
        || (expected?.present === true && expected?.configured !== true)
        || (expected?.present === true && expected?.modelMatches !== true)
        || (expected?.present === true && expected?.providerMatches !== true)
        || (expected?.present === true && expected?.fileNameMatches === false)
        || definitions.projectDuplicateNames.includes(providerPack.role);
      add(
        checks,
        'Custom Agent definition',
        invalid
          ? STATUS.BLOCKED
          : expected?.present ? STATUS.PASS : STATUS.WARN,
        invalid
          ? 'expected custom-agent identity is invalid, duplicated, or mismatched'
          : expected?.present
            ? `${providerPack.role} definition matches the selected provider/model; begin a new Codex session before live verification`
            : `${providerPack.role} definition is not installed`,
      );
      const managedAgent = (installState.manifest?.managedFiles ?? []).some((record) => (
        record.kind === 'agent' && record.path === path.join(baseEnv.agentsDir, providerPack.agentFile)
      ));
      const manifestHasCustomAgentIdentity = (installState.manifest?.options?.customAgents ?? [])
        .some((agent) => (
          agent.name === providerPack.role
          && agent.model === providerPack.model
          && agent.modelProvider === providerPack.modelProvider
        ));
      add(
        checks,
        'Custom Agent migration',
        invalid
          ? STATUS.BLOCKED
          : expected?.present && !managedAgent ? STATUS.WARN
            : installState.installed && !manifestHasCustomAgentIdentity ? STATUS.WARN
              : expected?.present ? STATUS.PASS : STATUS.WARN,
        invalid
          ? 'resolve the conflicting Custom Agent definition before installation'
          : expected?.present && !managedAgent
            ? 'matching legacy Custom Agent detected; review dry-run then use --migrate-legacy with --apply'
            : installState.installed && !manifestHasCustomAgentIdentity
              ? 'installed manifest predates Custom Agent identity metadata; rerun the installer'
              : expected?.present
                ? 'installer-managed Custom Agent identity is ready for a new Codex session'
                : 'install the selected Custom Agent before migration can be checked',
      );
    } catch {
      add(checks, 'Custom Agent definition', STATUS.WARN, 'custom-agent identity could not be inspected');
      add(checks, 'Custom Agent migration', STATUS.WARN, 'Custom Agent migration state could not be inspected');
    }
  } else {
    add(checks, 'Custom Agent definition', STATUS.WARN, 'expected custom-agent identity is unavailable');
    add(checks, 'Custom Agent migration', STATUS.WARN, 'Custom Agent migration state is unavailable');
  }

  if (!installState.info) {
    add(checks, 'Installation state', STATUS.WARN, 'provider worker is not installed');
  } else if (installState.error) {
    add(checks, 'Installation state', STATUS.BLOCKED, installState.error);
  } else if (mode(installState.info) !== 0o600) {
    add(checks, 'Installation state', STATUS.BLOCKED, 'install manifest must use mode 0600');
  } else if (options.provider && installedProvider !== providerId) {
    add(checks, 'Installation state', STATUS.BLOCKED, 'installed provider differs from the selected provider');
  } else if (providerPack && !profileIsInstalled(installState.manifest, providerPack)) {
    add(checks, 'Installation state', STATUS.BLOCKED, 'selected model profile is not installed');
  } else {
    add(checks, 'Installation state', STATUS.PASS, 'provider worker manifest is installed');
  }

  const lunaInfo = await lstat(path.join(baseEnv.codexDir, 'agents', 'luna_worker.toml'));
  add(checks, 'OpenAI fallback', validRegularFile(lunaInfo) ? STATUS.PASS : STATUS.WARN,
    validRegularFile(lunaInfo)
      ? 'luna_worker definition detected'
      : 'luna_worker was not detected; confirm Spark or Luna availability before install');

  if (providerPack && platform === 'darwin') {
    try {
      const present = await (options.keychainReadyImpl ?? keychainReady)({
        account: baseEnv.keychainAccount,
        service: providerPack.keychainService,
        platform,
        env: options.env ?? process.env,
        execFileImpl: options.execFileImpl,
      });
      add(checks, 'Keychain credential', present ? STATUS.PASS : STATUS.BLOCKED,
        `provider credential is ${present ? 'present' : 'missing'}`);
    } catch {
      add(checks, 'Keychain credential', STATUS.BLOCKED, 'provider credential is missing');
    }
  } else {
    add(checks, 'Keychain credential', STATUS.WARN, 'credential check is unavailable');
  }

  if (installState.installed && providerPack && installedProvider === providerId) {
    try {
      const result = await (options.verifyImpl ?? verify)({
        provider: providerId,
        model: options.model,
        checkKeychain: false,
        env: options.env ?? process.env,
        platform,
        homeDir,
        customAgentHost,
      });
      const ready = result.configurationReady ?? (
        result.configured === true
        && customAgentHost?.compatibility?.configurationInstallAllowed === true
      );
      add(checks, 'Verify prerequisites', ready ? STATUS.PASS : STATUS.BLOCKED,
        ready
          ? 'local configuration and Host compatibility checks are clean'
          : `${result.issues.length} local configuration issue(s) or Host compatibility blocker(s) found`);
    } catch {
      add(checks, 'Verify prerequisites', STATUS.BLOCKED, 'local configuration checks could not complete');
    }
  } else {
    add(checks, 'Verify prerequisites', STATUS.WARN, 'install the selected worker before running full verify');
  }

  const summary = Object.fromEntries(Object.values(STATUS).map((status) => [
    status,
    checks.filter((check) => check.status === status).length,
  ]));
  return {
    status: maximumStatus(checks),
    summary,
    provider: providerPack?.id ?? 'unsupported',
    model: providerPack?.model ?? null,
    worker: providerPack?.role ?? null,
    profile: providerPack?.profile ?? null,
    installed: installState.installed,
    customAgentHost,
    checks,
  };
}

export function formatDoctorSummary(report) {
  const outcome = report.summary.BLOCKED
    ? `${report.summary.BLOCKED} blocker(s) must be resolved before installation`
    : 'Ready for dry-run';
  return [
    ...report.checks.map((check) => `${check.status}  ${check.name}: ${check.detail}`),
    '',
    `Summary: ${outcome}`,
    `Checks: PASS=${report.summary.PASS}, WARN=${report.summary.WARN}, BLOCKED=${report.summary.BLOCKED}`,
  ].join('\n');
}

export function doctorHelp() {
  return 'Usage: npm run doctor -- [--provider <deepseek|minimax|qwen>] [--model <model>]\n';
}

export async function doctorCli(argv = process.argv.slice(2)) {
  try {
    const parsed = parseDoctorArgs(argv);
    if (parsed.help) return process.stdout.write(doctorHelp());
    const report = await runDoctor(parsed);
    process.stdout.write(`${formatDoctorSummary(report)}\n`);
    if (report.summary.BLOCKED) process.exitCode = 1;
  } catch {
    process.stderr.write('Doctor failed: invalid options or unreadable local state\n');
    process.exitCode = 1;
  }
}

export const { PASS, WARN, BLOCKED } = STATUS;
