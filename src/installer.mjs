import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertSupportedPlatform,
  discoverEnvironment,
  parseBoolean,
  parseThreshold,
  DEFAULT_PROVIDER_ID,
} from './environment.mjs';
import {
  DEFAULT_MAX_CATALOG_BYTES,
  acquireCatalog,
  catalogJson,
  extractCatalogDocument,
  reduceCatalogForProvider,
} from './catalog.mjs';
import { PRODUCTION_CATALOG_CONTRACT, validateProductionCatalog } from './production-catalog-contract.mjs';
import { credentialBackend, credentialReady } from './credentials.mjs';
import {
  inspectCustomAgentDefinitions,
  inspectCustomAgentHost,
} from './custom-agents.mjs';
import { publicHostCompatibility } from './host-compatibility.mjs';
import {
  listProviderPackProfiles,
  resolveProviderPack,
  listProviderPackIds,
} from './provider-packs.mjs';
import {
  copyOwnerOnly,
  assertOwnerOnly,
  ensureDir,
  fs,
  lstatIfExists,
  pathExists,
  sha256,
  writeFileIfChanged,
} from './fs-utils.mjs';
import {
  assertNoReparsePath,
  captureWindowsSecurityDescriptor,
  privatePathReady,
} from './platform-security.mjs';
import {
  agentToml,
  agentsBlock,
  bridgeWrapper,
  preflightWrapper,
  replaceAgentsBlock,
  workerConfig,
} from './templates.mjs';
import {
  installerTransportPlan,
  normalizeTransportPreference,
} from './transport-control-plane.mjs';

const INSTALL_VERSION = '0.4.0-beta.3';
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILES = [
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
  'platform-security.mjs',
  'preflight-runtime.mjs',
  'provider-packs.mjs',
  'routing.mjs',
  'transport-contract.mjs',
  'transport-control-plane.mjs',
  'transport-selection.mjs',
];

function stamp() {
  return new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14);
}

function normalizeOptions(options) {
  const providerId = String(options.provider ?? DEFAULT_PROVIDER_ID).toLowerCase();
  const plan = String(options.plan ?? '').toLowerCase();
  if (!['plus', 'pro'].includes(plan)) throw new Error('plan must be plus or pro');
  const providerPack = resolveProviderPack(providerId, options.model);
  const providerDefaultThreshold = plan === 'plus' ? providerPack.thresholds?.plus ?? 50 : providerPack.thresholds?.pro ?? 10;
  const threshold = parseThreshold(options.threshold ?? providerDefaultThreshold);
  const sparkAvailable = parseBoolean(
    options.sparkAvailable ?? plan === 'pro',
    'Spark availability',
  );
  const lunaAvailable = parseBoolean(options.lunaAvailable ?? true, 'Luna availability');
  const knownProviders = listProviderPackIds();
  if (!knownProviders.includes(providerId)) throw new Error(`unsupported provider: ${providerId}`);
  if (options.confirmMainPreserved !== true) {
    throw new Error('confirm that the main model/provider/auth remain preserved');
  }
  if (options.consentData !== true) {
    throw new Error('explicit consent is required because delegated data is sent to a provider');
  }
  return {
    ...options,
    providerId,
    providerPack,
    plan,
    threshold,
    sparkAvailable,
    lunaAvailable,
    migrateLegacy: options.migrateLegacy === true,
    transport: normalizeTransportPreference(options.transport),
  };
}

function profileFromManifest(providerId, value) {
  const candidate = value?.id ?? value?.profile ?? value?.model ?? value;
  try {
    return resolveProviderPack(providerId, candidate);
  } catch {
    return null;
  }
}

function activeProfiles(normalized, previousManifest) {
  if (normalized.providerId !== 'deepseek') return [normalized.providerPack];
  const previous = previousManifest?.options?.providerId === normalized.providerId
    ? (previousManifest.options?.profiles ?? [previousManifest.options?.model])
      .map((value) => profileFromManifest(normalized.providerId, value))
      .filter(Boolean)
    : [];
  const requested = normalized.providerPack;
  const requestedProfiles = new Set([...previous, requested].map((profile) => profile.profile));
  return listProviderPackProfiles(normalized.providerId)
    .filter((profile) => requestedProfiles.has(profile.profile));
}

function automaticProviderRole(providerId, profiles) {
  if (providerId === 'deepseek') {
    return profiles.find((profile) => profile.profile === 'flash')?.role ?? null;
  }
  return profiles[0]?.role ?? null;
}

function profileEnvironment(env, profile) {
  const found = env.profileEnvironments.find((candidate) => candidate.profile === profile.profile);
  if (!found) throw new Error(`provider profile environment is missing: ${profile.profile}`);
  return found;
}

function customAgentDefinitions(profiles) {
  return profiles.map((profile) => ({
    name: profile.role,
    model: profile.model,
    modelProvider: profile.modelProvider,
    fileName: profile.agentFile,
  }));
}

function customAgentMigration({
  definitions,
  expected,
  profileEnvironments,
  previousManifest,
  requested,
} = {}) {
  const expectedByName = new Map(expected.map((definition) => [definition.name, definition]));
  const pathByName = new Map(profileEnvironments.map(({ profile, environment }) => [
    profile.role,
    environment.agentPath,
  ]));
  const managedPaths = new Set((previousManifest?.managedFiles ?? [])
    .filter((record) => record.kind === 'agent')
    .map((record) => record.path));
  const candidates = [];
  const conflicts = [];
  for (const state of definitions.expectedDefinitions) {
    if (!state.present && !state.projectPresent) continue;
    const expectedDefinition = expectedByName.get(state.name);
    const managed = managedPaths.has(pathByName.get(state.name));
    const valid = state.present
      && state.configured === true
      && state.modelMatches === true
      && state.providerMatches === true
      && state.fileNameMatches !== false
      && state.duplicate !== true
      && state.projectPresent !== true;
    if (!managed && valid) candidates.push(state.name);
    if (!managed && !valid) conflicts.push(state.name);
    if (expectedDefinition?.fileName === undefined) conflicts.push(state.name);
  }
  return {
    requested: requested === true,
    candidates: [...new Set(candidates)].sort(),
    conflicts: [...new Set(conflicts)].sort(),
    applied: requested === true && candidates.length > 0,
    snapshotRequired: candidates.length > 0,
  };
}

function customAgentSummary(host, definitions, expected, migration) {
  return {
    host: {
      supported: host.supported,
      version: host.version,
      multiAgent: host.multiAgent,
      multiAgentV2: host.multiAgentV2,
      reason: host.reason,
      compatibility: publicHostCompatibility(host.compatibility),
    },
    expected: expected.map((definition) => ({
      name: definition.name,
      model: definition.model,
      modelProvider: definition.modelProvider,
    })),
    duplicateNames: definitions.expectedDefinitions
      .filter((definition) => definition.duplicate)
      .map((definition) => definition.name),
    projectDuplicateNames: definitions.projectDuplicateNames,
    discoveryRequiresNewSession: true,
    migration,
  };
}

async function regularFile(filePath) {
  const info = await lstatIfExists(filePath);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing to manage non-regular file: ${filePath}`);
  }
  return info;
}

async function managedDirectory(filePath, previousDirectories = []) {
  const info = await lstatIfExists(filePath);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error(`refusing to manage non-directory: ${filePath}`);
  }
  const previous = previousDirectories.find((record) => record?.path === filePath);
  if (previous && typeof previous.preExisting !== 'boolean') {
    throw new Error('existing install manifest has an invalid managed directory');
  }
  return {
    path: filePath,
    // A later profile install sees the runtime directory created by the first
    // install. Preserve its original ownership instead of treating it as user
    // owned and leaving an empty directory behind on rollback.
    preExisting: previous?.preExisting ?? Boolean(info),
  };
}

async function readPreviousManifest(env) {
  if (!(await pathExists(env.manifestPath))) return null;
  await regularFile(env.manifestPath);
  await assertOwnerOnly(env.manifestPath, 0o600, env.uid);
  const manifest = JSON.parse(await fs.readFile(env.manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.environment?.homeDir !== env.homeDir) {
    throw new Error('existing install manifest is incompatible with this home directory');
  }
  return manifest;
}

async function makeBackup(filePath, env, previousBackup = null) {
  const info = await regularFile(filePath);
  if (!info) return null;
  const data = await fs.readFile(filePath);
  await ensureDir(env.backupDir, 0o700, { enforceMode: false });
  const name = `${path.basename(filePath)}.${stamp()}-${crypto.randomBytes(5).toString('hex')}.bak`;
  const backupPath = path.join(env.backupDir, name);
  await copyOwnerOnly(filePath, backupPath);
  return {
    path: backupPath,
    hash: sha256(data),
    originalMode: info.mode & 0o777,
    windowsSecurityDescriptor: env.platform === 'win32'
      ? previousBackup?.windowsSecurityDescriptor ?? await captureWindowsSecurityDescriptor(filePath)
      : null,
  };
}

async function applyFile({ filePath, contents, mode, env, dryRun, previous }) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const info = await regularFile(filePath);
  const current = info ? await fs.readFile(filePath) : null;
  const currentHash = current ? sha256(current) : null;
  const desiredHash = sha256(data);
  const secure = info ? await privatePathReady(filePath, {
    kind: 'file', mode, uid: env.uid, platform: env.platform,
  }) : false;
  const changed = !info || currentHash !== desiredHash || !secure;
  let backup = previous?.backup ?? null;
  if (changed && info && currentHash !== previous?.hash && !dryRun) {
    backup = await makeBackup(filePath, env, previous?.backup);
  }
  if (!dryRun && changed) await writeFileIfChanged(filePath, data, { mode });
  return {
    path: filePath,
    hash: desiredHash,
    mode,
    changed,
    backup,
    preExisting: previous ? previous.preExisting === true : Boolean(info),
  };
}

async function runtimeEntries(env, sourceDir) {
  const entries = [];
  for (const name of RUNTIME_FILES) {
    entries.push({
      filePath: path.join(env.runtimeDir, name),
      contents: await fs.readFile(path.join(sourceDir, name)),
      mode: 0o600,
      kind: 'runtime',
    });
  }
  return entries;
}

function previousByPath(manifest) {
  return new Map((manifest?.managedFiles ?? []).map((entry) => [entry.path, entry]));
}

export async function install(options = {}) {
  const normalized = normalizeOptions(options);
  const platform = normalized.platform ?? process.platform;
  const providerPack = normalized.providerPack;
  const env = discoverEnvironment({ ...normalized, providerPack, platform, env: normalized.env ?? process.env });
  const dryRun = normalized.apply !== true;
  if (!dryRun) assertSupportedPlatform(platform);
  if (!dryRun) await assertNoReparsePath(env.codexDir, env.homeDir, { platform });

  const previousManifest = await readPreviousManifest(env);
  const previousDirectories = previousManifest?.managedDirectories ?? [];
  const managedDirectories = await Promise.all([
    managedDirectory(env.runtimeDir, previousDirectories),
    managedDirectory(path.join(env.runtimeDir, 'credentials'), previousDirectories),
  ]);
  const profiles = activeProfiles(normalized, previousManifest);
  const profileEnvironments = profiles.map((profile) => ({
    profile,
    environment: profileEnvironment(env, profile),
  }));
  if (!dryRun) {
    const managedRoots = [
      env.codexDir,
      env.agentsDir,
      env.runtimeDir,
      path.dirname(env.catalogPath),
      path.dirname(env.preflightPath),
      env.backupDir,
    ];
    for (const managedRoot of managedRoots) {
      await assertNoReparsePath(managedRoot, env.homeDir, { platform });
    }
  }
  const expectedCustomAgents = customAgentDefinitions(profiles);
  const customAgentHost = await (normalized.inspectCustomAgentHostImpl ?? inspectCustomAgentHost)({
    codexPath: normalized.codexPath,
    commandRunner: normalized.commandRunner,
  });
  const transportPlan = installerTransportPlan({
    requestedTransport: normalized.transport,
    compatibility: customAgentHost.compatibility,
    providerId: providerPack.id,
    providerRole: providerPack.role,
    model: providerPack.model,
    externalFlashBeta: normalized.externalFlashBeta,
  });
  if (!dryRun && transportPlan.requestedTransport === 'external-codex'
    && transportPlan.applyAllowed !== true) {
    throw new Error(transportPlan.reason);
  }
  const customAgentDefinitionsState = await (
    normalized.inspectCustomAgentDefinitionsImpl ?? inspectCustomAgentDefinitions
  )({
    homeDir: env.homeDir,
    projectRoot: normalized.projectRoot,
    expected: expectedCustomAgents,
  });
  const migration = customAgentMigration({
    definitions: customAgentDefinitionsState,
    expected: expectedCustomAgents,
    profileEnvironments,
    previousManifest,
    requested: normalized.migrateLegacy,
  });
  const customAgentConflict = migration.conflicts.length > 0
    || customAgentDefinitionsState.issues.length > 0;
  if (!dryRun && customAgentHost.compatibility?.configurationInstallAllowed !== true
    && transportPlan.externalFlashBetaConfiguration !== true) {
    throw new Error(`Host cross-provider subagent installation is blocked: ${customAgentHost.reason}`);
  }
  if (!dryRun && customAgentConflict) {
    throw new Error('custom-agent identity conflict detected; resolve duplicates before --apply');
  }
  if (!dryRun && migration.candidates.length > 0 && normalized.migrateLegacy !== true) {
    throw new Error('matching existing Custom Agent identities require --migrate-legacy before --apply');
  }
  const customAgents = customAgentSummary(
    customAgentHost,
    customAgentDefinitionsState,
    expectedCustomAgents,
    migration,
  );
  const defaultProviderRole = automaticProviderRole(providerPack.id, profiles);
  const source = normalized.catalogSource ?? 'auto';
  const setupScriptUrl = normalized.setupScriptUrl ?? providerPack.catalogSourceHint;
  const acquired = await acquireCatalog({
    source,
    setupScriptUrl,
    maxBytes: normalized.maxCatalogBytes ?? providerPack.catalog?.extraMaxBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    extract: (text) => extractCatalogDocument(text, {
      sourceFormat: providerPack.catalog?.sourceFormat ?? 'auto',
      modelId: providerPack.catalog?.modelId,
    }),
    validateHost: (candidate) => {
      const url = new URL(candidate);
      const sourceHost = providerPack.catalogSourceHost ?? providerPack.setupScriptHost;
      if (url.protocol !== 'https:' || !sourceHost?.test(url.hostname)) {
        throw new Error('official catalog source host is not allowed for this provider pack');
      }
      return candidate;
    },
    reduce: (catalog) => catalog,
    fetchImpl: normalized.fetchImpl,
  });
  const catalogs = new Map(profiles.map((profile) => [
    profile.profile,
    reduceCatalogForProvider(acquired.catalog, profile.catalog),
  ]));
  if (transportPlan.externalFlashBetaConfiguration === true) {
    catalogs.set(providerPack.profile, validateProductionCatalog(acquired.catalog, {
      codexVersion: PRODUCTION_CATALOG_CONTRACT.codexVersion,
      providerId: providerPack.id,
      model: providerPack.model,
      requiredModalities: providerPack.catalog.requiredModalities,
      outputModalities: providerPack.catalog.outputModalities,
    }));
  }

  if (!dryRun) {
    const check = normalized.credentialReadyImpl ?? normalized.keychainReadyImpl ?? credentialReady;
    const ready = await check({
      account: env.keychainAccount,
      service: providerPack.keychainService,
      platform,
      env: normalized.env ?? process.env,
      execFileImpl: normalized.execFileImpl,
    });
    if (!ready) {
      throw new Error('provider credential is not provisioned in the supported OS credential backend');
    }
  }

  const previous = previousByPath(previousManifest);
  const block = agentsBlock({
    nodePath: env.nodePath,
    preflightPath: env.preflightPath,
    bridgePath: env.bridgePath,
    threshold: normalized.threshold,
    sparkAvailable: normalized.sparkAvailable,
    lunaAvailable: normalized.lunaAvailable,
    providerPack,
    providerRole: providerPack.role,
    providerProfiles: profiles,
    defaultProviderRole,
  });
  const existingAgents = await pathExists(env.agentsMarkerPath)
    ? await fs.readFile(env.agentsMarkerPath, 'utf8')
    : '';
  const agentsMode = (await regularFile(env.agentsMarkerPath))?.mode & 0o777 || 0o600;
  const configOptions = {
    plan: normalized.plan,
    sparkAvailable: normalized.sparkAvailable,
    lunaAvailable: normalized.lunaAvailable,
    threshold: normalized.threshold,
    apiBase: providerPack.apiBase,
    catalogSource: source,
    setupScriptUrl,
    bridgePath: env.bridgePath,
    agentPath: env.agentPath,
    catalogPath: env.catalogPath,
    configPath: env.configPath,
    keychainAccount: env.keychainAccount,
    keychainService: providerPack.keychainService,
    credentialBackend: credentialBackend(platform),
    platform,
    providerId: providerPack.id,
    providerRole: providerPack.role,
    model: providerPack.model,
    modelProfile: providerPack.profile,
    profiles: profileEnvironments.map(({ profile, environment }) => ({
      id: profile.profile,
      providerRole: profile.role,
      model: profile.model,
      agentPath: environment.agentPath,
      catalogPath: environment.catalogPath,
    })),
    defaultProviderRole,
    customAgents: expectedCustomAgents,
    hostCompatibility: publicHostCompatibility(customAgentHost.compatibility),
    providerCapabilities: Array.from(providerPack.capabilities.supported.values()),
  };

  const entries = [
    ...(await runtimeEntries(env, normalized.sourceDir ?? SOURCE_DIR)),
    ...profileEnvironments.flatMap(({ profile, environment }) => [
      {
        filePath: environment.agentPath,
        contents: agentToml({
          catalogPath: environment.catalogPath,
          bridgePath: env.bridgePath,
          bridgeCliPath: env.bridgeCliPath,
          nodePath: env.nodePath,
          keychainAccount: env.keychainAccount,
          keychainService: profile.keychainService,
          providerPack: profile,
          platform,
          runtimeBlockerPath: path.join(env.runtimeDir, 'credential-runtime-blocker.mjs'),
        }),
        mode: 0o600,
        kind: 'agent',
      },
      {
        filePath: environment.catalogPath,
        contents: catalogJson(catalogs.get(profile.profile)),
        mode: 0o600,
        kind: 'catalog',
      },
    ]),
    {
      filePath: env.configPath,
      contents: workerConfig(configOptions),
      mode: 0o600,
      kind: 'config',
    },
    {
      filePath: env.preflightPath,
      contents: preflightWrapper({ runtimeDir: env.runtimeDir, configPath: env.configPath }),
      mode: 0o700,
      kind: 'preflight',
    },
    {
      filePath: env.bridgeCliPath,
      contents: bridgeWrapper({ runtimeDir: env.runtimeDir }),
      mode: 0o700,
      kind: 'bridge-cli',
    },
    {
      filePath: env.agentsMarkerPath,
      contents: replaceAgentsBlock(existingAgents, block),
      mode: agentsMode,
      kind: 'agents-marker',
    },
  ];

  const managedFiles = [];
  for (const entry of entries) {
    const record = await applyFile({
      ...entry,
      env,
      dryRun,
      previous: previous.get(entry.filePath),
    });
    managedFiles.push({ ...record, kind: entry.kind });
  }

  const manifest = {
    schemaVersion: 1,
    installVersion: INSTALL_VERSION,
    installedAt: new Date().toISOString(),
    environment: {
      homeDir: env.homeDir,
      uid: env.uid,
      username: env.username,
      nodePath: env.nodePath,
      bridgePath: env.bridgePath,
      providerId: providerPack.id,
      profiles: profiles.map((profile) => ({
        id: profile.profile,
        providerRole: profile.role,
        model: profile.model,
      })),
      customAgents: expectedCustomAgents,
      hostCompatibility: publicHostCompatibility(customAgentHost.compatibility),
      legacyMigration: migration.applied ? migration.candidates : [],
    },
    options: {
      providerId: providerPack.id,
      plan: normalized.plan,
      sparkAvailable: normalized.sparkAvailable,
      lunaAvailable: normalized.lunaAvailable,
      threshold: normalized.threshold,
      model: providerPack.model,
      modelProfile: providerPack.profile,
      profiles: profiles.map((profile) => ({
        id: profile.profile,
        providerRole: profile.role,
        model: profile.model,
      })),
      defaultProviderRole,
      customAgents: expectedCustomAgents,
      hostCompatibility: publicHostCompatibility(customAgentHost.compatibility),
      legacyMigration: migration.applied ? migration.candidates : [],
      mainModelPreserved: true,
      delegatedDataConsent: true,
    },
    managedFiles,
    managedDirectories,
    agentsBlock: block,
    secretStorage: {
      service: providerPack.keychainService,
      account: env.keychainAccount,
      backend: credentialBackend(platform),
      value: platform === 'darwin' ? 'keychain-only' : 'windows-credential-manager-only',
    },
  };

  if (!dryRun) {
    await writeFileIfChanged(env.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  return {
    dryRun,
    applied: !dryRun,
    environment: env,
    managedFiles,
    manifestPath: env.manifestPath,
    catalogAcquired: Boolean(acquired),
    keychainVerified: !dryRun,
    credentialBackend: credentialBackend(platform),
    customAgents,
    migration,
    profile: {
      id: providerPack.profile,
      providerRole: providerPack.role,
      model: providerPack.model,
    },
    profiles: profiles.map((profile) => ({
      id: profile.profile,
      providerRole: profile.role,
      model: profile.model,
    })),
    transportPlan,
    message: dryRun ? 'dry-run: no files or keychain entries were changed' : 'installation applied',
  };
}
