import fs from 'node:fs/promises';
import path from 'node:path';
import { reduceCatalogForProvider } from '../catalog.mjs';
import { resolveProviderPack } from '../provider-packs.mjs';
import { containsCredentialText } from './external-evidence.mjs';
import { sha256, writePrivateFile } from './external-fs-safety.mjs';

export const EXTERNAL_DISABLED_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'plugin_sharing',
  'skill_search',
]);

const CREDENTIAL_FIELDS = Object.freeze(['kind', 'command', 'args']);

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields do not match the contract`);
  }
}

function toml(value) {
  return JSON.stringify(String(value));
}

function safeCommandArgs(args) {
  return Array.isArray(args) && args.length <= 16
    && args.every((value) => typeof value === 'string' && value.length <= 256 && !containsCredentialText(value));
}

export function resolveExternalProviderTuple(request) {
  const pack = resolveProviderPack(request.providerId, request.model);
  if (pack.id !== request.providerId || pack.role !== request.providerRole || pack.model !== request.model) {
    throw new Error('provider/model/role tuple is not a reviewed provider pack');
  }
  if (pack.role === 'deepseek_pro_worker' && request.explicitOnly !== true) {
    throw new Error('DeepSeek V4 Pro must remain explicit-only');
  }
  return pack;
}

export function validateCredentialCommand(contract, pack, { allowFixture = false } = {}) {
  exactFields(contract, CREDENTIAL_FIELDS, 'credential command');
  if (!path.isAbsolute(contract.command ?? '') || !safeCommandArgs(contract.args)) {
    throw new Error('credential command is invalid');
  }
  if (contract.kind === 'keychain') {
    const expected = ['find-generic-password', '-a', contract.args[2], '-s', pack.keychainService, '-w'];
    if (contract.command !== '/usr/bin/security'
      || !/^[A-Za-z0-9._@-]{1,128}$/u.test(contract.args[2] ?? '')
      || JSON.stringify(contract.args) !== JSON.stringify(expected)) {
      throw new Error('credential command must use the reviewed macOS Keychain contract');
    }
  } else if (contract.kind !== 'fixture' || !allowFixture) {
    throw new Error('credential command kind is unsupported');
  }
  return Object.freeze({ kind: contract.kind, command: contract.command, args: Object.freeze([...contract.args]) });
}

export function minimalExternalConfig({ pack, catalogPath, credentialCommand, permissionProfile } = {}) {
  if (!path.isAbsolute(catalogPath ?? '')) throw new Error('catalogPath must be absolute');
  if (!['read-only', 'workspace-write'].includes(permissionProfile)) {
    throw new Error('permission profile is unsupported');
  }
  const provider = pack.modelProvider;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(provider ?? '')) throw new Error('provider id is unsafe');
  const lines = [
    `model = ${toml(pack.model)}`,
    `model_provider = ${toml(provider)}`,
    `model_catalog_json = ${toml(catalogPath)}`,
    'approval_policy = "never"',
    `sandbox_mode = ${toml(permissionProfile)}`,
    '',
    '[features]',
    ...EXTERNAL_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '',
    `[model_providers.${provider}]`,
    `name = ${toml(pack.modelProviderName)}`,
    `base_url = ${toml(pack.apiBase)}`,
    `wire_api = ${toml(pack.wireApi)}`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    `[model_providers.${provider}.auth]`,
    `command = ${toml(credentialCommand.command)}`,
    `args = [${credentialCommand.args.map(toml).join(', ')}]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
    '',
  ];
  const config = lines.join('\n');
  if (containsCredentialText(config)) throw new Error('generated config contains credential-like material');
  return config;
}

export async function writeMinimalExternalHome({
  homeDir,
  catalogSource,
  request,
  credentialCommand,
  allowFixtureCredential = false,
} = {}) {
  if (!path.isAbsolute(homeDir ?? '') || !path.isAbsolute(catalogSource ?? '')) {
    throw new Error('homeDir and catalogSource must be absolute');
  }
  const sourceInfo = await fs.lstat(catalogSource);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size > 4 * 1024 * 1024) {
    throw new Error('catalog source is unsafe or oversized');
  }
  const pack = resolveExternalProviderTuple(request);
  const checkedCredential = validateCredentialCommand(
    credentialCommand,
    pack,
    { allowFixture: allowFixtureCredential },
  );
  const source = JSON.parse(await fs.readFile(catalogSource, 'utf8'));
  const catalog = reduceCatalogForProvider(source, pack.catalog);
  const catalogPath = path.join(homeDir, pack.catalog.file);
  const configPath = path.join(homeDir, 'config.toml');
  await writePrivateFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { exclusive: true });
  const config = minimalExternalConfig({
    pack,
    catalogPath,
    credentialCommand: checkedCredential,
    permissionProfile: request.permissionProfile,
  });
  await writePrivateFile(configPath, config, { exclusive: true });
  return Object.freeze({
    pack,
    catalogPath,
    configPath,
    configSha256: sha256(config),
    credentialCommand: checkedCredential,
  });
}
