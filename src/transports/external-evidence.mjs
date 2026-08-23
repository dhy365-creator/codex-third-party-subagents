import fs from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_SOURCES, validateTransportEvidence } from '../transport-evidence.mjs';
import { sha256 } from './external-fs-safety.mjs';
export {
  containsCredentialText,
  containsSensitiveText,
  redactPortableData,
  redactText,
  sanitizeStderrLog,
  sanitizeStdoutLog,
  scanTreeForSecrets,
} from './external-redaction.mjs';

async function filesUnder(root, predicate, { maxFiles = 256 } = {}) {
  const found = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(target);
      else if (info.isFile() && predicate(target)) {
        found.push(target);
        if (found.length > maxFiles) throw new Error('evidence file count exceeds its bound');
      }
    }
  }
  await visit(root);
  return found;
}

function parseJsonl(text, label, { maxBytes = 1024 * 1024, maxRecords = 4096 } = {}) {
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} exceeds its byte bound`);
  const records = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    if (records.length >= maxRecords) throw new Error(`${label} has too many records`);
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`${label} contains malformed JSONL`);
    }
  }
  return records;
}

function canonicalEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return null;
  }
}

function unknownEvidence(issues) {
  return Object.freeze({
    status: 'UNKNOWN',
    providerResolved: false,
    taskDelivered: false,
    runtimeExecuted: false,
    toolObserved: false,
    toolTypes: Object.freeze([]),
    attribution: null,
    issues: Object.freeze(issues),
  });
}

export async function parseExternalRuntimeEvidence({
  format = 'codex-0.149-jsonl',
  stdoutText,
  codexHome,
  expected,
  stdinDelivered,
} = {}) {
  if (format !== 'codex-0.149-jsonl') return unknownEvidence(['unsupported evidence format']);
  try {
    const events = parseJsonl(stdoutText, 'stdout evidence');
    const threadIds = [...new Set(events
      .filter((record) => record.type === 'thread.started' && typeof record.thread_id === 'string')
      .map((record) => record.thread_id))];
    if (threadIds.length !== 1) return unknownEvidence(['exactly one thread.started record is required']);
    const sessionFiles = await filesUnder(codexHome, (target) => target.endsWith('.jsonl'), { maxFiles: 64 });
    const matchingRecords = [];
    for (const file of sessionFiles) {
      const info = await fs.lstat(file);
      if (info.size > 1024 * 1024) throw new Error('session evidence file exceeds its bound');
      const records = parseJsonl(await fs.readFile(file, 'utf8'), 'session evidence');
      if (records.some((record) => record.type === 'session_meta' && record.payload?.id === threadIds[0])) {
        matchingRecords.push(...records);
      }
    }
    if (!matchingRecords.length) return unknownEvidence(['matching session metadata is missing']);
    const providers = [...new Set(matchingRecords
      .filter((record) => record.type === 'session_meta')
      .map((record) => record.payload?.model_provider)
      .filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase()))];
    const models = [...new Set(matchingRecords
      .filter((record) => record.type === 'turn_context')
      .map((record) => record.payload?.model)
      .filter((value) => typeof value === 'string'))];
    const endpoints = [...new Set(matchingRecords
      .filter((record) => record.type === 'session_meta')
      .map((record) => canonicalEndpoint(record.payload?.base_url ?? record.payload?.endpoint))
      .filter(Boolean))];
    const taskDigests = [...new Set(matchingRecords
      .filter((record) => record.type === 'session_meta')
      .map((record) => record.payload?.task_sha256)
      .filter((value) => typeof value === 'string'))];
    const expectedEndpoint = canonicalEndpoint(expected.endpoint);
    const tupleMatches = providers.length === 1 && providers[0] === expected.providerId.toLowerCase()
      && models.length === 1 && models[0] === expected.model
      && endpoints.length === 1 && endpoints[0] === expectedEndpoint;
    const taskDelivered = stdinDelivered === true
      && taskDigests.length === 1 && taskDigests[0] === expected.taskSha256;
    const runtimeExecuted = events.some((record) => record.type === 'turn.completed')
      && matchingRecords.some((record) => record.type === 'turn_context');
    const toolTypes = [...new Set(events
      .filter((record) => record.type === 'item.completed' && typeof record.item?.type === 'string')
      .map((record) => record.item.type))].sort();
    const issues = [];
    if (!tupleMatches) issues.push('provider/model/endpoint attribution does not match');
    if (!taskDelivered) issues.push('task delivery evidence does not match');
    if (!runtimeExecuted) issues.push('runtime execution evidence is missing');
    const attribution = tupleMatches ? Object.freeze({
      sessionRef: `runtime:session:${sha256(threadIds[0]).slice(0, 24)}`,
      providers: Object.freeze(providers),
      models: Object.freeze(models),
      endpointRef: `runtime:endpoint:${sha256(expectedEndpoint).slice(0, 24)}`,
    }) : null;
    return Object.freeze({
      status: issues.length ? 'UNKNOWN' : 'ATTRIBUTED',
      providerResolved: tupleMatches,
      taskDelivered,
      runtimeExecuted,
      toolObserved: toolTypes.length > 0,
      toolTypes: Object.freeze(toolTypes),
      attribution,
      issues: Object.freeze(issues),
    });
  } catch (error) {
    return unknownEvidence([error.message]);
  }
}

function evidenceDetail(source, evidenceType, confidence, timestamp, sanitizedReference) {
  return Object.freeze({ source, evidenceType, confidence, timestamp, sanitizedReference });
}

export function buildExternalEvidenceDetails({
  parsed,
  collection,
  lifecycle,
  evidenceRefs,
  boundary = 'runtime',
} = {}) {
  const byKind = Object.fromEntries(evidenceRefs.map((reference) => [reference.kind, reference.ref]));
  const timestamp = lifecycle.endedAt;
  const source = (value) => `${boundary}:${value}`;
  return Object.freeze({
    providerEvidence: evidenceDetail(
      source('external-runtime'), 'provider-attribution',
      parsed.providerResolved ? 'verified' : 'unknown', timestamp, byKind.runtime,
    ),
    modelEvidence: evidenceDetail(
      source('external-runtime'), 'model-attribution',
      parsed.providerResolved ? 'verified' : 'unknown', timestamp, byKind.runtime,
    ),
    taskEvidence: evidenceDetail(
      source('stdin-and-runtime'), 'task-delivery',
      parsed.taskDelivered ? 'verified' : 'unknown', timestamp, byKind.runtime,
    ),
    toolEvidence: evidenceDetail(
      source('external-runtime'), 'tool-execution',
      parsed.toolObserved ? 'verified' : 'unknown', timestamp, byKind.runtime,
    ),
    workspaceEvidence: evidenceDetail(
      source('workspace-snapshot'), 'workspace-scope',
      collection.workspaceScopeValid ? 'verified' : 'rejected', timestamp, byKind.workspace,
    ),
    resultEvidence: evidenceDetail(
      source('adapter-validation'), 'structured-result',
      collection.childResult ? 'verified' : 'rejected', timestamp, byKind.result,
    ),
    lifecycleEvidence: evidenceDetail(
      source('process-supervisor'), 'closed-lifecycle',
      lifecycle.state === 'closed' && !lifecycle.orphanDetected ? 'verified' : 'rejected',
      timestamp,
      byKind.lifecycle,
    ),
  });
}

export function buildExternalTransportEvidence({
  request,
  parsed,
  evidenceRefs,
  acceptance,
  codexBinary,
  credentialReady = null,
  allowRuntimeVerification = false,
  verifiedAt = null,
} = {}) {
  const runtimeVerified = allowRuntimeVerification
    && parsed.providerResolved && parsed.taskDelivered && parsed.runtimeExecuted
    && Object.values(acceptance).every((value) => value === true);
  return validateTransportEvidence({
    schemaVersion: 1,
    taskName: request.taskName,
    providerId: request.providerId,
    model: request.model,
    transport: 'external-codex',
    configured: true,
    discoverable: null,
    providerResolved: parsed.providerResolved,
    taskDelivered: parsed.taskDelivered,
    runtimeExecuted: parsed.runtimeExecuted,
    runtimeVerified,
    configurationReady: true,
    ready: credentialReady === true,
    evidenceSource: EVIDENCE_SOURCES.LOCAL_INSTALLATION,
    credentialReady,
    hostVersion: null,
    codexBinary: path.basename(codexBinary),
    verifiedAt: runtimeVerified ? verifiedAt : null,
    providerAttribution: parsed.attribution,
    acceptance,
    evidenceRefs,
  });
}
