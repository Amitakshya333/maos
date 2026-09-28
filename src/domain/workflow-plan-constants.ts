/** Browser-safe constants for workflow-plan validation. */

export type WorkflowStepType =
  | 'INGEST_EVIDENCE'
  | 'RASTERIZE_DOCUMENT'
  | 'RUN_OCR'
  | 'ANALYZE_IMAGE'
  | 'REVIEW_CONFLICT'
  | 'SEARCH_KNOWLEDGE_BASE'
  | 'GENERATE_DOCX'
  | 'GENERATE_XLSX'
  | 'GENERATE_PPTX'
  | 'REQUEST_APPROVAL'
  | 'FINALIZE_ARTIFACT';

export const WORKFLOW_STEP_TYPES: readonly WorkflowStepType[] = [
  'INGEST_EVIDENCE',
  'RASTERIZE_DOCUMENT',
  'RUN_OCR',
  'ANALYZE_IMAGE',
  'REVIEW_CONFLICT',
  'SEARCH_KNOWLEDGE_BASE',
  'GENERATE_DOCX',
  'GENERATE_XLSX',
  'GENERATE_PPTX',
  'REQUEST_APPROVAL',
  'FINALIZE_ARTIFACT',
];

export type WorkflowStepStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'WAITING_APPROVAL';

export const WORKFLOW_STEP_STATUSES: readonly WorkflowStepStatus[] = [
  'PENDING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'WAITING_APPROVAL',
];

export type WorkflowPlanStatus =
  | 'READY'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED';

export const WORKFLOW_PLAN_STATUSES: readonly WorkflowPlanStatus[] = [
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'REJECTED',
];

export const MAX_WORKFLOW_PLAN_STEPS = 100;
export const MAX_STEP_TITLE_LENGTH = 500;
export const MAX_STEP_DEPENDENCIES = 50;
export const MAX_PLAN_ID_LENGTH = 128;
