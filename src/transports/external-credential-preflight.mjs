import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedChildEnvironment, resolveExecutable } from './external-process.mjs';
import { validateExternalUserHome } from './external-user-home.mjs';

const execFile = promisify(execFileCallback);
const ASCII_WHITESPACE = new Set([9, 10, 11, 12, 13, 32]);

function safeFailure(exitCode, metadata = {}) {
  const error = new Error('command-backed credential preflight failed');
  error.code = 'EXTERNAL_CREDENTIAL_PREFLIGHT_FAILED';
  error.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  Object.assign(error, metadata);
  return error;
}

function inspectAndDiscard(output) {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(String(output ?? ''));
  const present = buffer.length > 0;
  let start = 0;
  let end = buffer.length;
  while (start < end && ASCII_WHITESPACE.has(buffer[start])) start += 1;
  while (end > start && ASCII_WHITESPACE.has(buffer[end - 1])) end -= 1;
  const metadata = {
    credentialPresent: present,
    credentialNonEmpty: end > start,
    normalizationApplied: start !== 0 || end !== buffer.length,
  };
  buffer.fill(0);
  return metadata;
}

function discardErrorOutput(error) {
  for (const name of ['stdout', 'stderr']) {
    if (Buffer.isBuffer(error?.[name])) error[name].fill(0);
  }
}

export async function preflightExternalCredential({
  credentialCommand,
  codexPath,
  codexHome,
  tmpDir,
  userHome,
  sourceEnv,
  execFileImpl = execFile,
  platform = process.platform,
} = {}) {
  const [codexExecutable, credentialExecutable, validatedUserHome] = await Promise.all([
    resolveExecutable(codexPath, { platform }),
    resolveExecutable(credentialCommand?.command, { platform }),
    validateExternalUserHome(userHome, { platform }),
  ]);
  const env = isolatedChildEnvironment({
    codexHome,
    tmpDir,
    userHome: validatedUserHome,
    executablePaths: [codexExecutable, credentialExecutable],
    sourceEnv,
    platform,
  });
  let stdout;
  try {
    ({ stdout } = await execFileImpl(credentialExecutable, credentialCommand.args, {
      env,
      encoding: null,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    discardErrorOutput(error);
    throw safeFailure(error?.code);
  }
  const metadata = inspectAndDiscard(stdout);
  stdout = null;
  if (!metadata.credentialNonEmpty) throw safeFailure(0, metadata);
  return Object.freeze({ exitCode: 0, ...metadata });
}
