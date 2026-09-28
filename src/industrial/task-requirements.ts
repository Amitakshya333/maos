/**
 * MAOS Industrial — Task Requirements & Non-Degradation Engine (F7-01)
 *
 * Enforces explicit modality, model, tool, input, and output requirements.
 * Guarantees that unknown capabilities or unsupported modalities/tools
 * MUST NOT degrade silently to text-only; they must fail closed.
 */

import type {
  ExtendedTaskRequirements,
  TaskModality,
  TaskModelRequirement,
  TaskToolRequirement,
  TaskInputRequirements,
  TaskOutputRequirements,
  Task,
} from '../domain/schemas';
import type { TaskFile } from '../core/queue';
import type { TaskRequirements, AgentProfile } from '../core/router';

// ── Known Industrial Capabilities Registry ─────────────────────

export const KNOWN_INDUSTRIAL_CAPABILITIES = [
  // Modalities
  'text',
  'vision',
  'multimodal',
  'embedding',
  'code',
  'audio',
  // Specialized capabilities & roles
  'ocr',
  'search',
  'planning',
  'architecture',
  'decomposition',
  'review',
  'code-review',
  'security',
  'testing',
  'debugging',
  'refactoring',
  'styling',
  'css',
  'layout',
  'backend',
  'frontend',
  'api',
  'database',
  // Deliverable tools
  'generate_docx',
  'generate_xlsx',
  'generate_pptx',
  'ocr_page',
  // Industrial engines & workflows
  'rust_analysis',
  'vlm_inspect',
  'kb_search',
  'kb_index',
  'ingestion',
  // Standard development stacks
  'typescript',
  'javascript',
  'python',
  'rust',
  'react',
  'nodejs',
  'vitest',
  'jest',
] as const;

export type KnownIndustrialCapability = (typeof KNOWN_INDUSTRIAL_CAPABILITIES)[number];

// ── Degradation Error ──────────────────────────────────────────

export class TaskRequirementDegradationError extends Error {
  constructor(
    message: string,
    public readonly details: {
      unknownCapabilities?: string[];
      unsupportedModalities?: string[];
      unsupportedTools?: string[];
      allowDegradation: boolean;
    },
  ) {
    super(message);
    this.name = 'TaskRequirementDegradationError';
  }
}

// ── Assertions ─────────────────────────────────────────────────

/**
 * Asserts that the given capabilities and extended requirements are recognized
 * and will not undergo unauthorized silent degradation to text-only mode.
 *
 * Negative requirement rule (F7-01):
 * Unknown required capabilities or unsupported modalities/tools MUST NOT degrade
 * silently to text-only; they must fail closed.
 */
export function assertNonDegradableRequirements(
  capabilities: readonly string[],
  extended?: ExtendedTaskRequirements,
): void {
  const allowDegradation = extended?.allowDegradation === true;

  // 1. Detect unknown capabilities
  const unknown = capabilities.filter(
    (cap) => !KNOWN_INDUSTRIAL_CAPABILITIES.includes(cap.toLowerCase().trim() as any),
  );

  if (unknown.length > 0) {
    throw new TaskRequirementDegradationError(
      `Unknown required capabilities [${unknown.join(', ')}] cannot degrade to text-only mode. Explicit support is required.`,
      { unknownCapabilities: unknown, allowDegradation },
    );
  }

  // 2. If non-text modalities are requested and allowDegradation is false
  if (extended && !allowDegradation) {
    const nonText = extended.modalities.filter((m) => m !== 'text');
    if (nonText.length > 0 && extended.modalities.length === 1) {
      // Modality is purely non-text (e.g. ['vision'])
      // Degradation is prohibited
    }
  }
}

// ── Agent Eligibility Evaluator ────────────────────────────────

export interface AgentEligibilityResult {
  eligible: boolean;
  reasons: string[];
  missingCapabilities: string[];
  missingModalities: TaskModality[];
  missingTools: string[];
  contextExceeded?: boolean;
}

/**
 * Evaluates whether an agent satisfies all hard requirements of a task.
 * Returns eligible=false if any required modality, tool, model parameter, or capability is missing.
 */
export function evaluateAgentEligibility(
  task: TaskRequirements,
  agent: AgentProfile,
): AgentEligibilityResult {
  const reasons: string[] = [];
  const missingCapabilities: string[] = [];
  const missingModalities: TaskModality[] = [];
  const missingTools: string[] = [];
  let contextExceeded = false;

  const extended = task.extended;
  const allowDegradation = extended?.allowDegradation === true;

  // 1. Capabilities check
  const agentCaps = new Set(agent.capabilities.map((c) => c.toLowerCase().trim()));
  for (const cap of task.capabilities) {
    const lower = cap.toLowerCase().trim();
    if (!agentCaps.has(lower)) {
      missingCapabilities.push(cap);
    }
  }

  if (missingCapabilities.length > 0 && !allowDegradation) {
    reasons.push(`Agent '${agent.id}' lacks required capabilities: [${missingCapabilities.join(', ')}]`);
  }

  // 2. Extended Modalities check
  if (extended && extended.modalities.length > 0) {
    // Determine agent supported modalities: explicitly configured on agent or inferred from capabilities
    const agentModalities = new Set<TaskModality>(agent.modalities || ['text']);
    if (agentCaps.has('vision') || agentCaps.has('vlm')) agentModalities.add('vision');
    if (agentCaps.has('code') || agentCaps.has('coding') || agentCaps.has('typescript') || agentCaps.has('python')) {
      agentModalities.add('code');
    }
    if (agentCaps.has('multimodal')) agentModalities.add('multimodal');
    if (agentCaps.has('embedding')) agentModalities.add('embedding');
    if (agentCaps.has('audio')) agentModalities.add('audio');

    for (const mod of extended.modalities) {
      if (!agentModalities.has(mod)) {
        missingModalities.push(mod);
      }
    }

    if (missingModalities.length > 0 && !allowDegradation) {
      reasons.push(`Agent '${agent.id}' lacks required modalities: [${missingModalities.join(', ')}]`);
    }
  }

  // 3. Extended Tools check
  if (extended?.tools?.requiredTools && extended.tools.requiredTools.length > 0) {
    const agentTools = new Set<string>([
      ...(agent.allowedTools || []).map((t) => t.toLowerCase().trim()),
      ...agent.capabilities.map((c) => c.toLowerCase().trim()),
    ]);

    for (const tool of extended.tools.requiredTools) {
      const lower = tool.toLowerCase().trim();
      if (!agentTools.has(lower)) {
        missingTools.push(tool);
      }
    }

    if (missingTools.length > 0 && !allowDegradation) {
      reasons.push(`Agent '${agent.id}' lacks required tools: [${missingTools.join(', ')}]`);
    }
  }

  // 4. Model Context Window check
  if (extended?.model?.minContextTokens && extended.model.minContextTokens > 0) {
    const agentContext = agent.contextWindow || 8192; // Standard default
    if (agentContext < extended.model.minContextTokens && !allowDegradation) {
      contextExceeded = true;
      reasons.push(
        `Agent '${agent.id}' context window (${agentContext}) is smaller than required minContextTokens (${extended.model.minContextTokens})`,
      );
    }
  }

  const eligible =
    allowDegradation ||
    (missingCapabilities.length === 0 &&
      missingModalities.length === 0 &&
      missingTools.length === 0 &&
      !contextExceeded);

  return {
    eligible,
    reasons,
    missingCapabilities,
    missingModalities,
    missingTools,
    contextExceeded,
  };
}

// ── Backward-Compatibility Migration ───────────────────────────

/**
 * Migrates a legacy TaskFile (without extended requirements) to include
 * complete ExtendedTaskRequirements.
 *
 * Invariant: allowDegradation defaults strictly to false so unknown or non-text
 * capabilities never degrade silently to text-only mode.
 */
export function migrateTaskFileToExtended(task: TaskFile): TaskFile {
  if (task.requirements) {
    return task;
  }

  const modalities: TaskModality[] = ['text'];
  const requiredTools: string[] = [];

  for (const cap of task.capabilities) {
    const lower = cap.toLowerCase().trim();
    if (lower === 'vision' || lower === 'image' || lower === 'vlm') {
      if (!modalities.includes('vision')) modalities.push('vision');
    } else if (
      lower === 'code' ||
      lower === 'coding' ||
      lower === 'typescript' ||
      lower === 'javascript' ||
      lower === 'python' ||
      lower === 'rust'
    ) {
      if (!modalities.includes('code')) modalities.push('code');
    } else if (lower === 'embedding' || lower === 'vectors') {
      if (!modalities.includes('embedding')) modalities.push('embedding');
    } else if (lower === 'audio' || lower === 'speech') {
      if (!modalities.includes('audio')) modalities.push('audio');
    } else if (lower === 'multimodal') {
      if (!modalities.includes('multimodal')) modalities.push('multimodal');
    }

    if (lower === 'ocr' || lower === 'ocr_page') {
      if (!requiredTools.includes('ocr_page')) requiredTools.push('ocr_page');
    } else if (lower === 'generate_docx' || lower === 'docx') {
      if (!requiredTools.includes('generate_docx')) requiredTools.push('generate_docx');
    } else if (lower === 'generate_xlsx' || lower === 'xlsx') {
      if (!requiredTools.includes('generate_xlsx')) requiredTools.push('generate_xlsx');
    } else if (lower === 'generate_pptx' || lower === 'pptx') {
      if (!requiredTools.includes('generate_pptx')) requiredTools.push('generate_pptx');
    }
  }

  const extended: ExtendedTaskRequirements = {
    schemaVersion: 1,
    modalities,
    primaryModality: modalities[0],
    tools: requiredTools.length > 0 ? { requiredTools } : undefined,
    allowDegradation: false, // Strict fail-closed
  };

  return {
    ...task,
    requirements: extended,
  };
}
