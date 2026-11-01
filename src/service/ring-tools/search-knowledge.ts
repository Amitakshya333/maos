/**
 * TASK RING-CONTRACT-01 (Dev C stub): search_knowledge tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from `RingAgentService.toolSearchKnowledge`):
 * same input (`query` required, `topK` clamped 1..10), same unavailable /
 * no-answer honest results (never fabricates), same citation projection
 * (documentId, sourcePath, score, snippet truncated to 300 chars).
 *
 * Dev C implements `execute` by moving the method body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const searchKnowledgeTool: RingToolDefinition = {
  name: 'search_knowledge',
  description:
    'Search indexed company knowledge if an index is available. Returns an honest unavailable/no-answer result when no index exists; never fabricates results.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, topK: { type: 'number' } },
    required: ['query'],
  },
  consequential: false,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: search_knowledge still executes in ring-agent-service; Dev C migrates it.');
  },
};
