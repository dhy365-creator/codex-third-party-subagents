import path from 'node:path';
import { PACKAGE_NAME, RUNTIME_NAMESPACE } from './provider-packs.mjs';

// Preserve the existing marker contract across the public project rename.
export const AGENTS_START = `<!-- ${RUNTIME_NAMESPACE}:start -->`;
export const AGENTS_END = `<!-- ${RUNTIME_NAMESPACE}:end -->`;

function toml(value) {
  return JSON.stringify(String(value ?? ''));
}

function shellQuoted(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function agentsBlock({
  nodePath,
  preflightPath,
  bridgePath,
  threshold,
  sparkAvailable,
  lunaAvailable,
  providerPack,
  providerRole,
  providerProfiles,
  defaultProviderRole,
} = {}) {
  const provider = providerPack?.displayName ?? providerRole ?? 'third-party provider';
  const profiles = providerProfiles?.length ? providerProfiles : [providerPack].filter(Boolean);
  const profileSummary = profiles
    .map((profile) => `${profile.role} -> ${profile.model}`)
    .join(', ');
  const defaultRole = defaultProviderRole ?? providerRole ?? providerPack?.role ?? null;
  const defaultProfile = profiles.find((profile) => profile.role === defaultRole) ?? null;
  const explicitProfiles = profiles.filter((profile) => profile.role !== defaultRole);
  return [
    AGENTS_START,
    `## ${PACKAGE_NAME} routing guardrail`,
    `- Keep the main Codex thread on its configured OpenAI model, provider, and auth.`,
    '- Before every `spawn_agent` / `followup_task`, run the preflight command below with a version-1 JSON request containing `operation`, `requestedAgent`, `taskName`, exact `message`, `cwd`, and `providerSuitable`.',
    '- A follow-up also includes `existingAgentType` and `target`.',
    `- Command: ${shellQuoted(nodePath)} ${shellQuoted(preflightPath)}`,
    '- Apply the returned `action`, `agentType`, `target`, and `forkTurns` exactly, and stop on `deny`.',
    '- The preflight must confirm the exact Host compatibility contract before provider routing or bridge creation. A blocked or unknown Host always fails closed to an OpenAI role or deny.',
    '- The official Custom Agent TOML `name` is the Host identity source. This routing guard only selects a declared role; it never registers, renames, or overrides a Host agent.',
    '- Never send a live probe task merely to discover quota.',
    `- When provider fallback is selected, spawn/follow with only a minimal instruction to use the configured bridge; the exact task is already in the owner-only bridge. For OpenAI roles, send the scoped task normally.`,
    '- Do not use status-only messaging to assign a new scoped task. Confirm that the provider bridge was archived before starting another provider task.',
    `- Installed worker profiles: ${profileSummary || `${provider} worker profile`}.`,
    defaultProfile
      ? `- Default provider fallback remains ${defaultProfile.role} -> ${defaultProfile.model}; it is considered only below the ${provider} threshold of ${threshold}%. At the threshold use Luna.`
      : `- No provider role is configured for automatic fallback; keep suitable work on Spark or Luna unless an installed provider role is explicitly requested.`,
    ...(explicitProfiles.length
      ? [`- Explicit-only provider roles: ${explicitProfiles.map((profile) => `${profile.role} -> ${profile.model}`).join(', ')}. Never auto-route to them or silently substitute them for the default role.`]
      : []),
    `- Provider fallback is limited to text, code, research synthesis, and local validation. Never delegate credentials, images, audio, video, desktop control, browser control, MCP, or computer use.`,
    `- Bridge root: ${shellQuoted(bridgePath)}. It is a single owner-only slot; never overwrite an active task or delete an archive.`,
    '- The Codex Desktop may not enforce this hook natively. The main agent must run it manually; treat this as a policy-assisted guardrail, not a security boundary.',
    AGENTS_END,
  ].join('\n');
}

export function agentToml({
  catalogPath,
  bridgePath,
  bridgeCliPath,
  nodePath,
  keychainAccount,
  keychainService,
  providerPack,
} = {}) {
  const pack = providerPack ?? {};
  const providerRole = pack.role ?? 'provider_worker';
  const provider = pack.modelProvider ?? 'provider';
  const model = pack.model ?? 'unknown-model';
  const instructions = [
    `You are an implementation-focused fallback worker for ${pack.displayName ?? provider}.`,
    `Handle bounded text, code, research-synthesis, and local-validation tasks from the configured bridge.`,
    'Do not handle credentials, images, audio, video, desktop control, browser control, destructive changes, public API changes, or persisted-schema changes without explicit user approval.',
    'Preserve unrelated and uncommitted workspace changes. Prefer minimal diffs and run relevant local checks.',
    `At the start of every turn, read only ${bridgePath}/active/task.json. Verify its parent directory is owner-only 0700, the file is owner-only 0600, version is 1, status is pending or running, and taskBasename matches the final normalized component of taskName.`,
    `Verify the active task identifies providerId ${toml(pack.id)}, providerRole ${toml(providerRole)}, and model ${toml(model)} before doing any work.`,
    'Treat only message as the task and cwd as its working directory. If the bridge is absent or invalid, report failure and do not guess from encrypted content or scan archives.',
    `Before a successful final response run: ${shellQuoted(nodePath)} ${shellQuoted(bridgeCliPath)} complete "<taskBasename>"`,
    `If the task cannot complete run: ${shellQuoted(nodePath)} ${shellQuoted(bridgeCliPath)} fail "<taskBasename>"`,
    'Never print the task body or a credential. Report changed files, tests, failures, and residual risks.',
  ].join('\n');

  return [
    `name = "${providerRole}"`,
    `description = "Fallback worker using ${pack.displayName ?? pack.modelProvider ?? 'provider'} ${model}."`,
    `model = "${model}"`,
    `model_provider = "${provider}"`,
    'model_reasoning_effort = "high"',
    ...(pack.modelContextWindow ? [`model_context_window = ${pack.modelContextWindow}`] : []),
    `model_catalog_json = ${toml(catalogPath)}`,
    '',
    'developer_instructions = """',
    instructions,
    '"""',
    '',
    `[model_providers.${provider}]`,
    `name = "${pack.modelProviderName ?? provider}"`,
    `base_url = ${toml(pack.apiBase ?? 'https://example.invalid/')}`,
    `wire_api = ${toml(pack.wireApi ?? 'responses')}`,
    '',
    `[model_providers.${provider}.auth]`,
    `command = ${toml('/usr/bin/security')}`,
    `args = ["find-generic-password", "-a", ${toml(keychainAccount)}, "-s", ${toml(keychainService ?? pack.keychainService)}, "-w"]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
  ].join('\n');
}

export function workerConfig(options = {}) {
  const customAgents = (options.customAgents ?? []).map((agent) => ({
    name: agent.name,
    model: agent.model,
    modelProvider: agent.modelProvider,
  }));
  const profiles = (options.profiles ?? []).map((profile) => ({
    id: profile.id ?? profile.profile,
    providerRole: profile.providerRole ?? profile.role,
    model: profile.model,
    agentPath: profile.agentPath,
    catalogPath: profile.catalogPath,
  }));
  return `${JSON.stringify({
    schemaVersion: 1,
    role: options.providerRole,
    providerId: options.providerId,
    providerRole: options.providerRole,
    model: options.model,
    modelProfile: options.modelProfile,
    profiles,
    customAgents,
    hostCompatibility: options.hostCompatibility,
    defaultProviderRole: options.defaultProviderRole === undefined
      ? options.providerRole
      : options.defaultProviderRole,
    plan: options.plan,
    sparkAvailable: Boolean(options.sparkAvailable),
    lunaAvailable: Boolean(options.lunaAvailable),
    threshold: options.threshold,
    apiBase: options.apiBase,
    catalogSource: options.catalogSource,
    setupScriptUrl: options.setupScriptUrl,
    bridgePath: options.bridgePath,
    agentPath: options.agentPath,
    catalogPath: options.catalogPath,
    configPath: options.configPath,
    keychainAccount: options.keychainAccount,
    keychainService: options.keychainService,
    platform: 'darwin',
    mainModelPreserved: true,
    delegatedDataConsent: true,
    providerCapabilities: options.providerCapabilities,
  }, null, 2)}\n`;
}

export function preflightWrapper({ runtimeDir, configPath } = {}) {
  const modulePath = path.join(runtimeDir, 'preflight-runtime.mjs');
  return [
    '#!/usr/bin/env node',
    `import { preflightMain } from ${toml(modulePath)};`,
    `await preflightMain(${toml(configPath)});`,
    '',
  ].join('\n');
}

export function bridgeWrapper({ runtimeDir } = {}) {
  const modulePath = path.join(runtimeDir, 'bridge-cli.mjs');
  return [
    '#!/usr/bin/env node',
    `import { bridgeMain } from ${toml(modulePath)};`,
    'await bridgeMain();',
    '',
  ].join('\n');
}

function markerPositions(source) {
  const startPattern = new RegExp(AGENTS_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const endPattern = new RegExp(AGENTS_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const starts = [...source.matchAll(startPattern)];
  const ends = [...source.matchAll(endPattern)];
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) {
    throw new Error('AGENTS.md contains malformed managed routing markers');
  }
  if (!starts.length) return null;
  if (ends[0].index < starts[0].index) throw new Error('AGENTS.md marker order is invalid');
  return { start: starts[0].index, end: ends[0].index + AGENTS_END.length };
}

export function replaceAgentsBlock(existing, block) {
  const source = String(existing ?? '');
  const positions = markerPositions(source);
  if (!positions) {
    return `${source}${source && !source.endsWith('\n') ? '\n' : ''}${block}\n`;
  }
  return `${source.slice(0, positions.start)}${block}${source.slice(positions.end)}`;
}

export function extractAgentsBlock(source) {
  const text = String(source ?? '');
  const positions = markerPositions(text);
  return positions ? text.slice(positions.start, positions.end) : null;
}

export function removeAgentsBlock(source, expectedBlock) {
  const text = String(source ?? '');
  const positions = markerPositions(text);
  if (!positions) return { changed: false, text };
  const current = text.slice(positions.start, positions.end);
  if (current !== expectedBlock) throw new Error('managed AGENTS.md block was modified');
  const before = text.slice(0, positions.start).replace(/[ \t]+$/u, '');
  const after = text.slice(positions.end).replace(/^\n/u, '');
  const combined = `${before}${after}`;
  return { changed: true, text: combined && !combined.endsWith('\n') ? `${combined}\n` : combined };
}
