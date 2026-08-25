export const HOST_COMPATIBILITY_LEVELS = Object.freeze({
  RUNTIME_VERIFIED: 'LEVEL_A_RUNTIME_VERIFIED',
  CONFIGURATION_COMPATIBLE: 'LEVEL_B_CONFIGURATION_COMPATIBLE',
  HOST_BLOCKED: 'LEVEL_C_HOST_BLOCKED',
  UNKNOWN: 'LEVEL_D_UNKNOWN',
});

export const ROLE_FIELD_CONTRACT_0_149 = Object.freeze({
  model: { roleValue: 'SUPPORTED_ROLE_OVERRIDE', effectiveValue: 'ROLE_OVERRIDE' },
  model_reasoning_effort: { roleValue: 'SUPPORTED_ROLE_OVERRIDE', effectiveValue: 'ROLE_OVERRIDE' },
  developer_instructions: { roleValue: 'SUPPORTED_ROLE_OVERRIDE', effectiveValue: 'ROLE_OVERRIDE' },
  skills_and_feature_reductions: {
    roleValue: 'SUPPORTED_ROLE_OVERRIDE',
    effectiveValue: 'REDUCTIONS_ONLY',
  },
  model_provider: { roleValue: 'IGNORED', effectiveValue: 'INHERITED_FROM_PARENT' },
  model_providers: { roleValue: 'IGNORED', effectiveValue: 'INHERITED_FROM_PARENT' },
  model_catalog_json: { roleValue: 'IGNORED', effectiveValue: 'INHERITED_FROM_PARENT' },
  auth_and_provider_endpoint: { roleValue: 'IGNORED', effectiveValue: 'INHERITED_FROM_PARENT' },
});

const CONTRACT_SOURCE = 'https://github.com/openai/codex/pull/39299';

export function normalizeCodexVersion(value) {
  return String(value ?? '').match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u)?.[1] ?? null;
}

function result({ level, version, status, reason }) {
  const configurationInstallAllowed = [
    HOST_COMPATIBILITY_LEVELS.RUNTIME_VERIFIED,
    HOST_COMPATIBILITY_LEVELS.CONFIGURATION_COMPATIBLE,
  ].includes(level);
  const automaticRoutingAllowed = level === HOST_COMPATIBILITY_LEVELS.RUNTIME_VERIFIED;
  return {
    level,
    status,
    version,
    versionSource: 'codex --version',
    contractSource: CONTRACT_SOURCE,
    configurationInstallAllowed,
    automaticRoutingAllowed,
    bridgeCreationAllowed: automaticRoutingAllowed,
    reason,
  };
}

export function evaluateHostCompatibility({
  version,
  multiAgent,
  roleProviderOverride,
} = {}) {
  const normalizedVersion = normalizeCodexVersion(version);
  const stableVersion = normalizedVersion?.split('-')[0] ?? null;

  if (multiAgent === false || roleProviderOverride === false) {
    return result({
      level: HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED,
      version: normalizedVersion,
      status: 'HOST_BLOCKED',
      reason: multiAgent === false
        ? 'Codex multi_agent is disabled; cross-provider child dispatch is unavailable'
        : 'the Host reports that a child role cannot override its parent provider',
    });
  }

  if (/^0\.149\.\d+$/u.test(stableVersion ?? '')) {
    return result({
      level: HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED,
      version: normalizedVersion,
      status: 'HOST_BLOCKED',
      reason: `Codex ${normalizedVersion} is in the 0.149.x line, whose role overrides inherit provider configuration from the parent`,
    });
  }

  if (normalizedVersion === '0.147.0' && multiAgent === true) {
    return result({
      level: HOST_COMPATIBILITY_LEVELS.RUNTIME_VERIFIED,
      version: normalizedVersion,
      status: 'HISTORICAL_RUNTIME_VERIFIED',
      reason: 'exact Codex 0.147.0 matches the project historical cross-provider Flash and Pro E2E evidence',
    });
  }

  if (normalizedVersion && multiAgent === true && roleProviderOverride === true) {
    return result({
      level: HOST_COMPATIBILITY_LEVELS.CONFIGURATION_COMPATIBLE,
      version: normalizedVersion,
      status: 'CONFIGURATION_COMPATIBLE',
      reason: 'role provider override capability is present, but this exact Host has no project runtime E2E',
    });
  }

  return result({
    level: HOST_COMPATIBILITY_LEVELS.UNKNOWN,
    version: normalizedVersion,
    status: 'UNKNOWN',
    reason: normalizedVersion
      ? `Codex ${normalizedVersion} has no attributable project cross-provider Host contract evidence`
      : 'the Codex Host version or cross-provider role capability could not be established',
  });
}

export function publicHostCompatibility(compatibility) {
  return {
    level: compatibility.level,
    status: compatibility.status,
    version: compatibility.version,
    versionSource: compatibility.versionSource,
    contractSource: compatibility.contractSource,
    configurationInstallAllowed: compatibility.configurationInstallAllowed,
    automaticRoutingAllowed: compatibility.automaticRoutingAllowed,
    bridgeCreationAllowed: compatibility.bridgeCreationAllowed,
    reason: compatibility.reason,
  };
}
