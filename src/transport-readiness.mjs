import fs from 'node:fs/promises';
import { PERMISSION_PROFILES, TRANSPORTS } from './transport-contract.mjs';
import { EVIDENCE_SOURCES, validateTransportEvidence } from './transport-evidence.mjs';
import {
  EXTERNAL_CONTROL_PLANE,
  maintainerExternalEvidence,
  productionExternalTransportEligibility,
} from './transport-control-plane.mjs';

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectRuntimeRoot(runtimeRoot) {
  const info = await lstatIfExists(runtimeRoot);
  if (!info) {
    return Object.freeze({
      state: 'MISSING',
      present: false,
      ready: false,
      unsafe: false,
      reason: 'isolated runtime root has not been created',
    });
  }
  const owner = typeof process.getuid !== 'function' || info.uid === process.getuid();
  const mode = info.mode & 0o777;
  const ready = info.isDirectory() && !info.isSymbolicLink() && owner && mode === 0o700;
  return Object.freeze({
    state: ready ? 'READY' : 'UNSAFE',
    present: true,
    ready,
    unsafe: !ready,
    reason: ready
      ? 'isolated runtime root is an owner-only real directory'
      : 'isolated runtime root type, owner, or mode is unsafe',
  });
}

function inspectLocalEvidence(evidence, providerPack) {
  if (evidence === null || evidence === undefined) {
    return Object.freeze({
      available: false,
      valid: true,
      evidenceSource: null,
      providerResolved: false,
      runtimeVerified: false,
      verifiedAt: null,
      reason: 'no local installation runtime evidence is available',
    });
  }
  try {
    const checked = validateTransportEvidence(evidence);
    if (checked.transport !== TRANSPORTS.EXTERNAL_CODEX
      || checked.providerId !== providerPack.id
      || checked.model !== providerPack.model) {
      throw new Error('tuple mismatch');
    }
    const local = checked.evidenceSource === EVIDENCE_SOURCES.LOCAL_INSTALLATION;
    return Object.freeze({
      available: local,
      valid: true,
      evidenceSource: checked.evidenceSource,
      providerResolved: local && checked.providerResolved === true,
      runtimeVerified: local && checked.runtimeVerified === true,
      verifiedAt: local ? checked.verifiedAt : null,
      reason: local
        ? 'strict local installation evidence was validated'
        : 'maintainer evidence is not local installation evidence',
    });
  } catch {
    return Object.freeze({
      available: false,
      valid: false,
      evidenceSource: null,
      providerResolved: false,
      runtimeVerified: false,
      verifiedAt: null,
      reason: 'submitted External Transport evidence is invalid',
    });
  }
}

export async function inspectExternalTransportReadiness({
  providerPack,
  customAgentHost,
  codexDetected,
  runtimeRoot,
  permissionProfile = PERMISSION_PROFILES.READ_ONLY,
  credentialReady = null,
  externalEvidence = null,
} = {}) {
  if (!providerPack?.id || !providerPack?.role || !providerPack?.model) {
    throw new Error('provider pack is required for External Transport readiness');
  }
  const runtimeRootState = await inspectRuntimeRoot(runtimeRoot);
  const permissionReady = Object.values(PERMISSION_PROFILES).includes(permissionProfile);
  const codexExecReady = codexDetected === true && customAgentHost?.version === '0.149.0';
  const localEvidence = inspectLocalEvidence(externalEvidence, providerPack);
  const prerequisitesReady = codexExecReady
    && runtimeRootState.ready
    && permissionReady
    && credentialReady === true;
  const eligibility = productionExternalTransportEligibility({
    localRuntimeVerified: localEvidence.runtimeVerified,
    prerequisitesReady,
  });
  return Object.freeze({
    transport: TRANSPORTS.EXTERNAL_CODEX,
    module: Object.freeze({
      present: EXTERNAL_CONTROL_PLANE.modulePresent,
      phase: EXTERNAL_CONTROL_PLANE.phase,
    }),
    featureGate: Object.freeze({
      enabled: EXTERNAL_CONTROL_PLANE.featureEnabled,
      runtimeRouteEnabled: EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled,
      reason: EXTERNAL_CONTROL_PLANE.disabledReason,
    }),
    codexExec: Object.freeze({
      ready: codexExecReady,
      version: customAgentHost?.version ?? null,
      reason: codexExecReady
        ? 'exact Codex CLI 0.149.0 matches the controlled External prerequisite evidence'
        : 'exact Codex CLI 0.149.0 External prerequisite could not be established',
    }),
    runtimeRoot: runtimeRootState,
    permission: Object.freeze({
      profile: permissionProfile,
      ready: permissionReady,
      supported: EXTERNAL_CONTROL_PLANE.permissionProfiles,
    }),
    providerTuple: Object.freeze({
      ready: true,
      providerId: providerPack.id,
      providerRole: providerPack.role,
      model: providerPack.model,
    }),
    credential: Object.freeze({
      ready: credentialReady,
      valueExposed: false,
    }),
    maintainerEvidence: maintainerExternalEvidence(providerPack.id, providerPack.model),
    localEvidence,
    prerequisitesReady,
    eligibility,
  });
}

export function externalReadinessChecks(readiness) {
  const credentialStatus = readiness.credential.ready === true
    ? 'PASS'
    : readiness.credential.ready === false ? 'BLOCKED' : 'WARN';
  const runtimeRootStatus = readiness.runtimeRoot.ready
    ? 'PASS'
    : readiness.runtimeRoot.unsafe ? 'BLOCKED' : 'WARN';
  const localEvidenceStatus = !readiness.localEvidence.valid
    ? 'BLOCKED'
    : readiness.localEvidence.runtimeVerified ? 'PASS' : 'WARN';
  return Object.freeze([
    Object.freeze({
      name: 'External Transport module',
      status: readiness.module.present ? 'PASS' : 'BLOCKED',
      detail: readiness.module.present
        ? `External Transport Phase ${readiness.module.phase} control module is present`
        : 'External Transport control module is unavailable',
    }),
    Object.freeze({
      name: 'External feature gate',
      status: readiness.featureGate.enabled || readiness.featureGate.runtimeRouteEnabled ? 'BLOCKED' : 'WARN',
      detail: readiness.featureGate.enabled || readiness.featureGate.runtimeRouteEnabled
        ? 'External execution became reachable before Phase 3'
        : 'External execution is intentionally disabled and unreachable in Phase 2',
    }),
    Object.freeze({
      name: 'External Codex exec prerequisite',
      status: readiness.codexExec.ready ? 'PASS' : 'WARN',
      detail: readiness.codexExec.reason,
    }),
    Object.freeze({
      name: 'External isolated runtime root',
      status: runtimeRootStatus,
      detail: readiness.runtimeRoot.reason,
    }),
    Object.freeze({
      name: 'External permission profile',
      status: readiness.permission.ready ? 'PASS' : 'BLOCKED',
      detail: readiness.permission.ready
        ? `${readiness.permission.profile} is supported`
        : 'requested permission profile is unsupported',
    }),
    Object.freeze({
      name: 'External provider tuple',
      status: readiness.providerTuple.ready ? 'PASS' : 'BLOCKED',
      detail: readiness.providerTuple.ready
        ? `${readiness.providerTuple.providerRole} matches ${readiness.providerTuple.providerId}/${readiness.providerTuple.model}`
        : 'provider/model/role tuple is unavailable',
    }),
    Object.freeze({
      name: 'External credential readiness',
      status: credentialStatus,
      detail: readiness.credential.ready === true
        ? 'Keychain item presence was established without reading its value'
        : readiness.credential.ready === false
          ? 'required Keychain item is missing'
          : 'credential readiness was not established',
    }),
    Object.freeze({
      name: 'External maintainer evidence',
      status: readiness.maintainerEvidence.available ? 'PASS' : 'WARN',
      detail: readiness.maintainerEvidence.available
        ? 'controlled maintainer evidence exists and is not local installation evidence'
        : 'maintainer External runtime evidence is unknown for this tuple',
    }),
    Object.freeze({
      name: 'External local runtime evidence',
      status: localEvidenceStatus,
      detail: readiness.localEvidence.reason,
    }),
    Object.freeze({
      name: 'External Transport eligibility',
      status: readiness.eligibility.eligible ? 'BLOCKED' : 'WARN',
      detail: readiness.eligibility.eligible
        ? 'External execution unexpectedly became eligible before Phase 3'
        : readiness.eligibility.reason,
    }),
  ]);
}
