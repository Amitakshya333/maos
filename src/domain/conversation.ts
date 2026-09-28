/**
 * MAOS Conversation & Task Promotion Domain Schemas
 *
 * Defines contracts, bounds, and pure validation logic for interactive
 * chat conversations, attachments, and explicit promotion into tracked tasks.
 */
import type { Task, Conversation } from './schemas';

export interface ConversationValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function ok(): ConversationValidationResult {
  return { valid: true, errors: [] };
}

function fail(errors: string[]): ConversationValidationResult {
  return { valid: false, errors };
}

export const ATTACHMENT_BOUNDS = {
  MAX_ATTACHMENT_SIZE_BYTES: 52_428_800, // 50 MB
  MAX_ATTACHMENTS_PER_MESSAGE: 10,
  MAX_FILENAME_LENGTH: 255,
  MAX_PATH_LENGTH: 1024,
  MAX_CONVERSATION_TITLE_LENGTH: 120,
} as const;

export interface ChatAttachment {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly sha256?: string;
}

import type { OperationalMode } from './evidence-mode';

export interface PromoteToTaskInput {
  readonly conversationId: string;
  readonly messageId?: string;
  readonly description: string;
  readonly agent?: string;
  readonly branch?: string;
  readonly priority?: string;
  readonly complexity?: 'low' | 'medium' | 'high';
  readonly category?: string;
  readonly attachments?: ChatAttachment[];
  readonly mode?: OperationalMode;
  readonly allowUnreviewedBrainstorm?: boolean;
}

export interface PromoteToTaskResult {
  readonly task: Task;
  readonly conversation: Conversation;
}

export interface ProjectFileInfo {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly isDirectory: boolean;
  readonly mimeType?: string;
  readonly extension?: string;
}

/**
 * Validates a single ChatAttachment.
 */
export function validateChatAttachment(input: unknown): ConversationValidationResult {
  if (!input || typeof input !== 'object') {
    return fail(['Attachment must be an object']);
  }
  const att = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof att.id !== 'string' || !att.id.trim()) {
    errors.push('Attachment id must be a non-empty string');
  }

  if (typeof att.name !== 'string' || !att.name.trim()) {
    errors.push('Attachment name must be a non-empty string');
  } else if (att.name.length > ATTACHMENT_BOUNDS.MAX_FILENAME_LENGTH) {
    errors.push(`Attachment name exceeds max length ${ATTACHMENT_BOUNDS.MAX_FILENAME_LENGTH}`);
  }

  if (typeof att.relativePath !== 'string' || !att.relativePath.trim()) {
    errors.push('Attachment relativePath must be a non-empty string');
  } else {
    const p = att.relativePath.replace(/\\/g, '/');
    if (p.includes('..') || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) {
      errors.push('Attachment relativePath cannot contain traversal, drive letters, null bytes, or lead with a slash');
    }
    if (p.length > ATTACHMENT_BOUNDS.MAX_PATH_LENGTH) {
      errors.push(`Attachment relativePath exceeds max length ${ATTACHMENT_BOUNDS.MAX_PATH_LENGTH}`);
    }
  }

  if (typeof att.sizeBytes !== 'number' || !Number.isFinite(att.sizeBytes) || att.sizeBytes < 0) {
    errors.push('Attachment sizeBytes must be a non-negative number');
  } else if (att.sizeBytes > ATTACHMENT_BOUNDS.MAX_ATTACHMENT_SIZE_BYTES) {
    errors.push(`OVERSIZED_ATTACHMENT: Attachment exceeds limit of ${ATTACHMENT_BOUNDS.MAX_ATTACHMENT_SIZE_BYTES} bytes (50MB)`);
  }

  if (typeof att.mimeType !== 'string' || !att.mimeType.trim()) {
    errors.push('Attachment mimeType must be a non-empty string');
  }

  return errors.length > 0 ? fail(errors) : ok();
}

/**
 * Validates a PromoteToTaskInput payload.
 */
export function validatePromoteToTaskInput(input: unknown): ConversationValidationResult {
  if (!input || typeof input !== 'object') {
    return fail(['PromoteToTaskInput must be an object']);
  }
  const p = input as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof p.conversationId !== 'string' || !p.conversationId.trim()) {
    errors.push('Field "conversationId" must be a non-empty string');
  }

  if (typeof p.description !== 'string' || !p.description.trim()) {
    errors.push('Field "description" must be a non-empty string');
  }

  if (p.complexity !== undefined && p.complexity !== null) {
    if (!['low', 'medium', 'high'].includes(p.complexity as string)) {
      errors.push('Field "complexity" must be one of ["low", "medium", "high"]');
    }
  }

  if (p.attachments !== undefined && p.attachments !== null) {
    if (!Array.isArray(p.attachments)) {
      errors.push('Field "attachments" must be an array');
    } else {
      if (p.attachments.length > ATTACHMENT_BOUNDS.MAX_ATTACHMENTS_PER_MESSAGE) {
        errors.push(`Attachments exceed maximum count of ${ATTACHMENT_BOUNDS.MAX_ATTACHMENTS_PER_MESSAGE}`);
      }
      for (const att of p.attachments) {
        const attRes = validateChatAttachment(att);
        if (!attRes.valid) {
          errors.push(...attRes.errors);
        }
      }
    }
  }

  if (p.mode !== undefined && p.mode !== null) {
    if (!['evidence', 'brainstorm', 'industrial'].includes(p.mode as string)) {
      errors.push('Field "mode" must be one of ["evidence", "brainstorm", "industrial"]');
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}
