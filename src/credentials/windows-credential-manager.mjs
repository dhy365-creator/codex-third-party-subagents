import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./windows-credential-helper.ps1', import.meta.url));
const NOT_FOUND = 1168;
const ERROR_CODES = new Map([
  [5, 'ACCESS_DENIED'],
  [87, 'INVALID_PARAMETER'],
  [1312, 'NO_LOGON_SESSION'],
  [1168, 'NOT_FOUND'],
]);

export class CredentialBackendError extends Error {
  constructor(code) {
    super(`Windows credential operation failed: ${code}`);
    this.name = 'CredentialBackendError';
    this.code = code;
  }
}

function safeField(value, label, maxLength = 256) {
  const text = String(value ?? '');
  if (!text || text.length > maxLength || !/^[A-Za-z0-9._:@/\\-]+$/u.test(text)) {
    throw new CredentialBackendError(`INVALID_${label.toUpperCase()}`);
  }
  return text;
}

function powershellPath(env = process.env) {
  const root = path.resolve(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function encodedHelper() {
  const source = await fs.readFile(HELPER_PATH, 'utf8');
  return Buffer.from(source, 'utf16le').toString('base64');
}

function classify(response) {
  if (response?.status === 'OK') return response;
  const code = response?.code ?? ERROR_CODES.get(Number(response?.nativeCode)) ?? 'NATIVE_FAILURE';
  throw new CredentialBackendError(code);
}

function pipeId() {
  return `codex-third-party-subagents-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
}

export async function invokeWindowsCredentialOperation(request, {
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = 15_000,
} = {}) {
  if (process.platform !== 'win32') throw new CredentialBackendError('PLATFORM_UNSUPPORTED');
  const pipeName = pipeId();
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const pipeNonce = crypto.randomBytes(32).toString('hex');
  const body = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(body) > 16 * 1024) throw new CredentialBackendError('SECRET_TOO_LARGE');
  const server = net.createServer({ pauseOnConnect: true });
  let child;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath, resolve);
    });
    const helper = await encodedHelper();
    const childEnv = {
      SystemRoot: env.SystemRoot ?? env.WINDIR,
      WINDIR: env.WINDIR ?? env.SystemRoot,
      TEMP: env.TEMP,
      TMP: env.TMP,
      CODEX_CREDENTIAL_PIPE: pipeName,
      CODEX_CREDENTIAL_NONCE: pipeNonce,
    };
    child = spawnImpl(powershellPath(env), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', helper,
    ], { env: childEnv, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CredentialBackendError('TIMEOUT')), timeoutMs);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      child.once('error', () => finish(new CredentialBackendError('HELPER_START_FAILED')));
      child.once('exit', (code) => {
        if (code !== 0) finish(new CredentialBackendError(`HELPER_FAILED_${Number(code) || 'UNKNOWN'}`));
      });
      server.on('connection', (socket) => {
        socket.setEncoding('utf8');
        let output = '';
        let authenticated = false;
        socket.on('data', (chunk) => {
          output += chunk;
          if (Buffer.byteLength(output) > 16 * 1024) finish(new CredentialBackendError('INVALID_RESPONSE'));
          const newline = output.indexOf('\n');
          if (newline < 0) return;
          if (!authenticated) {
            const handshake = output.slice(0, newline).replace(/\r$/u, '');
            const received = Buffer.from(handshake, 'utf8');
            const expected = Buffer.from(pipeNonce, 'utf8');
            authenticated = received.length === expected.length && crypto.timingSafeEqual(received, expected);
            received.fill(0);
            expected.fill(0);
            output = output.slice(newline + 1);
            if (!authenticated) {
              socket.destroy();
              return;
            }
            socket.write(body);
            return;
          }
          try { finish(null, JSON.parse(output.slice(0, newline))); }
          catch { finish(new CredentialBackendError('INVALID_RESPONSE')); }
        });
        socket.once('error', () => finish(new CredentialBackendError('PIPE_FAILURE')));
        socket.resume();
      });
    });
    return classify(response);
  } finally {
    server.close();
    if (child && child.exitCode === null) child.kill();
  }
}

export function windowsCredentialTarget({ service, account, target } = {}) {
  if (target) {
    const checkedTarget = safeField(target, 'target');
    if (!checkedTarget.startsWith('codex-third-party-subagents')) {
      throw new CredentialBackendError('INVALID_TARGET_NAMESPACE');
    }
    return checkedTarget;
  }
  const checkedService = safeField(service, 'service', 128);
  const checkedAccount = safeField(account, 'account', 256);
  const accountHash = crypto.createHash('sha256').update(checkedAccount).digest('hex').slice(0, 32);
  return `codex-third-party-subagents:${checkedService}:${accountHash}`;
}

export async function storeWindowsCredential(options = {}) {
  const invoke = options.invokeImpl ?? invokeWindowsCredentialOperation;
  const secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(String(options.secret ?? ''));
  if (secret.length < 1 || secret.length > 2560) throw new CredentialBackendError('INVALID_SECRET_SIZE');
  const target = windowsCredentialTarget(options);
  try {
    await invoke({
      operation: 'write',
      target,
      username: safeField(options.account ?? os.userInfo().username, 'account'),
      secret: secret.toString('base64'),
    }, options);
    return Object.freeze({ backend: 'windows-credential-manager', target });
  } finally {
    secret.fill(0);
  }
}

export async function retrieveWindowsCredential(options = {}) {
  const invoke = options.invokeImpl ?? invokeWindowsCredentialOperation;
  const response = await invoke({
    operation: 'read',
    target: windowsCredentialTarget(options),
  }, options);
  if (typeof response.secret !== 'string') throw new CredentialBackendError('INVALID_RESPONSE');
  return Buffer.from(response.secret, 'base64');
}

export async function deleteWindowsCredential(options = {}) {
  const invoke = options.invokeImpl ?? invokeWindowsCredentialOperation;
  try {
    await invoke({ operation: 'delete', target: windowsCredentialTarget(options) }, options);
    return true;
  } catch (error) {
    if (error?.code === 'NOT_FOUND') return false;
    throw error;
  }
}

export async function windowsCredentialReady(options = {}) {
  let secret;
  try {
    secret = await retrieveWindowsCredential(options);
    return secret.length > 0;
  } catch (error) {
    if (error?.code === 'NOT_FOUND') return false;
    throw error;
  } finally {
    secret?.fill(0);
  }
}

export function classifyWindowsCredentialError(error) {
  return error instanceof CredentialBackendError ? error.code : 'NATIVE_FAILURE';
}
