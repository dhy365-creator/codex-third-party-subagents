import path from 'node:path';
import { discoverEnvironment } from './environment.mjs';
import { resolveProviderPack } from './provider-packs.mjs';
import {
  assertNoReparsePath,
  restoreWindowsSecurityDescriptor,
} from './platform-security.mjs';
import {
  copyOwnerOnly,
  assertOwnerOnly,
  fs,
  isPathInside,
  lstatIfExists,
  removeFileIfExists,
  sha256File,
  writeFileIfChanged,
} from './fs-utils.mjs';
import { removeAgentsBlock } from './templates.mjs';

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

function allowedPaths(env, profiles) {
  return new Set([
    ...RUNTIME_FILES.map((name) => path.join(env.runtimeDir, name)),
    ...profiles.flatMap((profile) => [profile.agentPath, profile.catalogPath]),
    env.configPath,
    env.preflightPath,
    env.bridgeCliPath,
    env.agentsMarkerPath,
  ]);
}

function profilesFromManifest(manifest, env) {
  const providerId = manifest.options?.providerId ?? manifest.environment?.providerId;
  if (!providerId) throw new Error('install manifest provider is missing');
  const records = Array.isArray(manifest.options?.profiles) && manifest.options.profiles.length
    ? manifest.options.profiles
    : [{ id: manifest.options?.modelProfile, model: manifest.options?.model }];
  const profiles = records.map((record) => {
    const pack = resolveProviderPack(providerId, record.id ?? record.profile ?? record.model);
    const role = record.providerRole ?? record.role;
    if (record.id && record.id !== pack.profile) throw new Error('install manifest profile id is invalid');
    if (record.model && record.model !== pack.model) throw new Error('install manifest profile model is invalid');
    if (role && role !== pack.role) throw new Error('install manifest profile role is invalid');
    const paths = env.profileEnvironments.find((candidate) => candidate.profile === pack.profile);
    if (!paths) throw new Error('install manifest profile paths are invalid');
    return { ...pack, ...paths };
  });
  if (!profiles.length || new Set(profiles.map((profile) => profile.role)).size !== profiles.length) {
    throw new Error('install manifest profiles are invalid');
  }
  return { providerId, profiles };
}

async function loadManifest(env) {
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

async function planRegular(record, env) {
  const info = await lstatIfExists(record.path);
  if (!info) return { type: 'already-missing', record };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('managed path is not a regular file');
  }
  if (await sha256File(record.path) !== record.hash) {
    throw new Error('managed file was modified');
  }
  if (record.backup) {
    if (!isPathInside(env.backupDir, record.backup.path)) {
      throw new Error('backup escapes the managed backup directory');
    }
    const backupInfo = await lstatIfExists(record.backup.path);
    if (!backupInfo || backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
      throw new Error('backup is missing or invalid');
    }
    try { await assertOwnerOnly(record.backup.path, 0o600, env.uid); }
    catch { throw new Error('backup failed integrity validation'); }
    if (await sha256File(record.backup.path) !== record.backup.hash) {
      throw new Error('backup failed integrity validation');
    }
    if (!Number.isInteger(record.backup.originalMode)
      || record.backup.originalMode < 0
      || record.backup.originalMode > 0o777) {
      throw new Error('backup mode is invalid');
    }
    if (env.platform === 'win32'
      && (typeof record.backup.windowsSecurityDescriptor !== 'string'
        || !record.backup.windowsSecurityDescriptor.startsWith('O:'))) {
      throw new Error('backup Windows security descriptor is invalid');
    }
    return { type: 'restore', record };
  }
  if (record.preExisting) return { type: 'preserve-preexisting', record };
  return { type: 'remove', record };
}

async function planAgents(record, manifest) {
  const info = await lstatIfExists(record.path);
  if (!info) return { type: 'already-missing', record };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('AGENTS.md is not a regular file');
  }
  const source = await fs.readFile(record.path, 'utf8');
  const removed = removeAgentsBlock(source, manifest.agentsBlock);
  if (!removed.changed) return { type: 'already-missing', record };
  return {
    type: !removed.text && !record.preExisting ? 'remove' : 'rewrite-agents',
    record,
    text: removed.text,
    mode: info.mode & 0o777,
  };
}

function summarizeAction(action) {
  return {
    type: action.type,
    kind: action.record.kind,
    preExisting: action.record.preExisting === true,
  };
}

function plannedDirectoryActions(manifest, env) {
  const records = manifest.managedDirectories ?? [];
  const kinds = new Map([
    [env.runtimeDir, 'runtime-directory'],
    [path.join(env.runtimeDir, 'credentials'), 'runtime-credentials-directory'],
  ]);
  const seen = new Set();
  return records.map((record) => {
    const kind = kinds.get(record?.path);
    if (!kind || seen.has(record.path) || typeof record.preExisting !== 'boolean') {
      throw new Error('install manifest contains an unmanaged directory');
    }
    seen.add(record.path);
    return record.preExisting ? null : {
      type: 'remove-empty-directory',
      record: { kind, preExisting: false, path: record.path },
    };
  }).filter(Boolean).sort((left, right) => right.record.path.length - left.record.path.length);
}

async function removeManagedDirectoryIfEmpty(action, env) {
  const target = action.record.path;
  if (!isPathInside(env.runtimeDir, target)) return;
  const info = await lstatIfExists(target);
  if (!info) return;
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  try {
    // Revalidate every existing parent component immediately before cleanup.
    // A renamed directory, symlink, or junction must never redirect removal.
    await assertNoReparsePath(target, env.homeDir, { platform: env.platform });
    await fs.rmdir(target);
  } catch {
    // Directory cleanup is best-effort after every managed file is already safe.
    // Preserve an unexpected or concurrently populated directory rather than
    // turning optional cleanup into a destructive action.
  }
}

export async function uninstall(options = {}) {
  if (options.model) {
    throw new Error('uninstall removes the whole installed provider registry; omit --model');
  }
  let env = discoverEnvironment({ ...options, env: options.env ?? process.env });
  const dryRun = options.apply !== true;
  const manifest = await loadManifest(env);
  if (!manifest) {
    return {
      dryRun,
      applied: false,
      alreadyUninstalled: true,
      actions: [],
      conflicts: [],
      keychainRemoved: false,
      manifestRemoved: false,
    };
  }
  const providerId = manifest.options?.providerId ?? manifest.environment?.providerId;
  if (!providerId) throw new Error('install manifest provider is missing');
  if (options.provider && String(options.provider).trim().toLowerCase() !== providerId) {
    throw new Error('selected provider does not match the installed provider');
  }
  env = discoverEnvironment({ ...options, provider: providerId, env: options.env ?? process.env });
  const { profiles } = profilesFromManifest(manifest, env);
  const allowed = allowedPaths(env, profiles);
  const actions = [];
  const conflicts = [];
  for (const record of manifest.managedFiles ?? []) {
    if (!allowed.has(record.path)) {
      conflicts.push('manifest contains an unmanaged path');
      continue;
    }
    try {
      actions.push(record.kind === 'agents-marker'
        ? await planAgents(record, manifest)
        : await planRegular(record, env));
    } catch (error) {
      conflicts.push(error.message);
    }
  }
  let directoryActions = [];
  try {
    directoryActions = plannedDirectoryActions(manifest, env);
  } catch (error) {
    conflicts.push(error.message);
  }
  const allActions = [...actions, ...directoryActions];
  if (conflicts.length || dryRun) {
    return {
      dryRun,
      applied: false,
      actions: allActions.map(summarizeAction),
      conflicts,
      keychainRemoved: false,
      manifestRemoved: false,
    };
  }
  for (const action of actions) {
    if (action.type === 'remove') {
      await removeFileIfExists(action.record.path);
    } else if (action.type === 'restore') {
      await copyOwnerOnly(action.record.backup.path, action.record.path);
      if (process.platform === 'darwin') await fs.chmod(action.record.path, action.record.backup.originalMode);
      if (env.platform === 'win32') {
        await restoreWindowsSecurityDescriptor(
          action.record.path,
          action.record.backup.windowsSecurityDescriptor,
          { env: options.env ?? process.env },
        );
      }
    } else if (action.type === 'rewrite-agents') {
      await writeFileIfChanged(action.record.path, action.text, { mode: action.mode });
      if (env.platform === 'win32' && action.record.backup?.windowsSecurityDescriptor) {
        await restoreWindowsSecurityDescriptor(
          action.record.path,
          action.record.backup.windowsSecurityDescriptor,
          { env: options.env ?? process.env },
        );
      }
    }
  }
  for (const action of directoryActions) await removeManagedDirectoryIfEmpty(action, env);
  await removeFileIfExists(env.manifestPath);
  return {
    dryRun: false,
    applied: true,
    actions: allActions.map(summarizeAction),
    conflicts: [],
    keychainRemoved: false,
    manifestRemoved: true,
  };
}
