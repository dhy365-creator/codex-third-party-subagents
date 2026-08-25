import path from 'node:path';
import { TRANSPORTS } from './transport-contract.mjs';
import {
  EVIDENCE_SOURCES,
  validateTransportEvidence,
} from './transport-evidence.mjs';
import {
  EXTERNAL_CONTROL_PLANE,
  maintainerExternalEvidence,
  productionExternalTransportEligibility,
} from './transport-control-plane.mjs';

function binaryName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.basename(value);
}

function validateSubmittedEvidence(evidence, providerPack) {
  if (evidence === null || evidence === undefined) return null;
  const checked = validateTransportEvidence(evidence);
  if (checked.transport !== TRANSPORTS.EXTERNAL_CODEX
    || checked.providerId !== providerPack.id
    || checked.model !== providerPack.model) {
    throw new Error('External Transport evidence does not match the selected provider/model tuple');
  }
  return checked;
}

function nativeState({ result, providerPack, hostVersion, codexBinary }) {
  return Object.freeze({
    transport: TRANSPORTS.NATIVE,
    configured: result.configured === true,
    discoverable: result.discoverable ?? false,
    providerResolved: result.providerResolved ?? null,
    taskDelivered: result.taskDelivered ?? null,
    runtimeExecuted: result.runtimeExecuted === true,
    runtimeVerified: result.runtimeVerified === true,
    configurationReady: result.configurationReady === true,
    ready: result.ready === true,
    credentialReady: result.credentialReady ?? null,
    evidenceSource: EVIDENCE_SOURCES.LOCAL_INSTALLATION,
    hostVersion,
    codexBinary,
    providerId: providerPack.id,
    model: providerPack.model,
    verifiedAt: null,
  });
}

function externalState({
  providerPack,
  submittedEvidence,
  externalConfigured,
  credentialReady,
  hostVersion,
  codexBinary,
  prerequisitesReady,
  busy,
}) {
  const localEvidence = submittedEvidence?.evidenceSource === EVIDENCE_SOURCES.LOCAL_INSTALLATION
    ? submittedEvidence
    : null;
  const eligibility = productionExternalTransportEligibility({
    localRuntimeVerified: localEvidence?.runtimeVerified === true,
    prerequisitesReady: prerequisitesReady === true,
    busy: busy === true,
  });
  return Object.freeze({
    transport: TRANSPORTS.EXTERNAL_CODEX,
    configured: externalConfigured === true && EXTERNAL_CONTROL_PLANE.modulePresent,
    discoverable: null,
    providerResolved: localEvidence?.providerResolved ?? false,
    taskDelivered: localEvidence?.taskDelivered ?? false,
    runtimeExecuted: localEvidence?.runtimeExecuted ?? false,
    runtimeVerified: localEvidence?.runtimeVerified ?? false,
    configurationReady: false,
    ready: false,
    credentialReady,
    evidenceSource: localEvidence?.evidenceSource ?? null,
    hostVersion,
    codexBinary,
    providerId: providerPack.id,
    model: providerPack.model,
    verifiedAt: localEvidence?.verifiedAt ?? null,
    modulePresent: EXTERNAL_CONTROL_PLANE.modulePresent,
    featureEnabled: EXTERNAL_CONTROL_PLANE.featureEnabled,
    runtimeRouteEnabled: EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled,
    maintainerEvidence: maintainerExternalEvidence(providerPack.id, providerPack.model),
    localEvidenceAvailable: localEvidence !== null,
    submittedEvidenceSource: submittedEvidence?.evidenceSource ?? null,
    eligibility,
  });
}

export function buildTransportVerification({
  result,
  providerPack,
  host,
  codexBinary,
  externalConfigured = false,
  externalEvidence = null,
  externalPrerequisitesReady = false,
  externalBusy = false,
} = {}) {
  if (!providerPack?.id || !providerPack?.model) {
    throw new Error('provider pack is required for Transport verification');
  }
  const hostVersion = host?.version ?? null;
  const safeCodexBinary = binaryName(codexBinary);
  const submittedEvidence = validateSubmittedEvidence(externalEvidence, providerPack);
  const native = nativeState({ result, providerPack, hostVersion, codexBinary: safeCodexBinary });
  const external = externalState({
    providerPack,
    submittedEvidence,
    externalConfigured,
    credentialReady: result.credentialReady ?? null,
    hostVersion,
    codexBinary: safeCodexBinary,
    prerequisitesReady: externalPrerequisitesReady,
    busy: externalBusy,
  });
  return Object.freeze({
    transport: TRANSPORTS.NATIVE,
    providerId: providerPack.id,
    model: providerPack.model,
    evidenceSource: EVIDENCE_SOURCES.LOCAL_INSTALLATION,
    hostVersion,
    codexBinary: safeCodexBinary,
    verifiedAt: null,
    transports: Object.freeze({ native, external }),
  });
}
