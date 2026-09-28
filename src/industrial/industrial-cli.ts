/**
 * F10-01: Industrial CLI Namespace & Application Service Operations
 *
 * Implements command execution for:
 *   - maos industrial preflight
 *   - maos industrial start
 *   - maos industrial demo
 *   - maos industrial verify (audit | service | boundary)
 *   - maos industrial stop
 *
 * Requirements:
 *   1. Routes every command through existing typed application services (ServiceContainer).
 *   2. Zero duplicate business logic.
 *   3. Enforces project root validation and loopback isolation.
 *   4. Stable numerical exit codes.
 *   5. Machine-readable JSON output (--json) and human-readable formatting.
 *   6. Force stop strictly mandates explicit confirmation (--yes / --confirm).
 *   7. Rejects unsupported modes like pause/resume.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { createServiceContainer, ServiceContainer } from '../service';
import { createProjectServiceHost } from '../service/project-service/host';
import { executeCodeSandboxTool } from '../integrations/tools';
import { runAllStages, PreflightResult } from './preflight';
import {
  executeDeterministicReset,
  ResetCategory,
  RESET_CATEGORIES,
} from './deterministic-reset';
import {
  executeJudgedRun,
  JudgedRunOptions,
  JudgedRunResult,
  readJudgedRunManifest,
} from './judged-run';
import {
  openLocalArtifact,
  OpenArtifactParams,
  OpenArtifactResult,
} from './open-artifact';
import { verifyTelemetryAnalysis } from './telemetry-analysis';

// ── Exit Codes ─────────────────────────────────────────────────────

export const INDUSTRIAL_CLI_EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  INVALID_ARGS: 2,
  PREFLIGHT_BLOCKED: 3,
  CONFIRMATION_REQUIRED: 4,
  STOP_FAILED: 5,
  DEMO_FAILED: 6,
  VERIFY_FAILED: 7,
  RESET_FAILED: 8,
  POLICY_VIOLATION: 9,
  GATE_REJECTED: 10,
  NOT_FOUND: 11,
  BOUNDARY_FAILED: 12,
} as const;

export type IndustrialCliExitCode =
  (typeof INDUSTRIAL_CLI_EXIT)[keyof typeof INDUSTRIAL_CLI_EXIT];

export interface IndustrialCliResult {
  readonly exitCode: IndustrialCliExitCode;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

// ── 1. Preflight ───────────────────────────────────────────────────

export interface PreflightCliOptions {
  readonly projectRoot?: string;
  readonly stage?: string;
  readonly json?: boolean;
  /**
   * Pre-built service container. Supplied by tests and embedding hosts that need
   * deterministic wiring; the CLI always constructs its own.
   */
  readonly services?: ServiceContainer;
}

export async function runIndustrialPreflight(
  options: PreflightCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const services = options.services ?? createServiceContainer(projectRoot);

  try {
    // At process scope a standalone preflight process holds no enforcement
    // session — that is in-process state, so it cannot be inherited from a
    // previous command. Instead of reporting a boundary it does not hold,
    // preflight establishes one, evaluates the real gate against it, then tears
    // it down. The gate is therefore exercised end to end, and an unreachable
    // observer, an invalid policy, or an attributed violation genuinely fails.
    //
    // No host packet filter state is written at any point in this sequence.
    const scope = services.industrialFirewallRequirement.getScope();

    let boundarySelfTest: Awaited<ReturnType<typeof services.processBoundary.selfTest>> | undefined;
    let boundaryStatus;

    if (scope === 'process') {
      // Never tear down a boundary this process did not establish: a live boundary
      // may belong to an embedding host, and destroying it (with its evidence)
      // would be a side effect no caller asked for.
      const boundaryPreExisted = services.processBoundary.isEnabled('default');

      if (!boundaryPreExisted) {
        await services.processBoundary.enable('default', {
          confirm: true,
          samplingIntervalMs: 0,
          selfTest: true,
        });
      }

      try {
        // A live boundary is measured as-is and left running by `selfTest`.
        boundarySelfTest = await services.processBoundary.selfTest('default');
        boundaryStatus = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
      } finally {
        if (!boundaryPreExisted) {
          try {
            // Preflight's boundary is a mechanism check, not evidence: discard its
            // scratch trace rather than growing the evidence directory once per
            // invocation. A real run keeps its trace.
            await services.processBoundary.disable('default', {
              confirm: true,
              selfTest: true,
              discardEvidence: true,
            });
          } catch {
            // Teardown is best effort; a leftover record can never report ACTIVE.
          }
        }
      }
    } else {
      boundaryStatus = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
    }

    const diagnostics = services.health.runDiagnostics();
    const allDiagsPassed = diagnostics.every((d) => d.passed);

    const boundaryOk =
      scope === 'process'
        ? boundaryStatus.verified && boundarySelfTest!.verified
        : boundaryStatus.verified;

    const isVerified = boundaryOk && allDiagsPassed;
    const exitCode = isVerified ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.PREFLIGHT_BLOCKED;

    const data: Record<string, unknown> = {
      verified: isVerified,
      boundaryScope: scope,
      boundaryStatus,
      boundarySelfTest,
      diagnostics,
      checkedAt: new Date().toISOString(),
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold.blue('\n🏭 MAOS Industrial — Preflight Check\n'));
      console.log(chalk.gray(`Project Root: ${projectRoot}`));
      console.log(
        `Boundary Status: ${
          boundaryOk ? chalk.green('VERIFIED') : chalk.red('BLOCKED')
        } (${boundaryStatus.overallStatus})`,
      );
      console.log(`Scope:           ${boundaryStatus.boundaryScope || 'host'}`);
      console.log(`Firewall:        ${boundaryStatus.firewallStatus}`);
      console.log(`Endpoint Policy: ${boundaryStatus.endpointPolicyStatus}`);
      console.log(`Monitor:         ${boundaryStatus.monitorStatus}`);
      console.log(`Diagnostics:     ${allDiagsPassed ? chalk.green('ALL PASSED') : chalk.red('FAILURES DETECTED')}`);

      if (boundarySelfTest) {
        console.log(
          `Boundary Self-Test: ${
            boundarySelfTest.verified ? chalk.green('PASSED') : chalk.red('FAILED')
          } (${boundarySelfTest.constraintCount} constraints, ` +
            `${boundarySelfTest.observedSocketCount} socket(s) observed, ` +
            `${boundarySelfTest.violationCount} violation(s), ` +
            `${boundarySelfTest.monitoredPids.length} process(es) attributed)`,
        );
        console.log(`Host Firewall:   ${chalk.green('NOT MODIFIED')} (process scope writes no host rules)`);
        if (boundarySelfTest.attributionReason) {
          console.log(chalk.yellow(`Attribution note: ${boundarySelfTest.attributionReason}`));
        }
        if (boundarySelfTest.errors.length > 0) {
          console.log(chalk.yellow('\nBoundary Errors:'));
          for (const e of boundarySelfTest.errors) console.log(chalk.red(`  ✗ ${e}`));
        }
        if (boundarySelfTest.violations.length > 0) {
          console.log(chalk.yellow('\nBoundary Violations:'));
          for (const v of boundarySelfTest.violations) console.log(chalk.red(`  ✗ ${v}`));
        }
      }

      if (boundaryStatus.measureDetails) {
        console.log(chalk.gray(`\nMeasurement: ${boundaryStatus.measureDetails}`));
      }

      if (boundaryStatus.activeViolations && boundaryStatus.activeViolations.length > 0) {
        console.log(chalk.yellow('\nActive Violations:'));
        for (const v of boundaryStatus.activeViolations) {
          console.log(chalk.red(`  ✗ ${v}`));
        }
      }

      if (!allDiagsPassed) {
        console.log(chalk.yellow('\nFailed Diagnostics:'));
        for (const d of diagnostics.filter((x) => !x.passed)) {
          console.log(chalk.red(`  ✗ ${d.check}${d.message ? `: ${d.message}` : ''}`));
        }
      }

      if (!isVerified) {
        console.log(chalk.cyan('\nDiagnosis:'));
        if (scope === 'process') {
          if (boundarySelfTest && !boundarySelfTest.verified) {
            console.log(
              chalk.gray(
                '  The process-scoped boundary could not be established or observed cleanly.\n' +
                  '  Fix the boundary errors above before running Industrial. Host packet filter\n' +
                  '  rules are not involved at this scope and changing them will not help.',
              ),
            );
          } else if (!boundaryStatus.verified) {
            console.log(
              chalk.gray(
                `  The boundary mechanism works, but the gate reported: ${boundaryStatus.blockingReason || 'unverified'}\n` +
                  '  Inspect with: maos industrial verify boundary',
              ),
            );
          }
          if (!allDiagsPassed) {
            console.log(
              chalk.gray('  Resolve the failed diagnostics listed above.'),
            );
          }
          console.log(chalk.gray('\n  Inspect current state: maos industrial boundary status'));
        } else {
          console.log(
            chalk.gray(
              '  This project is evaluating the boundary at host scope, which writes machine-wide\n' +
                '  packet filter rules. See docs/BOUNDARY_SCOPE.md before proceeding.',
            ),
          );
          console.log(chalk.gray('\n  Inspect current state: maos industrial boundary status'));
        }
      }
    }

    return {
      exitCode,
      message: isVerified ? 'Preflight verified successfully.' : 'Preflight blocked by boundary policy.',
      data,
    };
  } catch (err: any) {
    const msg = `Preflight error: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.FAILURE, message: msg };
  }
}

// ── 1b. Boundary Lifecycle (process scope) ─────────────────────────

export interface BoundaryCliOptions {
  readonly projectRoot?: string;
  readonly action?: 'enable' | 'status' | 'disable';
  readonly projectId?: string;
  readonly yes?: boolean;
  readonly samplingIntervalMs?: number;
  readonly monitorPids?: readonly number[];
  readonly json?: boolean;
}

/**
 * Drives the process-scoped Industrial boundary:
 *   enable | status | disable
 *
 * This is the supported path to a verified boundary. It writes no host packet
 * filter rules and requires no elevation — the process scope constrains the MAOS
 * process tree and its declared loopback endpoints, and observes them passively.
 *
 * The host-scope firewall path remains available through FirewallService for
 * deployments that explicitly want machine-wide rules, but it is never selected
 * implicitly and never required to run Industrial.
 */
export async function runIndustrialBoundary(
  options: BoundaryCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const projectId = options.projectId || 'default';
  const action = options.action || 'status';

  if (action !== 'enable' && action !== 'status' && action !== 'disable') {
    const msg = `Invalid boundary action '${action}'. Supported actions: enable, status, disable.`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
  }

  const services = createServiceContainer(projectRoot);

  try {
    if (action === 'status') {
      const status = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus(projectId);
      const measured = await services.processBoundary.getStatus(projectId);
      const verification = services.processBoundary.verifyEnabledBoundary(projectId);

      const data: Record<string, unknown> = {
        action: 'status',
        projectId,
        boundaryScope: 'process',
        hostFirewallModified: false,
        firewallStatus: measured.state,
        activePlanId: measured.activePlanId,
        activePolicyHash: measured.activePolicyHash,
        constraintCount: measured.activeRuleCount,
        verification,
        boundaryStatus: status,
        details: measured.details,
      };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.blue('\n🔒 MAOS Industrial — Sovereignty Boundary\n'));
        console.log(`Scope:          process (MAOS process tree + declared loopback endpoints)`);
        console.log(`Host Firewall:  ${chalk.green('NOT MODIFIED')} (this scope writes no host packet filter rules)`);
        console.log(
          `Boundary:       ${measured.state === 'ACTIVE' ? chalk.green('ACTIVE') : chalk.yellow(measured.state)}`,
        );
        console.log(`Verified:       ${verification.verified ? chalk.green('YES') : chalk.yellow('NO')}`);
        console.log(`Constraints:    ${measured.activeRuleCount}`);
        if (measured.details) console.log(chalk.gray(`\n${measured.details}`));
        if (verification.errors.length > 0) {
          console.log(chalk.yellow('\nVerification notes:'));
          for (const e of verification.errors) console.log(chalk.yellow(`  • ${e}`));
        }
        if (measured.state !== 'ACTIVE') {
          console.log(chalk.cyan('\nTo enable: maos industrial boundary enable --yes'));
        }
        console.log();
      }

      return {
        exitCode: verification.verified ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED,
        message: verification.verified
          ? 'Process-scoped boundary is active and verified.'
          : `Process-scoped boundary is ${measured.state}.`,
        data,
      };
    }

    if (action === 'enable') {
      const result = await services.processBoundary.enable(projectId, {
        confirm: options.yes === true,
        samplingIntervalMs: options.samplingIntervalMs,
        monitoredPids: options.monitorPids,
      });

      const data: Record<string, unknown> = { action: 'enable', ...result };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.green('\n🔒 MAOS Industrial — Boundary Enabled (process scope)\n'));
        console.log(`Session:        ${result.sessionId}`);
        console.log(`Plan:           ${result.planId}`);
        console.log(`Policy hash:    ${result.policyHash.substring(0, 16)}…`);
        console.log(`Constraints:    ${result.constraintCount}`);
        console.log(`Attribution:    ${result.monitoredPids.length} process(es)${result.attributionComplete ? '' : chalk.yellow(' (degraded: root process only)')}`);
        console.log(`Host Firewall:  ${chalk.green('NOT MODIFIED')}`);
        console.log(`Elevation:      ${chalk.green('not required')}`);
        if (result.alreadyActive) {
          console.log(chalk.gray('\nAn identical boundary was already enforced; nothing changed.'));
        }
        if (result.attributionReason) {
          console.log(chalk.yellow(`\nNote: ${result.attributionReason}`));
        }
        console.log(
          chalk.yellow(
            '\nImportant: this boundary is held by THIS process. A process-scoped boundary\n' +
              'constrains the process tree that holds it, so it ends when this command exits —\n' +
              'and another process cannot observe this session. To run a workflow inside an\n' +
              'enforced boundary, use:\n' +
              '  maos industrial run --enforce-firewall',
          ),
        );
        console.log();
      }

      return {
        exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
        message: result.alreadyActive
          ? 'Process-scoped boundary was already active.'
          : 'Process-scoped boundary enabled.',
        data,
      };
    }

    // disable
    const result = await services.processBoundary.disable(projectId, {
      confirm: options.yes === true,
    });

    const data: Record<string, unknown> = { action: 'disable', ...result };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold.yellow('\n🔓 MAOS Industrial — Boundary Disabled\n'));
      console.log(`Session:        ${result.sessionId || '(none active)'}`);
      if (result.tracePath) console.log(`Evidence:       ${result.tracePath}`);
      if (result.traceHash) console.log(`Trace hash:     ${result.traceHash.substring(0, 16)}…`);
      console.log(`Host Firewall:  ${chalk.green('NOT MODIFIED')}`);
      console.log();
    }

    return {
      exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
      message: 'Process-scoped boundary disabled.',
      data,
    };
  } catch (err: any) {
    const isConfirmation =
      err?.code === 'FIREWALL_CONFIRMATION_REQUIRED' ||
      typeof err?.message === 'string' && err.message.includes('FIREWALL_CONFIRMATION_REQUIRED');

    const message = isConfirmation
      ? `${action} requires explicit confirmation. Re-run with --yes.`
      : `Boundary ${action} failed: ${err.message}`;

    const exitCode = isConfirmation
      ? INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED
      : INDUSTRIAL_CLI_EXIT.BOUNDARY_FAILED;

    if (options.json) {
      console.log(JSON.stringify({ action, success: false, error: err.message, confirmationRequired: isConfirmation }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ ${message}`));
    }

    return { exitCode, message };
  }
}

// ── 2. Start ───────────────────────────────────────────────────────

export interface StartCliOptions {
  readonly projectRoot?: string;
  readonly port?: number;
  readonly host?: string;
  readonly json?: boolean;
}

export async function runIndustrialStart(
  options: StartCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());

  try {
    const host = createProjectServiceHost(projectRoot, {
      port: options.port ?? 0,
      host: options.host || '127.0.0.1',
    });

    const started = await host.start();
    const data: Record<string, unknown> = {
      port: started.port,
      host: options.host || '127.0.0.1',
      baseUrl: host.getBaseUrl(),
      projectRoot,
      instanceId: started.identity.serviceInstanceId,
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold.green('\n🚀 MAOS Industrial Project Service Started\n'));
      console.log(`Loopback Base URL: ${chalk.cyan(host.getBaseUrl())}`);
      console.log(`Service Port:      ${started.port}`);
      console.log(`Instance ID:       ${started.identity.serviceInstanceId}`);
      console.log(`Project Root:      ${projectRoot}`);
      console.log(chalk.gray('\nPress Ctrl+C to stop service.\n'));
    }

    return {
      exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
      message: `Industrial service listening on ${host.getBaseUrl()}`,
      data,
    };
  } catch (err: any) {
    const msg = `Failed to start industrial service: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.FAILURE, message: msg };
  }
}

// ── 3. Demo ────────────────────────────────────────────────────────

export interface DemoCliOptions {
  readonly projectRoot?: string;
  readonly demo?: string;
  readonly json?: boolean;
}

export async function runIndustrialDemo(
  options: DemoCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const services = createServiceContainer(projectRoot);

  const demoName = options.demo || 'rms';
  if (demoName !== 'rms' && demoName !== 'f8-05') {
    const msg = `Unsupported demo '${demoName}'. Supported demos: 'rms'`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
  }

  try {
    const csvPath = path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv');
    const scriptPath = path.join(projectRoot, 'fixtures', 'f8-05', 'rms-calculation.py');
    const truthPath = path.join(projectRoot, 'fixtures', 'f8-05', 'ground-truth.json');

    if (!fs.existsSync(csvPath) || !fs.existsSync(scriptPath) || !fs.existsSync(truthPath)) {
      const msg = 'Required demo fixtures missing in demo/industrial or fixtures/f8-05';
      if (!options.json) console.error(chalk.red(msg));
      return { exitCode: INDUSTRIAL_CLI_EXIT.DEMO_FAILED, message: msg };
    }

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    const groundTruth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));

    const context = {
      agentId: 'analyst_agent',
      taskId: 'demo-rms-coding-f8-05',
      projectRoot,
      allowedTools: ['execute_code_sandbox'],
      scope: ['demo/industrial', 'turbine_vibration_log.csv'],
    };

    const execResult = await executeCodeSandboxTool(
      {
        script: scriptContent,
        files: {
          'turbine_vibration_log.csv': csvContent,
        },
        requestId: `cli-demo-${Date.now()}`,
      },
      context,
      services,
    );

    if (!execResult.ok || execResult.exitCode !== 0) {
      const msg = `Demo execution failed with exit code ${execResult.exitCode}: ${execResult.stderr || (execResult as any).error || 'Execution failed'}`;
      if (!options.json) console.error(chalk.red(msg));
      return { exitCode: INDUSTRIAL_CLI_EXIT.DEMO_FAILED, message: msg, data: execResult as any };
    }

    const parsedOutput = JSON.parse(execResult.stdout.trim());
    const rmsDiff = Math.abs(parsedOutput.rms_value - groundTruth.rms_value);
    const truthMatches =
      rmsDiff < 1e-6 &&
      parsedOutput.warning_count === groundTruth.warning_count &&
      parsedOutput.critical_count === groundTruth.critical_count &&
      parsedOutput.row_count === groundTruth.row_count;

    const data: Record<string, unknown> = {
      demo: 'rms-coding-f8-05',
      truthMatches,
      rmsValue: parsedOutput.rms_value,
      expectedRms: groundTruth.rms_value,
      warningCount: parsedOutput.warning_count,
      criticalCount: parsedOutput.critical_count,
      rowCount: parsedOutput.row_count,
      outputHash: execResult.outputHash,
      executionOk: execResult.ok,
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold.blue('\n🏭 MAOS Industrial — Sovereign RMS Coding Demo\n'));
      console.log(`Execution:     ${chalk.green('PASSED (exit 0)')}`);
      console.log(`RMS Value:     ${chalk.cyan(parsedOutput.rms_value.toFixed(6))} (truth: ${groundTruth.rms_value.toFixed(6)})`);
      console.log(`Warnings:      ${parsedOutput.warning_count}`);
      console.log(`Criticals:     ${parsedOutput.critical_count}`);
      console.log(`Rows Analyzed: ${parsedOutput.row_count}`);
      console.log(`Output Hash:   ${execResult.outputHash}`);
      console.log(`Ground Truth:  ${truthMatches ? chalk.green('VERIFIED TO 6 DECIMAL PLACES') : chalk.red('MISMATCH')}\n`);
    }

    return {
      exitCode: truthMatches ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.DEMO_FAILED,
      message: truthMatches ? 'Demo completed with verified ground truth.' : 'Demo output did not match ground truth.',
      data,
    };
  } catch (err: any) {
    const msg = `Demo error: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.DEMO_FAILED, message: msg };
  }
}

// ── 4. Verify ──────────────────────────────────────────────────────

export interface VerifyCliOptions {
  readonly target?: 'audit' | 'boundary' | 'service' | 'telemetry';
  readonly runId?: string;
  readonly analysisId?: string;
  readonly projectRoot?: string;
  readonly json?: boolean;
}

export async function runIndustrialVerify(
  options: VerifyCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const target = options.target || 'audit';

  try {
    if (target === 'telemetry') {
      if (!options.analysisId) {
        const msg = "Telemetry verification requires --analysis-id <id>.";
        if (!options.json) console.error(chalk.red(msg));
        return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
      }
      const verification = verifyTelemetryAnalysis(projectRoot, options.analysisId);
      const exitCode = verification.valid ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED;
      const data = { target: 'telemetry', verification };
      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Telemetry Replay Verification\n'));
        console.log(`Analysis ID:       ${verification.analysisId}`);
        console.log(`Source hash:       ${verification.sourceHashMatched ? chalk.green('MATCHED') : chalk.red('MISMATCH')}`);
        console.log(`Ruleset hash:      ${verification.rulesetHashMatched ? chalk.green('MATCHED') : chalk.red('MISMATCH')}`);
        console.log(`Calculation replay:${verification.recomputationMatched ? chalk.green(' MATCHED') : chalk.red(' MISMATCH')}`);
        console.log(`Overall:           ${verification.valid ? chalk.green('VERIFIED') : chalk.red('FAILED')}`);
        if (verification.result) {
          console.log(`Rows:              ${verification.result.rowsAnalyzed}`);
          console.log(`Vibration RMS:     ${verification.result.overallVibrationRms.toFixed(6)} mm/s`);
          console.log(`Verdict:           ${verification.result.verdict} (demo thresholds)`);
        }
        for (const error of verification.errors) console.log(chalk.red(`  ✗ ${error}`));
      }
      return {
        exitCode,
        message: verification.valid ? 'Telemetry source hash and deterministic replay verified.' : 'Telemetry verification failed.',
        data,
      };
    }

    const services = createServiceContainer(projectRoot);
    if (target === 'audit') {
      const verification = services.audit.verifyChain();
      let judgedRun: Record<string, unknown> | undefined;
      let judgedRunValid = true;
      if (options.runId) {
        const manifest = readJudgedRunManifest(projectRoot, options.runId);
        if (!manifest) {
          judgedRunValid = false;
          judgedRun = { runId: options.runId, valid: false, error: 'Run manifest not found.' };
        } else {
          const reportAbsPath = manifest.deliverablePath ? path.resolve(projectRoot, manifest.deliverablePath) : '';
          const exportAbsPath = manifest.auditExportPath ? path.resolve(projectRoot, manifest.auditExportPath) : '';
          const reportHash = reportAbsPath && fs.existsSync(reportAbsPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(reportAbsPath)).digest('hex')
            : undefined;
          const exportHash = exportAbsPath && fs.existsSync(exportAbsPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(exportAbsPath)).digest('hex')
            : undefined;
          const exportText = exportAbsPath && fs.existsSync(exportAbsPath) ? fs.readFileSync(exportAbsPath, 'utf8') : '';
          judgedRunValid = manifest.status === 'completed' &&
            reportHash === manifest.deliverableSha256 &&
            exportHash === manifest.auditExportSha256 &&
            exportText.includes(options.runId) && exportText.includes('JUDGED_RUN_COMPLETED');
          judgedRun = {
            runId: manifest.runId,
            status: manifest.status,
            approvalId: manifest.approvalId,
            verdict: manifest.verdict,
            valid: judgedRunValid,
            deliverablePath: manifest.deliverablePath,
            deliverableSha256: reportHash,
            auditExportPath: manifest.auditExportPath,
          };
        }
      }
      const combinedVerification = { ...verification, valid: verification.valid && judgedRunValid };
      const exitCode = combinedVerification.valid ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED;
      const data = { target: 'audit', verification: combinedVerification, judgedRun };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Audit Chain Verification\n'));
        console.log(`Chain Integrity: ${combinedVerification.valid ? chalk.green('VERIFIED') : chalk.red('BROKEN')}`);
        console.log(`Record Count:    ${verification.recordCount}`);
        console.log(`Latest Hash:     ${verification.latestHash}`);
        console.log(`Executable Hash: ${verification.executableHash}`);
        if (judgedRun) {
          console.log(`Judged Run:      ${judgedRun.runId} (${judgedRun.status})`);
          console.log(`Run Evidence:    ${judgedRun.valid ? chalk.green('VERIFIED') : chalk.red('BROKEN')}`);
          if (judgedRun.deliverablePath) console.log(`Report:          ${judgedRun.deliverablePath}`);
        }
        if (verification.errors.length > 0) {
          console.log(chalk.red('\nErrors:'));
          for (const err of verification.errors) console.log(chalk.red(`  ✗ ${err}`));
        }
      }

      return { exitCode, message: verification.valid ? 'Audit chain verified.' : 'Audit chain broken.', data };
    }

    if (target === 'boundary') {
      const status = await services.industrialFirewallRequirement.getIndustrialBoundaryStatus('default');
      const exitCode = status.verified ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED;
      const data = { target: 'boundary', status };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Sovereignty Boundary Verification\n'));
        console.log(`Overall:  ${status.verified ? chalk.green('VERIFIED') : chalk.red('BLOCKED')}`);
        console.log(`Firewall: ${status.firewallStatus}`);
        console.log(`Endpoint: ${status.endpointPolicyStatus}`);
      }

      return { exitCode, message: status.verified ? 'Boundary verified.' : 'Boundary blocked.', data };
    }

    if (target === 'service') {
      const result = services.verifier.verifyServiceIdentity('default');
      const exitCode = result.valid ? INDUSTRIAL_CLI_EXIT.SUCCESS : INDUSTRIAL_CLI_EXIT.VERIFY_FAILED;
      const data = { target: 'service', result };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold.blue('\n🔍 MAOS Industrial — Service Identity Verification\n'));
        console.log(`Valid: ${result.valid ? chalk.green('YES') : chalk.red('NO')}`);
      }

      return { exitCode, message: result.valid ? 'Service identity verified.' : 'Service identity invalid.', data };
    }

    const msg = `Unknown verify target '${target}'. Use 'audit', 'boundary', 'service', or 'telemetry'.`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
  } catch (err: any) {
    const msg = `Verification error: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.FAILURE, message: msg };
  }
}

// ── 5. Stop ────────────────────────────────────────────────────────

export interface StopCliOptions {
  readonly projectRoot?: string;
  readonly mode?: 'after-current-tasks' | 'force';
  readonly yes?: boolean;
  readonly reason?: string;
  readonly json?: boolean;
}

export async function runIndustrialStop(
  options: StopCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const services = createServiceContainer(projectRoot);
  const mode = options.mode || 'after-current-tasks';

  if (mode !== 'after-current-tasks' && mode !== 'force') {
    const msg = `Invalid stop mode '${mode}'. Supported modes: 'after-current-tasks', 'force'. Pause/resume is forbidden.`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
  }

  if (mode === 'force' && !options.yes) {
    const msg = 'CONFIRMATION_REQUIRED: Force stop mandates explicit confirmation (--yes or -y).';
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED, message: msg };
  }

  try {
    const result = services.project.stopService({
      mode,
      confirm: mode === 'force' ? true : undefined,
      reason: options.reason || 'Operator stopped industrial service via CLI',
    });

    const data: Record<string, unknown> = {
      status: result.status,
      mode: result.mode,
      interruptedTasksCount: result.interruptedTasksCount,
      cleanedTempArtifacts: result.cleanedTempArtifacts,
      timestamp: result.timestamp,
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(chalk.bold.yellow('\n🛑 MAOS Industrial — Service Stop\n'));
      console.log(`Status: ${result.status}`);
      console.log(`Mode:   ${result.mode}`);
      if (result.interruptedTasksCount !== undefined) {
        console.log(`Tasks Interrupted: ${result.interruptedTasksCount}`);
      }
      if (result.cleanedTempArtifacts !== undefined) {
        console.log(`Cleaned Temp Files: ${result.cleanedTempArtifacts}`);
      }
    }

    return {
      exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
      message: `Service stop requested: ${result.status}`,
      data,
    };
  } catch (err: any) {
    const msg = `Stop failed: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.STOP_FAILED, message: msg };
  }
}

// ── 6. Deterministic Reset ─────────────────────────────────────────

export interface ResetCliOptions {
  readonly projectRoot?: string;
  readonly allowlist?: string;
  readonly runId?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

export async function runIndustrialReset(
  options: ResetCliOptions = {},
): Promise<IndustrialCliResult> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const services = createServiceContainer(projectRoot);

  // Parse categories from allowlist
  let categories: ResetCategory[] = [...RESET_CATEGORIES];
  if (options.allowlist && options.allowlist.trim().toLowerCase() !== 'all') {
    const rawCategories = options.allowlist
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const cat of rawCategories) {
      if (!RESET_CATEGORIES.includes(cat as any)) {
        const msg = `Invalid reset category '${cat}'. Allowed categories: ${RESET_CATEGORIES.join(', ')}, or 'all'.`;
        if (!options.json) console.error(chalk.red(msg));
        return { exitCode: INDUSTRIAL_CLI_EXIT.INVALID_ARGS, message: msg };
      }
    }
    categories = rawCategories as ResetCategory[];
  }

  // Dry-run is true if explicitly requested or if confirmation is omitted
  const isDryRun = options.dryRun === true || !options.yes;

  if (!isDryRun && !options.yes) {
    const msg = 'CONFIRMATION_REQUIRED: Live reset mandates explicit confirmation (--yes or -y). Use --dry-run to preview.';
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED, message: msg };
  }

  try {
    const result = await executeDeterministicReset({
      projectRoot,
      categories,
      runId: options.runId,
      dryRun: isDryRun,
      confirmed: options.yes,
      auditService: services.audit,
    });

    const data: Record<string, unknown> = {
      dryRun: result.dryRun,
      projectRoot: result.projectRoot,
      categories: result.categories,
      runId: result.runId,
      totalFiles: result.dryRun ? result.candidateFiles.length : result.removedFiles.length,
      totalBytes: result.totalBytes,
      files: result.dryRun
        ? result.candidateFiles.map((f) => f.relativePath)
        : result.removedFiles.map((f) => f.relativePath),
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      if (result.dryRun) {
        console.log(chalk.bold.yellow('\n🔍 MAOS Industrial — Deterministic Reset (DRY-RUN)\n'));
        console.log(chalk.gray(`Project Root: ${projectRoot}`));
        console.log(chalk.gray(`Categories:   ${categories.join(', ')}`));
        if (options.runId) console.log(chalk.gray(`Run ID:       ${options.runId}`));
        console.log(`\nCandidate Files to Remove (${result.candidateFiles.length} files, ${result.totalBytes} bytes):`);
        for (const file of result.candidateFiles) {
          console.log(chalk.cyan(`  [${file.category.padEnd(12)}] ${file.relativePath} (${file.byteSize} bytes)`));
        }
        console.log(chalk.yellow('\nNo files were deleted. To perform live reset, run with --yes.'));
      } else {
        console.log(chalk.bold.green('\n🧹 MAOS Industrial — Deterministic Reset (COMPLETED)\n'));
        console.log(chalk.gray(`Project Root: ${projectRoot}`));
        console.log(chalk.gray(`Categories:   ${categories.join(', ')}`));
        console.log(`Removed ${result.removedFiles.length} generated files (${result.totalBytes} bytes).\n`);
      }
    }

    return {
      exitCode: INDUSTRIAL_CLI_EXIT.SUCCESS,
      message: result.message,
      data,
    };
  } catch (err: any) {
    const msg = `Reset failed: ${err.message}`;
    if (!options.json) console.error(chalk.red(msg));
    return { exitCode: INDUSTRIAL_CLI_EXIT.RESET_FAILED, message: msg };
  }
}

// ── 7. One-Command Judged Run ──────────────────────────────────────

export interface RunCliOptions {
  readonly projectRoot?: string;
  readonly demo?: string;
  readonly autoApprove?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly enforceFirewall?: boolean;
}

export async function runIndustrialRun(
  options: RunCliOptions = {},
): Promise<IndustrialCliResult> {
  const result = await executeJudgedRun({
    projectRoot: options.projectRoot,
    demoName: options.demo,
    autoApprove: options.autoApprove,
    yes: options.yes,
    json: options.json,
    enforceFirewall: options.enforceFirewall,
  });

  const data: Record<string, unknown> = {
    success: result.success,
    runId: result.runId,
    durationMs: result.durationMs,
    stagesCompleted: result.stagesCompleted,
    overallVerdict: result.overallVerdict,
    approvalStatus: result.approvalStatus,
    deliverablePath: result.deliverablePath,
    deliverableSha256: result.deliverableSha256,
    auditVerified: result.auditVerified,
    auditExportPath: result.auditExportPath,
    auditExportSha256: result.auditExportSha256,
    details: result.details,
  };

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  }

  return {
    exitCode: result.exitCode,
    message: result.message,
    data,
  };
}

// ── 8. Open Artifact ──────────────────────────────────────────────

export interface OpenCliOptions {
  readonly projectRoot?: string;
  readonly target: string;
  readonly launcher?: 'auto' | 'office' | 'libreoffice' | 'system';
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export async function runIndustrialOpen(
  options: OpenCliOptions,
): Promise<IndustrialCliResult> {
  const result = await openLocalArtifact({
    projectRoot: options.projectRoot,
    target: options.target,
    launcher: options.launcher,
    dryRun: options.dryRun,
  });

  const data: Record<string, unknown> = {
    success: result.success,
    target: result.target,
    resolvedRelativePath: result.resolvedRelativePath,
    resolvedAbsPath: result.resolvedAbsPath,
    artifactId: result.artifactId,
    fileExtension: result.fileExtension,
    sha256: result.sha256,
    command: result.command,
    args: result.args,
    launched: result.launched,
    dryRun: result.dryRun,
    disclaimer: result.disclaimer,
  };

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (result.success) {
      console.log(chalk.bold.green(`\n📄 ${result.message}`));
      if (result.resolvedRelativePath) console.log(chalk.gray(`Path:       ${result.resolvedRelativePath}`));
      if (result.sha256) console.log(chalk.gray(`SHA-256:    ${result.sha256}`));
      if (result.command) console.log(chalk.gray(`Command:    ${result.command} ${result.args?.join(' ')}`));
      console.log(chalk.yellow(`\nNote: ${result.disclaimer}`));
    } else {
      console.error(chalk.red(`\n❌ ${result.message}`));
    }
  }

  return {
    exitCode: result.exitCode,
    message: result.message,
    data,
  };
}
