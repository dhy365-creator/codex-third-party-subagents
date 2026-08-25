import { PERMISSION_PROFILES, TRANSPORTS } from './transport-contract.mjs';

export const EXTERNAL_FLASH_FEATURE_GATE = 'phase3-flash-production-e2e';
export const EXTERNAL_FLASH_LIVE_REQUEST_LIMIT = 3;

const FLASH_TUPLE = Object.freeze({
  providerId: 'deepseek',
  providerRole: 'deepseek_worker',
  model: 'deepseek-v4-flash',
});
const permits = new WeakMap();
const consumed = new WeakSet();

function block(reason, input = {}) {
  return Object.freeze({
    decision: 'BLOCK',
    selectedTransport: null,
    providerId: input.providerId ?? null,
    providerRole: input.providerRole ?? null,
    model: input.model ?? null,
    reason,
  });
}

export function evaluateExternalFlashProductionGate(input = {}) {
  const tupleMatches = Object.entries(FLASH_TUPLE)
    .every(([field, value]) => input[field] === value);
  if (!tupleMatches) return block('only the exact DeepSeek V4 Flash tuple is authorized', input);
  if (input.requestedTransport !== TRANSPORTS.EXTERNAL_CODEX) {
    return block('External Transport must be explicitly requested', input);
  }
  if (input.featureGate !== EXTERNAL_FLASH_FEATURE_GATE || input.runtimeRouteEnabled !== true) {
    return block('the controlled External Flash feature gate is disabled', input);
  }
  if (input.billableAuthorized !== true || input.providerExplicitlyRequested !== true) {
    return block('BILLABLE PROVIDER REQUEST and explicit provider authorization are required', input);
  }
  if (input.providerSuitable !== true || input.providerReady !== true || input.credentialReady !== true) {
    return block('provider suitability, configuration, or credential readiness is incomplete', input);
  }
  if (input.permissionProfile !== PERMISSION_PROFILES.READ_ONLY) {
    return block('Phase 3 production E2E is restricted to read-only', input);
  }
  if (input.codexVersion !== '0.149.0') {
    return block('the controlled production E2E requires exact Codex CLI 0.149.0', input);
  }
  if (input.runtimeRootReady !== true || input.evidenceDestinationReady !== true) {
    return block('the isolated runtime root or evidence destination is not ready', input);
  }
  if (input.busy === true) return Object.freeze({ ...block('EXTERNAL CHILD BUSY', input), decision: 'BUSY' });
  if (input.liveRequestLimit !== EXTERNAL_FLASH_LIVE_REQUEST_LIMIT
    || !Number.isInteger(input.liveRequestCount)
    || input.liveRequestCount < 0
    || input.liveRequestCount >= EXTERNAL_FLASH_LIVE_REQUEST_LIMIT) {
    return block('the DeepSeek Flash live-request budget is unavailable or exhausted', input);
  }
  if (typeof input.taskName !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/u.test(input.taskName)) {
    return block('task identity is invalid', input);
  }
  if (typeof input.authorizationId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.authorizationId)) {
    return block('billable authorization identity is invalid', input);
  }
  if (typeof input.challenge !== 'string' || !/^challenge-[a-f0-9]{8}-[a-f0-9]{8}$/u.test(input.challenge)) {
    return block('the canonical E2E challenge is invalid', input);
  }
  return Object.freeze({
    decision: 'ALLOW',
    selectedTransport: TRANSPORTS.EXTERNAL_CODEX,
    ...FLASH_TUPLE,
    permissionProfile: input.permissionProfile,
    taskName: input.taskName,
    authorizationId: input.authorizationId,
    liveRequestNumber: input.liveRequestCount + 1,
    liveRequestLimit: input.liveRequestLimit,
    reason: 'controlled feature-gated DeepSeek V4 Flash production E2E is authorized',
  });
}

export function createExternalFlashExecutionPermit(input = {}) {
  const decision = evaluateExternalFlashProductionGate(input);
  if (decision.decision !== 'ALLOW') {
    const error = new Error(decision.reason);
    error.code = decision.decision === 'BUSY' ? 'EXTERNAL_CHILD_BUSY' : 'EXTERNAL_FLASH_GATE_BLOCKED';
    throw error;
  }
  const permit = Object.freeze({
    taskName: decision.taskName,
    providerId: decision.providerId,
    providerRole: decision.providerRole,
    model: decision.model,
    permissionProfile: decision.permissionProfile,
    authorizationId: decision.authorizationId,
    liveRequestNumber: decision.liveRequestNumber,
  });
  permits.set(permit, Object.freeze({ ...permit, challenge: input.challenge, codexVersion: input.codexVersion }));
  return permit;
}

function permitState(permit, request) {
  const state = permits.get(permit);
  if (!state) throw new Error('External Flash execution permit is invalid');
  for (const field of ['taskName', 'providerId', 'providerRole', 'model', 'permissionProfile']) {
    if (request?.[field] !== state[field]) throw new Error(`External Flash permit ${field} does not match`);
  }
  if (request.transportPreference !== TRANSPORTS.EXTERNAL_CODEX) {
    throw new Error('External Flash permit requires explicit External Transport');
  }
  return state;
}

export function validateExternalFlashExecutionPermit(permit, request) {
  if (consumed.has(permit)) throw new Error('External Flash execution permit was already consumed');
  return permitState(permit, request);
}

export function consumeExternalFlashExecutionPermit(permit, request) {
  const state = validateExternalFlashExecutionPermit(permit, request);
  consumed.add(permit);
  return state;
}

export function externalFlashResultAccepted(permit, request, result) {
  const state = permitState(permit, request);
  return result?.status === 'completed'
    && result.providerId === state.providerId
    && result.model === state.model
    && result.transport === TRANSPORTS.EXTERNAL_CODEX
    && result.changedFiles?.length === 0
    && result.summary === `CHALLENGE ${state.challenge}`;
}

export function externalFlashPermitMetadata(permit) {
  const state = permits.get(permit);
  if (!state) throw new Error('External Flash execution permit is invalid');
  return Object.freeze({
    authorizationId: state.authorizationId,
    liveRequestNumber: state.liveRequestNumber,
    codexVersion: state.codexVersion,
  });
}
