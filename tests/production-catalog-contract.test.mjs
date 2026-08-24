import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_CATALOG_CONTRACT,
  validateProductionCatalog,
} from '../src/production-catalog-contract.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const options = {
  codexVersion: '0.149.0',
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  requiredModalities: new Set(['text']),
  outputModalities: new Set(['text']),
};

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixtureDir, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rejectsSafely(document, field) {
  assert.throws(
    () => validateProductionCatalog(document, options),
    (error) => {
      assert.equal(error.code, 'PRODUCTION_CATALOG_INVALID');
      assert.match(error.message, new RegExp(field, 'u'));
      assert.doesNotMatch(error.message, /\/Users|secret-value|Sensitive display/u);
      return true;
    },
  );
}

test('synthetic complete catalog satisfies the exact Codex 0.149 production contract', async () => {
  const document = await fixture('production-catalog.json');
  const reduced = validateProductionCatalog(document, options);
  assert.equal(reduced.models.length, 1);
  assert.equal(reduced.models[0].slug, PRODUCTION_CATALOG_CONTRACT.model);
});

test('minimal fixture and byte-identical renamed copy are rejected semantically', async () => {
  const minimal = await fixture('catalog.json');
  rejectsSafely(minimal, 'support_verbosity');
  const renamed = clone(minimal);
  renamed.source_name = 'complete-production-catalog.json';
  rejectsSafely(renamed, 'support_verbosity');
});

test('every discovered required top-level field fails closed when missing', async () => {
  const complete = await fixture('production-catalog.json');
  for (const field of PRODUCTION_CATALOG_CONTRACT.requiredFields) {
    const document = clone(complete);
    delete document.models[0][field];
    rejectsSafely(document, field === 'slug' ? 'models' : field);
  }
});

test('nested, duplicate, modality, and instruction constraints fail closed', async () => {
  const complete = await fixture('production-catalog.json');
  const cases = [
    ['truncation_policy.mode', (model) => { delete model.truncation_policy.mode; }],
    ['truncation_policy.limit', (model) => { model.truncation_policy.limit = 0; }],
    ['supported_reasoning_levels', (model) => { delete model.supported_reasoning_levels[0].description; }],
    ['input_modalities', (model) => { model.input_modalities = ['image']; }],
    ['instructions', (model) => { delete model.base_instructions; }],
  ];
  for (const [field, mutate] of cases) {
    const document = clone(complete);
    mutate(document.models[0]);
    rejectsSafely(document, field);
  }
  const duplicate = clone(complete);
  duplicate.models.push(clone(duplicate.models[0]));
  rejectsSafely(duplicate, 'models');
});

test('errors do not include untrusted catalog content', async () => {
  const document = await fixture('production-catalog.json');
  document.models[0].display_name = `Sensitive display secret-value ${['', 'Users', 'private'].join('/')}`;
  document.models[0].support_verbosity = 'secret-value';
  rejectsSafely(document, 'support_verbosity');
});
