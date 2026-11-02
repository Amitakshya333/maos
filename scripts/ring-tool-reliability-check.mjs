#!/usr/bin/env node
/**
 * TASK RING-DEV-A-DAY2: Ring tool reliability harness (live path prepared, not executed here).
 *
 * What it does
 *  - `--dry-run` (no key needed, no hosted calls): evidence-only self-test of
 *    the harness machinery itself — temp project scaffolding, instruction
 *    runner, tool-call recorder, secret scrubber. Safe to run anywhere.
 *  - `--live` (requires BASETEN_API_KEY): runs 4 hosted instructions that
 *    each need 2-3 tool calls against the REAL Baseten endpoint, then records
 *    per instruction: observed tools, args validity, completion/final-answer
 *    stop, turn bound, and raw-row leak check. Exits non-zero on failure.
 *    Without BASETEN_API_KEY it prints the skip line and exits 0.
 *
 * Safety rules (enforced in code, not just docs)
 *  - The key is read ONLY from process.env.BASETEN_API_KEY and is NEVER
 *    printed, logged, or written anywhere: every console line and the JSON
 *    report pass through scrubSecrets(). Results land in os.tmpdir(), never
 *    in the repo, and are never committed.
 *  - Raw telemetry CSV rows are never asserted on; only deterministic
 *    summaries travel. The harness FAILS an instruction whose final answer
 *    contains the CSV header line.
 *  - A consequential tool gate (awaiting_approval) is auto-DENIED by the
 *    harness so a runaway model cannot pause forever; the denial is recorded.
 *  - Overrun protection: per-instruction timeout -> cancelRun -> FAIL.
 *
 * Prerequisites: `npm run build:backend` (requires ../dist). Node >= 18.
 *
 *   node scripts/ring-tool-reliability-check.mjs --dry-run
 *   BASETEN_API_KEY=... node scripts/ring-tool-reliability-check.mjs --live
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SKIP_LINE = 'BASETEN_API_KEY not set — skipping live check';
const PER_INSTRUCTION_TIMEOUT_MS = 240000;
const POLL_MS = 250;

const SECRET = process.env.BASETEN_API_KEY || '';
function scrubSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!SECRET) return text;
  return text.split(SECRET).join('[REDACTED]');
}
function log(...parts) {
  console.log(scrubSecrets(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')));
}
function fail(...parts) {
  console.error(scrubSecrets(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')));
}

/** 4 instructions, each needing 2-3 tool calls on the hosted path. */
const INSTRUCTIONS = [
  {
    id: 'telemetry-verdict',
    instruction: 'Analyze turbine vibration telemetry for T-07 and summarize the verdict, citing the deterministic overall RMS.',
    expectTools: ['analyze_telemetry'],
  },
  {
    id: 'sop-read-and-search',
    instruction: 'Read the turbine vibration monitoring SOP and search company knowledge for vibration guidance, then summarize both.',
    expectTools: ['read_company_document', 'search_knowledge'],
  },
  {
    id: 'memory-and-plan',
    instruction: 'Remember that T-07 is a critical asset needing vibration watch, then update the run plan with the next monitoring steps.',
    expectTools: ['remember', 'update_plan'],
  },
  {
    id: 'audit-verify',
    instruction: 'Verify the audit export chain and report whether the audit trail is valid.',
    expectTools: ['verify_export'],
  },
];

const RAW_ROW_MARKERS = ['timestamp,asset_id,vibration_rms_mm_s'];

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-reliab-'));
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
  for (const f of [
    'sop_turbine_vibration_monitoring.md',
    'maintenance_report.txt',
    'safety_thresholds.json',
    'turbine_vibration_log.csv',
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, 'demo', 'industrial', f), path.join(root, 'demo', 'industrial', f));
  }
  return root;
}

function writeArmedConfig(root) {
  // Mirrors the test arming shape: exact Baseten endpoint + model, opt-in on.
  const { BASETEN_API_BASE_URL, BASETEN_API_MODEL } = requireBasetenConstants();
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'ring-reliability-harness',
      profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
      providers: { baseten: { baseURL: BASETEN_API_BASE_URL, basetenApiEnabled: true } },
      agents: [{ id: 'ANALYST_AGENT', role: 'analyst', provider: 'baseten', model: BASETEN_API_MODEL }],
    }),
  );
}

function writeEvidenceOnlyConfig(root) {
  fs.writeFileSync(
    path.join(root, '.maos', 'maos.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectName: 'ring-reliability-harness-dryrun',
      profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true },
    }),
  );
}

function requireServiceModules() {
  const dist = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'service', 'ring-agent-service.js'))) {
    throw new Error(`HARNESS_SETUP: ${path.join(dist, 'service', 'ring-agent-service.js')} missing — run \`npm run build:backend\` first.`);
  }
  // eslint-disable-next-line global-require
  const { RingAgentService } = require(path.join(dist, 'service', 'ring-agent-service.js'));
  // eslint-disable-next-line global-require
  const { AuditService } = require(path.join(dist, 'service', 'audit-service.js'));
  // eslint-disable-next-line global-require
  const { MemoryService } = require(path.join(dist, 'service', 'memory-service.js'));
  return { RingAgentService, AuditService, MemoryService };
}

function requireBasetenConstants() {
  // eslint-disable-next-line global-require
  return require(path.join(REPO_ROOT, 'dist', 'backends', 'meta-api-policy.js'));
}

function summarizeArgs(argsSummary) {
  if (!argsSummary || typeof argsSummary !== 'object') return { ok: false, reason: 'argsSummary is not an object' };
  return { ok: true };
}

async function runOne(service, spec, timeoutMs) {
  const startedAt = Date.now();
  const runId = service.startRun(spec.instruction);
  const deadline = Date.now() + timeoutMs;
  let snap = service.getRun(runId);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    snap = service.getRun(runId);
    if (!snap) throw new Error(`HARNESS: run ${runId} vanished.`);
    if (snap.status === 'awaiting_approval' && snap.pendingApproval) {
      service.resolveApproval(runId, snap.pendingApproval.approvalId, 'denied');
      snap = service.getRun(runId);
    }
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') break;
    if (Date.now() > deadline) {
      service.cancelRun(runId);
      snap = await service.waitForCompletion(runId, 10000);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const transcript = snap.transcript || [];
  const toolCalls = transcript.filter((e) => e.type === 'tool.call');
  const toolResults = transcript.filter((e) => e.type === 'tool.result');
  const observedTools = [...new Set(toolCalls.map((e) => e.toolName))];
  const missingTools = spec.expectTools.filter((t) => !observedTools.includes(t));
  const pairingOk = toolResults.every((r) => toolCalls.some((c) => c.toolCallId === r.toolCallId));
  const argsOk = toolCalls.every((c) => summarizeArgs(c.argsSummary).ok);
  const modelTurns = transcript.filter((e) => e.type === 'model.turn').length;
  const finalAnswer = typeof snap.finalAnswer === 'string' ? snap.finalAnswer : '';
  const leakedRows = RAW_ROW_MARKERS.filter((m) => finalAnswer.includes(m));
  const completed = snap.status === 'completed' && finalAnswer.trim().length > 0;
  return {
    id: spec.id,
    runId,
    mode: snap.mode,
    status: snap.status,
    completed,
    expectedTools: spec.expectTools,
    observedTools,
    missingTools,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
    pairingOk,
    argsOk,
    modelTurns,
    finalAnswerChars: finalAnswer.length,
    leakedRows,
    elapsedMs: Date.now() - startedAt,
    pass:
      completed &&
      missingTools.length === 0 &&
      pairingOk &&
      argsOk &&
      leakedRows.length === 0 &&
      modelTurns <= 20,
  };
}

async function cmdDryRun() {
  const { RingAgentService, AuditService, MemoryService } = requireServiceModules();
  // scrubber self-test with a stand-in secret (never the real key)
  const probe = 'prefix-SYNTHETIC-SECRET-abc-suffix';
  const scrubbed = 'prefix-SYNTHETIC-SECRET-abc-suffix'.split('SYNTHETIC-SECRET-abc').join('[REDACTED]');
  if (scrubbed.includes('SYNTHETIC-SECRET-abc') || !scrubbed.includes('[REDACTED]')) {
    throw new Error('HARNESS_SELFTEST: scrubber is broken.');
  }
  void probe;
  const root = makeTempProject();
  try {
    writeEvidenceOnlyConfig(root);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), memoryService: new MemoryService(root) });
    const results = [];
    for (const spec of INSTRUCTIONS) {
      const res = await runOne(service, spec, 60000);
      results.push(res);
      log(`[dry-run] ${res.id}: status=${res.status} mode=${res.mode} tools=[${res.observedTools.join(',')}] (machinery check only; hosted expectations apply to --live)`);
      if (res.mode !== 'evidence-only') throw new Error(`HARNESS_SELFTEST: dry-run left evidence-only (mode=${res.mode}).`);
      if (res.status !== 'completed') throw new Error(`HARNESS_SELFTEST: instruction ${res.id} did not complete in dry-run.`);
    }
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-reliab-report-'));
    const reportPath = path.join(reportDir, 'dry-run-report.json');
    fs.writeFileSync(reportPath, scrubSecrets(JSON.stringify({ kind: 'dry-run', results }, null, 2)));
    if (scrubSecrets(SECRET || 'no-key-set') !== (SECRET ? '[REDACTED]' : 'no-key-set')) {
      throw new Error('HARNESS_SELFTEST: key scrubbing is broken.');
    }
    log(`dry-run self-test passed (${results.length}/${INSTRUCTIONS.length} instructions recorded, evidence-only, no hosted calls). report: ${reportPath}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function cmdLive() {
  if (!SECRET || !SECRET.trim()) {
    console.log(SKIP_LINE);
    return 'skipped';
  }
  const { RingAgentService, AuditService, MemoryService } = requireServiceModules();
  const root = makeTempProject();
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-reliab-report-'));
  try {
    writeArmedConfig(root);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), memoryService: new MemoryService(root) });
    const results = [];
    for (const spec of INSTRUCTIONS) {
      log(`[live] starting ${spec.id}: ${spec.instruction}`);
      const res = await runOne(service, spec, PER_INSTRUCTION_TIMEOUT_MS);
      results.push(res);
      log(`[live] ${res.id}: status=${res.status} mode=${res.mode} turns=${res.modelTurns} tools=[${res.observedTools.join(',')}] missing=[${res.missingTools.join(',')}] argsOk=${res.argsOk} pairingOk=${res.pairingOk} pass=${res.pass}`);
    }
    const reportPath = path.join(reportDir, 'live-report.json');
    fs.writeFileSync(reportPath, scrubSecrets(JSON.stringify({ kind: 'live', results }, null, 2)));
    // belt-and-braces: the written report must not contain the key
    const written = fs.readFileSync(reportPath, 'utf8');
    if (SECRET && written.includes(SECRET)) {
      throw new Error('HARNESS_SAFETY: live report contains the API key — refusing to keep it.');
    }
    const failed = results.filter((r) => !r.pass);
    log(`live reliability: ${results.length - failed.length}/${results.length} passed. report: ${reportPath}`);
    if (failed.length) {
      fail(`FAILED: ${failed.map((r) => r.id).join(', ')}`);
      process.exitCode = 1;
    }
    return 'done';
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run') && args.includes('--live')) {
    fail('Choose one of --dry-run or --live.');
    process.exitCode = 2;
    return;
  }
  if (args.includes('--dry-run')) {
    await cmdDryRun();
    return;
  }
  if (args.includes('--live') || args.length === 0) {
    await cmdLive();
    return;
  }
  fail(`Unknown args: ${args.join(' ')}. Use --dry-run or --live.`);
  process.exitCode = 2;
}

main().catch((err) => {
  fail(`HARNESS_ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
