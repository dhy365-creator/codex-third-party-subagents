import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSPORTS } from '../src/transport-contract.mjs';
import {
  EVIDENCE_SOURCES,
  validateTransportEvidence,
} from '../src/transport-evidence.mjs';

const hash = 'b'.repeat(64);

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    taskName: 'bounded-coding',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: TRANSPORTS.EXTERNAL_CODEX,
    configured: true,
    discoverable: null,
    providerResolved: true,
    taskDelivered: true,
    runtimeExecuted: true,
    runtimeVerified: true,
    configurationReady: true,
    ready: true,
    credentialReady: true,
    evidenceSource: EVIDENCE_SOURCES.MAINTAINER_CONTROLLED,
    hostVersion: '0.149.0',
    codexBinary: '/opt/homebrew/bin/codex',
    verifiedAt: '2026-08-23T14:50:37.743Z',
    providerAttribution: {
      sessionRef: 'runtime:session-1',
      providers: ['deepseek'],
      models: ['deepseek-v4-flash'],
      endpointRef: 'runtime:deepseek-responses',
    },
    acceptance: {
      resultValid: true,
      workspaceScopeValid: true,
      lifecycleValid: true,
      credentialSafetyValid: true,
      parentIsolationValid: true,
    },
    evidenceRefs: [{ kind: 'runtime', ref: 'runtime:session-1', sha256: hash }],
    ...overrides,
  };
}

test('runtime verification requires attributable provider, delivery, execution, and acceptance', () => {
  const checked = validateTransportEvidence(evidence());
  assert.equal(checked.runtimeVerified, true);
  assert.equal(checked.evidenceSource, EVIDENCE_SOURCES.MAINTAINER_CONTROLLED);
  assert.deepEqual(checked.providerAttribution.providers, ['deepseek']);
});

test('result provider claims cannot replace independent provider attribution', () => {
  assert.throws(() => validateTransportEvidence(evidence({ providerAttribution: null })), /attribution/u);
  assert.throws(() => validateTransportEvidence(evidence({
    providerAttribution: {
      sessionRef: 'runtime:session-1',
      providers: ['openai'],
      models: ['deepseek-v4-flash'],
      endpointRef: 'runtime:provider-endpoint',
    },
  })), /requested tuple/u);
});

test('runtimeVerified fails closed when a required evidence gate is missing', () => {
  assert.throws(() => validateTransportEvidence(evidence({ taskDelivered: false })), /delivery/u);
  assert.throws(() => validateTransportEvidence(evidence({
    acceptance: { ...evidence().acceptance, parentIsolationValid: false },
  })), /acceptance gate/u);
  assert.throws(() => validateTransportEvidence(evidence({ verifiedAt: null })), /verifiedAt/u);
  assert.throws(() => validateTransportEvidence(evidence({ evidenceRefs: [] })), /evidenceRefs/u);
});

test('configuration-only evidence remains distinct from runtime verification', () => {
  const checked = validateTransportEvidence(evidence({
    providerResolved: null,
    taskDelivered: null,
    runtimeExecuted: false,
    runtimeVerified: false,
    providerAttribution: null,
    verifiedAt: null,
    ready: false,
    credentialReady: null,
    evidenceSource: EVIDENCE_SOURCES.LOCAL_INSTALLATION,
    acceptance: {
      resultValid: false,
      workspaceScopeValid: false,
      lifecycleValid: false,
      credentialSafetyValid: true,
      parentIsolationValid: true,
    },
  }));
  assert.equal(checked.configured, true);
  assert.equal(checked.runtimeVerified, false);
  assert.equal(checked.evidenceSource, EVIDENCE_SOURCES.LOCAL_INSTALLATION);
});

test('ready requires an attributable local credential check', () => {
  assert.throws(() => validateTransportEvidence(evidence({ credentialReady: null })), /credentialReady/u);
  assert.throws(() => validateTransportEvidence(evidence({ configured: false })), /configured/u);
});
