#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { resolveProviderPack } from './provider-packs.mjs';
import {
  classifyWindowsCredentialError,
  retrieveWindowsCredential,
} from './credentials/windows-credential-manager.mjs';

const ACCOUNT = /^[A-Za-z0-9._@-]{1,128}$/u;
const ARG_FIELDS = Object.freeze(['--account', '--model', '--provider']);
export const WINDOWS_CREDENTIAL_COMMAND_PATH = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error('INVALID_ARGUMENTS');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ARG_FIELDS.includes(name) || values.has(name)
      || typeof value !== 'string' || value.length > 128 || /[\r\n\0]/u.test(value)) {
      throw new Error('INVALID_ARGUMENTS');
    }
    values.set(name, value);
  }
  if (values.size !== ARG_FIELDS.length || !ACCOUNT.test(values.get('--account') ?? '')) {
    throw new Error('INVALID_ARGUMENTS');
  }
  const pack = resolveProviderPack(values.get('--provider'), values.get('--model'));
  if (pack.id !== values.get('--provider') || pack.model !== values.get('--model')) {
    throw new Error('INVALID_PROVIDER_TUPLE');
  }
  return Object.freeze({ account: values.get('--account'), pack });
}

export function windowsCredentialCommandArgs({ providerPack, account } = {}) {
  if (!providerPack?.id || !providerPack?.model || !ACCOUNT.test(account ?? '')) {
    throw new Error('Windows credential command inputs are invalid');
  }
  const pack = resolveProviderPack(providerPack.id, providerPack.model);
  return Object.freeze([
    '--provider', pack.id,
    '--model', pack.model,
    '--account', account,
  ]);
}

export async function runWindowsCredentialCommand(argv, {
  platform = process.platform,
  retrieveImpl = retrieveWindowsCredential,
  stderr = process.stderr,
  writeSecretImpl = (buffer) => {
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    }
  },
} = {}) {
  let secret;
  try {
    if (platform !== 'win32') throw new Error('PLATFORM_UNSUPPORTED');
    const { account, pack } = parseArgs(argv);
    secret = await retrieveImpl({ service: pack.keychainService, account });
    if (!Buffer.isBuffer(secret) || secret.length < 1 || secret.length > 2560) {
      throw new Error('INVALID_SECRET');
    }
    writeSecretImpl(secret);
    return 0;
  } catch (error) {
    const classified = classifyWindowsCredentialError(error);
    const code = classified === 'NATIVE_FAILURE' && /^[A-Z0-9_]+$/u.test(error?.message ?? '')
      ? error.message
      : classified;
    stderr.write(`WINDOWS_CREDENTIAL_COMMAND_${code}\n`);
    return code === 'NOT_FOUND' ? 44 : 78;
  } finally {
    secret?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runWindowsCredentialCommand(process.argv.slice(2));
}
