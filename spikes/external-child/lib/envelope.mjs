import path from 'node:path';
import { writePrivateFile } from './fs-safety.mjs';

const MODES = new Set(['identity', 'read', 'coding']);
const REQUIRED_STRINGS = ['taskName', 'cwd', 'message', 'providerId', 'providerRole', 'model'];

function safeRelativeFile(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`)
    && normalized === value;
}

export function validateTaskEnvelope(envelope, { fixtureRoot } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('task envelope must be an object');
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof envelope[field] !== 'string' || !envelope[field].trim()) {
      throw new Error(`${field} is required`);
    }
  }
  if (!/^[A-Za-z0-9._-]{1,96}$/u.test(envelope.taskName)) throw new Error('taskName is invalid');
  if (!MODES.has(envelope.mode)) throw new Error('task mode is invalid');
  if (envelope.providerId !== 'deepseek'
    || envelope.providerRole !== 'deepseek_worker'
    || envelope.model !== 'deepseek-v4-flash') {
    throw new Error('task provider identity must be DeepSeek V4 Flash');
  }
  if (!path.isAbsolute(envelope.cwd)) throw new Error('task cwd must be absolute');
  if (fixtureRoot) {
    const relative = path.relative(path.resolve(fixtureRoot), path.resolve(envelope.cwd));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('task cwd escapes the fixture root');
    }
  }
  if (!Array.isArray(envelope.expectedScope)
    || envelope.expectedScope.some((value) => !safeRelativeFile(value))) {
    throw new Error('expectedScope must contain safe relative file paths');
  }
  if (!Array.isArray(envelope.acceptanceCriteria)
    || envelope.acceptanceCriteria.length === 0
    || envelope.acceptanceCriteria.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('acceptanceCriteria must contain non-empty strings');
  }
  if (envelope.message.length > 4000) throw new Error('task message is too large');
  return envelope;
}

export async function writeTaskEnvelope(tasksDir, envelope, options = {}) {
  validateTaskEnvelope(envelope, options);
  const filePath = path.join(tasksDir, `${envelope.taskName}.json`);
  await writePrivateFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, { exclusive: true });
  return filePath;
}

export function promptForEnvelope(envelope) {
  validateTaskEnvelope(envelope, { fixtureRoot: envelope.cwd });
  const mutationRule = envelope.mode === 'coding'
    ? 'Modify only files listed in expectedScope. Run the requested local test.'
    : 'Do not modify any file.';
  return [
    'You are an isolated external Codex child executing one bounded task.',
    'Treat the JSON envelope below as the complete task. Do not infer missing context.',
    'Do not inspect paths outside cwd. Do not use network, browser, desktop, MCP, plugins, skills, or subagents.',
    'Never read or print credentials. Preserve all unrelated files.',
    mutationRule,
    'Return only the JSON object required by the provided output schema.',
    'The providerId and model fields in that result repeat the requested tuple; they are not identity proof.',
    '',
    JSON.stringify(envelope, null, 2),
    '',
  ].join('\n');
}

export function expectedScopeIsRespected(diff, expectedScope) {
  const touched = [...diff.added, ...diff.deleted, ...diff.changed];
  return touched.every((file) => expectedScope.includes(file));
}
