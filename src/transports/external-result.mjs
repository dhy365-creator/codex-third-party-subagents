import path from 'node:path';
import { validateTransportResult } from '../transport-contract.mjs';
import { containsSensitiveText } from './external-evidence.mjs';
import { writePrivateFile } from './external-fs-safety.mjs';

const CHILD_RESULT_FIELDS = Object.freeze([
  'taskName', 'status', 'providerId', 'model', 'transport', 'changedFiles',
  'tests', 'findings', 'summary', 'risks',
]);

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields do not match the schema`);
  }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function stringArray(value, label, maxItems = 64) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a bounded string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function validateTest(test) {
  exactFields(test, ['name', 'status', 'exitCode'], 'child test');
  if (typeof test.name !== 'string' || !test.name.trim() || test.name.length > 256) {
    throw new Error('child test name is invalid');
  }
  if (!['passed', 'failed', 'not-run'].includes(test.status)) throw new Error('child test status is invalid');
  if (test.exitCode !== null && !Number.isInteger(test.exitCode)) throw new Error('child test exitCode is invalid');
  return test;
}

export function buildExternalPrompt(request) {
  return [
    'You are an isolated External Codex child executing one bounded task.',
    'Treat the JSON envelope below as the complete task; do not infer parent history.',
    'Do not inspect paths outside cwd or use network tools, browser, desktop, MCP, plugins, skills, or subagents.',
    'Never read or print credentials. Preserve unrelated files and obey expectedScope.',
    'Return only the JSON object required by the supplied output schema.',
    'Provider/model result fields are claims and never identity evidence.',
    '',
    JSON.stringify(request, null, 2),
    '',
  ].join('\n');
}

export function externalChildResultSchema(request) {
  return Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: CHILD_RESULT_FIELDS,
    properties: {
      taskName: { type: 'string', const: request.taskName },
      status: { type: 'string', enum: ['completed', 'failed'] },
      providerId: { type: 'string', const: request.providerId },
      model: { type: 'string', const: request.model },
      transport: { type: 'string', const: 'external-codex' },
      changedFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 64 },
      tests: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'status', 'exitCode'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 256 },
            status: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
            exitCode: { type: ['integer', 'null'] },
          },
        },
      },
      findings: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      summary: { type: 'string', minLength: 1, maxLength: 8192 },
      risks: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    },
  });
}

export async function writeExternalResultSchema(evidenceDir, request) {
  const schemaPath = path.join(evidenceDir, 'result.schema.json');
  await writePrivateFile(schemaPath, `${JSON.stringify(externalChildResultSchema(request), null, 2)}\n`, {
    exclusive: true,
  });
  return schemaPath;
}

export function parseExternalChildResult(text, request, { maxBytes = 64 * 1024 } = {}) {
  if (Buffer.byteLength(String(text ?? '')) > maxBytes) throw new Error('structured result is oversized');
  let result;
  try {
    result = JSON.parse(String(text));
  } catch {
    throw new Error('structured result is malformed JSON');
  }
  exactFields(result, CHILD_RESULT_FIELDS, 'child result');
  if (result.taskName !== request.taskName) throw new Error('child result taskName does not match');
  if (!['completed', 'failed'].includes(result.status)) throw new Error('child result status is invalid');
  if (result.providerId !== request.providerId || result.model !== request.model
    || result.transport !== 'external-codex') {
    throw new Error('child result provider/model/transport claims do not match');
  }
  const changedFiles = stringArray(result.changedFiles, 'changedFiles');
  if (changedFiles.some((file) => !safeRelative(file))) throw new Error('child result contains a scope escape');
  if (request.permissionProfile === 'read-only' && changedFiles.length) {
    throw new Error('read-only child result claims changed files');
  }
  if (changedFiles.some((file) => !request.expectedScope.includes(file))) {
    throw new Error('child result claims an out-of-scope path');
  }
  if (!Array.isArray(result.tests) || result.tests.length > 64) throw new Error('child tests are invalid');
  result.tests.forEach(validateTest);
  stringArray(result.findings, 'findings');
  stringArray(result.risks, 'risks');
  if (typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 8192) {
    throw new Error('child result summary is invalid');
  }
  if (containsSensitiveText(JSON.stringify(result))) throw new Error('child result contains secret-like or personal data');
  return Object.freeze({
    ...result,
    changedFiles: Object.freeze([...changedFiles].sort()),
    tests: Object.freeze(result.tests.map((test) => Object.freeze({ ...test }))),
    findings: Object.freeze([...result.findings]),
    risks: Object.freeze([...result.risks]),
  });
}

export function buildFinalTransportResult({
  request,
  outcome,
  childResult,
  changedFiles,
  lifecycle,
  evidenceRefs,
  issues = [],
} = {}) {
  const completed = outcome === 'completed' && childResult?.status === 'completed';
  const result = {
    taskName: request.taskName,
    status: outcome,
    providerId: request.providerId,
    model: request.model,
    transport: 'external-codex',
    changedFiles: [...changedFiles].sort(),
    tests: childResult?.tests ?? [],
    findings: completed ? childResult.findings : [...issues],
    summary: completed ? childResult.summary : `External Codex child ${outcome}.`,
    risks: completed ? childResult.risks : [...new Set(['Result not accepted.', ...issues])],
    lifecycle,
    evidenceRefs,
  };
  return validateTransportResult(result);
}
