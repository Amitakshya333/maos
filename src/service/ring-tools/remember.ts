/**
 * TASK DEV-A-01 (Dev A): remember tool (MemoryService wrapper).
 *
 * Stores an equipment note or user preference for future turns via the
 * existing MemoryService (no rewrite; additive `share()` passthrough).
 * Records a `memory.saved` streaming event carrying the stored note id
 * and summary. Non-consequential.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { auditToolExecution, type RingToolDeps } from './tool-deps';

const VALID_TYPES = ['DISCOVERY', 'DECISION', 'WARNING', 'FILE_MAP'] as const;

export function createRememberTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'remember',
    description:
      'Store an equipment note or user preference for future turns via the shared team memory. Returns the stored note id and summary.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note text (1..2000 chars). Equipment facts, user preferences, follow-up context.' },
        type: { type: 'string', description: 'One of DISCOVERY, DECISION, WARNING, FILE_MAP. Defaults to DISCOVERY.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags, e.g. ["T-07", "vibration"].' },
      },
      required: ['content'],
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      if (!deps.memoryService) {
        return { ok: true, available: false, message: 'Memory is unavailable: no memory service is configured for this run. Nothing was stored.' };
      }
      const content = typeof toolArgs.content === 'string' ? toolArgs.content.trim() : '';
      if (!content) return { ok: false, error: 'remember requires non-empty content.' };
      if (content.length > 2000) return { ok: false, error: 'remember content exceeds the 2000-character limit.' };
      const rawType = typeof toolArgs.type === 'string' ? toolArgs.type.trim().toUpperCase() : 'DISCOVERY';
      const type = (VALID_TYPES as readonly string[]).includes(rawType) ? (rawType as (typeof VALID_TYPES)[number]) : 'DISCOVERY';
      const tags = Array.isArray(toolArgs.tags)
        ? (toolArgs.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 10).map((t) => t.trim())
        : [];
      const entry = deps.memoryService.share({
        agentId: 'ring-agent',
        taskId: toolCtx.runId,
        type,
        content,
        tags,
        confidence: 1,
      });
      const summary = truncate(content, 200);
      auditToolExecution(deps, toolCtx, 'remember', true, { noteId: entry.id });
      return {
        ok: true,
        noteId: entry.id,
        summary,
        // Service-side envelope: recorded as memory.saved, stripped before
        // the result reaches the model.
        __ringEvents: [{ type: 'memory.saved', memory: { noteId: entry.id, summary } }],
      };
    },
  };
}
