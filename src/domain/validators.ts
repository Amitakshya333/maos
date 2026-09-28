/**
 * MAOS Domain Validators
 *
 * Pure validation functions for each domain schema.
 * No Node.js API dependencies — can be shared with Rust/Python via JSON Schema generation.
 *
 * Each validator returns { valid: boolean; errors: string[] }.
 * Validators check:
 *   - Required fields present and correct type
 *   - String length bounds
 *   - Enum membership
 *   - Array count bounds
 *   - schemaVersion matches expected value
 */

import {
  MAX_PROJECT_NAME_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_FINDING_METRIC_LENGTH,
  MAX_EVIDENCE_CRITERIA_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_PATH_LENGTH,
  MAX_HASH_LENGTH,
  MAX_CHILDREN_PER_WORKFLOW,
  MAX_PLAN_HISTORY_ENTRIES,
  MAX_TAGS_PER_ENTITY,
  TASK_MODALITIES,
  TASK_MODEL_PARAMETER_TIERS,
  TASK_DEVICE_PREFERENCES,
  TASK_QUANTIZATIONS,
  ExtendedTaskRequirements,
  TaskModality,
} from './schemas';
import {
  MAX_INFERENCE_TEXT_LENGTH,
  MAX_INFERENCE_ATTACHMENTS,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_REASONING_CODES,
  MAX_EVIDENCE_REFERENCES,
  INFERENCE_STATUSES,
} from './inference';
import {
  WORKFLOW_STEP_TYPES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_PLAN_STATUSES,
  MAX_WORKFLOW_PLAN_STEPS,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEP_DEPENDENCIES,
  MAX_PLAN_ID_LENGTH,
} from './workflow-plan-constants';
import {
  APPROVAL_CATEGORIES,
  MAX_CONTRACT_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_CONTRACT_ARTIFACTS,
} from './tool-plan-constants';
import {
  ALL_COCKPIT_STAGE_STATUSES,
  ALL_COCKPIT_RUN_STATUSES,
  MAX_COCKPIT_NODES,
  MAX_COCKPIT_EDGES,
} from './cockpit';

// ── Validation Result ─────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

export function fail(errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return isArray(v) && v.every(isString);
}

function checkRequired(obj: Record<string, unknown>, field: string, type: string, errors: string[]): boolean {
  const val = obj[field];
  if (val === undefined || val === null) {
    errors.push(`Missing required field: ${field}`);
    return false;
  }
  if (type === 'string' && !isString(val)) {
    errors.push(`Field "${field}" must be a string, got ${typeof val}`);
    return false;
  }
  if (type === 'number' && !isNumber(val)) {
    errors.push(`Field "${field}" must be a number, got ${typeof val}`);
    return false;
  }
  if (type === 'boolean' && !isBoolean(val)) {
    errors.push(`Field "${field}" must be a boolean, got ${typeof val}`);
    return false;
  }
  if (type === 'object' && !isObject(val)) {
    errors.push(`Field "${field}" must be an object, got ${typeof val}`);
    return false;
  }
  if (type === 'array' && !isArray(val)) {
    errors.push(`Field "${field}" must be an array, got ${typeof val}`);
    return false;
  }
  return true;
}

function checkStringBound(obj: Record<string, unknown>, field: string, max: number, errors: string[]): void {
  const val = obj[field];
  if (isString(val) && val.length > max) {
    errors.push(`Field "${field}" exceeds max length ${max} (got ${val.length})`);
  }
}

function checkArrayBound(obj: Record<string, unknown>, field: string, max: number, errors: string[]): void {
  const val = obj[field];
  if (isArray(val) && val.length > max) {
    errors.push(`Field "${field}" exceeds max count ${max} (got ${val.length})`);
  }
}

function checkEnum(obj: Record<string, unknown>, field: string, allowed: readonly string[], errors: string[]): void {
  const val = obj[field];
  if (isString(val) && !allowed.includes(val)) {
    errors.push(`Field "${field}" must be one of [${allowed.join(', ')}], got "${val}"`);
  }
}

function checkSchemaVersion(obj: Record<string, unknown>, expected: number, errors: string[]): boolean {
  if (obj.schemaVersion === undefined) {
    errors.push(`Missing required field: schemaVersion`);
    return false;
  }
  if (obj.schemaVersion !== expected) {
    errors.push(`Unsupported schemaVersion: expected ${expected}, got ${obj.schemaVersion}`);
    return false;
  }
  return true;
}

// ── Validators ────────────────────────────────────────────────

const TASK_TYPES = ['task', 'objective', 'subtask', 'review'] as const;
const TASK_STATUSES = ['pending', 'active', 'done', 'failed', 'interrupted'] as const;
const TASK_COMPLEXITIES = ['low', 'medium', 'high'] as const;
const TASK_RESULTS = ['success', 'partial_success', 'failed', 'no_mutation'] as const;
const RUNTIME_TYPES = ['api', 'cli', 'local'] as const;
const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
const OBJECTIVE_STATUSES = ['planning', 'executing', 'replanning', 'reviewing', 'done', 'failed'] as const;
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'conditional'] as const;
const FINDING_STATUSES = ['PASS', 'WARNING', 'FAIL'] as const;
const SERVICE_STATUSES = ['starting', 'healthy', 'degraded', 'stopped', 'crashed'] as const;
const ARTIFACT_TYPES = ['file', 'report', 'evidence', 'log', 'snapshot'] as const;
const PROFILE_MODES = ['sovereign-local', 'cloud', 'hybrid'] as const;
const MEMORY_TYPES = ['DISCOVERY', 'DECISION', 'WARNING', 'FILE_MAP'] as const;

export function validateProject(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'projectName', 'string', errors);
  checkStringBound(input, 'projectName', MAX_PROJECT_NAME_LENGTH, errors);
  checkRequired(input, 'routingMode', 'string', errors);
  checkRequired(input, 'providers', 'object', errors);
  checkRequired(input, 'agents', 'array', errors);
  checkRequired(input, 'routing', 'object', errors);
  if (isObject(input.profile)) {
    const p = input.profile;
    checkRequired(p, 'id', 'string', errors);
    checkRequired(p, 'displayName', 'string', errors);
    checkRequired(p, 'mode', 'string', errors);
    checkEnum(p, 'mode', PROFILE_MODES, errors);
    checkRequired(p, 'zeroCloud', 'boolean', errors);
    checkRequired(p, 'evidenceRoot', 'string', errors);
  }
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateExtendedTaskRequirements(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['ExtendedTaskRequirements must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);

  checkRequired(input, 'modalities', 'array', errors);
  if (isArray(input.modalities)) {
    if (input.modalities.length === 0) {
      errors.push('Field "modalities" must contain at least one modality');
    }
    for (const m of input.modalities) {
      if (!isString(m) || !TASK_MODALITIES.includes(m as any)) {
        errors.push(`Invalid modality "${m}". Must be one of [${TASK_MODALITIES.join(', ')}]`);
      }
    }
  }

  if (input.primaryModality !== undefined && input.primaryModality !== null) {
    if (!isString(input.primaryModality) || !TASK_MODALITIES.includes(input.primaryModality as any)) {
      errors.push(`Invalid primaryModality "${input.primaryModality}". Must be one of [${TASK_MODALITIES.join(', ')}]`);
    } else if (isArray(input.modalities) && !input.modalities.includes(input.primaryModality)) {
      errors.push(`primaryModality "${input.primaryModality}" must be included in modalities array`);
    }
  }

  if (input.model !== undefined && input.model !== null) {
    if (!isObject(input.model)) {
      errors.push('Field "model" must be an object');
    } else {
      const m = input.model;
      if (m.minContextTokens !== undefined && m.minContextTokens !== null) {
        if (!isNumber(m.minContextTokens) || !Number.isInteger(m.minContextTokens) || m.minContextTokens <= 0) {
          errors.push('Field "model.minContextTokens" must be a positive integer');
        }
      }
      if (m.parameterTier !== undefined && m.parameterTier !== null) {
        checkEnum(m, 'parameterTier', TASK_MODEL_PARAMETER_TIERS, errors);
      }
      if (m.devicePreference !== undefined && m.devicePreference !== null) {
        checkEnum(m, 'devicePreference', TASK_DEVICE_PREFERENCES, errors);
      }
      if (m.quantization !== undefined && m.quantization !== null) {
        checkEnum(m, 'quantization', TASK_QUANTIZATIONS, errors);
      }
      if (m.modelFamily !== undefined && m.modelFamily !== null && !isString(m.modelFamily)) {
        errors.push('Field "model.modelFamily" must be a string');
      }
      if (m.architecture !== undefined && m.architecture !== null && !isString(m.architecture)) {
        errors.push('Field "model.architecture" must be a string');
      }
      if (m.requiredRevision !== undefined && m.requiredRevision !== null && !isString(m.requiredRevision)) {
        errors.push('Field "model.requiredRevision" must be a string');
      }
    }
  }

  if (input.tools !== undefined && input.tools !== null) {
    if (!isObject(input.tools)) {
      errors.push('Field "tools" must be an object');
    } else {
      const t = input.tools;
      if (t.requiredTools !== undefined && t.requiredTools !== null) {
        if (!isStringArray(t.requiredTools)) {
          errors.push('Field "tools.requiredTools" must be an array of strings');
        }
      }
      if (t.optionalTools !== undefined && t.optionalTools !== null) {
        if (!isStringArray(t.optionalTools)) {
          errors.push('Field "tools.optionalTools" must be an array of strings');
        }
      }
      if (t.forbiddenTools !== undefined && t.forbiddenTools !== null) {
        if (!isStringArray(t.forbiddenTools)) {
          errors.push('Field "tools.forbiddenTools" must be an array of strings');
        }
      }
    }
  }

  if (input.input !== undefined && input.input !== null) {
    if (!isObject(input.input)) {
      errors.push('Field "input" must be an object');
    } else {
      const inp = input.input;
      if (inp.requiredArtifactTypes !== undefined && inp.requiredArtifactTypes !== null) {
        if (!isStringArray(inp.requiredArtifactTypes)) {
          errors.push('Field "input.requiredArtifactTypes" must be an array of strings');
        }
      }
      if (inp.requiredMimeTypes !== undefined && inp.requiredMimeTypes !== null) {
        if (!isStringArray(inp.requiredMimeTypes)) {
          errors.push('Field "input.requiredMimeTypes" must be an array of strings');
        }
      }
      if (inp.schemaId !== undefined && inp.schemaId !== null && !isString(inp.schemaId)) {
        errors.push('Field "input.schemaId" must be a string');
      }
      if (inp.maxInputSizeBytes !== undefined && inp.maxInputSizeBytes !== null) {
        if (!isNumber(inp.maxInputSizeBytes) || !Number.isInteger(inp.maxInputSizeBytes) || inp.maxInputSizeBytes <= 0) {
          errors.push('Field "input.maxInputSizeBytes" must be a positive integer');
        }
      }
    }
  }

  if (input.output !== undefined && input.output !== null) {
    if (!isObject(input.output)) {
      errors.push('Field "output" must be an object');
    } else {
      const out = input.output;
      if (out.expectedArtifactTypes !== undefined && out.expectedArtifactTypes !== null) {
        if (!isStringArray(out.expectedArtifactTypes)) {
          errors.push('Field "output.expectedArtifactTypes" must be an array of strings');
        }
      }
      if (out.outputSchemaId !== undefined && out.outputSchemaId !== null && !isString(out.outputSchemaId)) {
        errors.push('Field "output.outputSchemaId" must be a string');
      }
      if (out.enforceFormat !== undefined && out.enforceFormat !== null && !isBoolean(out.enforceFormat)) {
        errors.push('Field "output.enforceFormat" must be a boolean');
      }
    }
  }

  if (input.allowDegradation !== undefined && input.allowDegradation !== null && !isBoolean(input.allowDegradation)) {
    errors.push('Field "allowDegradation" must be a boolean');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Evaluates whether task requirements can safely degrade to text-only mode.
 *
 * Negative requirement rule (F7-01):
 * Unknown required capabilities or unsupported modalities/tools MUST NOT degrade silently
 * to text-only; they must fail closed.
 */
export function canDegradeToTextOnly(requirements?: ExtendedTaskRequirements | {
  allowDegradation?: boolean;
  modalities?: readonly string[];
  tools?: { requiredTools?: readonly string[] };
} | null): boolean {
  if (!requirements) return true;
  if (requirements.allowDegradation !== true) {
    return false;
  }
  if (Array.isArray(requirements.modalities)) {
    const nonText = requirements.modalities.filter(m => m !== 'text');
    if (nonText.length > 0) return false;
  }
  if (requirements.tools && Array.isArray(requirements.tools.requiredTools) && requirements.tools.requiredTools.length > 0) {
    return false;
  }
  return true;
}

export function validateTask(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'type', 'string', errors);
  checkEnum(input, 'type', TASK_TYPES, errors);
  checkRequired(input, 'agent', 'string', errors);
  checkStringBound(input, 'agent', MAX_AGENT_ID_LENGTH, errors);
  checkRequired(input, 'branch', 'string', errors);
  checkRequired(input, 'description', 'string', errors);
  checkStringBound(input, 'description', MAX_TASK_DESCRIPTION_LENGTH, errors);
  checkRequired(input, 'capabilities', 'array', errors);
  checkRequired(input, 'complexity', 'string', errors);
  checkEnum(input, 'complexity', TASK_COMPLEXITIES, errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', TASK_STATUSES, errors);
  checkRequired(input, 'createdAt', 'string', errors);
  if (input.requirements !== undefined && input.requirements !== null) {
    const reqResult = validateExtendedTaskRequirements(input.requirements);
    if (!reqResult.valid) {
      errors.push(...reqResult.errors);
    }
  }
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateMessage(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'role', 'string', errors);
  checkEnum(input, 'role', MESSAGE_ROLES, errors);
  checkRequired(input, 'timestamp', 'string', errors);
  if (input.content !== null && input.content !== undefined) {
    if (!isString(input.content)) {
      errors.push('Field "content" must be a string or null');
    } else {
      checkStringBound(input, 'content', MAX_MESSAGE_CONTENT_LENGTH, errors);
    }
  }
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateConversation(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  if (isString(input.id)) {
    if (input.id.includes('..') || input.id.includes('/') || input.id.includes('\\') || input.id.includes('\0')) {
      errors.push('Conversation id cannot contain path traversal characters, slashes, or null bytes');
    }
  }
  checkRequired(input, 'projectId', 'string', errors);
  checkRequired(input, 'agentId', 'string', errors);
  checkRequired(input, 'messages', 'array', errors);
  if (isArray(input.messages)) {
    for (let i = 0; i < input.messages.length; i++) {
      const msgRes = validateMessage(input.messages[i]);
      if (!msgRes.valid) {
        errors.push(...msgRes.errors.map((e) => `messages[${i}]: ${e}`));
      }
    }
  }
  checkRequired(input, 'createdAt', 'string', errors);
  checkRequired(input, 'updatedAt', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateRun(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'taskId', 'string', errors);
  checkRequired(input, 'agentId', 'string', errors);
  checkStringBound(input, 'agentId', MAX_AGENT_ID_LENGTH, errors);
  checkRequired(input, 'startedAt', 'string', errors);
  checkRequired(input, 'success', 'boolean', errors);
  checkRequired(input, 'summary', 'string', errors);
  checkRequired(input, 'filesChanged', 'array', errors);
  checkRequired(input, 'iterations', 'number', errors);
  checkRequired(input, 'totalTokens', 'number', errors);
  checkRequired(input, 'costUSD', 'number', errors);
  checkRequired(input, 'latencyMs', 'number', errors);
  checkRequired(input, 'runtimeType', 'string', errors);
  checkEnum(input, 'runtimeType', RUNTIME_TYPES, errors);
  if (input.result !== undefined) {
    checkEnum(input, 'result', TASK_RESULTS, errors);
  }
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateWorkflowStage(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'goal', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', OBJECTIVE_STATUSES, errors);
  checkRequired(input, 'version', 'number', errors);
  checkRequired(input, 'childTaskIds', 'array', errors);
  checkArrayBound(input, 'childTaskIds', MAX_CHILDREN_PER_WORKFLOW, errors);
  checkRequired(input, 'planHistory', 'array', errors);
  checkArrayBound(input, 'planHistory', MAX_PLAN_HISTORY_ENTRIES, errors);
  checkRequired(input, 'createdAt', 'string', errors);
  checkRequired(input, 'maxReplanAttempts', 'number', errors);
  checkRequired(input, 'replanCount', 'number', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateArtifact(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'runId', 'string', errors);
  checkRequired(input, 'path', 'string', errors);
  checkStringBound(input, 'path', MAX_PATH_LENGTH, errors);
  checkRequired(input, 'type', 'string', errors);
  checkEnum(input, 'type', ARTIFACT_TYPES, errors);
  checkRequired(input, 'hash', 'string', errors);
  checkStringBound(input, 'hash', MAX_HASH_LENGTH, errors);
  checkRequired(input, 'size', 'number', errors);
  checkRequired(input, 'createdAt', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateFinding(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'runId', 'string', errors);
  checkRequired(input, 'metric', 'string', errors);
  checkStringBound(input, 'metric', MAX_FINDING_METRIC_LENGTH, errors);
  checkRequired(input, 'observed', 'string', errors);
  checkRequired(input, 'threshold', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', FINDING_STATUSES, errors);
  checkRequired(input, 'ruleId', 'string', errors);
  checkRequired(input, 'unit', 'string', errors);
  checkRequired(input, 'timestamp', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateEvidence(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'gateId', 'string', errors);
  checkRequired(input, 'criteria', 'array', errors);
  checkRequired(input, 'verifiedItems', 'array', errors);
  checkRequired(input, 'blockers', 'array', errors);
  checkRequired(input, 'machineIdentity', 'object', errors);
  if (isObject(input.machineIdentity)) {
    checkRequired(input.machineIdentity, 'hostname', 'string', errors);
    checkRequired(input.machineIdentity, 'osBuild', 'string', errors);
  }
  checkRequired(input, 'timestamp', 'string', errors);
  checkRequired(input, 'summary', 'string', errors);
  checkRequired(input, 'g2Ready', 'boolean', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateApproval(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'gateId', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', APPROVAL_STATUSES, errors);
  checkRequired(input, 'approvedBy', 'string', errors);
  checkRequired(input, 'conditions', 'array', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateModel(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'name', 'string', errors);
  checkRequired(input, 'revision', 'string', errors);
  checkRequired(input, 'provider', 'string', errors);
  checkRequired(input, 'device', 'string', errors);
  checkRequired(input, 'snapshotPath', 'string', errors);
  checkStringBound(input, 'snapshotPath', MAX_PATH_LENGTH, errors);
  checkRequired(input, 'hash', 'string', errors);
  checkStringBound(input, 'hash', MAX_HASH_LENGTH, errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateModelLease(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'modelId', 'string', errors);
  checkRequired(input, 'agentId', 'string', errors);
  checkStringBound(input, 'agentId', MAX_AGENT_ID_LENGTH, errors);
  checkRequired(input, 'grantedAt', 'string', errors);
  checkRequired(input, 'port', 'number', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateAuditEvent(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'seq', 'number', errors);
  checkRequired(input, 'type', 'string', errors);
  checkRequired(input, 'agentId', 'string', errors);
  checkStringBound(input, 'agentId', MAX_AGENT_ID_LENGTH, errors);
  checkRequired(input, 'timestamp', 'number', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateServiceIdentity(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'executablePath', 'string', errors);
  checkStringBound(input, 'executablePath', MAX_PATH_LENGTH, errors);
  checkRequired(input, 'executableHash', 'string', errors);
  checkStringBound(input, 'executableHash', MAX_HASH_LENGTH, errors);
  checkRequired(input, 'host', 'string', errors);
  checkRequired(input, 'port', 'number', errors);
  checkRequired(input, 'pid', 'number', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', SERVICE_STATUSES, errors);
  checkRequired(input, 'startedAt', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateProvenanceReference(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'sourceFile', 'string', errors);
  checkStringBound(input, 'sourceFile', MAX_PATH_LENGTH, errors);
  checkRequired(input, 'sourceHash', 'string', errors);
  checkStringBound(input, 'sourceHash', MAX_HASH_LENGTH, errors);
  checkRequired(input, 'extractedAt', 'string', errors);
  checkRequired(input, 'chainPosition', 'number', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

// ── Aggregate Validators ──────────────────────────────────────

export function validateMemoryEntry(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkRequired(input, 'id', 'string', errors);
  checkRequired(input, 'agentId', 'string', errors);
  checkRequired(input, 'type', 'string', errors);
  checkEnum(input, 'type', MEMORY_TYPES, errors);
  checkRequired(input, 'content', 'string', errors);
  checkRequired(input, 'tags', 'array', errors);
  checkArrayBound(input, 'tags', MAX_TAGS_PER_ENTITY, errors);
  checkRequired(input, 'confidence', 'number', errors);
  checkRequired(input, 'timestamp', 'number', errors);
  checkRequired(input, 'ttlMs', 'number', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

// ── Unknown-Field Stripping ───────────────────────────────────

/**
 * Strip fields not in the allowed set from an object.
 * Returns a new object with only known fields.
 */
export function stripUnknownFields<T extends Record<string, unknown>>(
  obj: T,
  knownFields: readonly string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of knownFields) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result as Partial<T>;
}

// ── SequencedEvent Validator (F3-04) ──────────────────────────

export function validateSequencedEvent(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'eventId', 'string', errors);
  checkRequired(input, 'eventType', 'string', errors);
  checkRequired(input, 'projectId', 'string', errors);
  checkRequired(input, 'sequence', 'number', errors);
  if (typeof input.sequence === 'number' && input.sequence < 0) {
    errors.push('sequence must be non-negative');
  }
  checkRequired(input, 'occurredAt', 'string', errors);
  checkRequired(input, 'correlationId', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

// ── Audit Validators (F3-06) ──────────────────────────────────

export const AUDIT_CATEGORIES = [
  'stage',
  'tool',
  'model',
  'endpoint',
  'lease',
  'io_hash',
  'duration',
  'warning',
  'approval',
  'interruption',
] as const;

export function validateAuditCategory(category: unknown): ValidationResult {
  if (typeof category !== 'string') return fail(['Audit category must be a string']);
  if (!AUDIT_CATEGORIES.includes(category as any)) {
    return fail([`Invalid audit category '${category}'. Allowed: ${AUDIT_CATEGORIES.join(', ')}`]);
  }
  return ok();
}

export function validateAuditRecord(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'sequence', 'number', errors);
  if (typeof input.sequence === 'number' && input.sequence < 0) {
    errors.push('sequence must be non-negative');
  }
  checkRequired(input, 'previous_hash', 'string', errors);
  checkRequired(input, 'timestamp', 'string', errors);
  checkRequired(input, 'source', 'string', errors);
  checkRequired(input, 'category', 'string', errors);
  if (typeof input.category === 'string' && !AUDIT_CATEGORIES.includes(input.category as any)) {
    errors.push(`Invalid audit category '${input.category}'. Allowed: ${AUDIT_CATEGORIES.join(', ')}`);
  }
  checkRequired(input, 'data', 'object', errors);
  checkRequired(input, 'hash', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

// ── Idempotency Validator (F3-07) ─────────────────────────────

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed', 'failed'] as const;

export function validateIdempotencyRecord(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['Input must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'key', 'string', errors);
  checkRequired(input, 'requestHash', 'string', errors);
  checkRequired(input, 'operation', 'string', errors);
  checkRequired(input, 'projectId', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', IDEMPOTENCY_STATUSES, errors);
  checkRequired(input, 'createdAt', 'string', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

// ── Inference Validators (F7-02) ──────────────────────────────

export function validateInferenceInput(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['InferenceInput must be an object']);
  const errors: string[] = [];

  const hasText = input.text !== undefined && input.text !== null;
  const hasAttachments = input.attachments !== undefined && input.attachments !== null;

  if (!hasText && !hasAttachments) {
    errors.push('InferenceInput must contain at least "text" or "attachments"');
  }

  if (hasText) {
    if (!isString(input.text)) {
      errors.push('Field "text" must be a string');
    } else if (input.text.length > MAX_INFERENCE_TEXT_LENGTH) {
      errors.push(`Field "text" exceeds maximum length of ${MAX_INFERENCE_TEXT_LENGTH} characters`);
    }
  }

  if (hasAttachments) {
    if (!isArray(input.attachments)) {
      errors.push('Field "attachments" must be an array');
    } else {
      if (input.attachments.length > MAX_INFERENCE_ATTACHMENTS) {
        errors.push(`Field "attachments" exceeds maximum limit of ${MAX_INFERENCE_ATTACHMENTS} items`);
      }
      for (let i = 0; i < input.attachments.length; i++) {
        const att = input.attachments[i];
        if (!isObject(att)) {
          errors.push(`Attachment at index ${i} must be an object`);
          continue;
        }
        if (typeof att.name !== 'string' || att.name.trim().length === 0) {
          errors.push(`Attachment at index ${i} must have a non-empty string "name"`);
        } else if (att.name.length > MAX_ATTACHMENT_NAME_LENGTH) {
          errors.push(`Attachment "${att.name}" exceeds maximum name length of ${MAX_ATTACHMENT_NAME_LENGTH}`);
        } else if (att.name.includes('..') || att.name.includes('\0')) {
          errors.push(`Attachment "${att.name}" contains prohibited path traversal or control characters`);
        }
        if (att.mimeType !== undefined && att.mimeType !== null && !isString(att.mimeType)) {
          errors.push(`Attachment at index ${i} field "mimeType" must be a string`);
        }
        if (att.sourcePath !== undefined && att.sourcePath !== null) {
          if (!isString(att.sourcePath)) {
            errors.push(`Attachment at index ${i} field "sourcePath" must be a string`);
          } else if (att.sourcePath.includes('..') || att.sourcePath.includes('\0')) {
            errors.push(`Attachment at index ${i} field "sourcePath" contains prohibited path traversal sequences`);
          }
        }
        if (att.content !== undefined && att.content !== null && !isString(att.content)) {
          errors.push(`Attachment at index ${i} field "content" must be a string`);
        }
        if (att.sourceHash !== undefined && att.sourceHash !== null && (!isString(att.sourceHash) || att.sourceHash.length > MAX_HASH_LENGTH)) {
          errors.push(`Attachment at index ${i} field "sourceHash" must be a string within ${MAX_HASH_LENGTH} chars`);
        }
        if (att.artifactId !== undefined && att.artifactId !== null && !isString(att.artifactId)) {
          errors.push(`Attachment at index ${i} field "artifactId" must be a string`);
        }
        if (att.sizeBytes !== undefined && att.sizeBytes !== null && (!isNumber(att.sizeBytes) || att.sizeBytes < 0)) {
          errors.push(`Attachment at index ${i} field "sizeBytes" must be a non-negative number`);
        }
        if (att.pageCount !== undefined && att.pageCount !== null && (!isNumber(att.pageCount) || att.pageCount < 0)) {
          errors.push(`Attachment at index ${i} field "pageCount" must be a non-negative number`);
        }
        if (att.metadata !== undefined && att.metadata !== null && !isObject(att.metadata)) {
          errors.push(`Attachment at index ${i} field "metadata" must be an object`);
        }
      }
    }
  }

  if (input.context !== undefined && input.context !== null && !isObject(input.context)) {
    errors.push('Field "context" must be an object');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

export function validateInferenceResult(result: unknown): ValidationResult {
  if (!isObject(result)) return fail(['InferenceResult must be an object']);
  const errors: string[] = [];

  checkSchemaVersion(result, 1, errors);
  checkRequired(result, 'status', 'string', errors);
  checkEnum(result, 'status', INFERENCE_STATUSES, errors);
  checkRequired(result, 'inferredIntent', 'string', errors);
  checkRequired(result, 'confidence', 'number', errors);
  if (typeof result.confidence === 'number' && (result.confidence < 0 || result.confidence > 1)) {
    errors.push('Field "confidence" must be a number between 0.0 and 1.0');
  }

  if (result.matchedRuleId !== null && result.matchedRuleId !== undefined && !isString(result.matchedRuleId)) {
    errors.push('Field "matchedRuleId" must be a string or null');
  }
  if (result.matchedRuleVersion !== null && result.matchedRuleVersion !== undefined && !isNumber(result.matchedRuleVersion)) {
    errors.push('Field "matchedRuleVersion" must be a number or null');
  }

  checkRequired(result, 'reasoningCodes', 'array', errors);
  if (isArray(result.reasoningCodes)) {
    if (result.reasoningCodes.length > MAX_REASONING_CODES) {
      errors.push(`Field "reasoningCodes" exceeds maximum length of ${MAX_REASONING_CODES}`);
    }
    for (const code of result.reasoningCodes) {
      if (!isString(code)) {
        errors.push(`Field "reasoningCodes" must contain only strings, got ${typeof code}`);
      }
    }
  }

  checkRequired(result, 'supportingEvidence', 'array', errors);
  if (isArray(result.supportingEvidence)) {
    if (result.supportingEvidence.length > MAX_EVIDENCE_REFERENCES) {
      errors.push(`Field "supportingEvidence" exceeds maximum length of ${MAX_EVIDENCE_REFERENCES}`);
    }
    for (let i = 0; i < result.supportingEvidence.length; i++) {
      const ev = result.supportingEvidence[i];
      if (!isObject(ev)) {
        errors.push(`Evidence reference at index ${i} must be an object`);
        continue;
      }
      checkRequired(ev, 'source', 'string', errors);
      checkRequired(ev, 'ref', 'string', errors);
      checkRequired(ev, 'matchDetail', 'string', errors);
      if (ev.hash !== undefined && ev.hash !== null && !isString(ev.hash)) {
        errors.push(`Evidence reference at index ${i} field "hash" must be a string`);
      }
    }
  }

  if (result.requirements !== null && result.requirements !== undefined) {
    const reqRes = validateExtendedTaskRequirements(result.requirements);
    if (!reqRes.valid) {
      errors.push(...reqRes.errors.map(e => `Inference requirements: ${e}`));
    }
  }

  if (result.selectedModality !== null && result.selectedModality !== undefined) {
    if (!isString(result.selectedModality) || !TASK_MODALITIES.includes(result.selectedModality as any)) {
      errors.push(`Invalid selectedModality "${result.selectedModality}". Must be one of [${TASK_MODALITIES.join(', ')}]`);
    }
  }

  if (result.selectedAgent !== null && result.selectedAgent !== undefined && !isString(result.selectedAgent)) {
    errors.push('Field "selectedAgent" must be a string or null');
  }
  if (result.selectedWorkflow !== null && result.selectedWorkflow !== undefined && !isString(result.selectedWorkflow)) {
    errors.push('Field "selectedWorkflow" must be a string or null');
  }
  if (result.clarificationPrompt !== null && result.clarificationPrompt !== undefined && !isString(result.clarificationPrompt)) {
    errors.push('Field "clarificationPrompt" must be a string or null');
  }

  checkRequired(result, 'inputHash', 'string', errors);
  checkRequired(result, 'deterministic', 'boolean', errors);
  if (result.deterministic !== true) {
    errors.push('Field "deterministic" must be true');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ── Workflow Plan Validators (F7-03) ──────────────────────────

export function validateWorkflowPlanStep(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['WorkflowPlanStep must be an object']);
  const errors: string[] = [];

  checkRequired(input, 'stepId', 'string', errors);
  if (typeof input.stepId === 'string') {
    if (input.stepId.trim().length === 0) {
      errors.push('Field "stepId" cannot be empty');
    } else if (input.stepId.length > MAX_PLAN_ID_LENGTH) {
      errors.push(`Field "stepId" exceeds maximum length of ${MAX_PLAN_ID_LENGTH}`);
    }
  }

  checkRequired(input, 'stepType', 'string', errors);
  checkEnum(input, 'stepType', WORKFLOW_STEP_TYPES, errors);

  checkRequired(input, 'title', 'string', errors);
  if (typeof input.title === 'string') {
    if (input.title.trim().length === 0) {
      errors.push('Field "title" cannot be empty');
    } else if (input.title.length > MAX_STEP_TITLE_LENGTH) {
      errors.push(`Field "title" exceeds maximum length of ${MAX_STEP_TITLE_LENGTH}`);
    }
  }

  checkRequired(input, 'assignedAgentId', 'string', errors);
  if (typeof input.assignedAgentId === 'string' && input.assignedAgentId.trim().length === 0) {
    errors.push('Field "assignedAgentId" cannot be empty');
  }

  checkRequired(input, 'requiredTools', 'array', errors);
  if (isArray(input.requiredTools)) {
    for (const tool of input.requiredTools) {
      if (!isString(tool)) {
        errors.push(`Field "requiredTools" contains non-string item: ${typeof tool}`);
      }
    }
  }

  checkRequired(input, 'dependencies', 'array', errors);
  if (isArray(input.dependencies)) {
    if (input.dependencies.length > MAX_STEP_DEPENDENCIES) {
      errors.push(`Field "dependencies" exceeds maximum limit of ${MAX_STEP_DEPENDENCIES}`);
    }
    for (const dep of input.dependencies) {
      if (!isString(dep)) {
        errors.push(`Field "dependencies" contains non-string item: ${typeof dep}`);
      }
    }
  }

  checkRequired(input, 'inputs', 'object', errors);
  if (isObject(input.inputs)) {
    if (input.inputs.artifactTypes !== undefined && !isStringArray(input.inputs.artifactTypes)) {
      errors.push('Field "inputs.artifactTypes" must be an array of strings');
    }
    if (input.inputs.sourceIds !== undefined && !isStringArray(input.inputs.sourceIds)) {
      errors.push('Field "inputs.sourceIds" must be an array of strings');
    }
    if (input.inputs.parameters !== undefined && !isObject(input.inputs.parameters)) {
      errors.push('Field "inputs.parameters" must be an object');
    }
  }

  checkRequired(input, 'outputs', 'object', errors);
  if (isObject(input.outputs)) {
    checkRequired(input.outputs, 'expectedArtifactTypes', 'array', errors);
    if (isArray(input.outputs.expectedArtifactTypes)) {
      if (input.outputs.expectedArtifactTypes.length === 0) {
        errors.push('Field "outputs.expectedArtifactTypes" must contain at least one expected artifact type');
      } else {
        for (const outType of input.outputs.expectedArtifactTypes) {
          if (!isString(outType)) {
            errors.push('Field "outputs.expectedArtifactTypes" contains non-string item');
          }
        }
      }
    }
    if (input.outputs.outputSchemaId !== undefined && !isString(input.outputs.outputSchemaId)) {
      errors.push('Field "outputs.outputSchemaId" must be a string');
    }
  }

  checkRequired(input, 'requiresApproval', 'boolean', errors);
  if (input.approvalReason !== undefined && !isString(input.approvalReason)) {
    errors.push('Field "approvalReason" must be a string');
  }

  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', WORKFLOW_STEP_STATUSES, errors);

  return errors.length > 0 ? fail(errors) : ok();
}

function checkStepDependencyCycles(steps: Array<{ stepId: string; dependencies: string[] }>): string[] {
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.stepId, 0);
    graph.set(step.stepId, []);
  }

  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (graph.has(dep)) {
        graph.get(dep)!.push(step.stepId);
        inDegree.set(step.stepId, (inDegree.get(step.stepId) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const curr = queue.shift()!;
    visitedCount++;
    for (const next of graph.get(curr) || []) {
      const newDeg = inDegree.get(next)! - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  if (visitedCount < steps.length) {
    return ['Cyclic dependency detected in workflow plan steps'];
  }
  return [];
}

export function validateWorkflowPlan(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['WorkflowPlan must be an object']);
  const errors: string[] = [];

  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'planId', 'string', errors);
  checkRequired(input, 'title', 'string', errors);
  checkRequired(input, 'intent', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', WORKFLOW_PLAN_STATUSES, errors);

  checkRequired(input, 'provenance', 'object', errors);
  if (isObject(input.provenance)) {
    const prov = input.provenance;
    checkRequired(prov, 'projectId', 'string', errors);
    checkRequired(prov, 'taskId', 'string', errors);
    checkRequired(prov, 'runId', 'string', errors);
    checkRequired(prov, 'inferenceInputHash', 'string', errors);
    checkRequired(prov, 'sourceArtifactIds', 'array', errors);
    checkRequired(prov, 'sourceHashes', 'array', errors);
    checkRequired(prov, 'evidenceReferences', 'array', errors);
    checkRequired(prov, 'createdAt', 'string', errors);
  }

  checkRequired(input, 'requirements', 'object', errors);
  if (isObject(input.requirements)) {
    const reqRes = validateExtendedTaskRequirements(input.requirements);
    if (!reqRes.valid) {
      errors.push(...reqRes.errors.map((e) => `WorkflowPlan requirements: ${e}`));
    }
  }

  checkRequired(input, 'steps', 'array', errors);
  if (isArray(input.steps)) {
    if (input.steps.length === 0) {
      errors.push('WorkflowPlan must contain at least one step');
    } else if (input.steps.length > MAX_WORKFLOW_PLAN_STEPS) {
      errors.push(`WorkflowPlan exceeds maximum limit of ${MAX_WORKFLOW_PLAN_STEPS} steps`);
    }

    const stepIdSet = new Set<string>();
    const validStepList: Array<{ stepId: string; dependencies: string[] }> = [];

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i];
      const stepVal = validateWorkflowPlanStep(step);
      if (!stepVal.valid) {
        errors.push(...stepVal.errors.map((e) => `Step[${i}]: ${e}`));
      }
      if (isObject(step) && typeof step.stepId === 'string') {
        if (stepIdSet.has(step.stepId)) {
          errors.push(`Duplicate stepId "${step.stepId}" at index ${i}`);
        } else {
          stepIdSet.add(step.stepId);
        }
        if (isArray(step.dependencies)) {
          validStepList.push({
            stepId: step.stepId,
            dependencies: step.dependencies.filter(isString),
          });
        }
      }
    }

    // Validate that all step dependencies point to defined steps
    for (const s of validStepList) {
      for (const dep of s.dependencies) {
        if (!stepIdSet.has(dep)) {
          errors.push(`Step "${s.stepId}" has unknown dependency "${dep}"`);
        }
      }
    }

    // Detect DAG cycles
    const cycleErrors = checkStepDependencyCycles(validStepList);
    if (cycleErrors.length > 0) {
      errors.push(...cycleErrors);
    }
  }

  checkRequired(input, 'planHash', 'string', errors);
  checkRequired(input, 'deterministic', 'boolean', errors);
  if (input.deterministic !== true) {
    errors.push('Field "deterministic" must be true');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

// ── Schema 19: ToolExecutionPlan (F7-04) ───────────────────────

export function validateToolExecutionPlan(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return fail(['ToolExecutionPlan must be an object']);
  }

  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'contractId', 'string', errors);
  checkStringBound(input, 'contractId', MAX_CONTRACT_ID_LENGTH, errors);
  checkRequired(input, 'workflowPlanId', 'string', errors);
  checkStringBound(input, 'workflowPlanId', MAX_PLAN_ID_LENGTH, errors);
  checkRequired(input, 'stepId', 'string', errors);
  checkStringBound(input, 'stepId', MAX_PLAN_ID_LENGTH, errors);
  checkRequired(input, 'stepType', 'string', errors);
  checkEnum(input, 'stepType', WORKFLOW_STEP_TYPES, errors);
  checkRequired(input, 'projectId', 'string', errors);
  checkStringBound(input, 'projectId', MAX_PROJECT_NAME_LENGTH, errors);
  checkRequired(input, 'taskId', 'string', errors);
  checkStringBound(input, 'taskId', MAX_TASK_DESCRIPTION_LENGTH, errors);
  checkRequired(input, 'runId', 'string', errors);
  checkStringBound(input, 'runId', MAX_TASK_DESCRIPTION_LENGTH, errors);
  checkRequired(input, 'authorizedAgent', 'string', errors);
  checkStringBound(input, 'authorizedAgent', MAX_AGENT_ID_LENGTH, errors);
  checkRequired(input, 'allowedTool', 'string', errors);
  checkStringBound(input, 'allowedTool', MAX_TOOL_NAME_LENGTH, errors);

  if (input.requiredModel !== undefined) {
    checkRequired(input, 'requiredModel', 'string', errors);
    checkStringBound(input, 'requiredModel', MAX_AGENT_ID_LENGTH, errors);
  }
  if (input.requiredRevision !== undefined) {
    checkRequired(input, 'requiredRevision', 'string', errors);
    checkStringBound(input, 'requiredRevision', MAX_AGENT_ID_LENGTH, errors);
  }

  checkRequired(input, 'requiredModalities', 'array', errors);
  checkArrayBound(input, 'requiredModalities', 10, errors);
  if (isArray(input.requiredModalities)) {
    for (let i = 0; i < input.requiredModalities.length; i++) {
      const mod = input.requiredModalities[i];
      if (!TASK_MODALITIES.includes(mod as any)) {
        errors.push(`requiredModalities[${i}] "${mod}" is not a valid TaskModality`);
      }
    }
  }

  checkRequired(input, 'inputArtifactIds', 'array', errors);
  checkArrayBound(input, 'inputArtifactIds', MAX_CONTRACT_ARTIFACTS, errors);
  checkRequired(input, 'sourceHashes', 'array', errors);
  checkArrayBound(input, 'sourceHashes', MAX_CONTRACT_ARTIFACTS, errors);

  checkRequired(input, 'approvalRequirement', 'string', errors);
  checkEnum(input, 'approvalRequirement', APPROVAL_CATEGORIES, errors);
  checkRequired(input, 'humanReviewRequirement', 'boolean', errors);

  if (input.humanReviewGate !== undefined) {
    if (!isObject(input.humanReviewGate)) {
      errors.push('Field "humanReviewGate" must be an object');
    } else {
      checkRequired(input.humanReviewGate, 'reason', 'string', errors);
    }
  }

  if (input.approvalGate !== undefined) {
    if (!isObject(input.approvalGate)) {
      errors.push('Field "approvalGate" must be an object');
    } else {
      checkRequired(input.approvalGate, 'gateId', 'string', errors);
      if (input.approvalGate.requiredStatus !== 'approved') {
        errors.push('Field "approvalGate.requiredStatus" must be "approved"');
      }
    }
  }

  checkRequired(input, 'expectedOutputType', 'string', errors);
  checkRequired(input, 'idempotencyKey', 'string', errors);
  checkStringBound(input, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH, errors);
  checkRequired(input, 'timeoutMs', 'number', errors);
  if (typeof input.timeoutMs === 'number' && input.timeoutMs <= 0) {
    errors.push('Field "timeoutMs" must be a positive number');
  }

  if (!isObject(input.resourceBounds)) {
    errors.push('Field "resourceBounds" must be an object');
  }

  if (!isObject(input.auditRequirement)) {
    errors.push('Field "auditRequirement" must be an object');
  } else {
    checkRequired(input.auditRequirement, 'eventType', 'string', errors);
    checkRequired(input.auditRequirement, 'requiredFields', 'array', errors);
    checkArrayBound(input.auditRequirement, 'requiredFields', 50, errors);
  }

  checkRequired(input, 'contractHash', 'string', errors);

  return errors.length > 0 ? fail(errors) : ok();
}

// ── Agent Cockpit Validators (UI1-15) ──────────────────────────

export function validateCockpitStageNode(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['CockpitStageNode must be an object']);
  const errors: string[] = [];
  checkRequired(input, 'stepId', 'string', errors);
  checkRequired(input, 'stepType', 'string', errors);
  checkRequired(input, 'title', 'string', errors);
  checkRequired(input, 'assignedAgentId', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', ALL_COCKPIT_STAGE_STATUSES, errors);
  checkRequired(input, 'dependencies', 'array', errors);
  checkRequired(input, 'tools', 'array', errors);
  checkRequired(input, 'io', 'object', errors);
  checkRequired(input, 'telemetry', 'object', errors);
  checkRequired(input, 'approval', 'object', errors);
  checkRequired(input, 'retries', 'object', errors);
  return errors.length > 0 ? fail(errors) : ok();
}

export function validateCockpitState(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['CockpitState must be an object']);
  const errors: string[] = [];
  checkSchemaVersion(input, 1, errors);
  checkRequired(input, 'projectId', 'string', errors);
  checkRequired(input, 'runId', 'string', errors);
  checkRequired(input, 'status', 'string', errors);
  checkEnum(input, 'status', ALL_COCKPIT_RUN_STATUSES, errors);
  checkRequired(input, 'nodes', 'array', errors);
  checkArrayBound(input, 'nodes', MAX_COCKPIT_NODES, errors);
  checkRequired(input, 'edges', 'array', errors);
  checkArrayBound(input, 'edges', MAX_COCKPIT_EDGES, errors);
  checkRequired(input, 'totalTokens', 'object', errors);
  checkRequired(input, 'totalLatencyMs', 'number', errors);
  checkRequired(input, 'currentCursor', 'number', errors);
  checkRequired(input, 'forceStopped', 'boolean', errors);
  checkRequired(input, 'lastUpdated', 'string', errors);

  if (Array.isArray(input.nodes)) {
    for (let i = 0; i < input.nodes.length; i++) {
      const nodeRes = validateCockpitStageNode(input.nodes[i]);
      if (!nodeRes.valid) {
        errors.push(`Node [${i}] invalid: ${nodeRes.errors.join('; ')}`);
      }
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

export { validateSandboxManifest } from './sandbox-manifest';
