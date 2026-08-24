#!/usr/bin/env node
import path from 'node:path';
import { EXTERNAL_FLASH_FEATURE_GATE } from '../src/external-flash-gate.mjs';
import { runExternalFlashProductionE2E } from '../src/external-flash-runtime.mjs';
import { readExternalLiveRequestLedger } from '../src/external-live-request-ledger.mjs';
import { redactText } from '../src/transports/external-redaction.mjs';

const VALUE_FLAGS = new Set([
  'state-root', 'billing-ledger-root', 'codex', 'catalog', 'cwd', 'approved-root',
  'parent-codex-home', 'authorization-id',
]);
const BOOLEAN_FLAGS = new Set(['execute', 'enable-external-flash', 'authorize-billable', 'help']);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('unexpected argument');
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) result[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      result[name] = value;
    } else throw new Error(`unknown option: --${name}`);
  }
  return result;
}

function help() {
  return [
    'Controlled maintainer entry point for one DeepSeek V4 Flash production-path E2E.',
    'BILLABLE PROVIDER REQUEST: requires all three explicit flags.',
    '',
    'Required flags:',
    '  --execute --enable-external-flash --authorize-billable',
    '  --state-root <absolute> --billing-ledger-root <absolute>',
    '  --codex <absolute> --catalog <absolute>',
    '  --cwd <absolute> --approved-root <absolute> --parent-codex-home <absolute>',
    '  --authorization-id <bounded-id>',
    '',
  ].join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) return process.stdout.write(help());
  if (!parsed.execute || !parsed['enable-external-flash'] || !parsed['authorize-billable']) {
    throw new Error('execution, feature gate, and billable authorization flags are all required');
  }
  for (const name of VALUE_FLAGS) {
    if (!parsed[name]) throw new Error(`--${name} is required`);
  }
  for (const name of [...VALUE_FLAGS].filter((value) => value !== 'authorization-id')) {
    if (!path.isAbsolute(parsed[name])) throw new Error(`--${name} requires an absolute path`);
  }
  const options = {
    stateRoot: path.resolve(parsed['state-root'] ?? ''),
    billingLedgerRoot: path.resolve(parsed['billing-ledger-root'] ?? ''),
    codexPath: path.resolve(parsed.codex ?? ''),
    catalogSource: path.resolve(parsed.catalog ?? ''),
    cwd: path.resolve(parsed.cwd ?? ''),
    approvedRoot: path.resolve(parsed['approved-root'] ?? ''),
    parentCodexHome: path.resolve(parsed['parent-codex-home'] ?? ''),
    authorizationId: parsed['authorization-id'],
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
  };
  process.stderr.write('BILLABLE PROVIDER REQUEST: DeepSeek V4 Flash, maximum task ledger limit 3\n');
  try {
    const result = await runExternalFlashProductionE2E(options);
    process.stdout.write(`${JSON.stringify({
      status: 'completed',
      requestCount: result.requestCount,
      requestLimit: result.requestLimit,
      fixtureRequestCount: result.fixtureRequestCount,
      providerId: result.providerId,
      model: result.model,
      transport: result.transport,
      taskDelivered: result.taskDelivered,
      runtimeExecuted: result.runtimeExecuted,
      runtimeVerified: result.runtimeVerified,
      challengeVerified: result.challengeVerified,
      evidenceId: result.evidenceId,
      credentialPreflight: result.credentialPreflight,
    }, null, 2)}\n`);
  } catch (error) {
    const count = await readExternalLiveRequestLedger(options.billingLedgerRoot)
      .then((ledger) => ledger.attempts.length, () => null);
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      requestCount: count,
      code: error?.code ?? 'EXTERNAL_FLASH_E2E_FAILED',
      reason: redactText(error?.message ?? 'External Flash E2E failed', {
        cwd: options.cwd,
        homePath: options.parentCodexHome,
      }),
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
