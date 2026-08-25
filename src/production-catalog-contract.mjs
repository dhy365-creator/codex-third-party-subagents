import { modelEntries, modelId, reduceCatalogForProvider } from './catalog.mjs';

export const PRODUCTION_CATALOG_CONTRACT = Object.freeze({
  codexVersion: '0.149.0',
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  requiredFields: Object.freeze([
    'slug',
    'support_verbosity',
    'truncation_policy',
    'display_name',
    'supported_reasoning_levels',
    'shell_type',
    'visibility',
    'supported_in_api',
    'priority',
    'experimental_supported_tools',
  ]),
});

function reject(field, reason) {
  const error = new Error(`production catalog ${PRODUCTION_CATALOG_CONTRACT.codexVersion} contract rejected ${field}: ${reason}`);
  error.code = 'PRODUCTION_CATALOG_INVALID';
  throw error;
}

function own(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(field, 'object required');
  return value;
}

function boundedString(value, field, { max = 1024, pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max
    || (pattern && !pattern.test(value))) {
    reject(field, 'bounded string required');
  }
  return value;
}

function boundedInteger(value, field, { min = 0, max = 1_000_000_000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) reject(field, 'bounded integer required');
  return value;
}

function validateModalities(model, required) {
  if (!Array.isArray(model.input_modalities) || model.input_modalities.length < 1
    || model.input_modalities.length > 8) {
    reject('input_modalities', 'bounded array required');
  }
  const values = model.input_modalities.map((value) => boundedString(
    value,
    'input_modalities',
    { max: 32, pattern: /^[a-z][a-z0-9_-]*$/u },
  ).toLowerCase());
  if (new Set(values).size !== values.length) reject('input_modalities', 'duplicate values are forbidden');
  const requiredValues = [...(required ?? new Set(['text']))].map((value) => String(value).toLowerCase());
  if (requiredValues.some((value) => !values.includes(value))) {
    reject('input_modalities', 'required modality is missing');
  }
}

function validateReasoningLevels(model) {
  const levels = model.supported_reasoning_levels;
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > 16) {
    reject('supported_reasoning_levels', 'bounded non-empty array required');
  }
  const efforts = [];
  levels.forEach((entry, index) => {
    plainObject(entry, `supported_reasoning_levels[${index}]`);
    efforts.push(boundedString(entry.effort, `supported_reasoning_levels[${index}].effort`, {
      max: 32,
      pattern: /^[a-z][a-z0-9_-]*$/u,
    }));
    boundedString(entry.description, `supported_reasoning_levels[${index}].description`, { max: 512 });
  });
  if (new Set(efforts).size !== efforts.length) {
    reject('supported_reasoning_levels', 'duplicate efforts are forbidden');
  }
}

function validateInstructions(model) {
  const base = typeof model.base_instructions === 'string' ? model.base_instructions.trim() : '';
  const template = typeof model.model_messages?.instructions_template === 'string'
    ? model.model_messages.instructions_template.trim()
    : '';
  if (!base && !template) reject('instructions', 'base instructions or an instructions template is required');
  if (base) boundedString(model.base_instructions, 'base_instructions', { max: 2 * 1024 * 1024 });
  if (template) {
    boundedString(model.model_messages.instructions_template, 'model_messages.instructions_template', {
      max: 2 * 1024 * 1024,
    });
  }
}

function validateModel(model, options) {
  plainObject(model, 'model');
  for (const field of PRODUCTION_CATALOG_CONTRACT.requiredFields) {
    if (!own(model, field)) reject(field, 'required field is missing');
  }
  if (model.slug !== options.model) reject('slug', 'target model identity does not match');
  if (typeof model.support_verbosity !== 'boolean') reject('support_verbosity', 'boolean required');
  boundedString(model.display_name, 'display_name', { max: 256 });
  validateModalities(model, options.requiredModalities);

  const truncation = plainObject(model.truncation_policy, 'truncation_policy');
  if (!['bytes', 'tokens'].includes(truncation.mode)) reject('truncation_policy.mode', 'unsupported mode');
  boundedInteger(truncation.limit, 'truncation_policy.limit', { min: 1 });
  validateReasoningLevels(model);
  boundedString(model.shell_type, 'shell_type', { max: 64, pattern: /^[A-Za-z0-9._-]+$/u });
  boundedString(model.visibility, 'visibility', { max: 64, pattern: /^[A-Za-z0-9._-]+$/u });
  if (typeof model.supported_in_api !== 'boolean') reject('supported_in_api', 'boolean required');
  boundedInteger(model.priority, 'priority', { min: -1000, max: 1000 });
  if (!Array.isArray(model.experimental_supported_tools)
    || model.experimental_supported_tools.length > 64
    || model.experimental_supported_tools.some((value) => (
      typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ))) {
    reject('experimental_supported_tools', 'bounded string array required');
  }
  if (new Set(model.experimental_supported_tools).size !== model.experimental_supported_tools.length) {
    reject('experimental_supported_tools', 'duplicate values are forbidden');
  }
  validateInstructions(model);
}

export function validateProductionCatalog(document, options = {}) {
  const contract = PRODUCTION_CATALOG_CONTRACT;
  if (options.codexVersion !== contract.codexVersion
    || options.providerId !== contract.providerId
    || options.model !== contract.model) {
    reject('compatibility', 'unsupported provider, model, or Codex version');
  }
  const entries = modelEntries(document);
  const matches = entries.filter((entry) => modelId(entry) === contract.model);
  if (matches.length !== 1) reject('models', 'exactly one target model record is required');
  validateModel(matches[0], options);
  const reduced = reduceCatalogForProvider(document, {
    modelId: contract.model,
    requiredModalities: options.requiredModalities,
    outputModalities: options.outputModalities,
  });
  return JSON.parse(JSON.stringify(reduced));
}
