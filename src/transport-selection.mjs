import {
  PERMISSION_PROFILES,
  TRANSPORT_PREFERENCES,
  TRANSPORTS,
} from './transport-contract.mjs';

export const SELECTION_DECISIONS = Object.freeze({
  ALLOW: 'ALLOW',
  BLOCK: 'BLOCK',
  REQUIRE_EXPLICIT: 'REQUIRE_EXPLICIT',
  BUSY: 'BUSY',
});

export const PROVIDER_POLICIES = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  REQUIRE_EXPLICIT: 'require-explicit',
});

const ELIGIBILITY_FIELDS = [
  'eligible', 'runtimeVerified', 'busy', 'compatibilityLevel', 'reason',
  'permissionProfiles',
];
const SELECTION_FIELDS = [
  'requestedTransport', 'providerPolicy', 'providerExplicitlyRequested',
  'roleExplicitOnly', 'providerId', 'providerRole', 'model', 'permissionProfile',
  'native', 'external',
];

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields do not match the contract`);
  }
}

function validateEligibility(value, label) {
  exactFields(value, ELIGIBILITY_FIELDS, `${label} eligibility`);
  for (const field of ['eligible', 'runtimeVerified', 'busy']) {
    if (typeof value[field] !== 'boolean') throw new Error(`${label}.${field} must be boolean`);
  }
  if (typeof value.compatibilityLevel !== 'string' || !value.compatibilityLevel.trim()) {
    throw new Error(`${label}.compatibilityLevel is required`);
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error(`${label}.reason is required`);
  if (!Array.isArray(value.permissionProfiles)
    || value.permissionProfiles.some((profile) => !Object.values(PERMISSION_PROFILES).includes(profile))) {
    throw new Error(`${label}.permissionProfiles is invalid`);
  }
  if (value.eligible && !value.runtimeVerified) throw new Error(`${label} cannot be eligible without runtime evidence`);
  return value;
}

function response(input, decision, selectedTransport, reason, compatibilityLevel = null) {
  return Object.freeze({
    decision,
    requestedTransport: input.requestedTransport,
    selectedTransport,
    providerId: input.providerId,
    providerRole: input.providerRole,
    model: input.model,
    permissionProfile: input.permissionProfile,
    compatibilityLevel,
    reason,
  });
}

function unavailableReason(transport, eligibility, permissionProfile) {
  if (!eligibility.permissionProfiles.includes(permissionProfile)) {
    return `${transport} does not support permission profile ${permissionProfile}`;
  }
  return eligibility.reason;
}

function evaluateCandidate(input, transport, eligibility) {
  if (!eligibility.eligible || !eligibility.runtimeVerified
    || !eligibility.permissionProfiles.includes(input.permissionProfile)) {
    return response(
      input,
      SELECTION_DECISIONS.BLOCK,
      null,
      unavailableReason(transport, eligibility, input.permissionProfile),
      eligibility.compatibilityLevel,
    );
  }
  if (transport === TRANSPORTS.EXTERNAL_CODEX && eligibility.busy) {
    return response(
      input,
      SELECTION_DECISIONS.BUSY,
      null,
      'EXTERNAL CHILD BUSY',
      eligibility.compatibilityLevel,
    );
  }
  return response(
    input,
    SELECTION_DECISIONS.ALLOW,
    transport,
    eligibility.reason,
    eligibility.compatibilityLevel,
  );
}

export function selectTransport(input) {
  exactFields(input, SELECTION_FIELDS, 'transport selection input');
  if (!Object.values(TRANSPORT_PREFERENCES).includes(input.requestedTransport)) {
    throw new Error('requestedTransport is unsupported');
  }
  if (!Object.values(PROVIDER_POLICIES).includes(input.providerPolicy)) {
    throw new Error('providerPolicy is unsupported');
  }
  for (const field of ['providerExplicitlyRequested', 'roleExplicitOnly']) {
    if (typeof input[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  for (const field of ['providerId', 'providerRole', 'model']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`${field} is required`);
  }
  if (!Object.values(PERMISSION_PROFILES).includes(input.permissionProfile)) {
    throw new Error('permissionProfile is unsupported');
  }
  const native = validateEligibility(input.native, 'native');
  const external = validateEligibility(input.external, 'external');

  if (input.providerPolicy === PROVIDER_POLICIES.DENY) {
    return response(input, SELECTION_DECISIONS.BLOCK, null, 'provider policy denies third-party execution');
  }
  if ((input.providerPolicy === PROVIDER_POLICIES.REQUIRE_EXPLICIT || input.roleExplicitOnly)
    && !input.providerExplicitlyRequested) {
    return response(
      input,
      SELECTION_DECISIONS.REQUIRE_EXPLICIT,
      null,
      'provider role requires an explicit request',
    );
  }

  if (input.requestedTransport === TRANSPORTS.NATIVE) {
    return evaluateCandidate(input, TRANSPORTS.NATIVE, native);
  }
  if (input.requestedTransport === TRANSPORTS.EXTERNAL_CODEX) {
    return evaluateCandidate(input, TRANSPORTS.EXTERNAL_CODEX, external);
  }

  const nativeDecision = evaluateCandidate(input, TRANSPORTS.NATIVE, native);
  if (nativeDecision.decision === SELECTION_DECISIONS.ALLOW) return nativeDecision;
  const externalDecision = evaluateCandidate(input, TRANSPORTS.EXTERNAL_CODEX, external);
  if ([SELECTION_DECISIONS.ALLOW, SELECTION_DECISIONS.BUSY].includes(externalDecision.decision)) {
    return externalDecision;
  }
  return response(
    input,
    SELECTION_DECISIONS.BLOCK,
    null,
    `no runtime-verified transport is eligible: native=${native.reason}; external=${external.reason}`,
  );
}
