import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_FLASH_FEATURE_GATE } from '../src/external-flash-gate.mjs';
import { runExternalFlashProductionE2E } from '../src/external-flash-runtime.mjs';
import { readExternalFlashEvidence } from '../src/external-evidence-store.mjs';
import {
  beginExternalLiveRequest,
  finishExternalLiveRequest,
  readExternalLiveRequestLedger,
} from '../src/external-live-request-ledger.mjs';
import { createExternalTransportFixture } from './helpers/external-transport-fixture.mjs';

const fixtureCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'production-catalog.json',
);
const incompleteCatalog = path.join(
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
  assert.deepEqual(result.credentialPreflight, {
    exitCode: 0,
    credentialPresent: true,
    credentialNonEmpty: true,
    normalizationApplied: true,
  });
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

test('production runner rejects an incomplete catalog before permit, ledgers, slot, or execution', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  await assert.rejects(runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: incompleteCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'catalog-contract-regression',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
  }), (error) => error.code === 'PRODUCTION_CATALOG_INVALID');
  assert.equal((await readExternalLiveRequestLedger(fixture.stateRoot)).attempts.length, 0);
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'executions')));
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'verified-evidence', 'deepseek-v4-flash.latest.json')));
});

test('strict evidence is bound to one runtime root and rejects cross-fixture copying', async (t) => {
  const source = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  const target = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  await runExternalFlashProductionE2E({
    stateRoot: source.stateRoot,
    codexPath: source.codexPath,
    catalogSource: fixtureCatalog,
    cwd: source.cwd,
    approvedRoot: source.approvedRoot,
    parentCodexHome: source.parentCodexHome,
    authorizationId: 'bound-evidence-test',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: source.base }),
    credentialPreflightExecFileImpl: async () => ({ stdout: Buffer.from('fixture-value\n') }),
  });
  const sourceEvidence = path.join(source.stateRoot, 'verified-evidence');
  const targetEvidence = path.join(target.stateRoot, 'verified-evidence');
  await fs.mkdir(targetEvidence, { recursive: true, mode: 0o700 });
  await fs.copyFile(
    path.join(sourceEvidence, 'deepseek-v4-flash.latest.json'),
    path.join(targetEvidence, 'deepseek-v4-flash.latest.json'),
  );
  await fs.chmod(path.join(targetEvidence, 'deepseek-v4-flash.latest.json'), 0o600);
  await assert.rejects(readExternalFlashEvidence(target.stateRoot), /identity/u);
  await fs.copyFile(path.join(sourceEvidence, '.installation-id'), path.join(targetEvidence, '.installation-id'));
  await fs.chmod(path.join(targetEvidence, '.installation-id'), 0o600);
  await assert.rejects(readExternalFlashEvidence(target.stateRoot), /another runtime root/u);
});

test('production runner mirrors one request into a clean fixture while advancing the billing ledger', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'phase3-challenge' });
  const billingLedgerRoot = path.join(fixture.base, 'billing-ledger');
  for (let index = 0; index < 2; index += 1) {
    const attempt = await beginExternalLiveRequest(billingLedgerRoot, { purpose: `historical-${index + 1}` });
    await finishExternalLiveRequest(billingLedgerRoot, attempt.number, {
      outcome: index === 0 ? 'failed' : 'completed',
    });
  }
  const result = await runExternalFlashProductionE2E({
    stateRoot: fixture.stateRoot,
    billingLedgerRoot,
    codexPath: fixture.codexPath,
    catalogSource: fixtureCatalog,
    cwd: fixture.cwd,
    approvedRoot: fixture.approvedRoot,
    parentCodexHome: fixture.parentCodexHome,
    authorizationId: 'clean-install-test-authorization',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    keychainAccount: 'fixture-user',
    keychainReadyImpl: async () => true,
    userInfoImpl: () => ({ username: 'fixture-user', uid: process.getuid(), homedir: fixture.base }),
    credentialPreflightExecFileImpl: async () => ({ stdout: Buffer.from('fixture-value\n') }),
  });
  assert.equal(result.requestCount, 3);
  assert.equal(result.fixtureRequestCount, 1);
  assert.deepEqual(
    (await readExternalLiveRequestLedger(billingLedgerRoot)).attempts.map((item) => item.outcome),
    ['failed', 'completed', 'completed'],
  );
  assert.deepEqual(
    (await readExternalLiveRequestLedger(fixture.stateRoot)).attempts.map((item) => item.outcome),
    ['completed'],
  );
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
