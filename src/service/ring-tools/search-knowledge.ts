/**
 * TASK DEV-A-01 (Dev A): search_knowledge tool module.
 *
 * Migrated verbatim from RingAgentService.toolSearchKnowledge: same input
 * (query required, topK clamped 1..10), same unavailable/no-answer honest
 * results (never fabricates), same citation projection (documentId,
 * sourcePath, score, snippet truncated to 300 chars).
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { resolveProjectId, type RingToolDeps } from './tool-deps';

export function createSearchKnowledgeTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'search_knowledge',
    description:
      'Search indexed company knowledge if an index is available. Returns an honest unavailable/no-answer result when no index exists; never fabricates results.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, topK: { type: 'number' } },
      required: ['query'],
    },
    consequential: false,
    execute: async (toolCtx, toolArgs) => {
      const query = typeof toolArgs.query === 'string' ? toolArgs.query.trim() : '';
      if (!query) return { ok: false, error: 'search_knowledge requires a non-empty query.' };
      if (!deps.kbSearch || (!deps.kbSearch.searchSync && !deps.kbSearch.search)) {
        return {
          ok: true,
          available: false,
          answered: false,
          query: truncate(query, 200),
          results: [],
          message: 'Knowledge search is unavailable: no indexed company knowledge search is configured for this run. No results were fabricated.',
        };
      }
      try {
        const projectId = resolveProjectId(deps);
        const topK = typeof toolArgs.topK === 'number' ? Math.min(Math.max(1, Math.floor(toolArgs.topK)), 10) : 5;
        const input: Record<string, unknown> = { schemaVersion: 1, projectId, query, topK };
        const raw = deps.kbSearch.searchSync ? deps.kbSearch.searchSync(input) : await deps.kbSearch.search!(input);
        const result = raw as Record<string, unknown>;
        if (result && result.answered === true && Array.isArray(result.citations)) {
          return {
            ok: true,
            available: true,
            answered: true,
            query: truncate(query, 200),
            totalMatches: result.totalMatches,
            results: (result.citations as Array<Record<string, unknown>>).slice(0, 5).map((c) => ({
              documentId: c.documentId,
              sourcePath: c.sourcePath,
              score: c.score,
              snippet: typeof c.snippet === 'string' ? truncate(c.snippet, 300) : undefined,
            })),
            message: 'Knowledge search returned indexed citations.',
          };
        }
        const reason = typeof result?.reason === 'string' ? result.reason : 'NO_ANSWER';
        const details = typeof result?.details === 'string' ? result.details : 'No indexed answer was returned.';
        return {
          ok: true,
          available: true,
          answered: false,
          query: truncate(query, 200),
          results: [],
          message: 'Knowledge search returned no answer (' + reason + '): ' + details + ' No results were fabricated.',
        };
      } catch (err) {
        return {
          ok: true,
          available: false,
          answered: false,
          query: truncate(query, 200),
          results: [],
          message: 'Knowledge search is unavailable: ' + (err instanceof Error ? err.message : String(err)) + ' No results were fabricated.',
        };
      }
    },
  };
}
