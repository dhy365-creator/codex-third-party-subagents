import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EVIDENCE_SOURCES } from '../src/transport-evidence.mjs';
import { writeExternalFlashEvidence } from '../src/external-evidence-store.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';
import { buildTransportVerification } from '../src/transport-verification.mjs';
import { resolveProviderPack } from '../src/provider-packs.mjs';
import { verify } from '../src/verifier.mjs';

const hash = 'c'.repeat(64);

function evidence(evidenceSource, overrides = {}) {
  return {
    schemaVersion: 1,
    taskName: 'bounded-coding',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: 'external-codex',
    configured: true,
    discoverable: null,
    providerResolved: true,
    taskDelivered: true,
    runtimeExecuted: true,
    runtimeVerified: true,
    configurationReady: true,
    ready: true,
    credentialReady: true,
    evidenceSource,
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

function baseResult(overrides = {}) {
  return {
    configured: true,
    discoverable: true,
    providerResolved: false,
    taskDelivered: false,
    runtimeExecuted: false,
    runtimeVerified: false,
    configurationReady: false,
    ready: false,
    credentialReady: true,
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildTransportVerification({
    result: baseResult(),
    providerPack: resolveProviderPack('deepseek', 'flash'),
    host: { version: '0.149.0' },
    codexBinary: '/Applications/Codex.app/Contents/Resources/codex',
    ...overrides,
  });
}

test('Verifier state keeps Native and External readiness separate on 0.149', () => {
  const checked = build();
  assert.equal(checked.transport, 'native');
  assert.equal(checked.providerId, 'deepseek');
  assert.equal(checked.model, 'deepseek-v4-flash');
  assert.equal(checked.codexBinary, 'codex');
  assert.equal(checked.transports.native.runtimeVerified, false);
  assert.equal(checked.transports.external.modulePresent, true);
  assert.equal(checked.transports.external.featureEnabled, false);
  assert.equal(checked.transports.external.localEvidenceAvailable, false);
  assert.equal(checked.transports.external.runtimeVerified, false);
  assert.equal(checked.transports.external.ready, false);
  assert.equal(checked.transports.external.maintainerEvidence.available, true);
});

test('maintainer evidence never becomes local installation runtime verification', () => {
  const checked = build({
    externalEvidence: evidence(EVIDENCE_SOURCES.MAINTAINER_CONTROLLED),
  });
  const external = checked.transports.external;
  assert.equal(external.submittedEvidenceSource, EVIDENCE_SOURCES.MAINTAINER_CONTROLLED);
  assert.equal(external.localEvidenceAvailable, false);
  assert.equal(external.providerResolved, false);
  assert.equal(external.runtimeVerified, false);
  assert.equal(external.evidenceSource, null);
});

test('only strict local evidence can populate External provider and runtime fields', () => {
  const checked = build({
    externalConfigured: true,
    externalPrerequisitesReady: true,
    externalEvidence: evidence(EVIDENCE_SOURCES.LOCAL_INSTALLATION),
  });
  const external = checked.transports.external;
  assert.equal(external.localEvidenceAvailable, true);
  assert.equal(external.providerResolved, true);
  assert.equal(external.taskDelivered, true);
  assert.equal(external.runtimeExecuted, true);
  assert.equal(external.runtimeVerified, true);
  assert.equal(external.configurationReady, false);
  assert.equal(external.ready, false);
  assert.equal(external.featureEnabled, false);
  assert.equal(external.eligibility.eligible, false);
});

test('result self-report and tuple substitution are rejected as evidence', () => {
  assert.throws(() => build({
    externalEvidence: {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      runtimeVerified: true,
    },
  }), /fields do not match/);
  assert.throws(() => build({
    externalEvidence: evidence(EVIDENCE_SOURCES.LOCAL_INSTALLATION, {
      providerId: 'openai',
      providerAttribution: {
        sessionRef: 'runtime:session-1',
        providers: ['openai'],
        models: ['deepseek-v4-flash'],
        endpointRef: 'runtime:provider-endpoint',
      },
    }),
  }), /selected provider\/model tuple/);
});

test('Pro and other provider tuples do not inherit Flash maintainer evidence', () => {
  const pro = buildTransportVerification({
    result: baseResult(),
    providerPack: resolveProviderPack('deepseek', 'pro'),
    host: { version: '0.149.0' },
  });
  assert.equal(pro.transports.external.maintainerEvidence.available, false);
  assert.equal(pro.transports.external.maintainerEvidence.runtimeEvidence, 'UNKNOWN');
});

test('ordinary Verifier consumes stored strict Flash evidence without a live request', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-verifier-evidence-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const runtimeRoot = path.join(
    homeDir,
    '.codex',
    'external-transports',
    'codex-third-party-workers',
  );
  await writeExternalFlashEvidence(runtimeRoot, evidence(EVIDENCE_SOURCES.LOCAL_INSTALLATION));
  const compatibility = evaluateHostCompatibility({ version: '0.149.0', multiAgent: true });
  const checked = await verify({
    homeDir,
    provider: 'deepseek',
    model: 'flash',
    checkKeychain: false,
    customAgentHost: { version: '0.149.0', multiAgent: true, compatibility },
  });
  assert.equal(checked.transports.external.localEvidenceAvailable, true);
  assert.equal(checked.transports.external.runtimeVerified, true);
  assert.equal(checked.transports.external.featureEnabled, false);
  assert.equal(checked.transports.external.eligibility.eligible, false);
});
