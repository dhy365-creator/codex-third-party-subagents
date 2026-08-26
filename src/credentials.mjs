import { keychainReady } from './keychain.mjs';
import {
  deleteWindowsCredential,
  retrieveWindowsCredential,
  storeWindowsCredential,
  windowsCredentialReady,
} from './credentials/windows-credential-manager.mjs';

export function credentialBackend(platform = process.platform) {
  if (platform === 'darwin') return 'macos-keychain';
  if (platform === 'win32') return 'windows-credential-manager';
  const error = new Error('credential platform is unsupported');
  error.code = 'CREDENTIAL_PLATFORM_UNSUPPORTED';
  throw error;
}

export async function credentialReady(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return keychainReady(options);
  if (platform === 'win32') return windowsCredentialReady(options);
  credentialBackend(platform);
}

export async function storeCredential(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return storeWindowsCredential(options);
  const error = new Error('credential store is not managed by this platform adapter');
  error.code = 'CREDENTIAL_STORE_UNSUPPORTED';
  throw error;
}

export async function retrieveCredential(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return retrieveWindowsCredential(options);
  const error = new Error('credential retrieval is not exposed by this platform adapter');
  error.code = 'CREDENTIAL_RETRIEVE_UNSUPPORTED';
  throw error;
}

export async function deleteCredential(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return deleteWindowsCredential(options);
  const error = new Error('credential deletion is not managed by this platform adapter');
  error.code = 'CREDENTIAL_DELETE_UNSUPPORTED';
  throw error;
}
