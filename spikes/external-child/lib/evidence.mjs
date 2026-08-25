import fs from 'node:fs/promises';
import path from 'node:path';

async function filesUnder(root, predicate) {
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && predicate(target)) found.push(target);
    }
  }
  await visit(root);
  return found;
}

export async function parseJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSONL record in ${path.basename(filePath)}`);
    }
  }
  return records;
}

export async function eventSummary(stdoutPath) {
  const records = await parseJsonl(stdoutPath);
  const threadIds = records
    .filter((record) => record.type === 'thread.started' && typeof record.thread_id === 'string')
    .map((record) => record.thread_id);
  return {
    records: records.length,
    eventTypes: [...new Set(records.map((record) => record.type).filter(Boolean))].sort(),
    threadIds: [...new Set(threadIds)],
  };
}

export async function runtimeAttribution(codexHome, threadId) {
  const files = await filesUnder(codexHome, (target) => target.endsWith('.jsonl'));
  const matches = [];
  for (const file of files) {
    const records = await parseJsonl(file);
    const session = records.find((record) => record.type === 'session_meta'
      && record.payload?.id === threadId);
    if (!session) continue;
    const providers = records
      .filter((record) => record.type === 'session_meta')
      .map((record) => record.payload?.model_provider)
      .filter((value) => typeof value === 'string');
    const models = records
      .filter((record) => record.type === 'turn_context')
      .map((record) => record.payload?.model)
      .filter((value) => typeof value === 'string');
    matches.push({ file: path.relative(codexHome, file), providers, models });
  }
  const providers = [...new Set(matches.flatMap((entry) => entry.providers).map((value) => value.toLowerCase()))];
  const models = [...new Set(matches.flatMap((entry) => entry.models))];
  return {
    threadId,
    sources: matches.map((entry) => entry.file),
    providers,
    models,
    verified: matches.length > 0
      && providers.length === 1
      && providers[0] === 'deepseek'
      && models.length === 1
      && models[0] === 'deepseek-v4-flash',
  };
}

const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/u,
  /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/iu,
  /Authorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+\/-]{20,}/iu,
];

export async function scanCredentialLeaks(root) {
  const files = await filesUnder(root, () => true);
  const matchedFiles = [];
  for (const file of files) {
    const data = await fs.readFile(file);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) {
      matchedFiles.push(path.relative(root, file));
    }
  }
  return { pass: matchedFiles.length === 0, matchedFiles };
}
