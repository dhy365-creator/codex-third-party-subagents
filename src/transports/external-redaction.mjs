import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './external-fs-safety.mjs';

const CREDENTIAL_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{20,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/giu,
  /\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+\/-]{16,}/giu,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{16,}/giu,
]);

const PORTABLE_PATTERNS = Object.freeze([
  /\/Users\/[A-Za-z0-9._-]+(?:\/[^\s"']*)?/gu,
  /\b(?=[A-Za-z0-9._~+\/-]{32,63}\b)(?=[A-Za-z0-9._~+\/-]*[A-Za-z])(?=[A-Za-z0-9._~+\/-]*[0-9])[A-Za-z0-9._~+\/-]{32,63}\b/gu,
]);

function patterns(values) {
  return values.map((pattern) => new RegExp(pattern.source, pattern.flags));
}

export function containsCredentialText(value) {
  const text = String(value ?? '');
  return patterns(CREDENTIAL_PATTERNS).some((pattern) => pattern.test(text));
}

export function containsSensitiveText(value) {
  const text = String(value ?? '');
  return patterns([...CREDENTIAL_PATTERNS, ...PORTABLE_PATTERNS])
    .some((pattern) => pattern.test(text));
}

export function redactText(value, { cwd, message, homePath } = {}) {
  let text = String(value ?? '');
  for (const literal of [message, cwd, homePath]) {
    if (typeof literal === 'string' && literal) text = text.split(literal).join('[REDACTED]');
  }
  for (const pattern of patterns([...CREDENTIAL_PATTERNS, ...PORTABLE_PATTERNS])) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

export function redactPortableData(value, context = {}) {
  if (typeof value === 'string') return redactText(value, context);
  if (Array.isArray(value)) return value.map((item) => redactPortableData(item, context));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    ['cwd', 'message', 'prompt', 'stdin'].includes(key) ? '[REDACTED]' : redactPortableData(item, context),
  ]));
}

async function filesUnder(root, { maxFiles = 256 } = {}) {
  const found = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) {
        found.push(target);
        if (found.length > maxFiles) throw new Error('credential scan file count exceeds its bound');
      }
    }
  }
  await visit(root);
  return found;
}

export async function scanTreeForSecrets(root, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const files = await filesUnder(root);
  const matchedFiles = [];
  let totalBytes = 0;
  for (const file of files) {
    const info = await fs.lstat(file);
    totalBytes += info.size;
    if (totalBytes > maxBytes) throw new Error('credential scan exceeds its byte bound');
    const data = await fs.readFile(file);
    if (!data.includes(0) && containsCredentialText(data.toString('utf8'))) {
      matchedFiles.push(path.relative(root, file));
    }
  }
  return Object.freeze({ pass: matchedFiles.length === 0, matchedFiles: Object.freeze(matchedFiles.sort()) });
}

export function sanitizeStdoutLog(text, { maxRecords = 4096 } = {}) {
  const sanitized = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    if (sanitized.length >= maxRecords) {
      sanitized.push({ type: 'diagnostic.truncated' });
      break;
    }
    try {
      const record = JSON.parse(line);
      if (record.type === 'thread.started' && typeof record.thread_id === 'string') {
        sanitized.push({ type: record.type, threadRef: sha256(record.thread_id).slice(0, 24) });
      } else if (record.type === 'item.completed' && typeof record.item?.type === 'string') {
        sanitized.push({ type: record.type, item: { type: record.item.type } });
      } else if (typeof record.type === 'string') sanitized.push({ type: record.type });
      else sanitized.push({ type: 'diagnostic.redacted' });
    } catch {
      sanitized.push({ type: 'diagnostic.redacted' });
    }
  }
  return sanitized.map((record) => JSON.stringify(record)).join('\n') + (sanitized.length ? '\n' : '');
}

export function sanitizeStderrLog(text) {
  return String(text ?? '').trim() ? '[REDACTED STDERR DIAGNOSTIC]\n' : '';
}
