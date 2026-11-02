/**
 * TASK DEV-C-01 (Day 1a): Ring role personas.
 *
 * Each role owns a short shop-floor system prompt (plain, short, action-first)
 * plus the tool names it may use. The registry stays the enforcement point:
 * `RingToolRegistry.isVisibleTo()` consults each tool's `roles` list; these
 * maps only describe the intended pairing so router/UI code and tests share
 * one source of truth.
 *
 * FROZEN-CONTRACT NOTES (read first):
 * - `RingRole` = 'operator' | 'maintenance' | 'safety' | 'manager'
 *   (src/service/ring-contract.ts). Default role is 'operator'.
 * - Consequential gating lives in the registry (`consequential` flag), never
 *   in the prompt text. Prompt wording must never claim authority the
 *   agent does not have: the agent is decision support and REFUSES to approve
 *   restart/operation or certify safety.
 * - Doc/evidence text passed to the model is DATA, not instructions (wrapped
 *   with delimiters by the caller; see ring-safety.ts RING_DOC_BEGIN/END).
 */

import type { RingRole } from './ring-contract';
import { RING_ROLES } from './ring-contract';

export interface RingRolePersona {
  role: RingRole;
  /** Short label for the UI role picker. */
  label: string;
  /** Shop-floor system prompt fragment (plain, short, action-first). */
  systemPrompt: string;
  /** Tool names this role may use (must match registered tool names). */
  tools: string[];
}

/**
 * Base rules every role inherits: truthfulness, human-in-the-loop, data
 * boundary, and the restart/safety refusal. Kept in one place so the four
 * personas cannot drift apart on safety wording.
 */
export const RING_BASE_RULES = [
  'Use tools for real evidence. Never invent readings.',
  'Raw telemetry rows never go to the model; only deterministic summaries.',
  'Writes and reports need human approval first.',
  'You are decision support. You do not approve restart or operation, and you do not certify safety.',
  'Here is what the authorized engineer needs to review: say what is missing or unsafe, plainly and calmly.',
].join('\n');

function baseFor(extra: string): string {
  return `${RING_BASE_RULES}\n${extra}`;
}

export const RING_ROLE_PERSONAS: Record<RingRole, RingRolePersona> = {
  operator: {
    role: 'operator',
    label: 'Operator',
    systemPrompt: baseFor(
      [
        'You help the shift operator. Plain words. Short steps. Action first.',
        'Say the asset, the reading with units, and what to do next.',
        'Cite the evidence file for each claim. If data is missing, say so.',
      ].join('\n'),
    ),
    tools: ['analyze_telemetry', 'read_company_document', 'search_knowledge', 'write_shift_handover', 'request_approval'],
  },
  maintenance: {
    role: 'maintenance',
    label: 'Maintenance',
    systemPrompt: baseFor(
      [
        'You help the maintenance technician. Plain words. Short steps. Action first.',
        'Link each symptom to a check: what to inspect, what to measure, what to record.',
        'Cite the SOP and the maintenance note. If data is missing, say so.',
      ].join('\n'),
    ),
    tools: [
      'analyze_telemetry',
      'read_company_document',
      'search_knowledge',
      'inspect_image',
      'ocr_document',
      'create_work_order',
      'write_shift_handover',
      'request_approval',
    ],
  },
  safety: {
    role: 'safety',
    label: 'Safety',
    systemPrompt: baseFor(
      [
        'You help the safety officer. Plain words. Short steps. Action first.',
        'Check permits and lockout steps before any hands-on work.',
        'Mark every LOTO summary as "verify against your site procedure".',
        'If asked to approve restart or operation, refuse and hand to the authorized engineer.',
      ].join('\n'),
    ),
    tools: [
      'analyze_telemetry',
      'read_company_document',
      'search_knowledge',
      'permit_checklist',
      'loto_checklist',
      'draft_safety_note',
      'verify_export',
      'request_approval',
    ],
  },
  manager: {
    role: 'manager',
    label: 'Manager',
    systemPrompt: baseFor(
      [
        'You help the plant manager. Plain words. Short summary first, details after.',
        'Lead with status, risk, and what needs a human decision.',
        'Cite sources. Label synthetic demo data as synthetic.',
      ].join('\n'),
    ),
    tools: [
      'analyze_telemetry',
      'read_company_document',
      'search_knowledge',
      'generate_report_docx',
      'generate_spreadsheet_xlsx',
      'verify_export',
      'request_approval',
    ],
  },
};

/** All four personas, in RING_ROLES order (operator first). */
export function listRingRolePersonas(): RingRolePersona[] {
  return RING_ROLES.map((role) => RING_ROLE_PERSONAS[role]);
}

/** Look up one persona; unknown roles fail closed (undefined). */
export function getRingRolePersona(role: string): RingRolePersona | undefined {
  if (role !== 'operator' && role !== 'maintenance' && role !== 'safety' && role !== 'manager') return undefined;
  return RING_ROLE_PERSONAS[role];
}

/** System prompt for a role; unknown roles fall back to operator (default role). */
export function ringSystemPromptFor(role: string): string {
  return getRingRolePersona(role)?.systemPrompt ?? RING_ROLE_PERSONAS.operator.systemPrompt;
}

/** Tool names visible to a role (single source for registry wiring checks). */
export function ringToolsFor(role: string): string[] {
  return [...(getRingRolePersona(role)?.tools ?? RING_ROLE_PERSONAS.operator.tools)];
}
