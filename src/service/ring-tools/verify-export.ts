/**
 * TASK RING-CONTRACT-01 (Dev C stub): verify_export tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from `RingAgentService.toolVerifyExport`):
 * same input (optional `exportPath`), same isStrictlyWithin check, same
 * audit-service.verifyChainRecords code path, same honest unavailable
 * results when no audit service is configured.
 *
 * Dev C implements `execute` by moving the method body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const verifyExportTool: RingToolDefinition = {
  name: 'verify_export',
  description:
    'Verify an audit export (or the live audit trail) using the real audit chain verification code path.',
  parameters: {
    type: 'object',
    properties: { exportPath: { type: 'string', description: 'Optional project-relative audit export JSON path.' } },
  },
  consequential: false,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: verify_export still executes in ring-agent-service; Dev C migrates it.');
  },
};
