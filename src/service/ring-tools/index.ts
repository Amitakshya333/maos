/**
 * TASK DEV-A-01 (Dev A): tool module barrel + registry wiring.
 *
 * Registers the six migrated tools (behavior unchanged) plus the Day 2
 * tools. Registration order is stable: the original six first (provider
 * prompt stability), then the new tools. Consequential enforcement lives
 * in the REGISTRY (`isConsequential` is the single approval gate), never
 * in the model; unknown tools fail closed as consequential.
 */

import { RingToolRegistry } from '../ring-tool-registry';
import { createAnalyzeTelemetryTool } from './telemetry';
import { createReadCompanyDocumentTool } from './read-document';
import { createSearchKnowledgeTool } from './search-knowledge';
import { createDraftSafetyNoteTool } from './draft-note';
import { createVerifyExportTool } from './verify-export';
import { createRequestApprovalTool } from './request-approval';
import { createUpdatePlanTool } from './update-plan';
import { createRememberTool } from './remember';
import { createRecallTool } from './recall';
import { createOcrDocumentTool } from './ocr-document';
import { createInspectImageTool } from './inspect-image';
import { createGenerateReportDocxTool } from './generate-report-docx';
import { createGenerateSpreadsheetXlsxTool } from './generate-spreadsheet-xlsx';
import { createWorkOrderTool } from './create-work-order';
import { createWriteShiftHandoverTool } from './write-shift-handover';
import type { RingToolDeps } from './tool-deps';

export { createAnalyzeTelemetryTool } from './telemetry';
export { createReadCompanyDocumentTool } from './read-document';
export { createSearchKnowledgeTool } from './search-knowledge';
export { createDraftSafetyNoteTool } from './draft-note';
export { createVerifyExportTool } from './verify-export';
export { createRequestApprovalTool } from './request-approval';
export { createUpdatePlanTool } from './update-plan';
export { createRememberTool } from './remember';
export { createRecallTool } from './recall';
export { createOcrDocumentTool } from './ocr-document';
export { createInspectImageTool } from './inspect-image';
export { createGenerateReportDocxTool } from './generate-report-docx';
export { createGenerateSpreadsheetXlsxTool } from './generate-spreadsheet-xlsx';
export { createWorkOrderTool } from './create-work-order';
export { createWriteShiftHandoverTool } from './write-shift-handover';
export type { RingToolDeps } from './tool-deps';

const FACTORIES = [
  createAnalyzeTelemetryTool,
  createReadCompanyDocumentTool,
  createSearchKnowledgeTool,
  createDraftSafetyNoteTool,
  createVerifyExportTool,
  createRequestApprovalTool,
  createUpdatePlanTool,
  createRememberTool,
  createRecallTool,
  createOcrDocumentTool,
  createInspectImageTool,
  createGenerateReportDocxTool,
  createGenerateSpreadsheetXlsxTool,
  createWorkOrderTool,
  createWriteShiftHandoverTool,
];

/** Build a registry with all Ring tools registered in stable order. */
export function createRingToolRegistry(deps: RingToolDeps): RingToolRegistry {
  const registry = new RingToolRegistry();
  for (const factory of FACTORIES) {
    registry.register(factory(deps));
  }
  return registry;
}
