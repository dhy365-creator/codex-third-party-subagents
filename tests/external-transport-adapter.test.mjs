import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTERNAL_ERROR_CODES } from '../src/transports/external-codex.mjs';
import { containsSensitiveText } from '../src/transports/external-evidence.mjs';
import { createExternalTransportFixture } from './helpers/external-transport-fixture.mjs';

async function executeAndCollect(fixture, request = fixture.request()) {
  const prepared = await fixture.adapter.prepare(request, fixture.context);
  const execution = await fixture.adapter.execute(prepared);
  const collection = await fixture.adapter.collect(execution);
  return { prepared, execution, collection };
}

test('adapter prepare/execute/collect/cleanup returns a closed result while runtime verification stays false', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  for (const method of ['describe', 'prepare', 'execute', 'cancel', 'collect', 'cleanup']) {
    assert.equal(typeof fixture.adapter[method], 'function');
  }
  const run = await executeAndCollect(fixture);
  assert.equal(run.collection.outcome, 'completed');
  const final = await fixture.adapter.cleanup(run.execution);
  assert.equal(final.result.status, 'completed');
  assert.equal(final.result.lifecycle.state, 'closed');
  assert.equal(final.result.lifecycle.activeSlotReleased, true);
  assert.equal(final.result.lifecycle.orphanDetected, false);
  assert.equal(final.evidence.providerResolved, true);
  assert.equal(final.evidence.taskDelivered, true);
  assert.equal(final.evidence.runtimeExecuted, true);
  assert.equal(final.evidence.runtimeVerified, false);
  assert.equal(final.evidence.credentialReady, null);
  assert.equal(final.evidence.ready, false);
  assert.equal(final.evidenceDetails.providerEvidence.source, 'test-fixture:external-runtime');
  assert.equal(final.evidenceDetails.providerEvidence.confidence, 'verified');
  assert.equal(final.evidenceDetails.toolEvidence.confidence, 'verified');
  assert.equal(final.evidenceDetails.lifecycleEvidence.confidence, 'verified');
  assert.equal(Object.values(final.evidenceDetails).every((item) => !path.isAbsolute(item.sanitizedReference)), true);
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));

  const archiveName = final.archiveRef.ref.replace(/^archive:/u, '');
  const archivePath = path.join(fixture.executionRoot(run.prepared.executionId), 'archive', archiveName);
  const archive = await fs.readFile(archivePath, 'utf8');
  assert.match(archive, /"cwd": "\[REDACTED\]"/u);
  assert.match(archive, /"message": "\[REDACTED\]"/u);
  assert.doesNotMatch(archive, /Inspect the bounded local fixture/u);
  assert.equal(containsSensitiveText(archive), false);
  assert.equal((await fs.lstat(archivePath)).mode & 0o777, 0o600);
  assert.equal(await fixture.adapter.cleanup(run.execution), final);
  await fs.access(archivePath);
});

test('workspace-write accepts only the declared changed file', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'success-write' });
  const run = await executeAndCollect(fixture, fixture.request({
    permissionProfile: 'workspace-write',
    expectedScope: ['output.txt'],
  }));
  const final = await fixture.adapter.cleanup(run.execution);
  assert.equal(final.result.status, 'completed');
  assert.deepEqual(final.result.changedFiles, ['output.txt']);
  assert.equal(await fs.readFile(path.join(fixture.cwd, 'output.txt'), 'utf8'), 'fixture output\n');
});

test('single-slot acquisition returns EXTERNAL_CHILD_BUSY without overwriting the active task', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const first = await fixture.adapter.prepare(fixture.request({ taskName: 'first-task' }), fixture.context);
  const activePath = path.join(fixture.stateRoot, 'active.json');
  const before = await fs.readFile(activePath, 'utf8');
  await assert.rejects(
    fixture.adapter.prepare(fixture.request({ taskName: 'second-task' }), fixture.context),
    (error) => error.code === EXTERNAL_ERROR_CODES.BUSY,
  );
  assert.equal(await fs.readFile(activePath, 'utf8'), before);
  const execution = await fixture.adapter.execute(first);
  await fixture.adapter.collect(execution);
  await fixture.adapter.cleanup(execution);
  await assert.rejects(fs.access(activePath));
});

test('malformed, oversized, spoofed, secret, and out-of-scope child outputs fail closed', async (t) => {
  const cases = [
    'reported-failure',
    'exit-failure',
    'malformed-result',
    'oversized-result',
    'scope-claim',
    'secret-result',
    'secret-stdout',
    'wrong-provider',
    'wrong-model',
    'missing-evidence',
    'malformed-evidence',
    'external-write',
  ];
  for (const mode of cases) {
    await t.test(mode, async (subtest) => {
      const fixture = await createExternalTransportFixture(subtest, { mode });
      const run = await executeAndCollect(fixture);
      const final = await fixture.adapter.cleanup(run.execution);
      assert.equal(final.result.status, 'failed');
      assert.equal(final.evidence.runtimeVerified, false);
      await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
      if (mode === 'secret-stdout') {
        const log = await fs.readFile(
          path.join(fixture.executionRoot(run.prepared.executionId), 'logs', 'stdout.jsonl'),
          'utf8',
        );
        assert.doesNotMatch(log, /Bearer\s+b/u);
        assert.match(log, /diagnostic\.redacted/u);
      }
    });
  }
});

test('archive collision never overwrites evidence or releases the active slot', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const run = await executeAndCollect(fixture);
  const archivePath = path.join(
    fixture.executionRoot(run.prepared.executionId),
    'archive',
    `completed-${run.prepared.executionId}.json`,
  );
  await fs.writeFile(archivePath, 'existing immutable archive\n', { mode: 0o600 });
  await assert.rejects(
    fixture.adapter.cleanup(run.execution),
    (error) => error.code === EXTERNAL_ERROR_CODES.CLEANUP,
  );
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'existing immutable archive\n');
  await fs.access(path.join(fixture.stateRoot, 'active.json'));
});
