import fs from 'node:fs/promises';
import path from 'node:path';
import { writePrivateFile } from './fs-safety.mjs';

const PACKAGE_JSON = `${JSON.stringify({
  name: 'external-child-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test' },
}, null, 2)}\n`;

const BUGGY_SOURCE = `export function average(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
`;

const TEST_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { average } from '../src/math.js';

test('average returns the arithmetic mean', () => {
  assert.equal(average([2, 4, 6]), 4);
});

test('average of an empty list is zero', () => {
  assert.equal(average([]), 0);
});
`;

export async function createFixture(workspaceDir) {
  const root = path.join(path.resolve(workspaceDir), 'fixture');
  await fs.mkdir(path.join(root, 'src'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'test'), { recursive: true, mode: 0o700 });
  await writePrivateFile(path.join(root, 'package.json'), PACKAGE_JSON);
  await writePrivateFile(path.join(root, 'src', 'math.js'), BUGGY_SOURCE);
  await writePrivateFile(path.join(root, 'test', 'math.test.js'), TEST_SOURCE);
  return root;
}
