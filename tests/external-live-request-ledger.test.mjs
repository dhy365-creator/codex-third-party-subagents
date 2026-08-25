import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  beginExternalLiveRequest,
  finishExternalLiveRequest,
  readExternalLiveRequestLedger,
} from '../src/external-live-request-ledger.mjs';

test('live-request ledger is owner-only, monotonic, and enforces the hard ceiling', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'external-live-ledger-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.chmod(base, 0o700);
  for (let number = 1; number <= 3; number += 1) {
    const attempt = await beginExternalLiveRequest(base, { now: new Date(`2026-08-24T00:00:0${number}.000Z`) });
    assert.equal(attempt.number, number);
    await finishExternalLiveRequest(base, number, {
      outcome: number === 1 ? 'completed' : 'failed',
      evidenceId: number === 1 ? 'a'.repeat(64) : null,
      now: new Date(`2026-08-24T00:01:0${number}.000Z`),
    });
  }
  const ledger = await readExternalLiveRequestLedger(base);
  assert.equal(ledger.attempts.length, 3);
  assert.equal(ledger.attempts[0].outcome, 'completed');
  assert.equal(ledger.attempts[1].outcome, 'failed');
  await assert.rejects(beginExternalLiveRequest(base), /ceiling/u);
  const info = await fs.lstat(path.join(base, 'deepseek-flash-live-request-ledger.json'));
  assert.equal(info.mode & 0o777, 0o600);
});

test('unsafe or malformed ledger data fails closed', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'external-live-ledger-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.chmod(base, 0o700);
  const file = path.join(base, 'deepseek-flash-live-request-ledger.json');
  await fs.writeFile(file, '{"schemaVersion":1}', { mode: 0o600 });
  await assert.rejects(readExternalLiveRequestLedger(base), /fields/u);
});
