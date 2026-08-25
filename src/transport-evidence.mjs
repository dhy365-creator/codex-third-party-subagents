import { TRANSPORTS, validateEvidenceRef } from './transport-contract.mjs';

export const EVIDENCE_SOURCES = Object.freeze({
  MAINTAINER_CONTROLLED: 'maintainer-controlled',
  LOCAL_INSTALLATION: 'local-installation',
});

const EVIDENCE_FIELDS = [
  'schemaVersion', 'taskName', 'providerId', 'model', 'transport', 'configured',
  'discoverable', 'providerResolved', 'taskDelivered', 'runtimeExecuted',
  'runtimeVerified', 'configurationReady', 'ready', 'evidenceSource',
  'credentialReady', 'hostVersion', 'codexBinary', 'verifiedAt', 'providerAttribution',
  'acceptance', 'evidenceRefs',
];
const ATTRIBUTION_FIELDS = ['sessionRef', 'providers', 'models', 'endpointRef'];
const ACCEPTANCE_FIELDS = [
  'resultValid', 'workspaceScopeValid', 'lifecycleValid',
  'credentialSafetyValid', 'parentIsolationValid',
];

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields do not match the contract`);
  }
}

function boundedString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function triState(value, label) {
  if (![true, false, null].includes(value)) throw new Error(`${label} must be true, false, or null`);
  return value;
}

function stringSet(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 8
    || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty bounded string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function validateAttribution(attribution, evidence) {
  if (attribution === null) return null;
  exactFields(attribution, ATTRIBUTION_FIELDS, 'provider attribution');
  boundedString(attribution.sessionRef, 'sessionRef');
  boundedString(attribution.endpointRef, 'endpointRef');
  const providers = stringSet(attribution.providers, 'providers');
  const models = stringSet(attribution.models, 'models');
  if (providers.length !== 1 || providers[0] !== evidence.providerId
    || models.length !== 1 || models[0] !== evidence.model) {
    throw new Error('provider attribution does not match the requested tuple');
  }
  return attribution;
}

export function validateTransportEvidence(evidence) {
  exactFields(evidence, EVIDENCE_FIELDS, 'transport evidence');
  if (evidence.schemaVersion !== 1) throw new Error('transport evidence schemaVersion is unsupported');
  for (const field of ['taskName', 'providerId', 'model']) boundedString(evidence[field], field);
  if (!Object.values(TRANSPORTS).includes(evidence.transport)) throw new Error('evidence transport is invalid');
  if (typeof evidence.configured !== 'boolean') throw new Error('configured must be boolean');
  for (const field of ['discoverable', 'providerResolved', 'taskDelivered', 'runtimeExecuted', 'runtimeVerified']) {
    triState(evidence[field], field);
  }
  for (const field of ['configurationReady', 'ready']) {
    if (typeof evidence[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  triState(evidence.credentialReady, 'credentialReady');
  if (!Object.values(EVIDENCE_SOURCES).includes(evidence.evidenceSource)) {
    throw new Error('evidenceSource is invalid');
  }
  boundedString(evidence.hostVersion, 'hostVersion', { nullable: true });
  boundedString(evidence.codexBinary, 'codexBinary', { nullable: true });
  if (evidence.verifiedAt !== null && Number.isNaN(Date.parse(evidence.verifiedAt))) {
    throw new Error('verifiedAt must be an ISO timestamp or null');
  }
  const attribution = validateAttribution(evidence.providerAttribution, evidence);
  exactFields(evidence.acceptance, ACCEPTANCE_FIELDS, 'acceptance');
  for (const field of ACCEPTANCE_FIELDS) {
    if (typeof evidence.acceptance[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  if (!Array.isArray(evidence.evidenceRefs) || !evidence.evidenceRefs.length || evidence.evidenceRefs.length > 32) {
    throw new Error('evidenceRefs must be a bounded array');
  }
  evidence.evidenceRefs.forEach(validateEvidenceRef);

  if (evidence.configurationReady && !evidence.configured) {
    throw new Error('configurationReady requires configured');
  }
  if (evidence.ready && (!evidence.configurationReady || evidence.credentialReady !== true)) {
    throw new Error('ready requires configurationReady and credentialReady');
  }
  if (evidence.providerResolved === true && attribution === null) {
    throw new Error('providerResolved requires independent runtime attribution');
  }
  if (evidence.runtimeVerified === true) {
    if (!evidence.configured) throw new Error('runtimeVerified requires configured');
    if (evidence.providerResolved !== true || evidence.taskDelivered !== true || evidence.runtimeExecuted !== true) {
      throw new Error('runtimeVerified requires provider, delivery, and execution evidence');
    }
    if (!ACCEPTANCE_FIELDS.every((field) => evidence.acceptance[field] === true)) {
      throw new Error('runtimeVerified requires every acceptance gate');
    }
    if (evidence.verifiedAt === null) throw new Error('runtimeVerified requires verifiedAt');
  }
  return Object.freeze({
    ...evidence,
    acceptance: Object.freeze({ ...evidence.acceptance }),
    evidenceRefs: Object.freeze(evidence.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
  });
}
