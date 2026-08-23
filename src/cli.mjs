import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { install } from './installer.mjs';
import { uninstall } from './uninstaller.mjs';
import { verify } from './verifier.mjs';
import { listProviderPackIds, DEFAULT_PROVIDER_ID } from './provider-packs.mjs';

const VALUE_FLAGS = new Set([
  'plan',
  'provider',
  'model',
  'spark-available',
  'luna-available',
  'threshold',
  'catalog-source',
  'setup-script-url',
]);
const BOOLEAN_FLAGS = new Set([
  'apply',
  'confirm-main-preserved',
  'consent-data',
  'migrate-legacy',
  'skip-keychain-check',
  'help',
]);

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      result[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function yes(value) {
  return /^(?:y|yes|true|1)$/i.test(String(value).trim());
}

async function askInstallOptions(parsed, streams = { input, output }) {
  const interactive = streams.input.isTTY && streams.output.isTTY;
  let rl;
  const ask = async (question, fallback) => {
    if (!interactive) return fallback;
    rl ??= createInterface(streams);
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  };
  try {
    const availableProviders = listProviderPackIds();
    const provider = (
      parsed.provider
      ?? await ask(`Provider pack [${DEFAULT_PROVIDER_ID}] (available: ${availableProviders.join(', ')}): `, DEFAULT_PROVIDER_ID)
    ).toLowerCase();
    const model = parsed.model
      ?? (provider === 'deepseek'
        ? await ask('DeepSeek model profile (flash/pro) [flash]: ', 'flash')
        : undefined);
    const plan = (parsed.plan ?? await ask('Subscription plan (plus/pro) [plus]: ', 'plus')).toLowerCase();
    const plus = plan === 'plus';
    const sparkAvailable = parsed['spark-available']
      ?? await ask(`Spark worker available? [${plus ? 'no' : 'yes'}]: `, plus ? 'no' : 'yes');
    const lunaAvailable = parsed['luna-available']
      ?? await ask('Luna worker available? [yes]: ', 'yes');
    const threshold = parsed.threshold
      ?? await ask(`Fallback threshold percent [${plus ? '50' : '10'}]: `, plus ? '50' : '10');
    const confirmMainPreserved = parsed['confirm-main-preserved']
      ?? yes(await ask('Keep the main model/provider/auth unchanged? [yes]: ', 'yes'));
    const consentData = parsed['consent-data']
      ?? yes(await ask(`Allow suitable provider tasks and bridge task bodies to be delegated to ${provider}? [no]: `, 'no'));
    return {
      apply: parsed.apply === true,
      provider,
      model,
      plan,
      sparkAvailable,
      lunaAvailable,
      threshold,
      confirmMainPreserved: confirmMainPreserved === true,
      consentData: consentData === true,
      migrateLegacy: parsed['migrate-legacy'] === true,
      catalogSource: parsed['catalog-source'] ?? 'auto',
      setupScriptUrl: parsed['setup-script-url'],
    };
  } finally {
    rl?.close();
  }
}

function installHelp() {
  return `Usage: node scripts/install.mjs [options]\n\n` +
    `Dry-run is the default. Add --apply to write files.\n\n` +
    `  --provider <provider-pack-id>\n` +
    `  --model <profile-or-model-id>\n` +
    `  --plan <plus|pro>\n` +
    `  --spark-available <true|false>\n` +
    `  --luna-available <true|false>\n` +
    `  --threshold <0-100>\n` +
    `  --confirm-main-preserved\n` +
   `  --consent-data\n` +
    `  --migrate-legacy (adopt a matching existing Custom Agent with a backup)\n` +
   `  --catalog-source <auto|local-path>\n` +
    `  --setup-script-url <official-provider-url>\n` +
    `  --apply\n`;
}

function uninstallHelp() {
  return 'Usage: node scripts/uninstall.mjs [--provider <provider-pack-id>] [--apply]\nDry-run is the default. Uninstall removes every installed profile for that provider; Keychain credentials and bridge archives are never removed.\n';
}

function summarizeInstall(result) {
  return {
    applied: result.applied,
    dryRun: result.dryRun,
    changedFiles: result.managedFiles.filter((file) => file.changed).map((file) => file.path),
    manifestPath: result.manifestPath,
    catalogAcquired: result.catalogAcquired,
    keychainVerified: result.keychainVerified,
    customAgents: result.customAgents,
    hostCompatibility: result.customAgents?.host?.compatibility ?? null,
    migration: result.migration,
    profile: result.profile,
    profiles: result.profiles,
    message: result.message,
  };
}

export function summarizeVerify(result) {
  const summary = {
    configured: result.configured,
    discoverable: result.discoverable,
    providerResolved: result.providerResolved,
    taskDelivered: result.taskDelivered,
    runtimeExecuted: result.runtimeExecuted,
    runtimeVerified: result.runtimeVerified,
    configurationReady: result.configurationReady,
    ready: result.ready,
    credentialReady: result.credentialReady,
    hostCompatibility: result.hostCompatibility,
    profile: result.profile,
    agentEvidence: result.agentEvidence,
    runtimeEvidence: result.runtimeEvidence,
    issues: result.issues,
    warnings: result.warnings,
  };
  if (result.ready === true && result.credentialReady === true) {
    summary.POST_INSTALL_STATUS = 'SUCCESS';
  }
  return summary;
}

async function run(main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? 'command failed'}\n`);
    process.exitCode = 1;
  }
}

export function installCli(argv = process.argv.slice(2)) {
  return run(async () => {
    const parsed = parseArgs(argv);
    if (parsed.help) return process.stdout.write(installHelp());
    const result = await install(await askInstallOptions(parsed));
    process.stdout.write(`${JSON.stringify(summarizeInstall(result), null, 2)}\n`);
  });
}

export function verifyCli(argv = process.argv.slice(2)) {
  return run(async () => {
    const parsed = parseArgs(argv);
    if (parsed.help) return process.stdout.write('Usage: node scripts/verify.mjs [--skip-keychain-check]\n');
    const result = await verify({
      checkKeychain: parsed['skip-keychain-check'] !== true,
      provider: parsed.provider,
      model: parsed.model,
    });
    process.stdout.write(`${JSON.stringify(summarizeVerify(result), null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
  });
}

export function uninstallCli(argv = process.argv.slice(2)) {
  return run(async () => {
    const parsed = parseArgs(argv);
    if (parsed.help) return process.stdout.write(uninstallHelp());
    const result = await uninstall({
      apply: parsed.apply === true,
      provider: parsed.provider,
      model: parsed.model,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.conflicts.length) process.exitCode = 1;
  });
}
