/**
 * TASK DEV-A-01 (Dev A): recall tool (MemoryService wrapper).
 *
 * Searches stored equipment notes and preferences by substring via the
 * existing MemoryService (no rewrite). Returns short summaries only.
 * Non-consequential. Honest unavailable result when no memory service
 * is configured.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { auditToolExecution, type RingToolDeps } from './tool-deps';

export function createRecallTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'recall',
    description:
      'Search stored equipment notes and preferences from prior turns. Returns short summaries; never fabricates notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for in stored notes.' },
        topK: { type: 'number', description: 'Max notes to return (1..10, default 5).' },
      },
      required: ['query'],
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      if (!deps.memoryService) {
        return { ok: true, available: false, answered: false, results: [], message: 'Memory is unavailable: no memory service is configured for this run. No notes were fabricated.' };
      }
      const query = typeof toolArgs.query === 'string' ? toolArgs.query.trim() : '';
      if (!query) return { ok: false, error: 'recall requires a non-empty query.' };
      const topK = typeof toolArgs.topK === 'number' ? Math.min(Math.max(1, Math.floor(toolArgs.topK)), 10) : 5;
      const matches = deps.memoryService.search(query).slice(0, topK);
      const results = matches.map((m) => ({
        noteId: m.id,
        summary: truncate(m.content, 300),
        type: m.type,
        tags: m.tags,
      }));
      auditToolExecution(deps, toolCtx, 'recall', true, { query: truncate(query, 200), matches: results.length });
      return {
        ok: true,
        available: true,
        query: truncate(query, 200),
        results,
        message: results.length > 0 ? 'Recalled ' + results.length + ' stored note(s).' : 'No stored notes matched the query. No notes were fabricated.',
      };
    },
  };
}
