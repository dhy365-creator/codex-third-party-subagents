import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  deleteCredential,
  retrieveCredential,
  storeCredential,
} from '../src/credentials.mjs';
import { createProcessTreeSupervisor } from '../src/transports/external-process.mjs';

const nativeWindows = process.platform === 'win32';
const nativeSkip = nativeWindows ? false : 'SKIP_NON_WINDOWS: requires native Windows product primitives';
const fixturePath = fileURLToPath(new URL('./fixtures/windows-process-tree-child.mjs', import.meta.url));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function readJsonLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('process-tree fixture startup timed out')),
      5000,
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      output += String(chunk);
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try { finish(null, JSON.parse(output.slice(0, newline))); }
      catch (error) { finish(error); }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`process-tree fixture exited early: ${code}`)));
  });
}

test('native Windows Credential Manager round-trip uses a synthetic scoped secret and cleans up', {
  skip: nativeSkip,
}, async (t) => {
  const target = `codex-third-party-subagents-acceptance-${crypto.randomUUID()}`;
  const source = crypto.randomBytes(32);
  let stored = false;
  t.after(async () => {
    if (stored) await deleteCredential({ platform: 'win32', target }).catch(() => {});
    source.fill(0);
  });

  await storeCredential({
    platform: 'win32', target, account: 'synthetic-acceptance', secret: source,
  });
  stored = true;
  const retrieved = await retrieveCredential({ platform: 'win32', target });
  try {
    assert.equal(crypto.timingSafeEqual(source, retrieved), true);
  } finally {
    retrieved.fill(0);
  }
  assert.equal(await deleteCredential({ platform: 'win32', target }), true);
  stored = false;
  assert.equal(await deleteCredential({ platform: 'win32', target }), false);
});

test('production Windows supervisor terminates a repository-owned descendant tree', {
  skip: nativeSkip,
}, async (t) => {
  const child = spawn(process.execPath, [fixturePath], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const supervisor = createProcessTreeSupervisor(child.pid);
  let childPid;
  t.after(async () => {
    await supervisor.terminate(true).catch(() => {});
    if (childPid && pidAlive(childPid)) {
      await createProcessTreeSupervisor(childPid).terminate(true).catch(() => {});
    }
  });
  const started = await readJsonLine(child);
  childPid = started.childPid;
  assert.equal(started.parentPid, child.pid);
  assert.equal(await supervisor.isAlive(), true);
  assert.equal(pidAlive(childPid), true);
  assert.equal(await supervisor.terminate(true), true);
  assert.equal(await waitFor(async () => !(await supervisor.isAlive())), true);
  assert.equal(await waitFor(() => !pidAlive(childPid)), true);
});

test('native Codex auth-command consumption remains a later reviewed runtime gate', {
  skip: 'SKIP_UNSUPPORTED_NATIVE_GATE: exact supported Windows Codex runtime contract is not established',
}, () => {});

test('Provider-backed Windows execution and attribution remain unauthorized', {
  skip: 'SKIP_UNSUPPORTED_NATIVE_GATE: Phase 2C live Provider request is not authorized',
}, () => {});
