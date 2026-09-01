import path from 'node:path';
import {
  WINDOWS_CREDENTIAL_COMMAND_PATH,
  windowsCredentialCommandArgs,
} from './windows-credential-command.mjs';
import { resolveProviderPack } from './provider-packs.mjs';

export const WINDOWS_PHASE2B_INTENT = 'PHASE_2B_OFFLINE_ONLY';

export function buildWindowsRuntimeCandidate({
  internalValidationIntent,
  nodePath,
  providerId,
  model,
  account,
  prerequisites = {},
} = {}) {
  if (internalValidationIntent !== WINDOWS_PHASE2B_INTENT) {
    throw new Error('Windows runtime candidate requires explicit Phase 2B offline intent');
  }
  if (!path.isAbsolute(nodePath ?? '') || path.basename(nodePath).toLowerCase() !== 'node.exe') {
    throw new Error('Windows runtime candidate Node path must be an absolute node.exe');
  }
  const pack = resolveProviderPack(providerId, model);
  const args = [
    WINDOWS_CREDENTIAL_COMMAND_PATH,
    ...windowsCredentialCommandArgs({ providerPack: pack, account }),
  ];
  const foundationReady = [
    prerequisites.credentialCommandReady,
    prerequisites.privateTreeReady,
    prerequisites.executableReady,
    prerequisites.processTreeReady,
  ].every((value) => value === true);
  return Object.freeze({
    phase: '2A',
    internalOnly: true,
    providerId: pack.id,
    model: pack.model,
    credentialCommand: Object.freeze({
      kind: 'windows-credential-manager', command: nodePath, args: Object.freeze(args),
    }),
    foundationReady,
    installConfigurationReady: foundationReady,
    configurationReady: false,
    providerRuntimeStatus: 'BLOCKED_PENDING_PHASE_2',
    runtimeVerified: false,
    ready: false,
    thirdPartyLiveRequests: 0,
  });
}
