import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  evaluateHostCompatibility,
  HOST_COMPATIBILITY_LEVELS,
  normalizeCodexVersion,
} from './host-compatibility.mjs';

const execFile = promisify(execFileCallback);
const REQUIRED_FIELDS = Object.freeze(['name', 'description', 'developer_instructions']);
const LEGACY_FIELDS = Object.freeze(['complete', 'fail', 'requestedAgent', 'agent_type']);

function quotedValue(source, name) {
  const match = String(source).match(new RegExp(
    `^${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`,
    'm',
  ));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function tripleQuotedValue(source, name) {
  const match = String(source).match(new RegExp(
    `^${name}\\s*=\\s*"""\\n([\\s\\S]*?)^"""\\s*$`,
    'm',
  ));
  return match?.[1]?.trim() || null;
}

function topLevelFieldNames(source) {
  const names = new Set();
  let inMultiline = false;
  for (const line of String(source).split('\n')) {
    if (line.includes('"""')) inMultiline = !inMultiline;
    if (inMultiline || line.startsWith('[') || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_]+)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

export function parseCustomAgentToml(source) {
  return {
    name: quotedValue(source, 'name'),
    description: quotedValue(source, 'description'),
    developerInstructions: tripleQuotedValue(source, 'developer_instructions'),
    model: quotedValue(source, 'model'),
    modelProvider: quotedValue(source, 'model_provider'),
    fields: topLevelFieldNames(source),
  };
}

export function validateCustomAgentToml(source, expected = {}) {
  const agent = parseCustomAgentToml(source);
  const issues = [];
  for (const field of REQUIRED_FIELDS) {
    const value = field === 'developer_instructions'
      ? agent.developerInstructions
      : agent[field];
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(`required custom-agent field is missing: ${field}`);
    }
  }
  if (expected.name && agent.name !== expected.name) {
    issues.push('custom-agent name does not match the expected worker');
  }
  if (expected.model && agent.model !== expected.model) {
    issues.push('custom-agent model does not match the expected provider profile');
  }
  if (expected.modelProvider && agent.modelProvider !== expected.modelProvider) {
    issues.push('custom-agent model provider does not match the expected provider profile');
  }
  for (const field of LEGACY_FIELDS) {
    if (agent.fields.has(field)) {
      issues.push(`unsupported legacy custom-agent field is present: ${field}`);
    }
  }
  return {
    configured: issues.length === 0,
    issues,
    agent: {
      name: agent.name,
      model: agent.model,
      modelProvider: agent.modelProvider,
      hasDescription: Boolean(agent.description),
      hasDeveloperInstructions: Boolean(agent.developerInstructions),
    },
  };
}

function featureState(output, feature) {
  const line = String(output)
    .split('\n')
    .find((value) => value.trim().startsWith(`${feature} `));
  if (!line) return null;
  const fields = line.trim().split(/\s+/u);
  const value = fields.at(-1);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function versionFrom(output) {
  return normalizeCodexVersion(output);
}

async function defaultCommandRunner(command, args) {
  const { stdout } = await execFile(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export async function inspectCustomAgentHost({
  codexPath = 'codex',
  commandRunner = defaultCommandRunner,
  roleProviderOverride,
} = {}) {
  let versionOutput;
  try {
    versionOutput = await commandRunner(codexPath, ['--version']);
  } catch {
    const compatibility = evaluateHostCompatibility();
    return {
      supported: null,
      version: null,
      multiAgent: null,
      multiAgentV2: null,
      compatibility,
      reason: compatibility.reason,
    };
  }
  let featureOutput;
  try {
    featureOutput = await commandRunner(codexPath, ['features', 'list']);
  } catch {
    const version = versionFrom(versionOutput);
    const compatibility = evaluateHostCompatibility({ version });
    return {
      supported: null,
      version,
      multiAgent: null,
      multiAgentV2: null,
      compatibility,
      reason: compatibility.reason,
    };
  }
  const multiAgent = featureState(featureOutput, 'multi_agent');
  const multiAgentV2 = featureState(featureOutput, 'multi_agent_v2');
  const version = versionFrom(versionOutput);
  const compatibility = evaluateHostCompatibility({
    version,
    multiAgent,
    roleProviderOverride,
  });
  return {
    supported: compatibility.configurationInstallAllowed
      ? true
      : compatibility.level === HOST_COMPATIBILITY_LEVELS.HOST_BLOCKED ? false : null,
    version,
    multiAgent,
    multiAgentV2,
    compatibility,
    reason: compatibility.reason,
  };
}

async function readAgentDirectory(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], issues: [] };
    return { entries: [], issues: ['custom-agent directory could not be read'] };
  }
  const found = [];
  const issues = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.toml')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        issues.push('custom-agent definition is not a regular file');
        continue;
      }
      const source = await fs.readFile(filePath, 'utf8');
      const parsed = parseCustomAgentToml(source);
      const validation = validateCustomAgentToml(source);
      found.push({
        filePath,
        fileName: entry.name,
        name: parsed.name,
        model: parsed.model,
        modelProvider: parsed.modelProvider,
        configured: validation.configured,
      });
    } catch {
      issues.push('custom-agent definition could not be read');
    }
  }
  return { entries: found, issues };
}

export async function inspectCustomAgentDefinitions({
  homeDir = os.homedir(),
  projectRoot = process.cwd(),
  expected = [],
} = {}) {
  const userDirectory = path.join(path.resolve(homeDir), '.codex', 'agents');
  const projectDirectory = path.join(path.resolve(projectRoot), '.codex', 'agents');
  const [user, project] = await Promise.all([
    readAgentDirectory(userDirectory),
    readAgentDirectory(projectDirectory),
  ]);
  const all = [
    ...user.entries.map((entry) => ({ ...entry, scope: 'user' })),
    ...project.entries.map((entry) => ({ ...entry, scope: 'project' })),
  ];
  const byName = new Map();
  for (const entry of all) {
    if (!entry.name) continue;
    const records = byName.get(entry.name) ?? [];
    records.push(entry);
    byName.set(entry.name, records);
  }
  const duplicateNames = [...byName.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([name]) => name)
    .sort();
  const expectedDefinitions = expected.map((definition) => {
    const userIdentityRecords = user.entries.filter((entry) => entry.name === definition.name);
    const projectIdentityRecords = project.entries.filter((entry) => entry.name === definition.name);
    const userTarget = definition.fileName
      ? user.entries.find((entry) => entry.fileName === definition.fileName) ?? null
      : null;
    const projectTarget = definition.fileName
      ? project.entries.find((entry) => entry.fileName === definition.fileName) ?? null
      : null;
    const matched = userTarget ?? userIdentityRecords[0] ?? null;
    const identityRecords = [...userIdentityRecords, ...projectIdentityRecords];
    return {
      name: definition.name,
      present: Boolean(userTarget || userIdentityRecords.length),
      projectPresent: Boolean(projectTarget || projectIdentityRecords.length),
      duplicate: identityRecords.length > 1,
      configured: matched ? matched.configured : null,
      modelMatches: matched ? matched.model === definition.model : null,
      providerMatches: matched ? matched.modelProvider === definition.modelProvider : null,
      fileNameMatches: matched
        ? (!definition.fileName
          || (matched.fileName === definition.fileName && matched.name === definition.name))
        : null,
    };
  });
  return {
    expectedDefinitions,
    duplicateNames,
    projectDuplicateNames: expectedDefinitions
      .filter((definition) => definition.projectPresent)
      .map((definition) => definition.name),
    issues: [...user.issues, ...project.issues],
  };
}
