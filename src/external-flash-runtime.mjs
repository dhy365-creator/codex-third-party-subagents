import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EXTERNAL_FLASH_FEATURE_GATE,
  EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
  createExternalFlashExecutionPermit,
} from './external-flash-gate.mjs';
import {
  beginExternalLiveRequest,
  finishExternalLiveRequest,
  readExternalLiveRequestLedger,
} from './external-live-request-ledger.mjs';
import { writeExternalFlashEvidence } from './external-evidence-store.mjs';
import { keychainReady } from './keychain.mjs';
import { resolveProviderPack } from './provider-packs.mjs';
import { PERMISSION_PROFILES, TRANSPORTS } from './transport-contract.mjs';
import { createExternalCodexTransport } from './transports/external-codex.mjs';
import { resolveExternalUserHome } from './transports/external-user-home.mjs';
import {
  assertPrivateTree,
  ensurePrivateDirectory,
  lstatIfExists,
  sha256,
} from './transports/external-fs-safety.mjs';

const execFile = promisify(execFileCallback);

function requireAbsolute(value, label) {
  if (!path.isAbsolute(value ?? '')) throw new Error(`${label} must be absolute`);
  return value;
}

async function inspectCodexVersion(codexPath, execFileImpl = execFile) {
  const { stdout } = await execFileImpl(codexPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const match = String(stdout).match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u);
  if (!match) throw new Error('Codex CLI version could not be established');
  return match[1];
}

function challenge() {
  const value = crypto.randomBytes(8).toString('hex');
  return `challenge-${value.slice(0, 8)}-${value.slice(8)}`;
}

function canonicalRequest(cwd, authorizationId) {
  const nonce = challenge();
  const taskName = `phase3-flash-e2e-${crypto.randomBytes(6).toString('hex')}`;
  return Object.freeze({
    nonce,
    request: {
      taskName,
      cwd,
      message: [
        'Complete this deterministic read-only handshake without inspecting files or running tools.',
        `Set the structured result summary to exactly: CHALLENGE ${nonce}`,
        'Return status completed, no changed files, no findings, no risks, and no tests.',
      ].join(' '),
      providerId: 'deepseek',
      providerRole: 'deepseek_worker',
      model: 'deepseek-v4-flash',
      expectedScope: [],
      acceptanceCriteria: [
        `The summary is exactly CHALLENGE ${nonce}`,
        'No file is read or modified',
        'The exact provider/model tuple is preserved',
      ],
      permissionProfile: PERMISSION_PROFILES.READ_ONLY,
      timeoutMs: 120_000,
      explicitOnly: false,
      metadata: { authorizationId, challengeSha256: sha256(nonce) },
      transportPreference: TRANSPORTS.EXTERNAL_CODEX,
    },
  });
}

export async function runExternalFlashProductionE2E(options = {}) {
  if (process.platform !== 'darwin') throw new Error('External Flash production E2E is macOS-only');
  const stateRoot = requireAbsolute(options.stateRoot, 'stateRoot');
  const codexPath = requireAbsolute(options.codexPath, 'codexPath');
  const catalogSource = requireAbsolute(options.catalogSource, 'catalogSource');
  const cwd = requireAbsolute(options.cwd, 'cwd');
  const approvedRoot = requireAbsolute(options.approvedRoot, 'approvedRoot');
  const parentCodexHome = requireAbsolute(options.parentCodexHome, 'parentCodexHome');
  const authorizationId = String(options.authorizationId ?? '').trim();
  if (options.featureGate !== EXTERNAL_FLASH_FEATURE_GATE
    || options.runtimeRouteEnabled !== true
    || options.billableAuthorized !== true) {
    throw new Error('controlled feature gate and BILLABLE PROVIDER REQUEST authorization are required');
  }
  const pack = resolveProviderPack('deepseek', 'flash');
  const userHome = await resolveExternalUserHome({ userInfoImpl: options.userInfoImpl });
  const keychainAccount = options.keychainAccount ?? os.userInfo().username;
  const credentialReady = await (options.keychainReadyImpl ?? keychainReady)({
    account: keychainAccount,
    service: pack.keychainService,
    platform: 'darwin',
    env: options.env ?? process.env,
    execFileImpl: options.keychainExecFileImpl,
  }).then(() => true, () => false);
  if (!credentialReady) throw new Error('DeepSeek Keychain credential is not ready');
  const codexVersion = await inspectCodexVersion(codexPath, options.execFileImpl);
  await ensurePrivateDirectory(stateRoot);
  const evidenceDirectory = path.join(stateRoot, 'verified-evidence');
  await ensurePrivateDirectory(evidenceDirectory);
  const privateState = await assertPrivateTree(stateRoot, { allowedExecutable: codexPath });
  if (!privateState.pass) throw new Error('External runtime root is not owner-only');
  const active = await lstatIfExists(path.join(stateRoot, 'active.json'));
  const ledger = await readExternalLiveRequestLedger(stateRoot);
  const { nonce, request } = canonicalRequest(cwd, authorizationId);
  const permit = createExternalFlashExecutionPermit({
    taskName: request.taskName,
    requestedTransport: request.transportPreference,
    providerId: request.providerId,
    providerRole: request.providerRole,
    model: request.model,
    permissionProfile: request.permissionProfile,
    featureGate: options.featureGate,
    runtimeRouteEnabled: options.runtimeRouteEnabled,
    billableAuthorized: options.billableAuthorized,
    providerExplicitlyRequested: true,
    providerSuitable: true,
    providerReady: true,
    credentialReady,
    codexVersion,
    runtimeRootReady: privateState.pass,
    evidenceDestinationReady: true,
    busy: active !== null,
    liveRequestCount: ledger.attempts.length,
    liveRequestLimit: EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
    authorizationId,
    challenge: nonce,
  });
  const adapter = createExternalCodexTransport({
    stateRoot,
    codexPath,
    catalogSource,
    credentialCommand: {
      kind: 'keychain',
      command: '/usr/bin/security',
      args: ['find-generic-password', '-a', keychainAccount, '-s', pack.keychainService, '-w'],
    },
    executionPermit: permit,
    userHome,
    sourceEnv: options.env ?? process.env,
    outputLimits: options.outputLimits,
    credentialPreflightExecFileImpl: options.credentialPreflightExecFileImpl,
    now: options.now ?? (() => new Date()),
  });
  const prepared = await adapter.prepare(request, { approvedRoot, parentCodexHome });
  let attempt = null;
  try {
    attempt = await beginExternalLiveRequest(stateRoot, {
      purpose: 'canonical production-path Flash E2E',
    });
    if (attempt.number !== permit.liveRequestNumber) throw new Error('live-request ledger and permit disagree');
    const execution = await adapter.execute(prepared);
    await adapter.collect(execution);
    const final = await adapter.cleanup(execution);
    if (final.result.status !== 'completed' || final.evidence.runtimeVerified !== true
      || final.evidence.providerResolved !== true || final.evidence.taskDelivered !== true
      || final.evidence.runtimeExecuted !== true || final.evidence.credentialReady !== true
      || final.result.summary !== `CHALLENGE ${nonce}`) {
      throw new Error('strict External Flash E2E acceptance failed');
    }
    const evidenceId = sha256(JSON.stringify(final.evidence));
    await writeExternalFlashEvidence(stateRoot, final.evidence);
    await finishExternalLiveRequest(stateRoot, attempt.number, {
      outcome: 'completed',
      evidenceId,
    });
    return Object.freeze({
      requestCount: attempt.number,
      requestLimit: EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
      providerId: final.evidence.providerId,
      model: final.evidence.model,
      transport: final.evidence.transport,
      taskDelivered: final.evidence.taskDelivered,
      runtimeExecuted: final.evidence.runtimeExecuted,
      runtimeVerified: final.evidence.runtimeVerified,
      challengeVerified: true,
      evidenceId,
      result: final.result,
      evidence: final.evidence,
      authorization: final.authorization,
    });
  } catch (error) {
    if (attempt) {
      await finishExternalLiveRequest(stateRoot, attempt.number, { outcome: 'failed' }).catch(() => {});
    }
    throw error;
  }
}
