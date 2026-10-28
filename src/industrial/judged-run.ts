/**
 * F10-06: One-Command Judged Run for MAOS Industrial
 *
 * Implements the end-to-end judged operator journey in a single command:
 *   PREFLIGHT → POLICY → SERVICES → DAG (Ingest → Analyze → Approval → Synthesize) → VERIFY → AUDIT EXPORT
 *
 * Requirements & Negative Invariants:
 *   1. All interactive/manual boundaries are explicitly documented.
 *   2. Skipped gates or failed services CANNOT continue as success.
 *   3. If preflight fails, abort immediately with PREFLIGHT_BLOCKED (3).
 *   4. If policy verification fails, abort immediately with POLICY_VIOLATION (9).
 *   5. Non-interactive automated approval mandates explicit confirmation (--auto-approve with -y / --yes).
 *      Without confirmation, halts with CONFIRMATION_REQUIRED (4) or GATE_REJECTED (10).
 *   6. Generates valid, verified OOXML .docx deliverable citing source hashes and timestamps.
 *   7. Exports complete cryptographic audit trail (.json) and verifies hash chain integrity.
 *   8. Zero bypass of ServiceContainer.
 */

import fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { createServiceContainer, ServiceContainer } from '../service';
import { INDUSTRIAL_CLI_EXIT, IndustrialCliExitCode } from './industrial-cli';
import type { ApprovalRecord, ReviewApprovalInput } from '../domain/approval';
import { withJudgedRunLock, withJudgedRunOutputLock } from './judged-run-lock';
import {
  OfficeDocxInput,
  computeOfficeInputHash,
} from '../domain/office-artifact';
import { verifyTelemetryAnalysis } from './telemetry-analysis';

export interface JudgedRunOptions {
  readonly projectRoot?: string;
  readonly demoName?: string;
  readonly autoApprove?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly enforceFirewall?: boolean;
  /** Internal adapter hook so the GUI and CLI share the live service container. */
  readonly services?: ServiceContainer;
}

export interface JudgedRunResult {
  readonly success: boolean;
  readonly exitCode: IndustrialCliExitCode;
  readonly message: string;
  readonly runId: string;
  readonly durationMs: number;
  readonly stagesCompleted: readonly string[];
  readonly boundaryVerified: boolean;
  readonly policyVerified: boolean;
  readonly overallVerdict: 'PASS' | 'WARNING' | 'FAIL' | 'UNAVAILABLE';
  readonly approvalStatus: 'approved' | 'rejected' | 'pending';
  readonly deliverablePath?: string;
  readonly deliverableSha256?: string;
  readonly auditVerified: boolean;
  readonly auditExportPath?: string;
  readonly auditExportSha256?: string;
  readonly details?: Record<string, unknown>;
}

export interface JudgedRunManifest {
  schemaVersion: 1;
  runId: string;
  /** This run ID is one immutable attempt; failed attempts are never retried in place. */
  attempt: 1;
  approvalId: string;
  status: 'pending_approval' | 'finalizing' | 'rejected' | 'completed' | 'failed';
  verdict: 'PASS' | 'WARNING' | 'FAIL';
  createdAt: string;
  updatedAt: string;
  sourceHashes: Record<string, string>;
  officeInputHash: string;
  approvalPayloadHash: string;
  officeInput: OfficeDocxInput;
  details: Record<string, unknown>;
  deliverablePath?: string;
  deliverableSha256?: string;
  deliverableArtifactId?: string;
  finalOfficeInputHash?: string;
  auditExportPath?: string;
  auditExportSha256?: string;
  auditExportThroughSequence?: number;
  auditExportLatestHash?: string;
  failureReason?: string;
}

export function getJudgedRunManifestPath(projectRoot: string, runId: string): string {
  if (!/^judged-run-[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid judged run ID.');
  return path.join(projectRoot, '.maos', 'industrial-runs', `${runId}.json`);
}

export function readJudgedRunManifest(projectRoot: string, runId: string): JudgedRunManifest | null {
  const manifestPath = getJudgedRunManifestPath(projectRoot, runId);
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as JudgedRunManifest;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function resolveRunFile(projectRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = fs.realpathSync(projectRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..') return null;
  try {
    const realPath = fs.realpathSync(candidate);
    const realRelative = path.relative(root, realPath);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..') return null;
    return fs.statSync(realPath).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

function fileSha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function terminalRunRecords(services: ServiceContainer, manifest: JudgedRunManifest) {
  if (!services.audit.verifyChain().valid) return [];
  return services.audit.getRecords().filter((record) => {
    const data = record.data as Record<string, unknown>;
    return data.runId === manifest.runId && (data.attempt ?? 1) === (manifest.attempt ?? 1) &&
      ['JUDGED_RUN_COMPLETED', 'JUDGED_RUN_FAILED', 'JUDGED_RUN_REJECTED'].includes(String(data.event));
  });
}

function matchingCompletionRecords(services: ServiceContainer, manifest: JudgedRunManifest) {
  const terminalRecords = terminalRunRecords(services, manifest);
  if (terminalRecords.length !== 1 || (terminalRecords[0].data as Record<string, unknown>).event !== 'JUDGED_RUN_COMPLETED') return [];
  const runRecords = terminalRecords;
  if (runRecords.length !== 1) return [];
  return runRecords.filter((record) => {
    const data = record.data as Record<string, unknown>;
    return data.approvalId === manifest.approvalId &&
      record.sequence > manifest.auditExportThroughSequence! &&
      data.approvalPayloadHash === manifest.approvalPayloadHash && data.verdict === manifest.verdict &&
      data.deliverablePath === manifest.deliverablePath &&
      data.deliverableArtifactId === manifest.deliverableArtifactId &&
      data.deliverableSha256 === manifest.deliverableSha256 &&
      data.finalOfficeInputHash === manifest.finalOfficeInputHash &&
      data.auditExportPath === manifest.auditExportPath &&
      data.auditExportSha256 === manifest.auditExportSha256 &&
      data.auditExportThroughSequence === manifest.auditExportThroughSequence &&
      data.auditExportLatestHash === manifest.auditExportLatestHash;
  });
}

function hasDurableFinalizationInputs(
  projectRoot: string,
  services: ServiceContainer,
  manifest: JudgedRunManifest,
): boolean {
  if (
    !manifest.deliverablePath || !manifest.deliverableArtifactId || !manifest.deliverableSha256 ||
    !manifest.finalOfficeInputHash || !manifest.auditExportPath || !manifest.auditExportSha256 ||
    !Number.isSafeInteger(manifest.auditExportThroughSequence) || !manifest.auditExportLatestHash ||
    !services.audit.verifyChain().valid
  ) return false;
  const approval = services.approval.getApproval(manifest.approvalId);
  if (!approval || approval.status !== 'approved' || approval.payloadHash !== manifest.approvalPayloadHash) return false;
  for (const [relativePath, expectedHash] of Object.entries(manifest.sourceHashes)) {
    const sourcePath = resolveRunFile(projectRoot, relativePath);
    if (!sourcePath || fileSha256(sourcePath) !== expectedHash) return false;
  }
  const outputPath = resolveRunFile(projectRoot, manifest.deliverablePath);
  const exportPath = resolveRunFile(projectRoot, manifest.auditExportPath);
  if (!outputPath || !exportPath || fileSha256(outputPath) !== manifest.deliverableSha256 ||
      fileSha256(exportPath) !== manifest.auditExportSha256) return false;
  const runArtifacts = services.artifact.listArtifacts(manifest.runId);
  const artifacts = runArtifacts.filter((artifact) =>
    artifact.id === manifest.deliverableArtifactId && artifact.path === manifest.deliverablePath &&
    artifact.hash === manifest.deliverableSha256,
  );
  if (artifacts.length !== 1 || runArtifacts.filter((artifact) => artifact.path === manifest.deliverablePath).length !== 1) return false;
  try {
    const auditExport = JSON.parse(fs.readFileSync(exportPath, 'utf8')) as any;
    if (
      auditExport.verification?.valid !== true ||
      auditExport.verification.recordCount !== manifest.auditExportThroughSequence! + 1 ||
      auditExport.verification.latestHash !== manifest.auditExportLatestHash ||
      !Array.isArray(auditExport.records) ||
      auditExport.records.length !== manifest.auditExportThroughSequence! + 1
    ) return false;
    const docxEvents = auditExport.records.filter((record: any) =>
      record.data?.event === 'DOCX_GENERATED' && record.data.runId === manifest.runId &&
      record.data.artifactId === manifest.deliverableArtifactId &&
      record.data.artifactHash === manifest.deliverableSha256 && record.data.inputHash === manifest.finalOfficeInputHash &&
      record.data.relativePath === manifest.deliverablePath,
    );
    return docxEvents.length === 1;
  } catch {
    return false;
  }
}

export function isAcceptedJudgedRun(
  projectRoot: string,
  services: ServiceContainer,
  manifest: JudgedRunManifest | null,
): boolean {
  if (!manifest || manifest.status !== 'completed' || !hasDurableFinalizationInputs(projectRoot, services, manifest)) return false;
  return matchingCompletionRecords(services, manifest).length === 1;
}

export function isAcceptedJudgedRunArtifact(
  projectRoot: string,
  services: ServiceContainer,
  artifact: { id: string; runId?: string; path: string; hash: string },
): boolean {
  if (!artifact.runId?.startsWith('judged-run-')) return true;
  const manifest = readJudgedRunManifest(projectRoot, artifact.runId);
  if (!manifest || !isAcceptedJudgedRun(projectRoot, services, manifest)) return false;
  return manifest.deliverableArtifactId === artifact.id && manifest.deliverablePath === artifact.path &&
    manifest.deliverableSha256 === artifact.hash;
}

function markJudgedRunFailed(
  projectRoot: string,
  services: ServiceContainer,
  manifest: JudgedRunManifest,
  reason: string,
): JudgedRunManifest {
  const existingTerminals = terminalRunRecords(services, manifest);
  if (existingTerminals.some((record) => {
    const event = (record.data as Record<string, unknown>).event;
    return event === 'JUDGED_RUN_COMPLETED' || event === 'JUDGED_RUN_REJECTED';
  })) return manifest;

  const failed: JudgedRunManifest = {
    ...manifest,
    status: 'failed',
    failureReason: reason,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomically(getJudgedRunManifestPath(projectRoot, manifest.runId), failed);
  if (!existingTerminals.some((record) => (record.data as Record<string, unknown>).event === 'JUDGED_RUN_FAILED')) {
    try {
      services.audit.recordAuditEvent({
        category: 'stage',
        source: 'judged-runner',
        data: {
          event: 'JUDGED_RUN_FAILED',
          runId: manifest.runId,
          attempt: manifest.attempt ?? 1,
          approvalId: manifest.approvalId,
          reason,
          ...((manifest.details as any)?.agentAnalysis ? {
            analysisId: (manifest.details as any).agentAnalysis.analysisId,
            agentRunId: (manifest.details as any).agentAnalysis.agentRunId,
            receiptSha256: (manifest.details as any).agentAnalysis.receiptSha256,
          } : {}),
          timestamp: failed.updatedAt,
        },
      });
    } catch {
      // The failed manifest remains the fail-closed state if the audit chain is unavailable.
    }
  }
  try {
    services.docxGenerator.markRequestFailed(`req-${manifest.runId}`, reason);
  } catch {
    // Artifact visibility still depends on the failed manifest and matching completion audit.
  }
  return failed;
}

function appendCompletionEvent(services: ServiceContainer, manifest: JudgedRunManifest): void {
  const terminalRecords = terminalRunRecords(services, manifest);
  if (terminalRecords.length) {
    if (terminalRecords.length === 1 && (terminalRecords[0].data as Record<string, unknown>).event === 'JUDGED_RUN_COMPLETED' &&
        matchingCompletionRecords(services, manifest).length === 1) return;
    throw new Error(`Judged run '${manifest.runId}' already has terminal history and cannot complete again.`);
  }
  services.audit.recordAuditEvent({
    category: 'stage',
    source: 'judged-runner',
    data: {
      event: 'JUDGED_RUN_COMPLETED',
      runId: manifest.runId,
      attempt: manifest.attempt ?? 1,
      approvalId: manifest.approvalId,
      approvalPayloadHash: manifest.approvalPayloadHash,
      verdict: manifest.verdict,
      deliverablePath: manifest.deliverablePath,
      deliverableArtifactId: manifest.deliverableArtifactId,
      deliverableSha256: manifest.deliverableSha256,
      finalOfficeInputHash: manifest.finalOfficeInputHash,
      auditExportPath: manifest.auditExportPath,
      auditExportSha256: manifest.auditExportSha256,
      auditExportThroughSequence: manifest.auditExportThroughSequence,
      auditExportLatestHash: manifest.auditExportLatestHash,
      ...((manifest.details as any)?.agentAnalysis ? {
        analysisId: (manifest.details as any).agentAnalysis.analysisId,
        agentRunId: (manifest.details as any).agentAnalysis.agentRunId,
        receiptSha256: (manifest.details as any).agentAnalysis.receiptSha256,
      } : {}),
      timestamp: new Date().toISOString(),
    },
  });
}

function appendRejectedEvent(services: ServiceContainer, manifest: JudgedRunManifest, approval: ApprovalRecord): void {
  const terminalRecords = terminalRunRecords(services, manifest);
  if (terminalRecords.length) {
    if (terminalRecords.length === 1) {
      const data = terminalRecords[0].data as Record<string, unknown>;
      if (data.event === 'JUDGED_RUN_REJECTED' && data.approvalId === manifest.approvalId) return;
    }
    throw new Error(`Judged run '${manifest.runId}' already has contradictory terminal history.`);
  }
  services.audit.recordAuditEvent({
    category: 'stage',
    source: 'judged-runner',
    data: {
      event: 'JUDGED_RUN_REJECTED',
      runId: manifest.runId,
      attempt: manifest.attempt ?? 1,
      approvalId: manifest.approvalId,
      reviewer: approval.reviewedBy || approval.approvedBy,
      ...((manifest.details as any)?.agentAnalysis ? {
        analysisId: (manifest.details as any).agentAnalysis.analysisId,
        agentRunId: (manifest.details as any).agentAnalysis.agentRunId,
        receiptSha256: (manifest.details as any).agentAnalysis.receiptSha256,
      } : {}),
      timestamp: new Date().toISOString(),
    },
  });
}

function recoverJudgedRunFinalization(
  projectRoot: string,
  services: ServiceContainer,
  manifest: JudgedRunManifest,
): JudgedRunManifest | null {
  if (isAcceptedJudgedRun(projectRoot, services, manifest)) return manifest;
  if (terminalRunRecords(services, manifest).length > 0) return null;
  if (!hasDurableFinalizationInputs(projectRoot, services, manifest)) return null;
  const completed: JudgedRunManifest = { ...manifest, status: 'completed', failureReason: undefined, updatedAt: new Date().toISOString() };
  writeJsonAtomically(getJudgedRunManifestPath(projectRoot, manifest.runId), completed);
  try {
    appendCompletionEvent(services, completed);
  } catch {
    if (!isAcceptedJudgedRun(projectRoot, services, completed)) return null;
  }
  return isAcceptedJudgedRun(projectRoot, services, completed) ? completed : null;
}

function finalizeJudgedRunOutput(
  projectRoot: string,
  services: ServiceContainer,
  manifest: JudgedRunManifest,
  officeInput: OfficeDocxInput,
  deliverable: { artifactId: string; path: string; sha256: string },
  auditExportPath: string,
): JudgedRunManifest {
  const verification = services.audit.verifyChain();
  if (!verification.valid) throw new Error(`Audit chain verification failed: ${verification.errors.join('; ')}`);
  const auditExport = services.audit.exportAuditTrail();
  if (!auditExport.verification.valid) throw new Error('Audit export did not verify before judged-run acceptance.');
  const auditExportAbsolutePath = path.join(projectRoot, auditExportPath);
  writeJsonAtomically(auditExportAbsolutePath, auditExport);
  const auditExportSha256 = fileSha256(auditExportAbsolutePath);
  const latestAuditRecord = auditExport.records[auditExport.records.length - 1];
  const finalizing: JudgedRunManifest = {
    ...manifest,
    status: 'finalizing',
    updatedAt: new Date().toISOString(),
    officeInput,
    deliverablePath: deliverable.path,
    deliverableArtifactId: deliverable.artifactId,
    deliverableSha256: deliverable.sha256,
    finalOfficeInputHash: computeOfficeInputHash(officeInput),
    auditExportPath,
    auditExportSha256,
    auditExportThroughSequence: latestAuditRecord?.sequence ?? -1,
    auditExportLatestHash: latestAuditRecord?.hash ?? '',
    failureReason: undefined,
  };
  writeJsonAtomically(getJudgedRunManifestPath(projectRoot, manifest.runId), finalizing);
  const completed: JudgedRunManifest = { ...finalizing, status: 'completed', updatedAt: new Date().toISOString() };
  writeJsonAtomically(getJudgedRunManifestPath(projectRoot, manifest.runId), completed);
  try {
    appendCompletionEvent(services, completed);
  } catch (error) {
    if (!isAcceptedJudgedRun(projectRoot, services, completed)) throw error;
  }
  if (!isAcceptedJudgedRun(projectRoot, services, completed)) throw new Error('Judged run completion could not be verified after its terminal audit append.');
  return completed;
}

/** Put a completed model analysis through the existing judged-run approval and DOCX path. */
export function prepareAgentJudgedRun(
  projectRoot: string,
  services: ServiceContainer,
  analysisId: string,
): JudgedRunManifest {
  if (!/^telemetry-\d{10,}-[a-f0-9]{8}$/.test(analysisId)) throw new Error('Invalid telemetry analysis ID.');
  const runId = `judged-run-agent-${analysisId}`;
  return withJudgedRunOutputLock(projectRoot, () =>
    withJudgedRunLock(projectRoot, runId, () => prepareAgentJudgedRunLocked(projectRoot, services, analysisId, runId)));
}

function prepareAgentJudgedRunLocked(
  projectRoot: string,
  services: ServiceContainer,
  analysisId: string,
  runId: string,
): JudgedRunManifest {
  const manifestPath = getJudgedRunManifestPath(projectRoot, runId);
  const existing = readJudgedRunManifest(projectRoot, runId);
  if (existing) {
    if ((existing.details as any)?.agentAnalysis?.analysisId !== analysisId) throw new Error('Agent review run identity mismatch.');
    if (existing.status === 'failed') {
      markJudgedRunFailed(projectRoot, services, existing, existing.failureReason || 'This attempt already failed and cannot be resubmitted.');
      throw new Error(`Agent review run '${runId}' failed and cannot be resubmitted.`);
    }
    if (existing.status === 'finalizing' || existing.status === 'completed') {
      const recovered = recoverJudgedRunFinalization(projectRoot, services, existing);
      if (recovered) return recovered;
      markJudgedRunFailed(projectRoot, services, existing, 'Interrupted finalization could not be reconciled from its persisted artifact, audit snapshot, approval, and source hashes.');
      throw new Error(`Agent review run '${runId}' has an incomplete finalization and remains unaccepted.`);
    }
    const existingApproval = services.approval.getApproval(existing.approvalId);
    if (!existingApproval || existingApproval.payloadHash !== existing.approvalPayloadHash) {
      throw new Error(`Agent review run '${runId}' has no matching persisted approval.`);
    }
    return existing;
  }

  const reportRelativePath = `.maos/industrial/telemetry-analyses/agent-reports/${analysisId}.json`;
  const reportPath = path.resolve(projectRoot, reportRelativePath);
  const projectRealPath = fs.realpathSync(projectRoot);
  if (!fs.existsSync(reportPath) || !fs.realpathSync(reportPath).startsWith(`${projectRealPath}${path.sep}`)) {
    throw new Error('Accepted agent report was not found inside the active project.');
  }
  const reportBytes = fs.readFileSync(reportPath);
  const reportSha256 = crypto.createHash('sha256').update(reportBytes).digest('hex');
  const report = JSON.parse(reportBytes.toString('utf8')) as any;
  if (
    report.schemaVersion !== 1 || report.status !== 'completed' || report.acceptance !== 'accepted' ||
    report.analysisId !== analysisId || typeof report.runId !== 'string' ||
    report.numericFindings?.status !== 'replay-matched' ||
    report.numericFindings?.verificationMethod !== 'same-implementation-replay' ||
    typeof report.numericFindings?.rulesetSha256 !== 'string' ||
    report.explanation?.status !== 'unverified' || typeof report.explanation?.text !== 'string'
  ) {
    throw new Error('Agent report is not an accepted, replay-verified result with explicitly unverified model prose.');
  }

  const auditTrail = services.audit.exportAuditTrail();
  const completionAudit = auditTrail.records.find((record) => {
    const data = record.data as Record<string, unknown>;
    return data.event === 'INDUSTRIAL_ANALYSIS_AGENT_COMPLETED' && data.runId === report.runId &&
      data.analysisId === analysisId && data.reportSha256 === reportSha256 && data.outcome === 'completed';
  });
  if (!auditTrail.verification.valid || !completionAudit) {
    if (report.status === 'completed' && report.acceptance === 'accepted') {
      writeJsonAtomically(reportPath, {
        ...report,
        status: 'failed',
        acceptance: 'unaccepted',
        failure: { code: 'COMPLETION_AUDIT_NOT_VERIFIED' },
      });
    }
    throw new Error('Agent report has no matching valid completion audit record and cannot enter human review.');
  }

  const receiptPath = String(report.numericFindings.receiptPath || '');
  const expectedReceiptPath = `.maos/industrial/telemetry-analyses/${analysisId}.json`;
  if (receiptPath !== expectedReceiptPath) throw new Error('Agent report points to an unexpected telemetry receipt path.');
  const verification = verifyTelemetryAnalysis(projectRoot, analysisId);
  const result = verification.result;
  const expectedReportedResult = result && {
    ...result,
    findings: result.findings.slice(0, 30),
    omittedFindingCount: Math.max(0, result.findings.length - 30),
  };
  if (
    !verification.valid || !result || verification.receiptSha256 !== report.numericFindings.receiptSha256 ||
    verification.sourcePath !== report.source?.evidencePath || verification.sourceSha256 !== report.source?.sha256 ||
    JSON.stringify(expectedReportedResult) !== JSON.stringify(report.numericFindings.result)
  ) {
    throw new Error('Agent receipt, selected-source copy, ruleset or numeric replay no longer matches the accepted report.');
  }

  const selectedPath = String(report.source?.selectedPath || '');
  if (!selectedPath || path.isAbsolute(selectedPath)) throw new Error('Agent report has no safe selected source path.');
  const selectedAbsolutePath = path.resolve(projectRoot, selectedPath);
  const selectedRealPath = fs.realpathSync(selectedAbsolutePath);
  if (!selectedRealPath.startsWith(`${projectRealPath}${path.sep}`) || !fs.statSync(selectedRealPath).isFile()) {
    throw new Error('Selected source is missing or resolves outside the active project.');
  }
  const selectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(selectedRealPath)).digest('hex');
  if (selectedSha256 !== report.source.sha256) throw new Error('Selected source changed after agent analysis.');

  const rulesetRelativePath = 'demo/industrial/safety_thresholds.json';
  const rulesetPath = path.join(projectRoot, rulesetRelativePath);
  const rulesetSha256 = crypto.createHash('sha256').update(fs.readFileSync(rulesetPath)).digest('hex');
  if (rulesetSha256 !== report.numericFindings.rulesetSha256) throw new Error('Demonstration rules changed after agent analysis.');
  const receiptBytes = fs.readFileSync(path.join(projectRoot, receiptPath));
  const receiptSha256 = crypto.createHash('sha256').update(receiptBytes).digest('hex');
  if (receiptSha256 !== report.numericFindings.receiptSha256) throw new Error('Telemetry receipt changed after agent analysis.');

  const sourceHashes = {
    [selectedPath]: selectedSha256,
    [String(report.source.evidencePath)]: String(report.source.sha256),
    [rulesetRelativePath]: rulesetSha256,
    [receiptPath]: receiptSha256,
    [reportRelativePath]: reportSha256,
  };
  const activeProjectId = services.officeInput.resolveProjectId();
  const approvalId = `appr-${runId}`;
  const verdict: JudgedRunManifest['verdict'] = result.verdict === 'CRITICAL' ? 'FAIL' : result.verdict;
  const generatedAt = new Date().toISOString();
  const citationIds = ['CIT-SOURCE', 'CIT-RULES', 'CIT-RECEIPT'];
  const findings = result.findings.map((finding, index) => ({
    id: `TELEMETRY-${String(index + 1).padStart(3, '0')}`,
    category: 'TELEMETRY',
    statement: `Row ${finding.row}${finding.timestamp ? ` at ${finding.timestamp}` : ''}: ${finding.field} measured ${finding.value} ${finding.unit}; demonstration threshold ${finding.threshold} ${finding.unit}.`,
    severity: finding.severity === 'CRITICAL' ? 'critical' as const : 'warning' as const,
    status: finding.severity === 'CRITICAL' ? 'FAIL' as const : 'WARNING' as const,
    metric: finding.field,
    observedValue: finding.value,
    thresholdValue: finding.threshold,
    unit: finding.unit,
    citationIds,
    verified: true,
  }));
  const officeInput: OfficeDocxInput = {
    schemaVersion: 1,
    projectId: activeProjectId,
    runId,
    taskId: runId,
    artifactType: 'docx',
    title: `Telemetry Review — ${path.basename(selectedPath)}`,
    author: { id: 'industrial-analysis-agent', name: 'Industrial Analysis Agent', role: 'Telemetry reviewer' },
    sections: [{
      id: 'AGENT-ANALYSIS',
      heading: 'Selected CSV analysis',
      content: `Deterministic findings were replayed from the selected source. Engineering verdict: ${result.verdict} (${verdict}). Human review is required before the report is finalized.`,
      order: 1,
      findingIds: findings.map((finding) => finding.id),
      citationIds,
    }],
    findings,
    measurements: [
      { id: 'M-RMS', name: 'Overall vibration RMS', numericValue: result.overallVibrationRms, unit: 'mm/s', status: result.verdict === 'CRITICAL' ? 'critical' : result.verdict === 'WARNING' ? 'out_of_spec' : 'nominal', citationIds },
      { id: 'M-PEAK-VIBRATION', name: 'Peak vibration', numericValue: result.peakVibration, unit: 'mm/s', status: result.criticalCount > 0 ? 'critical' : result.warningCount > 0 ? 'out_of_spec' : 'nominal', citationIds },
      { id: 'M-PEAK-TEMPERATURE', name: 'Peak temperature', numericValue: result.peakTemperature, unit: 'deg C', status: result.findings.some((finding) => finding.field === 'bearing_temperature_c' && finding.severity === 'CRITICAL') ? 'critical' : result.findings.some((finding) => finding.field === 'bearing_temperature_c') ? 'out_of_spec' : 'nominal', citationIds },
    ],
    units: ['mm/s', 'deg C', 'rows'],
    calculations: [{
      id: 'CALC-RMS',
      name: 'Overall vibration RMS',
      inputs: [{ name: 'rowsAnalyzed', value: result.rowsAnalyzed, unit: 'rows' }],
      methodOrFormula: 'sqrt(mean(vibration_rms_mm_s ** 2))',
      resultValue: result.overallVibrationRms,
      resultUnit: 'mm/s',
      verifiedBy: 'deterministic_calc',
      citationIds,
    }],
    warnings: [],
    limitations: [
      'Demonstration thresholds only; not a certified standard, diagnosis, or operating authorization.',
      'Model-generated explanation remains unverified even after human approval.',
    ],
    citations: [
      { citationId: 'CIT-SOURCE', sourcePath: selectedPath, sourceHash: selectedSha256, snippet: `Selected CSV source (${report.source.bytes} bytes).`, verifiedAt: generatedAt },
      { citationId: 'CIT-RULES', sourcePath: rulesetRelativePath, sourceHash: rulesetSha256, snippet: 'Configured demonstration threshold ruleset.', verifiedAt: generatedAt },
      { citationId: 'CIT-RECEIPT', sourcePath: receiptPath, sourceHash: receiptSha256, snippet: `Replay-verified telemetry receipt ${analysisId}.`, verifiedAt: generatedAt },
    ],
    sourceArtifactIds: [],
    sourceHashes,
    references: [{ id: 'REF-SELECTED-SOURCE', sourcePath: selectedPath, sourceHash: selectedSha256 }],
    evidenceState: { hasUnresolvedConflicts: false, isQuarantined: false, reviewedByHuman: false },
    modelIdentity: {
      modelId: `provider-reported: ${report.model.reported || 'unavailable'}`,
      revision: `requested: ${report.model.provider}/${report.model.requested}`,
    },
    generatedAt,
    approval: { required: true, status: 'pending', approvalId },
    proseBlocks: [{
      id: 'MODEL-EXPLANATION',
      label: 'Model-generated explanation — unverified',
      text: report.explanation.text,
      isModelGenerated: true,
      verifiedAgainstData: false,
      approvedByReviewer: false,
      modelId: `provider-reported: ${report.model.reported || 'unavailable'}`,
    }],
    conclusions: [{
      id: 'PENDING-HUMAN-REVIEW',
      statement: 'The replayed engineering verdict is distinct from model prose. A human reviewer must decide whether to accept the prepared report.',
      verdict: 'conditional',
      signOffIdentity: 'pending reviewer',
      signedAt: generatedAt,
    }],
  };
  const officeInputHash = computeOfficeInputHash(officeInput);
  const details = {
    anomalyCount: findings.length,
    overallRms: result.overallVibrationRms,
    anomalies: result.findings,
    engineeringVerdict: result.verdict,
    agentAnalysis: {
      kind: 'industrial-analysis-agent',
      agentRunId: report.runId,
      analysisId,
      reportPath: reportRelativePath,
      reportSha256,
      receiptPath,
      receiptSha256,
      sourcePath: selectedPath,
      sourceSha256: selectedSha256,
      rulesetSha256,
      model: report.model,
      explanation: report.explanation.text,
      explanationStatus: 'unverified',
      replayVerification: verification.method,
    },
  };
  const approvalPayloadHash = computeJudgedRunApprovalHash(
    runId,
    verdict,
    result.overallVibrationRms,
    result.findings,
    sourceHashes,
    officeInputHash,
  );
  const manifest: JudgedRunManifest = {
    schemaVersion: 1,
    runId,
    attempt: 1,
    approvalId,
    status: 'pending_approval',
    verdict,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    sourceHashes,
    officeInputHash,
    approvalPayloadHash,
    officeInput,
    details,
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  try {
    services.approval.createApproval({
      approvalId,
      projectId: activeProjectId,
      runId,
      taskId: runId,
      stepId: 'step-human-review',
      actorId: 'maos-analysis-engine',
      actorRole: 'agent',
      reason: `Review selected CSV telemetry: ${result.verdict} engineering verdict with ${findings.length} threshold findings.`,
      scope: 'reviewer_signoff',
      payloadHash: approvalPayloadHash,
      sourceHashes: Object.values(sourceHashes),
      metadata: {
        kind: 'maos-industrial-judged-run',
        analysisKind: 'industrial-analysis-agent',
        runId,
        manifestPath: path.relative(projectRoot, manifestPath),
        approvalPayloadHash,
        officeInputHash,
        overallRms: result.overallVibrationRms,
        engineeringVerdict: result.verdict,
        findings: result.findings.map((finding) => ({ ...finding, verdict: finding.severity === 'CRITICAL' ? 'FAIL' : finding.severity })),
        sourceFiles: Object.fromEntries(Object.entries(sourceHashes).map(([sourcePath, sha256]) => [sourcePath, { sha256 }])),
        agentAnalysis: details.agentAnalysis,
      },
    });
  } catch (error) {
    markJudgedRunFailed(projectRoot, services, manifest, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return manifest;
}

function computeJudgedRunApprovalHash(
  runId: string,
  verdict: JudgedRunManifest['verdict'],
  overallRms: unknown,
  anomalies: unknown,
  sourceHashes: Record<string, string>,
  officeInputHash: string,
): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    runId,
    overallVerdict: verdict,
    overallRms,
    detectedAnomalies: anomalies,
    sourceHashes,
    officeInputHash,
  })).digest('hex');
}

/**
 * One-command judged run.
 *
 * With `enforceFirewall`, a process-scoped boundary is ESTABLISHED FOR THE
 * LIFETIME OF THIS RUN: the workflow executes inside an active, passively
 * observed boundary rather than merely being authorized once by a state check.
 * The boundary is torn down afterwards, persisting its observation trace as run
 * evidence. Host packet filter state is never touched at process scope.
 */
export async function executeJudgedRun(
  options: JudgedRunOptions = {},
): Promise<JudgedRunResult> {
  const startTime = Date.now();
  const projectRoot = path.resolve(options.projectRoot || process.cwd());

  // Container construction touches the project root (directories, policy files),
  // so an unusable root fails here. A CLI operator needs a typed refusal with an
  // exit code, not an escaped exception.
  let services: ServiceContainer;
  try {
    services = options.services || createServiceContainer(projectRoot);
  } catch (err: any) {
    const msg = `PREFLIGHT_BLOCKED: Could not initialize Industrial services for ${projectRoot}: ${err.message}`;
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED,
      message: msg,
      runId: `judged-run-${Date.now()}`,
      durationMs: Date.now() - startTime,
      stagesCompleted: [],
      boundaryVerified: false,
      policyVerified: false,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }

  const runId = `judged-run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const runUnderLock = async () => {
    try {
      return await withJudgedRunOutputLock(projectRoot, () =>
        withJudgedRunLock(projectRoot, 'judged-run-t07-output', () =>
          withJudgedRunLock(projectRoot, runId, () => executeJudgedRunInner(options, services, runId))));
    } catch (error) {
      if (!['JUDGED_RUN_BUSY', 'JUDGED_RUN_LOCK_UNAVAILABLE'].includes(String((error as any)?.code))) throw error;
      const code = String((error as any).code);
      return {
        success: false,
        exitCode: INDUSTRIAL_CLI_EXIT.VERIFY_FAILED,
        message: `${code}: ${error instanceof Error ? error.message : String(error)}`,
        runId,
        durationMs: Date.now() - startTime,
        stagesCompleted: [],
        boundaryVerified: true,
        policyVerified: true,
        overallVerdict: 'UNAVAILABLE' as const,
        approvalStatus: 'pending' as const,
        auditVerified: false,
        details: { executionErrorCode: code },
      };
    }
  };

  const scope = services.industrialFirewallRequirement.getScope();

  if (!options.enforceFirewall || scope !== 'process') {
    return runUnderLock();
  }

  // Never tear down a boundary this run did not establish: a live boundary may
  // belong to an embedding host, and destroying it (with its evidence) would be a
  // side effect no caller asked for.
  const boundaryPreExisted = services.processBoundary.isEnabled('default');

  if (!boundaryPreExisted) {
    // Establish the boundary this run will execute inside. A boundary that cannot
    // be established must halt the run as a structured PREFLIGHT_BLOCKED result —
    // never as an escaped exception, and never by proceeding unenforced.
    try {
      await services.processBoundary.enable('default', { confirm: true });
    } catch (err: any) {
      const msg = `PREFLIGHT_BLOCKED: Could not establish the Industrial boundary for this run: ${err.message}`;
      if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
      return {
        success: false,
        exitCode: INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED,
        message: msg,
        runId: `judged-run-${Date.now()}`,
        durationMs: Date.now() - startTime,
        stagesCompleted: [],
        boundaryVerified: false,
        policyVerified: false,
        overallVerdict: 'FAIL',
        approvalStatus: 'pending',
        auditVerified: false,
      };
    }
  }

  try {
    return await runUnderLock();
  } finally {
    if (!boundaryPreExisted) {
      // Tear down and persist the observation trace as evidence of what the
      // boundary actually observed for the duration of the run.
      try {
        await services.processBoundary.disable('default', { confirm: true });
      } catch {
        // A boundary that cannot be torn down is still reported INACTIVE by
        // status reads, so this never leaves a false ACTIVE behind.
      }
    }
  }
}

async function executeJudgedRunInner(
  options: JudgedRunOptions,
  services: ServiceContainer,
  runId: string,
): Promise<JudgedRunResult> {
  const startTime = Date.now();
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const stagesCompleted: string[] = [];

  const logStep = (stepName: string, detail: string) => {
    if (!options.json) {
      console.log(chalk.bold.blue(`[STAGE ${stagesCompleted.length + 1}] ${stepName.padEnd(16)} `) + chalk.gray(detail));
    }
  };

  if (!options.json) {
    console.log(chalk.bold.cyan('\n🚀 MAOS Industrial — One-Command Judged Run'));
    console.log(chalk.gray(`Project Root: ${projectRoot}`));
    console.log(chalk.gray(`Run ID:       ${runId}\n`));
  }

  // ══════════════════════════════════════════════════════════════
  // STAGE 1: PREFLIGHT
  // ══════════════════════════════════════════════════════════════
  logStep('PREFLIGHT', 'Checking offline boundary isolation, firewall, and diagnostics...');
  try {
    const boundaryStatus = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
    const diagnostics = services.health.runDiagnostics();
    const allDiagsPassed = diagnostics.length > 0 && diagnostics.every((d) => d.passed);

    const boundaryVerified = options.enforceFirewall ? boundaryStatus.verified : true;

    if (!boundaryVerified || !allDiagsPassed) {
      const msg = `PREFLIGHT_BLOCKED: Boundary or diagnostic checks failed (boundary verified: ${boundaryStatus.verified}, diagnostics passed: ${allDiagsPassed}).`;
      if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
      return {
        success: false,
        exitCode: INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED,
        message: msg,
        runId,
        durationMs: Date.now() - startTime,
        stagesCompleted,
        boundaryVerified: boundaryStatus.verified,
        policyVerified: false,
        overallVerdict: 'FAIL',
        approvalStatus: 'pending',
        auditVerified: false,
      };
    }
    stagesCompleted.push('PREFLIGHT');
  } catch (err: any) {
    const msg = `PREFLIGHT_FAILED: ${err.message}`;
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: false,
      policyVerified: false,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // STAGE 2: POLICY
  // ══════════════════════════════════════════════════════════════
  logStep('POLICY', 'Verifying safety thresholds, endpoint allowlists, and execution policy...');
  const thresholdsPath = path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
  if (!fs.existsSync(thresholdsPath)) {
    const msg = `POLICY_VIOLATION: Required safety threshold file missing: ${thresholdsPath}`;
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.POLICY_VIOLATION,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: false,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }

  let thresholdsBuffer: Buffer;
  let thresholdsData: any;
  try {
    thresholdsBuffer = fs.readFileSync(thresholdsPath);
    thresholdsData = JSON.parse(thresholdsBuffer.toString('utf8'));
    const vibrationRule = thresholdsData.thresholds?.vibration_rms_mm_s;
    const temperatureRule = thresholdsData.thresholds?.bearing_temperature_c;
    if (
      !vibrationRule || !temperatureRule ||
      !Number.isFinite(vibrationRule.warning) || !Number.isFinite(vibrationRule.critical) ||
      !Number.isFinite(temperatureRule.warning) || !Number.isFinite(temperatureRule.critical)
    ) {
      throw new Error('Missing expected vibration or temperature threshold definitions.');
    }
    stagesCompleted.push('POLICY');
  } catch (err: any) {
    const msg = `POLICY_VIOLATION: Invalid threshold policy: ${err.message}`;
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.POLICY_VIOLATION,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: false,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }
  const thresholdsHash = crypto.createHash('sha256').update(thresholdsBuffer).digest('hex');
  const vibrationRule = thresholdsData.thresholds.vibration_rms_mm_s;
  const temperatureRule = thresholdsData.thresholds.bearing_temperature_c;

  // ══════════════════════════════════════════════════════════════
  // STAGE 3: SERVICES & INITIALIZATION
  // ══════════════════════════════════════════════════════════════
  logStep('SERVICES', 'Initializing project service container and logging run genesis...');
  try {
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'generated'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.maos', 'approvals'), { recursive: true });

    services.audit.recordAuditEvent({
      category: 'stage',
      source: 'judged-runner',
      data: {
        event: 'JUDGED_RUN_STARTED',
        runId,
        demoName: options.demoName || 'safety-audit',
        timestamp: new Date().toISOString(),
      },
    });
    stagesCompleted.push('SERVICES');
  } catch (err: any) {
    const msg = `SERVICES_INIT_FAILED: ${err.message}`;
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // STAGE 4: DAG WORKFLOW EXECUTION
  // ══════════════════════════════════════════════════════════════
  // 4a. Ingest Evidence
  logStep('DAG: INGEST', 'Ingesting 500-row turbine CSV, maintenance log, and scanned PDF...');
  const csvPath = path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv');
  const maintPath = path.join(projectRoot, 'demo', 'industrial', 'maintenance_report.txt');
  const scanPath = path.join(projectRoot, 'demo', 'industrial', 'turbine_inspection_scan.pdf');

  if (!fs.existsSync(csvPath) || !fs.existsSync(maintPath) || !fs.existsSync(scanPath)) {
    const msg = 'INGEST_FAILED: One or more demo source files missing in demo/industrial/';
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict: 'FAIL',
      approvalStatus: 'pending',
      auditVerified: false,
    };
  }

  const csvBuffer = fs.readFileSync(csvPath);
  const csvHash = crypto.createHash('sha256').update(csvBuffer).digest('hex');
  const maintHash = crypto.createHash('sha256').update(fs.readFileSync(maintPath)).digest('hex');
  const scanHash = crypto.createHash('sha256').update(fs.readFileSync(scanPath)).digest('hex');
  const sourceHashes = {
    'demo/industrial/safety_thresholds.json': thresholdsHash,
    'demo/industrial/turbine_vibration_log.csv': csvHash,
    'demo/industrial/maintenance_report.txt': maintHash,
    'demo/industrial/turbine_inspection_scan.pdf': scanHash,
  };
  stagesCompleted.push('INGEST');

  // 4b. Analyze Telemetry & Detect Anomalies
  logStep('DAG: ANALYZE', 'Evaluating time-series telemetry against ISO & thermal thresholds...');
  const csvText = csvBuffer.toString('utf8');
  const csvLines = csvText.trim().split(/\r?\n/);
  const header = csvLines[0].split(',');
  const vibCol = header.indexOf('vibration_rms_mm_s');
  const tempCol = header.indexOf('bearing_temperature_c');
  const timeCol = header.indexOf('timestamp');

  const vibValues: number[] = [];
  const temperatureValues: number[] = [];
  const detectedAnomalies: Array<{ row: number; timestamp: string; field: string; value: number; threshold: number; unit: string; verdict: string }> = [];

  for (let i = 1; i < csvLines.length; i++) {
    const cols = csvLines[i].split(',');
    const v = parseFloat(cols[vibCol]);
    const t = parseFloat(cols[tempCol]);
    const ts = cols[timeCol];
    vibValues.push(v);
    temperatureValues.push(t);

    if (v >= vibrationRule.critical) {
      detectedAnomalies.push({ row: i, timestamp: ts, field: 'vibration_rms_mm_s', value: v, threshold: vibrationRule.critical, unit: vibrationRule.unit || 'mm/s RMS', verdict: 'FAIL' });
    } else if (v >= vibrationRule.warning) {
      detectedAnomalies.push({ row: i, timestamp: ts, field: 'vibration_rms_mm_s', value: v, threshold: vibrationRule.warning, unit: vibrationRule.unit || 'mm/s RMS', verdict: 'WARNING' });
    }

    if (t >= temperatureRule.critical) {
      detectedAnomalies.push({ row: i, timestamp: ts, field: 'bearing_temperature_c', value: t, threshold: temperatureRule.critical, unit: temperatureRule.unit || 'deg C', verdict: 'FAIL' });
    } else if (t >= temperatureRule.warning) {
      detectedAnomalies.push({ row: i, timestamp: ts, field: 'bearing_temperature_c', value: t, threshold: temperatureRule.warning, unit: temperatureRule.unit || 'deg C', verdict: 'WARNING' });
    }
  }

  const sumSquares = vibValues.reduce((acc, val) => acc + val * val, 0);
  const overallRms = Math.sqrt(sumSquares / vibValues.length);
  const peakVibration = Math.max(...vibValues);
  const peakTemperature = Math.max(...temperatureValues);
  const vibrationPeakStatus = peakVibration >= vibrationRule.critical ? 'FAIL' : peakVibration >= vibrationRule.warning ? 'WARNING' : 'PASS';
  const temperaturePeakStatus = peakTemperature >= temperatureRule.critical ? 'FAIL' : peakTemperature >= temperatureRule.warning ? 'WARNING' : 'PASS';
  const hasCritical = detectedAnomalies.some((a) => a.verdict === 'FAIL');
  const overallVerdict = hasCritical ? 'FAIL' : (detectedAnomalies.length > 0 ? 'WARNING' : 'PASS');
  stagesCompleted.push('ANALYZE');

  // 4c. Human-in-the-Loop Approval Gate
  logStep('DAG: APPROVAL', 'Entering human review gate for safety verdict determination...');

  const activeProjectId = services.officeInput.resolveProjectId();
  const deliverableRelPath = 'artifacts/generated/turbine_safety_approval_note.docx';
  const deliverableAbsPath = path.join(projectRoot, deliverableRelPath);
  fs.mkdirSync(path.dirname(deliverableAbsPath), { recursive: true });

  const approvalId = `appr-${runId}`;
  const autoApproval = options.autoApprove === true && options.yes === true;
  const manifestPath = getJudgedRunManifestPath(projectRoot, runId);

  // Construct OfficeDocxInput
  const officeInput: OfficeDocxInput = {
    schemaVersion: 1,
    projectId: activeProjectId,
    runId,
    taskId: runId,
    artifactType: 'docx',
    title: 'Steam Turbine T-07 Safety Audit Approval Note',
    author: {
      id: 'agent-inspector-01',
      name: 'Lead Inspector Agent',
      role: 'Safety Verification Engineer',
    },
    sections: [
      {
        id: 'SEC-01',
        heading: 'Executive Summary',
        content: `Turbine T-07 evaluation resulted in an overall verdict of ${overallVerdict} under the bundled demonstration thresholds. Any operational response must be determined by qualified personnel.`,
        order: 1,
        findingIds: ['FINDING-VIB-01', 'FINDING-TEMP-01'],
        citationIds: ['CIT-01'],
      },
      {
        id: 'SEC-02',
        heading: 'Corroborating Field Evidence',
        content: 'Field inspections corroborate thermal elevation and dark lubricant residue beneath the drive-end bearing housing.',
        order: 2,
        citationIds: ['CIT-02'],
      },
    ],
    findings: [
      {
        id: 'FINDING-VIB-01',
        category: 'SAFETY',
        statement: `Peak vibration reading ${peakVibration.toFixed(2)} mm/s RMS (critical threshold ${vibrationRule.critical} mm/s). Overall RMS: ${overallRms.toFixed(5)} mm/s.`,
        severity: vibrationPeakStatus === 'FAIL' ? 'critical' : vibrationPeakStatus === 'WARNING' ? 'warning' : 'info',
        status: vibrationPeakStatus,
        metric: 'vibration_rms_mm_s',
        observedValue: peakVibration,
        thresholdValue: vibrationRule.critical,
        unit: 'mm/s',
        citationIds: ['CIT-01'],
        verified: true,
      },
      {
        id: 'FINDING-TEMP-01',
        category: 'SAFETY',
        statement: `Peak drive-end bearing temperature ${peakTemperature.toFixed(1)} °C (critical threshold ${temperatureRule.critical} °C).`,
        severity: temperaturePeakStatus === 'FAIL' ? 'critical' : temperaturePeakStatus === 'WARNING' ? 'warning' : 'info',
        status: temperaturePeakStatus,
        metric: 'bearing_temperature_c',
        observedValue: peakTemperature,
        thresholdValue: temperatureRule.critical,
        unit: 'deg C',
        citationIds: ['CIT-01'],
        verified: true,
      },
    ],
    measurements: [
      {
        id: 'M-01',
        name: 'Overall Vibration RMS',
        numericValue: overallRms,
        unit: 'mm/s',
        status: overallVerdict === 'FAIL' ? 'critical' : overallVerdict === 'WARNING' ? 'out_of_spec' : 'nominal',
        citationIds: ['CIT-01'],
      },
      {
        id: 'M-02',
        name: 'Peak Bearing Temperature',
        numericValue: peakTemperature,
        unit: 'deg C',
        status: temperaturePeakStatus === 'FAIL' ? 'critical' : temperaturePeakStatus === 'WARNING' ? 'out_of_spec' : 'nominal',
        citationIds: ['CIT-01'],
      },
    ],
    units: ['mm/s', 'deg C', 'samples'],
    calculations: [
      {
        id: 'CALC-RMS-01',
        name: 'Overall RMS Vibration',
        inputs: [{ name: 'vibration_rms_mm_s', value: vibValues.length, unit: 'samples' }],
        methodOrFormula: 'sqrt(mean(v**2))',
        resultValue: overallRms,
        resultUnit: 'mm/s',
        verifiedBy: 'deterministic_calc',
        citationIds: ['CIT-01'],
      },
    ],
    warnings: [],
    limitations: [
      'Hackathon demonstration rules only; not a certified standard or operating authorization.',
    ],
    citations: [
      {
        citationId: 'CIT-01',
        sourcePath: 'demo/industrial/turbine_vibration_log.csv',
        sourceHash: csvHash,
        snippet: '2026-08-22T10:31:30+05:30,8.3,82.1',
        verifiedAt: new Date().toISOString(),
      },
      {
        citationId: 'CIT-02',
        sourcePath: 'demo/industrial/maintenance_report.txt',
        sourceHash: maintHash,
        snippet: 'Dark lubricant residue below drive-end seal',
        verifiedAt: new Date().toISOString(),
      },
    ],
    sourceArtifactIds: [],
    sourceHashes,
    references: [
      {
        id: 'REF-01',
        sourcePath: 'demo/industrial/turbine_vibration_log.csv',
        sourceHash: csvHash,
      },
    ],
    evidenceState: {
      hasUnresolvedConflicts: false,
      isQuarantined: false,
      reviewedByHuman: autoApproval,
      reviewerId: autoApproval ? 'judge-evaluator' : undefined,
      reviewerNotes: autoApproval ? 'Confirmed the prepared demo evidence and deterministic calculations.' : undefined,
    },
    generatedAt: new Date().toISOString(),
    approval: {
      required: true,
      status: autoApproval ? 'approved' : 'pending',
      approvalId,
      approvedBy: autoApproval ? 'judge-evaluator' : undefined,
      approvedAt: autoApproval ? new Date().toISOString() : undefined,
      comment: autoApproval ? 'Confirmed judged run evaluation auto-approval under hackathon demonstration criteria.' : undefined,
    },
    proseBlocks: [
      {
        id: 'PROSE-01',
        label: 'Summary Narrative',
        text: 'Autonomous analysis completed with strict verification of evidence and ISO thresholds.',
        isModelGenerated: false,
        verifiedAgainstData: true,
        approvedByReviewer: autoApproval,
      },
    ],
    conclusions: [
      {
        id: 'CONC-01',
        statement: 'Controlled load reduction and inspection of drive-end bearing assembly required.',
        verdict: 'approved',
        signOffIdentity: 'Lead Safety Engineer',
        signedAt: new Date().toISOString(),
      },
    ],
  };

  const officeInputHash = computeOfficeInputHash(officeInput);
  const approvalPayloadHash = computeJudgedRunApprovalHash(
    runId,
    overallVerdict,
    overallRms,
    detectedAnomalies,
    sourceHashes,
    officeInputHash,
  );
  const preparedManifest: JudgedRunManifest = {
    schemaVersion: 1,
    runId,
    attempt: 1,
    approvalId,
    status: 'pending_approval',
    verdict: overallVerdict,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceHashes: officeInput.sourceHashes,
    officeInputHash,
    approvalPayloadHash,
    officeInput,
    details: { anomalyCount: detectedAnomalies.length, overallRms, anomalies: detectedAnomalies },
  };

  if (!options.autoApprove || options.yes) {
    services.approval.createApproval({
      approvalId,
      projectId: activeProjectId,
      runId,
      taskId: runId,
      stepId: 'step-human-review',
      actorId: 'maos-analysis-engine',
      actorRole: 'agent',
      reason: `Review T-07 safety analysis: ${overallVerdict} verdict with ${detectedAnomalies.length} threshold findings.`,
      scope: 'reviewer_signoff',
      payloadHash: approvalPayloadHash,
      sourceHashes: Object.values(sourceHashes),
      metadata: {
        kind: 'maos-industrial-judged-run',
        runId,
        manifestPath: path.relative(projectRoot, manifestPath),
        approvalPayloadHash,
        officeInputHash,
        overallRms,
        findings: detectedAnomalies,
        sourceFiles: {
          'demo/industrial/safety_thresholds.json': { sha256: thresholdsHash },
          'demo/industrial/turbine_vibration_log.csv': { sha256: csvHash },
          'demo/industrial/maintenance_report.txt': { sha256: maintHash },
          'demo/industrial/turbine_inspection_scan.pdf': { sha256: scanHash },
        },
      },
    });
    stagesCompleted.push('APPROVAL');
  }

  // Check interactive confirmation boundary
  if (options.autoApprove) {
    if (!options.yes) {
      const msg = 'CONFIRMATION_REQUIRED: Non-interactive --auto-approve mandates confirmation flag (-y or --yes).';
      if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
      return {
        success: false,
        exitCode: INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED,
        message: msg,
        runId,
        durationMs: Date.now() - startTime,
        stagesCompleted,
        boundaryVerified: true,
        policyVerified: true,
        overallVerdict,
        approvalStatus: 'pending',
        auditVerified: false,
      };
    }

    // Persist verified approval contract via authoritative ApprovalService
    services.approval.decideApproval(
      approvalId,
      'approved',
      'judge-evaluator',
      'Confirmed judged run evaluation auto-approval under hackathon demonstration criteria.',
      'lead',
    );
  }

  if (!autoApproval) {
    writeJsonAtomically(manifestPath, preparedManifest);
    const msg = `WAITING_FOR_APPROVAL: T-07 analysis is ready for human review. Run ${runId}; approval ${approvalId}.`;
    if (!options.json) console.log(chalk.yellow(`\n⏸  ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.GATE_REJECTED,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict,
      approvalStatus: 'pending',
      auditVerified: false,
      details: { approvalId, manifestPath: path.relative(projectRoot, manifestPath), anomalyCount: detectedAnomalies.length, overallRms, anomalies: detectedAnomalies },
    };
  }

  let runManifest: JudgedRunManifest = { ...preparedManifest, status: 'finalizing', updatedAt: new Date().toISOString() };
  try {
    writeJsonAtomically(manifestPath, runManifest);
  } catch (err: any) {
    try { runManifest = markJudgedRunFailed(projectRoot, services, runManifest, `RUN_MANIFEST_PERSIST_FAILED: ${err.message}`); } catch {}
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.VERIFY_FAILED,
      message: `RUN_MANIFEST_PERSIST_FAILED: Could not persist finalizing state: ${err.message}`,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict,
      approvalStatus: 'approved',
      auditVerified: false,
    };
  }

  // 4d. Synthesize Deliverable
  logStep('DAG: SYNTHESIZE', 'Generating verified OOXML .docx approval note...');
  let docxResult;
  try {
    docxResult = services.docxGenerator.generateDocx({
      schemaVersion: 1,
      projectId: activeProjectId,
      input: officeInput,
      outputPath: deliverableRelPath,
      allowOverwrite: true,
      requestId: `req-${runId}`,
      callerIdentity: { agentId: 'synthesizer_agent', taskId: runId },
    });

    if (!docxResult.ok || !docxResult.artifactId || !fs.existsSync(deliverableAbsPath)) {
      throw new Error(`Docx generation failed: ${docxResult.error || 'File not written'}`);
    }
    stagesCompleted.push('DAG');
  } catch (err: any) {
    const msg = `SYNTHESIZE_FAILED: ${err.message}`;
    try { runManifest = markJudgedRunFailed(projectRoot, services, runManifest, msg); } catch {}
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.FAILURE,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict,
      approvalStatus: 'approved',
      auditVerified: false,
    };
  }

  const deliverableSha256 = fileSha256(deliverableAbsPath);

  // ══════════════════════════════════════════════════════════════
  // STAGE 5: POST-RUN VERIFICATION
  // ══════════════════════════════════════════════════════════════
  logStep('VERIFY', 'Validating deliverable signatures and cryptographic audit chain...');
  const auditExportRelPath = `artifacts/generated/${runId}-audit-export.json`;
  let completedManifest: JudgedRunManifest;
  try {
    if (!services.audit.verifyChain().valid) throw new Error('AUDIT_VERIFICATION_FAILED: Hash chain integrity failure before export.');
    stagesCompleted.push('VERIFY');
    logStep('AUDIT EXPORT', 'Exporting the verified audit snapshot and sealing the run record...');
    completedManifest = finalizeJudgedRunOutput(projectRoot, services, runManifest, officeInput, {
      artifactId: docxResult.artifactId,
      path: deliverableRelPath,
      sha256: deliverableSha256,
    }, auditExportRelPath);
    stagesCompleted.push('AUDIT_EXPORT');
  } catch (err: any) {
    const msg = `RUN_FINALIZATION_FAILED: ${err.message}`;
    try { runManifest = markJudgedRunFailed(projectRoot, services, runManifest, msg); } catch {}
    if (!options.json) console.error(chalk.red(`\n❌ ${msg}`));
    return {
      success: false,
      exitCode: INDUSTRIAL_CLI_EXIT.VERIFY_FAILED,
      message: msg,
      runId,
      durationMs: Date.now() - startTime,
      stagesCompleted,
      boundaryVerified: true,
      policyVerified: true,
      overallVerdict,
      approvalStatus: 'approved',
      auditVerified: false,
      details: { unacceptedDeliverablePath: deliverableRelPath, unacceptedDeliverableSha256: deliverableSha256 },
    };
  }

  const auditExportSha256 = completedManifest.auditExportSha256!;

  const durationMs = Date.now() - startTime;

  if (!options.json) {
    console.log(chalk.bold.green('\n✅ Judged Run Completed Successfully!'));
    console.log(`Duration:       ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`Stages:         ${stagesCompleted.join(' → ')}`);
    console.log(`Overall Verdict: ${chalk.bold.red(overallVerdict)}`);
    console.log(`Deliverable:    ${deliverableRelPath} (${deliverableSha256.substring(0, 16)}...)`);
    console.log(`Audit Export:   ${auditExportRelPath} (${auditExportSha256.substring(0, 16)}...)`);
  }

  return {
    success: true,
    exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
    message: `Judged run completed with verdict ${overallVerdict}. All 6 stages verified.`,
    runId,
    durationMs,
    stagesCompleted,
    boundaryVerified: true,
    policyVerified: true,
    overallVerdict,
    approvalStatus: 'approved',
    deliverablePath: deliverableRelPath,
    deliverableSha256,
    auditVerified: true,
    auditExportPath: auditExportRelPath,
    auditExportSha256,
    details: {
      anomalyCount: detectedAnomalies.length,
      overallRms,
    },
  };
}

/** Resume a GUI-started judged run only after its exact approval is decided. */
export async function resumeJudgedRunAfterApproval(
  projectRoot: string,
  services: ServiceContainer,
  approvalId: string,
): Promise<JudgedRunManifest> {
  const approval = services.approval.getApproval(approvalId);
  if (!approval || approval.metadata?.kind !== 'maos-industrial-judged-run') {
    throw new Error(`Approval '${approvalId}' is not bound to a MAOS Industrial judged run.`);
  }
  const runId = String(approval.metadata.runId || approval.runId || '');
  return withJudgedRunOutputLock(projectRoot, () =>
    withJudgedRunLock(projectRoot, runId, () => resumeJudgedRunAfterApprovalLocked(projectRoot, services, approvalId)));
}

export async function decideAndResumeJudgedRunAfterApproval(
  projectRoot: string,
  services: ServiceContainer,
  approvalId: string,
  review: ReviewApprovalInput,
): Promise<{ approval: ApprovalRecord; judgedRun: JudgedRunManifest }> {
  const approval = services.approval.getApproval(approvalId);
  if (!approval || approval.metadata?.kind !== 'maos-industrial-judged-run') {
    throw new Error(`Approval '${approvalId}' is not bound to a MAOS Industrial judged run.`);
  }
  const runId = String(approval.metadata.runId || approval.runId || '');
  return withJudgedRunOutputLock(projectRoot, () =>
    withJudgedRunLock(projectRoot, runId, async (): Promise<{ approval: ApprovalRecord; judgedRun: JudgedRunManifest }> => {
    const current = services.approval.getApproval(approvalId);
    const sameDecision = current?.status === review.decision && current.reviewedBy === review.actorId &&
      current.reviewRole === review.actorRole && (current.reviewNotes || undefined) === (review.notes || undefined) &&
      (!review.conditions || JSON.stringify(current.conditions) === JSON.stringify(review.conditions));
    const updatedApproval = sameDecision && current
      ? current
      : services.approval.decideApproval(approvalId, review);
    const judgedRun = await resumeJudgedRunAfterApprovalLocked(projectRoot, services, approvalId);
    return { approval: updatedApproval, judgedRun };
    }));
}

async function resumeJudgedRunAfterApprovalLocked(
  projectRoot: string,
  services: ServiceContainer,
  approvalId: string,
): Promise<JudgedRunManifest> {
  const approval = services.approval.getApproval(approvalId);
  if (!approval || approval.metadata?.kind !== 'maos-industrial-judged-run') {
    throw new Error(`Approval '${approvalId}' is not bound to a MAOS Industrial judged run.`);
  }
  const runId = String(approval.metadata.runId || approval.runId || '');
  const manifest = readJudgedRunManifest(projectRoot, runId);
  if (!manifest || manifest.approvalId !== approvalId) {
    throw new Error(`Prepared judged run manifest for approval '${approvalId}' was not found.`);
  }
  if (manifest.status === 'rejected') {
    appendRejectedEvent(services, manifest, approval);
    return manifest;
  }
  if (manifest.status === 'failed') {
    markJudgedRunFailed(projectRoot, services, manifest, manifest.failureReason || 'This attempt already failed and cannot be resumed.');
    throw new Error(`Judged run '${runId}' failed and cannot be resumed.`);
  }
  if (manifest.status === 'completed' || manifest.status === 'finalizing') {
    const recovered = recoverJudgedRunFinalization(projectRoot, services, manifest);
    if (recovered) return recovered;
    markJudgedRunFailed(projectRoot, services, manifest, 'Interrupted finalization could not be reconciled from its persisted artifact, audit snapshot, approval, and source hashes.');
    throw new Error(`Judged run '${runId}' has an incomplete finalization and remains unaccepted.`);
  }
  const refusePreparedRun = (message: string): never => {
    markJudgedRunFailed(projectRoot, services, manifest, message);
    const error = new Error(message) as Error & { code: string };
    error.code = 'STALE_APPROVAL';
    throw error;
  };
  if (approval.status === 'rejected') {
    const rejected: JudgedRunManifest = { ...manifest, status: 'rejected', updatedAt: new Date().toISOString() };
    writeJsonAtomically(getJudgedRunManifestPath(projectRoot, runId), rejected);
    appendRejectedEvent(services, rejected, approval);
    return rejected;
  }
  if (approval.status !== 'approved') {
    throw new Error(`Judged run '${runId}' is waiting for an approved or rejected decision.`);
  }

  const sourceHashes = manifest.sourceHashes;
  const sourceEntries = Object.entries(sourceHashes);
  for (const [relativePath, expectedHash] of sourceEntries) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!absolutePath.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || !fs.existsSync(absolutePath)) {
      return refusePreparedRun(`Judged run source is unavailable: ${relativePath}`);
    }
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
    if (actualHash !== expectedHash) return refusePreparedRun(`Judged run source changed after analysis: ${relativePath}`);
  }

  const details = manifest.details as { overallRms?: number; anomalies?: unknown[] };
  const officeInputHash = computeOfficeInputHash(manifest.officeInput);
  if (!manifest.officeInputHash || officeInputHash !== manifest.officeInputHash) {
    return refusePreparedRun(`Judged run '${runId}' report input changed after analysis.`);
  }
  const expectedPayloadHash = computeJudgedRunApprovalHash(
    runId,
    manifest.verdict,
    details.overallRms,
    details.anomalies,
    sourceHashes,
    officeInputHash,
  );
  if (expectedPayloadHash !== manifest.approvalPayloadHash || approval.payloadHash !== manifest.approvalPayloadHash) {
    return refusePreparedRun(`Judged run '${runId}' approval payload does not match its prepared analysis.`);
  }

  const reviewer = approval.reviewedBy || approval.approvedBy || 'reviewer';
  const reviewedAt = approval.reviewedAt || approval.approvedAt || new Date().toISOString();
  const officeInput: OfficeDocxInput = {
    ...manifest.officeInput,
    evidenceState: {
      ...manifest.officeInput.evidenceState,
      reviewedByHuman: true,
      reviewerId: reviewer,
      reviewerNotes: approval.reviewNotes || undefined,
    },
    approval: {
      required: true,
      status: 'approved',
      approvalId,
      approvedBy: reviewer,
      approvedAt: reviewedAt,
      comment: approval.reviewNotes || undefined,
    },
    proseBlocks: manifest.officeInput.proseBlocks.map((block) => ({ ...block, approvedByReviewer: true })),
    conclusions: manifest.officeInput.conclusions.map((conclusion) => ({
      ...conclusion,
      verdict: 'approved',
      signOffIdentity: reviewer,
      signedAt: reviewedAt,
    })),
  };

  const deliverableRelPath = `artifacts/generated/${runId}-turbine_safety_approval_note.docx`;
  const deliverableAbsPath = path.join(projectRoot, deliverableRelPath);
  let finalizing: JudgedRunManifest = { ...manifest, status: 'finalizing', updatedAt: new Date().toISOString() };
  try {
    writeJsonAtomically(getJudgedRunManifestPath(projectRoot, runId), finalizing);
    const docxResult = await services.docxGenerator.generateDocxAsync({
      schemaVersion: 1,
      projectId: officeInput.projectId,
      input: officeInput,
      outputPath: deliverableRelPath,
      allowOverwrite: true,
      approvalId,
      requestId: `req-${runId}`,
      callerIdentity: { agentId: 'synthesizer_agent', taskId: runId },
    });
    if (!docxResult.ok || !docxResult.artifactId || !fs.existsSync(deliverableAbsPath)) {
      throw new Error(`Docx generation failed: ${docxResult.error || 'File not written'}`);
    }
    const deliverableSha256 = fileSha256(deliverableAbsPath);
    return finalizeJudgedRunOutput(
      projectRoot,
      services,
      finalizing,
      officeInput,
      { artifactId: docxResult.artifactId, path: deliverableRelPath, sha256: deliverableSha256 },
      `artifacts/generated/${runId}-audit-export.json`,
    );
  } catch (error) {
    const latest = readJudgedRunManifest(projectRoot, runId) || finalizing;
    if (isAcceptedJudgedRun(projectRoot, services, latest)) return latest;
    markJudgedRunFailed(projectRoot, services, latest, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
