import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_FLASH_FEATURE_GATE } from '../src/external-flash-gate.mjs';
import { runExternalFlashProductionE2E } from '../src/external-flash-runtime.mjs';
import { readExternalFlashEvidence } from '../src/external-evidence-store.mjs';
import { readExternalLiveRequestLedger } from '../src/external-live-request-ledger.mjs';
import { createExternalTransportFixture } from './helpers/external-transport-fixture.mjs';

const fixtureCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog.json',
);

test('production runner uses one gated fake request and persists strict local evidence', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  const result = await runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: fixtureCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'phase3-test-authorization',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
    credentialPreflightExecFileImpl: async () => ({ stdout: Buffer.from('fixture-value\n') }),
  });
  assert.equal(result.requestCount, 1);
  assert.equal(result.providerId, 'deepseek');
  assert.equal(result.model, 'deepseek-v4-flash');
  assert.equal(result.taskDelivered, true);
  assert.equal(result.runtimeExecuted, true);
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.challengeVerified, true);
  const ledger = await readExternalLiveRequestLedger(fixture.stateRoot);
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].outcome, 'completed');
  assert.equal((await readExternalFlashEvidence(fixture.stateRoot)).runtimeVerified, true);
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
});

test('production runner blocks before a request when authorization is absent', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  await assert.rejects(runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: fixtureCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'phase3-test-authorization',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: false,
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
    credentialPreflightExecFileImpl: async () => ({ stdout: Buffer.from('fixture-value\n') }),
  }), /authorization/u);
  assert.equal((await readExternalLiveRequestLedger(fixture.stateRoot)).attempts.length, 0);
});

test('production runner archives and releases the slot when launch validation fails', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  await assert.rejects(runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: fixtureCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'phase3-test-authorization',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
    credentialPreflightExecFileImpl: async () => ({ stdout: Buffer.from('fixture-value\n') }),
    outputLimits: { stdoutBytes: 0, stderrBytes: 1024 },
  }), /execution failed/u);
  const ledger = await readExternalLiveRequestLedger(fixture.stateRoot);
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].outcome, 'failed');
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
});

test('failed child-context credential preflight does not increment ledger or launch child', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  await assert.rejects(runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: fixtureCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'phase3-test-authorization',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
    credentialPreflightExecFileImpl: async () => {
      const error = new Error('secret-bearing provider output must be discarded');
      error.code = 44;
      error.stdout = Buffer.from('must-not-survive');
      throw error;
    },
  }), /preparation failed/u);
  assert.equal((await readExternalLiveRequestLedger(fixture.stateRoot)).attempts.length, 0);
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
  const files = await fs.readdir(path.join(fixture.stateRoot, 'executions'), { recursive: true });
  assert.equal(files.some((name) => name.endsWith('capture.json')), false);
  assert.equal(files.some((name) => name.includes('must-not-survive')), false);
});
