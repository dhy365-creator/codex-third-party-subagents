import fs from 'node:fs/promises';
import path from 'node:path';
import { writePrivateFile } from './fs-safety.mjs';
import { superviseProcess } from './supervisor.mjs';

const DISABLED_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'plugin_sharing',
  'skill_search',
]);

export function isolatedChildEnvironment({ codexHome, tmpDir, sourceEnv = process.env } = {}) {
  if (!path.isAbsolute(codexHome ?? '') || !path.isAbsolute(tmpDir ?? '')) {
    throw new Error('isolated CODEX_HOME and TMPDIR must be absolute');
  }
  const executableDir = path.dirname(process.execPath);
  const env = {
    CODEX_HOME: codexHome,
    // CODEX_HOME controls Codex configuration. Keep the OS home only so the
    // command-backed macOS Keychain lookup resolves the user's login keychain.
    HOME: sourceEnv.HOME ?? codexHome,
    TMPDIR: tmpDir,
    PATH: [...new Set([
      executableDir,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ])].join(':'),
    LANG: sourceEnv.LANG ?? 'en_US.UTF-8',
    LC_ALL: sourceEnv.LC_ALL ?? 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const name of ['USER', 'LOGNAME']) {
    if (sourceEnv[name]) env[name] = sourceEnv[name];
  }
  if (Object.keys(env).some((name) => /API_KEY|TOKEN|SECRET|PASSWORD/u.test(name))) {
    throw new Error('child environment contains a credential variable');
  }
  return env;
}

export function externalChildArgs({ cwd, schemaPath, resultPath, sandbox } = {}) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('unsupported child sandbox');
  const featureArgs = DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]);
  return [
    'exec',
    '--strict-config',
    '--ignore-rules',
    '--json',
    '--output-schema', schemaPath,
    '--output-last-message', resultPath,
    '--sandbox', sandbox,
    '--cd', cwd,
    '--skip-git-repo-check',
    ...featureArgs,
    '-',
  ];
}

export async function runExternalChild({
  codexPath,
  codexHome,
  tmpDir,
  cwd,
  schemaPath,
  resultPath,
  stdoutPath,
  stderrPath,
  prompt,
  sandbox,
  timeoutMs,
  graceMs,
  signal,
} = {}) {
  if (!path.isAbsolute(codexPath ?? '') || !path.isAbsolute(cwd ?? '')) {
    throw new Error('codexPath and cwd must be absolute');
  }
  await writePrivateFile(resultPath, '', { exclusive: true });
  const args = externalChildArgs({ cwd, schemaPath, resultPath, sandbox });
  const environment = isolatedChildEnvironment({ codexHome, tmpDir });
  const lifecycle = await superviseProcess({
    command: codexPath,
    args,
    cwd,
    env: environment,
    stdin: prompt,
    stdoutPath,
    stderrPath,
    timeoutMs,
    graceMs,
    signal,
  });
  const resultText = await fs.readFile(resultPath, 'utf8');
  return {
    args,
    environmentKeys: Object.keys(environment).sort(),
    lifecycle,
    resultText,
  };
}
