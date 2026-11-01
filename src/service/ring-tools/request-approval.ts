/**
 * TASK RING-CONTRACT-01 (Dev C stub): request_approval tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from the `request_approval` branch
 * of `RingAgentService.executeTool`): same input (`summary` + `reason`),
 * same `{ ok: true, approved: true, message }` result after the human grants
 * approval. CONSEQUENTIAL: the registry flag (not the model) gates the
 * approval pause.
 *
 * Dev C implements `execute` by moving the branch body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const requestApprovalTool: RingToolDefinition = {
  name: 'request_approval',
  description:
    'Ask a human to approve a proposed consequential action. Pauses the run until the approval is resolved.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' }, reason: { type: 'string' } },
    required: ['summary'],
  },
  consequential: true,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: request_approval still executes in ring-agent-service; Dev C migrates it.');
  },
};
