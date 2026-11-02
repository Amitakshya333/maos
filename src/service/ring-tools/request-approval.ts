/**
 * TASK DEV-A-01 (Dev A): request_approval tool module.
 *
 * Migrated verbatim from the request_approval branch of
 * RingAgentService.executeTool: same input (summary + reason), same
 * `{ ok: true, approved: true, message }` result after the human grants
 * approval. CONSEQUENTIAL: the registry flag (not the model) gates the
 * approval pause; this body only runs after the pause resolves approved.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import type { RingToolDeps } from './tool-deps';

export function createRequestApprovalTool(_deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'request_approval',
    description:
      'Ask a human to approve a proposed consequential action. Pauses the run until the approval is resolved.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' }, reason: { type: 'string' } },
      required: ['summary'],
    },
    consequential: true,
    execute: (_toolCtx, toolArgs) => {
      return {
        ok: true,
        approved: true,
        message: 'Human approval was granted for the proposed action.',
        summary: typeof toolArgs.summary === 'string' ? truncate(toolArgs.summary, 300) : undefined,
      };
    },
  };
}
