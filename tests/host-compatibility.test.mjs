import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateHostCompatibility,
  HOST_COMPATIBILITY_LEVELS,
  ROLE_FIELD_CONTRACT_0_149,
} from '../src/host-compatibility.mjs';

test('exact 0.147.0 retains historical runtime-verified compatibility', () => {
  const result = evaluateHostCompatibility({ version: '0.147.0', multiAgent: true });
  assert.equal(result.level, HOST_COMPATIBILITY_LEVELS.RUNTIME_VERIFIED);
  assert.equal(result.status, 'HISTORICAL_RUNTIME_VERIFIED');
  assert.equal(result.configurationInstallAllowed, true);
  assert.equal(result.automaticRoutingAllowed, true);
});

test('0.149.0 is blocked because provider fields are inherited from the parent', () => {
  const result = evaluateHostCompatibility({ version: 'codex-cli 0.149.0', multiAgent: true });
  assert.equal(result.level, HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED);
  assert.equal(result.configurationInstallAllowed, false);
  assert.equal(ROLE_FIELD_CONTRACT_0_149.model.roleValue, 'SUPPORTED_ROLE_OVERRIDE');
  assert.equal(ROLE_FIELD_CONTRACT_0_149.model_provider.roleValue, 'IGNORED');
  assert.equal(ROLE_FIELD_CONTRACT_0_149.model_provider.effectiveValue, 'INHERITED_FROM_PARENT');
  const desktop = evaluateHostCompatibility({ version: '0.149.0-alpha.4.1', multiAgent: true });
  assert.equal(desktop.level, HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED);
  const patchRelease = evaluateHostCompatibility({ version: '0.149.7', multiAgent: true });
  assert.equal(patchRelease.level, HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED);
});

test('an unverified Host remains unknown and fails closed', () => {
  const result = evaluateHostCompatibility({ version: '0.148.7', multiAgent: true });
  assert.equal(result.level, HOST_COMPATIBILITY_LEVELS.UNKNOWN);
  assert.equal(result.configurationInstallAllowed, false);
  assert.equal(result.automaticRoutingAllowed, false);
});

test('multi_agent true cannot override an unavailable provider role capability', () => {
  const result = evaluateHostCompatibility({
    version: '0.148.0',
    multiAgent: true,
    roleProviderOverride: false,
  });
  assert.equal(result.level, HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED);
  assert.equal(result.configurationInstallAllowed, false);
});

test('an explicit future provider-override probe can establish configuration-only compatibility', () => {
  const result = evaluateHostCompatibility({
    version: '0.150.0',
    multiAgent: true,
    roleProviderOverride: true,
  });
  assert.equal(result.level, HOST_COMPATIBILITY_LEVELS.CONFIGURATION_COMPATIBLE);
  assert.equal(result.configurationInstallAllowed, true);
  assert.equal(result.automaticRoutingAllowed, false);
});
