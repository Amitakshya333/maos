/**
 * TASK DEV-A-01 (Dev A): shared office-artifact builder for Ring tools.
 *
 * Maps small structured tool args onto the validated OfficeDocxInput /
 * OfficeXlsxInput contracts. Citations are never invented: every citation
 * is hashed from the evidence file on disk by the tool itself, CSV bodies
 * are never embedded (mirroring the read_company_document refusal), and
 * model-supplied prose lands in segregated unverified prose blocks.
 * The Ring registry approval gate (not the model) authorizes generation;
 * the generator's approval block records the real human approval id.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  OfficeCitation,
  OfficeDocxInput,
  OfficeFinding,
  OfficeMeasurement,
  OfficeReportSection,
  OfficeXlsxInput,
} from '../../domain/office-artifact';
import type { RingArtifactDescriptor } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { readEvidenceText, resolveEvidencePath, saveRunArtifact, snippetForCitation } from './common';
import { auditToolExecution, resolveProjectId, type RingToolDeps } from './tool-deps';

export interface RingOfficeSections {
  title: string;
  summary?: string;
  sections?: Array<{ heading: string; content?: string }>;
  findings?: Array<{
    statement: string;
    severity?: string;
    metric?: string;
    observedValue?: string | number;
    thresholdValue?: string | number;
    unit?: string;
  }>;
  measurements?: Array<{ name: string; numericValue: number; unit: string }>;
  evidencePaths?: string[];
  tables?: Array<{ title?: string; columns?: string[]; rows: Array<Array<string | number | boolean | null>> }>;
}

export interface RingRunApprovalRef {
  approvalId: string;
  decidedAt: string;
}

export interface RingTelemetryRef {
  verdict?: string;
  overallVibrationRms?: number;
  rowsAnalyzed?: number;
  csvRel?: string;
}

function failFast(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reject titles/headings the office validator would refuse (fail fast). */
export function sanitizeOfficeText(value: string, field: string, maxLen: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) failFast('OFFICE_' + field.toUpperCase() + '_REQUIRED: a non-empty ' + field + ' is required.');
  if (text.length > maxLen) failFast('OFFICE_' + field.toUpperCase() + '_TOO_LONG: ' + field + ' exceeds ' + maxLen + ' characters.');
  if (/^[=+\-@\t\r]/.test(text)) {
    failFast('OFFICE_FORMULA_INJECTION: ' + field + ' must not start with a formula character.');
  }
  return text;
}

function readApprovalRef(runContext: unknown): RingRunApprovalRef {
  const ref = asRecord(runContext).__lastApproval;
  const rec = asRecord(ref);
  if (typeof rec.approvalId !== 'string' || !rec.approvalId) {
    failFast('OFFICE_APPROVAL_REQUIRED: no recorded human approval for this generation; the approval gate must resolve first.');
  }
  return { approvalId: rec.approvalId, decidedAt: typeof rec.decidedAt === 'string' ? rec.decidedAt : new Date().toISOString() };
}

function readTelemetryRef(runContext: unknown): RingTelemetryRef | undefined {
  const tel = asRecord(asRecord(runContext).__telemetry);
  if (!tel || typeof tel.verdict !== 'string') return undefined;
  return {
    verdict: tel.verdict,
    overallVibrationRms: typeof tel.overallVibrationRms === 'number' ? tel.overallVibrationRms : undefined,
    rowsAnalyzed: typeof tel.rowsAnalyzed === 'number' ? tel.rowsAnalyzed : undefined,
    csvRel: typeof tel.csvRel === 'string' ? tel.csvRel : undefined,
  };
}

function containsMacroOrUrl(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('vba') || lower.includes('vbscript') || lower.includes('powershell') ||
    lower.includes('cmd.exe') || lower.includes('http://') || lower.includes('https://')
  );
}

interface BuiltCitations {
  citations: OfficeCitation[];
  evidenceLines: string[];
}

/** Hash cited evidence files from disk; CSV bodies are never embedded. */
function buildCitations(
  evidenceRoot: string,
  projectRoot: string,
  evidencePaths: string[] | undefined,
  telemetry: RingTelemetryRef | undefined,
): BuiltCitations {
  const citations: OfficeCitation[] = [];
  const evidenceLines: string[] = [];
  const seen = new Set<string>();
  let n = 0;
  const addCitation = (rel: string, snippet: string, sourceArtifactId?: string) => {
    if (seen.has(rel)) return 'cit-' + String([...seen].indexOf(rel) + 1).padStart(3, '0');
    n += 1;
    const id = 'cit-' + String(n).padStart(3, '0');
    const abs = path.resolve(projectRoot, rel);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    citations.push({
      citationId: id,
      sourceArtifactId,
      sourcePath: rel,
      sourceHash: hash,
      snippet: snippetForCitation(snippet),
      verifiedAt: new Date().toISOString(),
    });
    seen.add(rel);
    return id;
  };
  if (telemetry && telemetry.csvRel) {
    const csvAbs = path.resolve(projectRoot, telemetry.csvRel);
    if (fs.existsSync(csvAbs)) {
      const parts = ['Deterministic telemetry summary: verdict=' + String(telemetry.verdict)];
      if (typeof telemetry.overallVibrationRms === 'number') parts.push('overallVibrationRms=' + String(telemetry.overallVibrationRms) + ' mm/s');
      if (typeof telemetry.rowsAnalyzed === 'number') parts.push('rowsAnalyzed=' + String(telemetry.rowsAnalyzed));
      parts.push('(raw CSV rows are never embedded; see the evidence file for full detail)');
      const id = addCitation(telemetry.csvRel, parts.join('; '), 'telemetry-csv');
      void id;
      evidenceLines.push('Telemetry verdict ' + String(telemetry.verdict) + ' from ' + telemetry.csvRel + '.');
    }
  }
  for (const requested of evidencePaths || []) {
    if (typeof requested !== 'string' || !requested.trim()) continue;
    const resolved = resolveEvidencePath(evidenceRoot, projectRoot, requested);
    const read = readEvidenceText(resolved.abs, resolved.rel);
    const snippet = read.refusedCsv
      ? 'CSV content is not returned raw. Deterministic telemetry summary only.'
      : read.text;
    addCitation(resolved.rel, snippet || '(empty file)', undefined);
    evidenceLines.push('Cited ' + resolved.rel + ' (' + read.bytes + ' bytes).');
  }
  return { citations, evidenceLines };
}

export interface BuiltOfficeInput {
  docxInput: OfficeDocxInput;
  xlsxInput: OfficeXlsxInput;
  approvalId: string;
}

/**
 * Build deterministic docx/xlsx inputs from small structured args.
 * Model-supplied prose is segregated as unverified; measurements and
 * findings cite tool-hashed evidence. Throws honest errors for bad input.
 */
export function buildOfficeInput(
  deps: RingToolDeps,
  toolCtx: { projectRoot: string; evidenceRoot: string; runId: string; runContext: unknown },
  args: RingOfficeSections,
): BuiltOfficeInput {
  const title = sanitizeOfficeText(args.title || '', 'title', 256);
  const approval = readApprovalRef(toolCtx.runContext);
  const telemetry = readTelemetryRef(toolCtx.runContext);
  const evidencePaths = Array.isArray(args.evidencePaths) ? args.evidencePaths.filter((p) => typeof p === 'string').slice(0, 20) : [];
  const { citations, evidenceLines } = buildCitations(toolCtx.evidenceRoot, toolCtx.projectRoot, evidencePaths, telemetry);
  const firstCitation = citations[0]?.citationId;

  const measurements: OfficeMeasurement[] = [];
  for (const m of args.measurements || []) {
    const rec = asRecord(m);
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    if (typeof rec.numericValue !== 'number' || !Number.isFinite(rec.numericValue)) {
      failFast('OFFICE_MEASUREMENT_INVALID: measurement numericValue must be a finite number.');
    }
    if (typeof rec.unit !== 'string' || !rec.unit.trim()) {
      failFast('OFFICE_MEASUREMENT_UNIT: measurement unit is required.');
    }
    if (!firstCitation) failFast('OFFICE_MEASUREMENT_CITATION: measurements require at least one cited evidence file.');
    measurements.push({ id: 'meas-' + (measurements.length + 1), name: rec.name.trim().slice(0, 120), numericValue: rec.numericValue, unit: rec.unit.trim().slice(0, 40), status: 'unverified', citationIds: [firstCitation] });
  }

  const findings: OfficeFinding[] = [];
  for (const f of args.findings || []) {
    const rec = asRecord(f);
    if (typeof rec.statement !== 'string' || !rec.statement.trim()) continue;
    const statement = rec.statement.trim().slice(0, 2000);
    if (containsMacroOrUrl(statement)) failFast('OFFICE_FINDING_UNSAFE: finding statement contains a forbidden macro or URL pattern.');
    const sev = typeof rec.severity === 'string' ? rec.severity.trim().toLowerCase() : 'info';
    if (!firstCitation) failFast('OFFICE_FINDING_CITATION: findings require at least one cited evidence file.');
    findings.push({
      id: 'find-' + (findings.length + 1),
      category: 'observation',
      statement,
      severity: sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'info',
      status: 'WARNING',
      metric: typeof rec.metric === 'string' ? rec.metric.slice(0, 120) : undefined,
      observedValue: typeof rec.observedValue === 'string' || typeof rec.observedValue === 'number' ? rec.observedValue : undefined,
      thresholdValue: typeof rec.thresholdValue === 'string' || typeof rec.thresholdValue === 'number' ? rec.thresholdValue : undefined,
      unit: typeof rec.unit === 'string' && rec.unit.trim() ? rec.unit.trim().slice(0, 40) : undefined,
      citationIds: [firstCitation],
      verified: false,
    });
  }

  const sections: OfficeReportSection[] = [];
  const evidenceContent = evidenceLines.length > 0 ? evidenceLines.join('\n') : 'No evidence files were cited for this artifact.';
  sections.push({
    id: 'sec-evidence',
    heading: 'Evidence summary',
    content: truncate(evidenceContent, 4000),
    order: 1,
    findingIds: findings.map((f) => f.id),
    citationIds: citations.map((c) => c.citationId),
  });
  let order = 2;
  for (const s of args.sections || []) {
    const rec = asRecord(s);
    if (typeof rec.heading !== 'string' || !rec.heading.trim()) continue;
    const heading = sanitizeOfficeText(rec.heading, 'section heading', 256);
    const content = typeof rec.content === 'string' ? rec.content.slice(0, 65536) : '';
    if (content && containsMacroOrUrl(content)) failFast('OFFICE_SECTION_UNSAFE: section content contains a forbidden macro or URL pattern.');
    sections.push({ id: 'sec-' + order, heading, content, order });
    order += 1;
  }

  const units = [...new Set([...measurements.map((m) => m.unit), ...findings.map((f) => f.unit).filter((u): u is string => Boolean(u))])].slice(0, 50);
  const projectId = resolveProjectId(deps);
  const generatedAt = new Date().toISOString();
  const base = {
    schemaVersion: 1 as const,
    projectId,
    runId: toolCtx.runId,
    title,
    author: { id: 'ring-agent', name: 'MAOS Ring Agent', role: 'decision-support' },
    sections,
    findings,
    measurements,
    units,
    calculations: [],
    warnings: [],
    limitations: ['Synthetic demo data. Decision support only; not operating authority. Human review required before action.'],
    citations,
    sourceArtifactIds: [] as string[],
    sourceHashes: {} as Record<string, string>,
    references: [],
    evidenceState: {
      hasUnresolvedConflicts: false,
      isQuarantined: false,
      reviewedByHuman: true,
      reviewerId: 'human-operator',
      reviewerNotes: 'Ring run ' + toolCtx.runId + ' generation approved by human via approval ' + approval.approvalId + '.',
    },
    generatedAt,
    approval: {
      required: false,
      status: 'approved' as const,
      approvalId: approval.approvalId,
      approvedBy: 'human-operator',
      approvedAt: approval.decidedAt,
    },
    proseBlocks: [],
    conclusions: [],
  };
  const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 4000) : '';
  const proseBlocks = summary
    ? [{ id: 'prose-1', label: 'Model draft summary (unverified)', text: summary, isModelGenerated: true, verifiedAgainstData: false, approvedByReviewer: false }]
    : [];
  return {
    docxInput: { ...base, artifactType: 'docx' as const, proseBlocks },
    xlsxInput: { ...base, artifactType: 'xlsx' as const, proseBlocks },
    approvalId: approval.approvalId,
  };
}

export interface OfficeTwinResult {
  /** Tool result payload (before the service strips __ringEvents). */
  payload: Record<string, unknown>;
}

interface GeneratorLike {
  generateDocx?: (params: Record<string, unknown>) => { ok: boolean; relativePath?: string; artifactHash?: string; bytesWritten?: number; message?: string; error?: string };
  generateXlsx?: (params: Record<string, unknown>) => { ok: boolean; relativePath?: string; artifactHash?: string; bytesWritten?: number; message?: string; error?: string };
}

/**
 * Run the office generator, then write the markdown twin beside it.
 * Returns the tool payload with an __ringEvents envelope (one
 * artifact.created per file). The service records the events and strips
 * the envelope before the model sees the result.
 */
export function generateOfficeTwin(options: {
  deps: RingToolDeps;
  toolCtx: { projectRoot: string; runId: string };
  toolName: string;
  kind: 'docx' | 'xlsx';
  input: OfficeDocxInput | OfficeXlsxInput;
  fileStem: string;
  markdown: string;
  requestId: string;
}): OfficeTwinResult {
  const { deps, toolCtx, toolName, kind, input, fileStem, markdown, requestId } = options;
  const generator = (kind === 'docx' ? deps.docxGenerator : deps.xlsxGenerator) as unknown as GeneratorLike | undefined;
  const serviceName = kind === 'docx' ? 'DOCX' : 'XLSX';
  if (!generator || (kind === 'docx' ? !generator.generateDocx : !generator.generateXlsx)) {
    return {
      payload: {
        ok: true,
        available: false,
        message: serviceName + ' generation is unavailable: no ' + serviceName.toLowerCase() + ' generator service is configured for this run. Nothing was written.',
      },
    };
  }
  const safeStem = fileStem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'artifact';
  const outputRelPath = '.maos/ring-runs/artifacts/' + toolCtx.runId + '/' + safeStem + '.' + kind;
  const params: Record<string, unknown> = {
    schemaVersion: 1,
    projectId: input.projectId,
    input,
    outputPath: outputRelPath,
    requestId,
  };
  let genResult: { ok: boolean; relativePath?: string; artifactHash?: string; bytesWritten?: number; message?: string; error?: string };
  try {
    genResult = kind === 'docx' ? generator.generateDocx!(params) : generator.generateXlsx!(params);
  } catch (err) {
    return { payload: { ok: false, error: serviceName + ' generation failed: ' + (err instanceof Error ? err.message : String(err)) } };
  }
  if (!genResult || genResult.ok !== true || !genResult.relativePath) {
    return { payload: { ok: false, error: serviceName + ' generation failed: ' + String(genResult?.error || genResult?.message || 'unknown error') } };
  }
  const abs = path.resolve(toolCtx.projectRoot, genResult.relativePath);
  let size = typeof genResult.bytesWritten === 'number' ? genResult.bytesWritten : 0;
  let sha256 = typeof genResult.artifactHash === 'string' ? genResult.artifactHash : '';
  try {
    const buf = fs.readFileSync(abs);
    size = buf.length;
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    /* keep generator-reported values */
  }
  const officeDescriptor: RingArtifactDescriptor = { path: genResult.relativePath, kind, size, sha256 };
  const mdDescriptor = saveRunArtifact(toolCtx.projectRoot, toolCtx.runId, safeStem + '.md', markdown, 'markdown');
  auditToolExecution(deps, toolCtx, toolName, true, { artifacts: [officeDescriptor.path, mdDescriptor.path] });
  return {
    payload: {
      ok: true,
      primaryPath: officeDescriptor.path,
      artifacts: [officeDescriptor, mdDescriptor],
      title: input.title,
      approvalId: input.approval.approvalId,
      __ringEvents: [
        { type: 'artifact.created', artifact: { path: officeDescriptor.path, kind: officeDescriptor.kind, size: officeDescriptor.size, sha256: officeDescriptor.sha256 } },
        { type: 'artifact.created', artifact: { path: mdDescriptor.path, kind: mdDescriptor.kind, size: mdDescriptor.size, sha256: mdDescriptor.sha256 } },
      ],
    },
  };
}
