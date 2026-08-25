import fs from 'node:fs/promises';
import path from 'node:path';
import { reduceCatalogForProvider } from '../../../src/catalog.mjs';
import { resolveProviderPack } from '../../../src/provider-packs.mjs';
import { writePrivateFile } from './fs-safety.mjs';

function toml(value) {
  return JSON.stringify(String(value));
}

export function flashPack() {
  const pack = resolveProviderPack('deepseek', 'flash');
  if (pack.id !== 'deepseek' || pack.role !== 'deepseek_worker' || pack.model !== 'deepseek-v4-flash') {
    throw new Error('DeepSeek Flash provider pack identity is invalid');
  }
  return pack;
}

export function minimalChildConfig({ catalogPath, keychainAccount, pack = flashPack() } = {}) {
  if (!path.isAbsolute(catalogPath ?? '')) throw new Error('catalogPath must be absolute');
  if (typeof keychainAccount !== 'string' || !keychainAccount.trim()) {
    throw new Error('keychainAccount is required');
  }
  const provider = pack.modelProvider;
  return [
    `model = ${toml(pack.model)}`,
    `model_provider = ${toml(provider)}`,
    `model_catalog_json = ${toml(catalogPath)}`,
    'approval_policy = "never"',
    '',
    `[model_providers.${provider}]`,
    `name = ${toml(pack.modelProviderName)}`,
    `base_url = ${toml(pack.apiBase)}`,
    `wire_api = ${toml(pack.wireApi)}`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    `[model_providers.${provider}.auth]`,
    'command = "/usr/bin/security"',
    `args = ["find-generic-password", "-a", ${toml(keychainAccount)}, "-s", ${toml(pack.keychainService)}, "-w"]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
    '',
  ].join('\n');
}

export async function writeMinimalChildHome({ homeDir, catalogSource, keychainAccount } = {}) {
  if (!path.isAbsolute(homeDir ?? '')) throw new Error('homeDir must be absolute');
  const pack = flashPack();
  const source = JSON.parse(await fs.readFile(catalogSource, 'utf8'));
  const catalog = reduceCatalogForProvider(source, pack.catalog);
  const catalogPath = path.join(homeDir, 'deepseek-v4-flash.json');
  const configPath = path.join(homeDir, 'config.toml');
  await writePrivateFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await writePrivateFile(configPath, minimalChildConfig({ catalogPath, keychainAccount, pack }));
  return { pack, catalogPath, configPath };
}
