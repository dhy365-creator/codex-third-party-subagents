import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertPrivateTree,
  tightenPrivateTree,
} from '../src/transports/external-fs-safety.mjs';

test('only reviewed Codex arg0 runtime symlinks to the exact executable are allowed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-private-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const arg0 = path.join(root, 'home', 'tmp', 'arg0', 'slot');
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'external-safe-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.mkdir(arg0, { recursive: true, mode: 0o700 });
  const codex = path.join(bin, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.symlink(codex, path.join(arg0, 'apply_patch'));
  await tightenPrivateTree(root, { allowedExecutable: codex });
  assert.equal((await assertPrivateTree(root, { allowedExecutable: codex })).pass, true);
  await fs.symlink('/bin/sh', path.join(arg0, 'codex-execve-wrapper'));
  assert.equal((await assertPrivateTree(root, { allowedExecutable: codex })).pass, false);
  await assert.rejects(tightenPrivateTree(root, { allowedExecutable: codex }), /unsafe symlink/u);
});

test('Codex package wrapper may create arg0 links to its packaged native executable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-private-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageBase = await fs.mkdtemp(path.join(os.tmpdir(), 'external-codex-package-'));
  t.after(() => fs.rm(packageBase, { recursive: true, force: true }));
  const packageRoot = path.join(packageBase, 'node_modules', '@openai', 'codex');
  const arg0 = path.join(root, 'home', 'tmp', 'arg0', 'slot');
  const wrapper = path.join(packageRoot, 'bin', 'codex.js');
  const native = path.join(packageRoot, 'vendor', 'platform', 'bin', 'codex');
  await fs.mkdir(arg0, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(wrapper), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(native), { recursive: true, mode: 0o700 });
  await fs.writeFile(wrapper, '#!/usr/bin/env node\n', { mode: 0o700 });
  await fs.writeFile(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.symlink(native, path.join(arg0, 'apply_patch'));
  await tightenPrivateTree(root, { allowedExecutable: wrapper });
  assert.equal((await assertPrivateTree(root, { allowedExecutable: wrapper })).pass, true);
});

test('state-root validation accepts reviewed arg0 links inside historical execution trees only', async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-state-root-'));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'external-safe-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const codex = path.join(bin, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const arg0 = path.join(stateRoot, 'executions', '20260824T000000000Z-aabbccddeeff0011', 'home', 'tmp', 'arg0', 'slot');
  await fs.mkdir(arg0, { recursive: true, mode: 0o700 });
  await fs.symlink(codex, path.join(arg0, 'apply_patch'));
  assert.equal((await assertPrivateTree(stateRoot, { allowedExecutable: codex })).pass, true);
  const outside = path.join(stateRoot, 'executions', 'unsafe', 'home', 'tmp', 'arg0');
  await fs.mkdir(outside, { recursive: true, mode: 0o700 });
  await fs.symlink(codex, path.join(outside, 'apply_patch'));
  assert.equal((await assertPrivateTree(stateRoot, { allowedExecutable: codex })).pass, false);
});
