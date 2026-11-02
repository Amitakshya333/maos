/**
 * TASK DEV-A-01 (Dev A): verify_export tool module.
 *
 * Migrated verbatim from RingAgentService.toolVerifyExport: same input
 * (optional exportPath), same isStrictlyWithin check, same
 * audit-service.verifyChainRecords code path, same honest unavailable
 * results when no audit service is configured.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RingToolDefinition } from '../ring-contract';
import { isStrictlyWithin } from './common';
import type { RingToolDeps } from './tool-deps';

export function createVerifyExportTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'verify_export',
    description:
      'Verify an audit export (or the live audit trail) using the real audit chain verification code path.',
    parameters: {
      type: 'object',
      properties: { exportPath: { type: 'string', description: 'Optional project-relative audit export JSON path.' } },
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      const runExportPath = (toolCtx.runContext as Record<string, unknown> | undefined)?.exportPath;
      const requested =
        (typeof toolArgs.exportPath === 'string' && toolArgs.exportPath.trim()) ||
        (typeof runExportPath === 'string' && runExportPath.trim()) ||
        '';
      if (requested) {
        const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(toolCtx.projectRoot, requested);
        if (!isStrictlyWithin(toolCtx.projectRoot, resolved)) {
          throw new Error('PATH_OUTSIDE_PROJECT_ROOT: audit export path is outside the project root: ' + requested);
        }
        if (!fs.existsSync(resolved)) {
          return { ok: true, valid: false, exportPath: requested, recordCount: 0, errors: ['Audit export file not found: ' + requested], message: 'Audit export verification failed: file not found (' + requested + ').' };
        }
        if (!deps.auditService) {
          return { ok: true, available: false, valid: false, exportPath: requested, message: 'Audit verification unavailable: no audit service is configured for this run. No verification was fabricated.' };
        }
        const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
        const records = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.records;
        if (!Array.isArray(records)) {
          return { ok: true, valid: false, exportPath: requested, recordCount: 0, errors: ['Audit export does not contain a records array.'], message: 'Audit export verification failed: no records array.' };
        }
        const verification = deps.auditService.verifyChainRecords(records as never);
        return {
          ok: true,
          valid: verification.valid,
          method: 'audit-service.verifyChainRecords',
          exportPath: path.relative(toolCtx.projectRoot, resolved).split(path.sep).join('/'),
          recordCount: verification.recordCount,
          latestHash: verification.latestHash,
          errors: verification.errors,
          message: verification.valid
            ? 'Audit export verified (' + verification.recordCount + ' records).'
            : 'Audit export verification failed: ' + verification.errors.join('; '),
        };
      }
      if (!deps.auditService) {
        return { ok: true, available: false, valid: false, message: 'Audit verification unavailable: no export path was provided and no audit service is configured. No verification was fabricated.' };
      }
      const exported = deps.auditService.exportAuditTrail();
      return {
        ok: true,
        valid: exported.verification.valid,
        method: 'audit-service.exportAuditTrail',
        recordCount: exported.verification.recordCount,
        latestHash: exported.verification.latestHash,
        errors: exported.verification.errors,
        message: exported.verification.valid
          ? 'Live audit trail verified (' + exported.verification.recordCount + ' records).'
          : 'Live audit trail verification returned valid=' + String(exported.verification.valid) + ': ' + exported.verification.errors.join('; '),
      };
    },
  };
}
