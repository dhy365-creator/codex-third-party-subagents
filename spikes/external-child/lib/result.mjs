import path from 'node:path';
import { writePrivateFile } from './fs-safety.mjs';

export const RESULT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['taskName', 'status', 'providerId', 'model', 'changedFiles', 'tests', 'findings', 'summary', 'risks'],
  properties: {
    taskName: { type: 'string', minLength: 1, maxLength: 96 },
    status: { type: 'string', enum: ['completed', 'failed'] },
    providerId: { type: 'string', const: 'deepseek' },
    model: { type: 'string', const: 'deepseek-v4-flash' },
    changedFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    tests: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
});

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a string array`);
  }
}

function safeRelative(value) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

export function validateResultEnvelope(result, task) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result must be an object');
  const expectedKeys = Object.keys(RESULT_SCHEMA.properties).sort();
  const actualKeys = Object.keys(result).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error('result fields do not match schema');
  if (result.taskName !== task.taskName) throw new Error('result taskName does not match');
  if (!['completed', 'failed'].includes(result.status)) throw new Error('result status is invalid');
  if (result.providerId !== task.providerId || result.model !== task.model) {
    throw new Error('result provider tuple does not match task');
  }
  for (const field of ['changedFiles', 'tests', 'findings', 'risks']) stringArray(result[field], field);
  if (result.changedFiles.some((file) => !safeRelative(file))) throw new Error('result changedFiles are unsafe');
  if (new Set(result.changedFiles).size !== result.changedFiles.length) throw new Error('result changedFiles contain duplicates');
  if (typeof result.summary !== 'string') throw new Error('result summary must be a string');
  if (task.mode !== 'coding' && result.changedFiles.length) throw new Error('read-only result reports changed files');
  return result;
}

export function parseResultEnvelope(text, task) {
  let result;
  try {
    result = JSON.parse(String(text));
  } catch {
    throw new Error('result is not valid JSON');
  }
  return validateResultEnvelope(result, task);
}

export async function writeResultSchema(evidenceDir) {
  const filePath = path.join(evidenceDir, 'result.schema.json');
  await writePrivateFile(filePath, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`);
  return filePath;
}
