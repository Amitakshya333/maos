/**
 * TASK DEV-A-01 (Dev A): shared dependency surface for Ring tools.
 *
 * Tools are pure `(ctx, args)` functions over the frozen `RingToolContext`
 * (`{ projectRoot, evidenceRoot, runId, runContext }`). Anything beyond
 * that surface (service handles, project id) arrives through this deps
 * object, closed over by each tool factory in `index.ts`. No frozen file
 * is touched.
 */

import type { AuditService } from '../audit-service';
import type { DocxGeneratorService } from '../docx-generator-service';
import type { XlsxGeneratorService } from '../xlsx-generator-service';
import type { MemoryService } from '../memory-service';
import type { OcrService } from '../ocr-service';
import type { VisionService } from '../vision-service';
import type { RingKbSearchLike } from '../ring-agent-service';

export interface RingToolDeps {
  auditService?: AuditService;
  kbSearch?: RingKbSearchLike;
  ocrService?: OcrService;
  visionService?: VisionService;
  docxGenerator?: DocxGeneratorService;
  xlsxGenerator?: XlsxGeneratorService;
  memoryService?: MemoryService;
  /** Resolves the project id for office inputs; defaults to 'default'. */
  getProjectId?: () => string;
}

export function resolveProjectId(deps: RingToolDeps): string {
  try {
    const id = deps.getProjectId?.();
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    /* fall through to default */
  }
  return 'default';
}

/**
 * Best-effort audit for a tool execution. Audit must never break a tool:
 * every failure is swallowed. Mirrors the existing ring pattern
 * (`RING_APPROVAL_RESOLVED` is recorded try/catch in ring-agent-service).
 */
export function auditToolExecution(
  deps: RingToolDeps,
  ctx: { runId: string },
  toolName: string,
  ok: boolean,
  extra?: Record<string, unknown>,
): void {
  if (!deps.auditService) return;
  try {
    deps.auditService.recordAuditEvent({
      category: 'tool',
      source: 'ring-agent',
      data: { event: 'RING_TOOL_EXECUTED', runId: ctx.runId, toolName, ok, ...(extra || {}) },
    });
  } catch {
    /* audit must not break tool execution */
  }
}
