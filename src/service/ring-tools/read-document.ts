/**
 * TASK RING-CONTRACT-01 (Dev C stub): read_company_document tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from `RingAgentService.toolReadCompanyDocument`):
 * same input (`path` relative to the run evidence root), same
 * isWithin/isStrictlyWithin + realpath checks, same 256 KB limit, same CSV
 * refusal text, same truncate(content, 6000) output shape with bytes.
 *
 * Dev C implements `execute` by moving the method body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const readCompanyDocumentTool: RingToolDefinition = {
  name: 'read_company_document',
  description:
    'Read a text company document located under the project evidence root. Paths outside the evidence root are refused.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Document path relative to the evidence root (or project-relative inside it).' },
    },
    required: ['path'],
  },
  consequential: false,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: read_company_document still executes in ring-agent-service; Dev C migrates it.');
  },
};
