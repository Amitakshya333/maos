/**
 * TASK DEV-C-01 (Day 1c): deterministic server-side skill workflows.
 *
 * Prompt templates (ring-skills.ts) tell the model which evidence tools to
 * call; THESE workflows are the reliable path the agent loop and router
 * prefer when tool-calling is flaky (Handoff #2 Section 3.2). Every workflow
 * below is deterministic, evidence-first, and safe:
 *
 * - Tools run through the registry (`RingToolRegistry`), never by prompt
 *   text. `permit`/`loto` only READ the SOP; nothing here writes files.
 * - Evidence/doc text is wrapped as DATA via `wrapEvidenceAsData()` and
 *   scanned with `containsInjectionAttempt()`; injections are surfaced,
 *   never obeyed.
 * - Restart/operation authorization is refused with the shared calm wording
 *   (`ringRestartRefusal`); nothing here authorizes restart or certifies
 *   safety.
 * - Telemetry comes from the frozen `analyzeTelemetryCsv` code path;
 *   summaries are deterministic. Raw CSV rows never leave the evidence
 *   boundary (`stripRawCsvRows`, and the read path refuses `.csv` bodies).
 * - Skill runs are audit-logged by the CALLER (agent loop / router own the
 *   audit trail); workflows return the record payload to log.
 * - Synthetic demo data is ALWAYS labelled "Synthetic demo data".
 *
 * FROZEN-CONTRACT NOTES (read first, do not change):
 * - Skills register as prompt templates (ring-skills.ts) plus required tools
 *   on the registry (ring-tool-registry.ts); the registry's `consequential`
 *   flag is the enforcement point, never prompt text.
 * - `RingToolContext` = { projectRoot, evidenceRoot, runId, runContext }.
 * - Default evidence root is `demo/industrial`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RingRole } from './ring-contract';
import { DEFAULT_RING_ROLE } from './ring-contract';
import { analyzeTelemetryCsv, loadTelemetryDemoThresholds } from '../industrial/telemetry-analysis';
import {
  containsInjectionAttempt,
  isRestartAuthorizationRequest,
  ringMissingDataMessage,
  ringRestartRefusal,
  stripRawCsvRows,
  wrapEvidenceAsData,
} from './ring-safety';
import type { RingSkill } from './ring-skills';
import { RING_SKILLS } from './ring-skills';

export interface RingWorkflowEvidencePaths {
  csvPath?: string;
  documentPath?: string;
}

export interface RingWorkflowInput {
  skillName: string;
  arg?: string;
  role?: RingRole;
  projectRoot: string;
  evidenceRoot?: string;
  runId?: string;
}

/** One evidence file read: text wrapped as data, injection flagged. */
export interface RingWorkflowEvidence {
  path: string;
  bytes: number;
  /** Document text wrapped with RING_DOC_BEGIN/END (data, not instructions). */
  wrapped: string;
  /** True when the evidence text contains an instruction-override attempt. */
  injectionDetected: boolean;
}

export interface RingWorkflowResult {
  skill: string;
  role: RingRole;
  title: string;
  body: string;
  evidence: RingWorkflowEvidence[];
  telemetry?: {
    csvPath: string;
    verdict: string;
    overallVibrationRms: number;
    peakVibration: number;
    peakTemperature: number;
    rowsAnalyzed: number;
    warningCount: number;
    criticalCount: number;
  };
  /** Injection attempts found inside evidence text (surfaced, never obeyed). */
  injectionNotes: string[];
  /** True when this skill run proposes a write needing human approval. */
  needsApproval: boolean;
  /** Audit payload for the caller to record (category `approval`). */
  audit: { event: string; skill: string; role: string; runId: string; evidencePaths: string[]; needsApproval: boolean };
}

function toRole(role: unknown): RingRole {
  return role === 'operator' || role === 'maintenance' || role === 'safety' || role === 'manager'
    ? role
    : DEFAULT_RING_ROLE;
}

function resolveWithinRoot(root: string, requested: string): string {
  const resolved = path.resolve(root, requested);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
  }
  return resolved;
}

function readEvidenceFile(evidenceRoot: string, requested: string, maxBytes = 256 * 1024): RingWorkflowEvidence {
  const resolved = resolveWithinRoot(evidenceRoot, requested);
  if (!fs.existsSync(resolved)) {
    throw new Error(`EVIDENCE_NOT_FOUND: no evidence file at ${requested} under the evidence root.`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`EVIDENCE_NOT_FOUND: ${requested} is not a file.`);
  if (requested.toLowerCase().endsWith('.csv')) {
    throw new Error(
      `EVIDENCE_CSV_REFUSED: read ${requested} via analyze_telemetry only; raw rows never go to the model.`,
    );
  }
  if (stat.size > maxBytes) {
    throw new Error(`EVIDENCE_TOO_LARGE: ${requested} is ${stat.size} bytes (limit ${maxBytes}).`);
  }
  const text = fs.readFileSync(resolved, 'utf-8');
  return {
    path: requested,
    bytes: stat.size,
    wrapped: wrapEvidenceAsData(stripRawCsvRows(text)),
    injectionDetected: containsInjectionAttempt(text),
  };
}

function defaultPathsFor(skill: string, arg: string, paths?: RingWorkflowEvidencePaths): RingWorkflowEvidencePaths {
  const out: RingWorkflowEvidencePaths = { ...(paths || {}) };
  if (!out.csvPath) {
    out.csvPath = 'turbine_vibration_log.csv';
  }
  if (!out.documentPath) {
    if (skill === 'handover' || skill === 'rca' || skill === 'report') {
      out.documentPath = 'maintenance_report.txt';
    } else {
      out.documentPath = 'sop_turbine_vibration_monitoring.md';
    }
  }
  void arg;
  return out;
}

function summarizeTelemetry(
  projectRoot: string,
  evidenceRoot: string,
  csvPath: string,
): RingWorkflowResult['telemetry'] & { findingsText: string } {
  const relToProject = path.relative(projectRoot, path.resolve(evidenceRoot, csvPath)).split(path.sep).join('/');
  const resolved = resolveWithinRoot(projectRoot, relToProject);
  if (!fs.existsSync(resolved)) {
    throw new Error(`EVIDENCE_NOT_FOUND: telemetry CSV not found: ${csvPath}`);
  }
  const thresholds = loadTelemetryDemoThresholds(projectRoot);
  const metrics = analyzeTelemetryCsv(fs.readFileSync(resolved), thresholds);
  return {
    csvPath,
    verdict: metrics.verdict,
    overallVibrationRms: Number(metrics.overallVibrationRms.toFixed(3)),
    peakVibration: Number(metrics.peakVibration.toFixed(3)),
    peakTemperature: Number(metrics.peakTemperature.toFixed(1)),
    rowsAnalyzed: metrics.rowsAnalyzed,
    warningCount: metrics.warningCount,
    criticalCount: metrics.criticalCount,
    findingsText: metrics.findings
      .slice(0, 20)
      .map(
        (f) =>
          `row ${f.row} ${f.field}=${f.value}${f.unit ? ` ${f.unit}` : ''} (${f.severity}, threshold ${f.threshold})`,
      )
      .join('; '),
  };
}

function evidenceSection(evidence: RingWorkflowEvidence[]): string {
  return evidence.map((e) => `Evidence file ${e.path} (${e.bytes} bytes):\n${e.wrapped}`).join('\n\n');
}

/**
 * Run a skill deterministically, evidence-first. Throws on unknown skills,
 * missing evidence, or path escapes. Never calls the network. Never invents
 * readings: missing evidence yields an honest missing-data message.
 */
export function runRingSkillWorkflow(input: RingWorkflowInput, paths?: RingWorkflowEvidencePaths): RingWorkflowResult {
  const skill: RingSkill | undefined = RING_SKILLS.find((s) => s.name === input.skillName);
  if (!skill) throw new Error(`UNKNOWN_SKILL: no Ring skill named '${input.skillName}'.`);
  if (isRestartAuthorizationRequest(input.arg || '')) {
    const body = ringRestartRefusal('this asset', 'The request asks for restart/operation approval.');
    return {
      skill: skill.name,
      role: toRole(input.role),
      title: skill.title,
      body,
      evidence: [],
      injectionNotes: [],
      needsApproval: false,
      audit: {
        event: 'RING_SKILL_REFUSED',
        skill: skill.name,
        role: toRole(input.role),
        runId: input.runId || 'ring-skill',
        evidencePaths: [],
        needsApproval: false,
      },
    };
  }
  const role = toRole(input.role);
  const projectRoot = path.resolve(input.projectRoot);
  const evidenceRoot = path.resolve(input.projectRoot, input.evidenceRoot || 'demo/industrial');
  const runId = input.runId || `ring-skill-${Date.now().toString(36)}`;
  const arg = (input.arg || '').trim();
  const resolvedPaths = defaultPathsFor(skill.name, arg, paths);
  const skillKey = skill.name as string;

  if (skillKey === 'sop' && !arg) {
    return {
      skill: skill.name,
      role,
      title: skill.title,
      body: 'Usage: /sop <equipment> — for example `/sop T-07`. Known SOP: sop_turbine_vibration_monitoring.md (T-07). Synthetic demo data only.',
      evidence: [],
      injectionNotes: [],
      needsApproval: false,
      audit: { event: 'RING_SKILL_RUN', skill: skill.name, role, runId, evidencePaths: [], needsApproval: false },
    };
  }

  if (skillKey === 'permit' || skillKey === 'loto') {
    const docPath = resolvedPaths.documentPath as string;
    let evidence: RingWorkflowEvidence;
    try {
      evidence = readEvidenceFile(evidenceRoot, docPath);
    } catch {
      return {
        skill: skill.name,
        role,
        title: skill.title,
        body: `${ringMissingDataMessage(`the SOP (${docPath})`, evidenceRoot)}. Synthetic demo data only.`,
        evidence: [],
        injectionNotes: [],
        needsApproval: false,
        audit: {
          event: 'RING_SKILL_MISSING_EVIDENCE',
          skill: skill.name,
          role,
          runId,
          evidencePaths: [docPath],
          needsApproval: false,
        },
      };
    }
    const injectionNotes = evidence.injectionDetected
      ? [`Prompt-injection attempt found inside ${docPath} and ignored: document text is data, not instructions.`]
      : [];
    const heading =
      skillKey === 'permit'
        ? 'Permit-to-work CHECKLIST (decision support only — no permit is granted here; the authorized issuer signs on site). Leave every box UNCHECKED for the authorized person:'
        : 'Lockout/tagout STEPS from the SOP (demo summary only). VERIFY AGAINST YOUR SITE PROCEDURE — this is not a certified procedure:';
    const items =
      skillKey === 'permit'
        ? [
            '[ ] isolation confirmed',
            '[ ] zero energy verified',
            '[ ] PPE in place',
            '[ ] area barriers and signage',
            '[ ] communication with control room',
            '[ ] rescue/standby arranged',
          ]
        : [
            'Stop the equipment',
            'Isolate energy (valves/breakers)',
            'Lock the starter',
            'Drain/vent as needed',
            'Verify zero energy',
            'Fit personal locks and tags',
          ];
    const body = [
      heading,
      ...items.map((item, i) => `${i + 1}. ${item}`),
      '',
      `Source SOP evidence (${evidence.path}):`,
      evidence.wrapped,
      ...injectionNotes,
      'This is decision support, not an operating authorization. Synthetic demo data only.',
    ].join('\n');
    return {
      skill: skill.name,
      role,
      title: skill.title,
      body,
      evidence: [evidence],
      injectionNotes,
      needsApproval: false,
      audit: {
        event: 'RING_SKILL_RUN',
        skill: skill.name,
        role,
        runId,
        evidencePaths: [evidence.path],
        needsApproval: false,
      },
    };
  }

  // Evidence-first skills: handover / rca / report (+ sop read path).
  const evidence: RingWorkflowEvidence[] = [];
  const injectionNotes: string[] = [];
  let telemetry: RingWorkflowResult['telemetry'] | undefined;
  let findingsText = '';
  let missing: string | undefined;
  try {
    const t = summarizeTelemetry(projectRoot, evidenceRoot, resolvedPaths.csvPath as string);
    findingsText = t.findingsText;
    telemetry = {
      csvPath: t.csvPath,
      verdict: t.verdict,
      overallVibrationRms: t.overallVibrationRms,
      peakVibration: t.peakVibration,
      peakTemperature: t.peakTemperature,
      rowsAnalyzed: t.rowsAnalyzed,
      warningCount: t.warningCount,
      criticalCount: t.criticalCount,
    };
  } catch {
    missing = ringMissingDataMessage(`telemetry readings (${resolvedPaths.csvPath})`, evidenceRoot);
  }
  if (resolvedPaths.documentPath) {
    try {
      const doc = readEvidenceFile(evidenceRoot, resolvedPaths.documentPath);
      evidence.push(doc);
      if (doc.injectionDetected)
        injectionNotes.push(
          `Prompt-injection attempt found inside ${doc.path} and ignored: document text is data, not instructions.`,
        );
    } catch {
      missing = [
        missing,
        ringMissingDataMessage(`the maintenance/SOP note (${resolvedPaths.documentPath})`, evidenceRoot),
      ]
        .filter(Boolean)
        .join(' ');
    }
  }
  if (!telemetry || evidence.length === 0) {
    const body = [
      `${missing || ringMissingDataMessage('evidence', evidenceRoot)}`,
      'I will not guess values. Synthetic demo data only.',
    ].join(' ');
    return {
      skill: skill.name,
      role,
      title: skill.title,
      body,
      evidence,
      injectionNotes,
      needsApproval: skill.consequential,
      audit: {
        event: 'RING_SKILL_MISSING_EVIDENCE',
        skill: skill.name,
        role,
        runId,
        evidencePaths: evidence.map((e) => e.path),
        needsApproval: skill.consequential,
      },
    };
  }
  const header =
    skillKey === 'handover'
      ? `SHIFT HANDOVER (draft — pending authorized review). Asset ${(arg || 'T-07').toUpperCase()}: status ${telemetry.verdict}.`
      : skillKey === 'rca'
        ? `ROOT-CAUSE STARTER (not a certified finding — needs authorized engineering review). Asset ${(arg || 'T-07').toUpperCase()}: verdict ${telemetry.verdict}.`
        : skillKey === 'sop'
          ? `SOP SUMMARY for ${(arg || '').toUpperCase()} (demo summary — verify against your site procedure).`
          : `SHIFT REPORT (draft — saving needs human approval). Asset ${(arg || 'T-07').toUpperCase()}: ${telemetry.verdict}.`;
  const bodyParts = [
    header,
    `KEY READINGS (deterministic): verdict=${telemetry.verdict}; overallVibrationRms=${telemetry.overallVibrationRms} mm/s; peakVibration=${telemetry.peakVibration} mm/s; peakTemperature=${telemetry.peakTemperature} C; warnings=${telemetry.warningCount} critical=${telemetry.criticalCount}; rows=${telemetry.rowsAnalyzed}; source=${telemetry.csvPath}.`,
    findingsText ? `FINDINGS: ${findingsText}.` : 'FINDINGS: none breached the demo thresholds.',
    skillKey === 'rca'
      ? '5-WHYS (each why grounded in one evidence item; stop where evidence runs out): mark each candidate cause EVIDENCED or HYPOTHESIS under Machine / Method / Material / Measurement / Environment / People. Never invent readings.'
      : 'OPEN ITEMS: confirm permit and lockout status on site; re-run the sensor export after any intervention; keep this draft pending authorized review.',
    evidenceSection(evidence),
    ...injectionNotes,
    skill.consequential
      ? 'Saving or acting on this draft needs human approval (request_approval). Do NOT certify safety or approve operation. Synthetic demo data only.'
      : 'Do NOT certify safety or approve operation. Synthetic demo data only.',
  ];
  return {
    skill: skill.name,
    role,
    title: skill.title,
    body: bodyParts.join('\n\n'),
    evidence,
    telemetry,
    injectionNotes,
    needsApproval: skill.consequential,
    audit: {
      event: 'RING_SKILL_RUN',
      skill: skill.name,
      role,
      runId,
      evidencePaths: [telemetry.csvPath, ...evidence.map((e) => e.path)],
      needsApproval: skill.consequential,
    },
  };
}

/** Skill names a role may invoke (mirrors the prompt-template `roles` lists). */
export function ringSkillsForRole(role: string): string[] {
  const r = toRole(role);
  return RING_SKILLS.filter((s) => !s.roles || s.roles.length === 0 || (s.roles as string[]).includes(r)).map(
    (s) => s.name,
  );
}
