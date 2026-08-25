import {
  EXTERNAL_CODEX_TRANSPORT_ENABLED,
  EXTERNAL_ERROR_CODES,
} from './external-codex.mjs';

export const TRANSPORT_REGISTRY = Object.freeze({
  'external-codex': Object.freeze({
    name: 'external-codex',
    enabled: EXTERNAL_CODEX_TRANSPORT_ENABLED,
    billable: true,
    factory: null,
    disabledReason: EXTERNAL_ERROR_CODES.DISABLED,
  }),
});

export function describeTransportRegistry() {
  return Object.freeze(Object.values(TRANSPORT_REGISTRY).map((entry) => Object.freeze({ ...entry })));
}

export function resolveEnabledTransportFactory(name) {
  const entry = TRANSPORT_REGISTRY[name];
  if (!entry) throw new Error(`unknown transport: ${name}`);
  if (!entry.enabled || typeof entry.factory !== 'function') {
    const error = new Error(`${name} transport is disabled`);
    error.code = entry.disabledReason;
    throw error;
  }
  return entry.factory;
}
