/**
 * TASK RING-CONTRACT-01 (Dev C stub): draft_safety_note tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from `RingAgentService.toolDraftSafetyNote`):
 * same input (`content` required; `title`/`filename` sanitized), same
 * `.maos/ring-runs/drafts/<runId>-<safe>.md` write with `wx` flag, same
 * sha256/bytes output. CONSEQUENTIAL: the registry flag (not the model)
 * gates the approval pause before any file is written.
 *
 * Dev C implements `execute` by moving the method body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const draftSafetyNoteTool: RingToolDefinition = {
  name: 'draft_safety_note',
  description:
    'Draft a safety note as text and write it under .maos/ring-runs/drafts after human approval. CONSEQUENTIAL: requires approval before any file is written.',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, content: { type: 'string' }, filename: { type: 'string' } },
    required: ['content'],
  },
  consequential: true,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: draft_safety_note still executes in ring-agent-service; Dev C migrates it.');
  },
};
