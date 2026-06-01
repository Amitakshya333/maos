/**
 * MAOS CLI Runtime
 *
 * Spawns CLI-based AI tools (Copilot, Codex, Claude Code, etc.) in
 * visible Windows Terminal tabs and monitors their work.
 *
 * Directly inspired by the ARIOTH Fleet orchestrator:
 *   c:\lovable workflow\.agent\orchestrator\orchestrate.ps1
 *
 * Execution flow:
 *   1. Take filesystem snapshot (before)
 *   2. Write task prompt to .maos/prompts/{agentId}_task.md
 *   3. Generate launcher script (sets auth env, launches CLI)
 *   4. Open Windows Terminal tab: wt.exe new-tab --title {agentId}
 *   5. Monitor completion via lifecycle hierarchy:
 *      a. Sentinel file (.maos/agent-done-{agentId})
 *      b. Process exit detection
 *      c. Filesystem quiescence (last resort)
 *   6. Take filesystem snapshot (after), diff = filesChanged
 *   7. Return RuntimeResult
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { IRuntime, RuntimeTask, RuntimeResult, RuntimeCapabilityProfile } from './runtime';
import { MessageBus, createEvent } from '../core/message-bus';

// ---- Interactive Mode Detection ----
// Patterns that indicate a CLI entered REPL/interactive mode instead of autonomous execution.
// We make these specific (requiring trailing prompt-like symbols/structure) to avoid false-positives
// in natural conversation/logs.
const INTERACTIVE_PATTERNS = [
  /^\s*>\s*$/m,                            // bare '>' prompt
  /^\s*\$\s*$/m,                            // bare '$' prompt
  /^\s*>>>\s*$/m,                           // Python REPL
  /press\s+enter\s+to/i,                    // press enter to ...
  /\(y\/n\)\s*$/mi,                         // ends with (y/n)
  /\[Y\/n\]\s*$/mi,                         // ends with [Y/n]
  /\bconfirm\b\s*[:?]\s*$/mi,                // confirm prompt (e.g. "confirm:")
  /\b(?:log\s*in|sign\s*in|username|email)\b\s*[:?]\s*$/mi, // login / username prompt
  /\bauthenticate\b\s*[:?]\s*$/mi,           // authenticate prompt
  /\benter\b\s+(?:auth\s+)?token\b\s*[:?]\s*$/mi, // token prompt
  /\bpassword\b\s*:\s*$/mi,                 // password: prompt
];

/** Check if output indicates interactive/REPL mode */
function detectInteractiveMode(output: string): string | null {
  // Prompts are always at the end of the output stream (last 200 characters)
  const checkText = output.substring(Math.max(0, output.length - 200));
  for (const pattern of INTERACTIVE_PATTERNS) {
    const match = checkText.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  return null;
}

/** Get last N lines of text */
function lastLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

// ---- CLI Profiles ----
// Maps CLI names to their invocation patterns + auth env vars.
// Users can also define custom CLIs in config.

interface CliProfile {
  command: string;
  buildArgs: (promptFile: string) => string[];
  buildLauncherCommand: (promptFile: string, cliArgsStr: string) => string;
  authEnvKey?: string;
}

const CLI_PROFILES: Record<string, CliProfile> = {
  copilot: {
    command: 'copilot',
    buildArgs: (promptFile) => ['-p', fs.readFileSync(promptFile, 'utf-8'), '--yolo', '--no-ask-user'],
    buildLauncherCommand: (promptFile, cliArgsStr) => `copilot -p (Get-Content -Raw "${promptFile.replace(/\\/g, '\\\\')}") --yolo --no-ask-user${cliArgsStr}`,
    authEnvKey: 'COPILOT_HOME',
  },
  codex: {
    command: 'codex',
    buildArgs: (promptFile) => ['exec', fs.readFileSync(promptFile, 'utf-8'), '--dangerously-bypass-approvals-and-sandbox'],
    buildLauncherCommand: (promptFile, cliArgsStr) => `codex exec (Get-Content -Raw "${promptFile.replace(/\\/g, '\\\\')}") --dangerously-bypass-approvals-and-sandbox${cliArgsStr}`,
    authEnvKey: 'CODEX_HOME',
  },
  opencode: {
    command: 'opencode',
    buildArgs: (promptFile) => ['run', fs.readFileSync(promptFile, 'utf-8'), '--dangerously-skip-permissions'],
    buildLauncherCommand: (promptFile, cliArgsStr) => `opencode run (Get-Content -Raw "${promptFile.replace(/\\/g, '\\\\')}") --dangerously-skip-permissions${cliArgsStr}`,
    authEnvKey: 'OPENCODE_HOME',
  },
  claude: {
    command: 'claude',
    buildArgs: (promptFile) => ['-p', fs.readFileSync(promptFile, 'utf-8'), '--dangerously-skip-permissions'],
    buildLauncherCommand: (promptFile, cliArgsStr) => `claude -p (Get-Content -Raw "${promptFile.replace(/\\/g, '\\\\')}") --dangerously-skip-permissions${cliArgsStr}`,
    authEnvKey: 'CLAUDE_CONFIG_DIR',
  },
  antigravity: {
    command: 'antigravity',
    buildArgs: (promptFile) => ['--prompt-file', promptFile],
    buildLauncherCommand: (promptFile, cliArgsStr) => `antigravity --prompt-file "${promptFile.replace(/\\/g, '\\\\')}"${cliArgsStr}`,
    authEnvKey: undefined,
  },
};

// ---- Config ----

export interface CliRuntimeConfig {
  /** CLI command name (copilot, codex, claude, or custom) */
  cliCommand: string;

  /** Additional CLI arguments */
  cliArgs: string[];

  /** Auth env vars in native format (e.g., { COPILOT_HOME: ".maos/auth/AGENT" }) */
  authEnv: Record<string, string>;

  /** Kill the CLI after this many ms (default: 300000 = 5 min) */
  timeoutMs: number;

  /** Consider "done" after no file changes for this many ms (default: 30000 = 30s) */
  quiescenceMs: number;

  /** Agent role for the prompt */
  role: string;

  /** Agent capabilities for the prompt */
  capabilities: string[];
}

// ---- Helpers ----

/**
 * Convert a taskId into a filesystem-safe slug.
 * Task IDs contain characters that are invalid on Windows filenames
 * (colons in ISO timestamps, slashes, etc.).
 *
 * Examples:
 *   AUTO__1780063937339  →  AUTO__1780063937339   (already safe)
 *   task:2024-01-01T00:00:00Z  →  task_2024-01-01T00_00_00Z
 */
function sanitizeForFilename(id: string): string {
  return id
    .replace(/[:\\/<>|?*]/g, '_')  // Windows-invalid chars → underscore
    .replace(/\.{2,}/g, '_')       // double dots → underscore
    .slice(0, 80);                 // max 80 chars to stay well under path limits
}

// ---- CLI Runtime ----

export class CliRuntime implements IRuntime {
  readonly type = 'cli' as const;
  readonly name: string;
  readonly model: string;
  private childProcess: child_process.ChildProcess | null = null;

  constructor(
    private config: CliRuntimeConfig,
    private bus: MessageBus,
  ) {
    this.name = `${config.cliCommand}-cli`;
    this.model = config.cliCommand;
  }

  async execute(task: RuntimeTask): Promise<RuntimeResult> {
    // Platform guard: CLI runtimes use Windows Terminal (wt.exe) + PowerShell launcher
    if (process.platform !== 'win32') {
      throw new Error(
        `CLI runtime '${this.config.cliCommand}' requires Windows (PowerShell + Windows Terminal). ` +
        `API runtimes (OpenAI, Anthropic, Gemini) work cross-platform. ` +
        `Set runtime: "api" in your agent config for cross-platform use.`
      );
    }

    // Validate agent ID, CLI command name, and CLI arguments to prevent command/shell injection attacks
    if (!/^[a-zA-Z0-9_-]+$/.test(task.agentId)) {
      throw new Error(`Security Violation: Invalid agent ID '${task.agentId}'. Agent IDs must only contain alphanumeric characters, underscores, and dashes.`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(this.config.cliCommand)) {
      throw new Error(`Security Violation: Invalid CLI command '${this.config.cliCommand}'. CLI commands must only contain alphanumeric characters, underscores, and dashes.`);
    }
    for (const arg of this.config.cliArgs) {
      if (/[\;&\|`\$\(\)]/.test(arg)) {
        throw new Error(`Security Violation: Dangerous characters detected in CLI argument '${arg}'`);
      }
    }

    const startTime = Date.now();
    const maosDir = path.join(task.projectRoot, '.maos');
    const promptsDir = path.join(maosDir, 'prompts');
    const launchersDir = path.join(maosDir, 'launchers');
    const authDir = path.join(maosDir, 'auth', task.agentId);

    // Ensure directories exist
    const logsDir = path.join(maosDir, 'logs');
    const archiveDir = path.join(logsDir, 'archive');
    for (const dir of [promptsDir, launchersDir, authDir, logsDir, archiveDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // ── Task-scoped log files ───────────────────────────────────────────────
    // Files are keyed by taskId+agentId so each execution (including retries,
    // crash-recovery, and parallel dispatch) gets its own handles — no Windows
    // file-lock contention across overlapping executions of the same agent.
    const taskSlug = sanitizeForFilename(task.id);
    const fileBase = `${taskSlug}_${task.agentId}`;
    const cliLogFile  = path.join(logsDir, `${fileBase}_cli.log`);
    const stdoutFile  = path.join(logsDir, `${fileBase}_stdout.log`);
    const stderrFile  = path.join(logsDir, `${fileBase}_stderr.log`);
    const exitFile    = path.join(logsDir, `${fileBase}_exit.txt`);
    // Liveness file: launcher writes a timestamp every 5s while alive.
    // If this file goes stale (>15s), the launcher process was killed abruptly.
    const livenessFile = path.join(logsDir, `${fileBase}_liveness.txt`);

    // Clear any stale files from a previous attempt of the same task-agent pair.
    // Because the filename is task-scoped a running execution of a *different*
    // task on the same agent will have a different name → no lock collision.
    const clearFile = (filePath: string) => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        try {
          fs.writeFileSync(filePath, '', 'utf-8');
        } catch {
          // ignore residual lock issues on the exact same task retry
        }
      }
    };
    clearFile(cliLogFile);
    clearFile(stdoutFile);
    clearFile(stderrFile);
    clearFile(exitFile);
    clearFile(livenessFile);

    const delayMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const writeFileWithRetry = async (filePath: string, content: string, retries = 5, delay = 200) => {
      for (let i = 0; i < retries; i++) {
        try {
          fs.writeFileSync(filePath, content, 'utf-8');
          return;
        } catch (err) {
          if (i === retries - 1) throw err;
          await delayMs(delay);
        }
      }
    };

    // 1. Take filesystem snapshot (before)
    const beforeSnapshot = this.snapshotFiles(task.projectRoot, task.scope);

    // 2. Write task prompt file
    const promptFile = path.join(promptsDir, `${task.agentId}_task.md`);
    const prompt = this.buildPrompt(task);
    await writeFileWithRetry(promptFile, prompt);

    // 3. Resolve auth env vars to absolute paths
    const resolvedAuth: Record<string, string> = {};
    for (const [key, val] of Object.entries(this.config.authEnv)) {
      resolvedAuth[key] = path.isAbsolute(val)
        ? val
        : path.resolve(task.projectRoot, val);
      // Ensure auth dir exists
      if (!fs.existsSync(resolvedAuth[key])) {
        fs.mkdirSync(resolvedAuth[key], { recursive: true });
      }
    }

    // 4. Generate launcher script
    // Launcher is also task-scoped so a retry never clobbers an active launcher
    // that may still be referenced by a lingering PowerShell process.
    const launcherFile = path.join(launchersDir, `${fileBase}_launcher.ps1`);
    const launcherContent = this.buildLauncher(task, promptFile, resolvedAuth, stdoutFile, stderrFile, exitFile, livenessFile);
    await writeFileWithRetry(launcherFile, launcherContent);

    // 5. Open Windows Terminal tab securely using spawnSync (no shell evaluation)
    try {
      const wtArgs = [
        'new-tab',
        '--title', task.agentId,
        '--',
        'pwsh.exe',
        '-NoProfile',
        '-NoExit',
        '-File', launcherFile
      ];
      const spawnResult = child_process.spawnSync('wt.exe', wtArgs, {
        cwd: task.projectRoot,
        stdio: 'ignore',
        windowsHide: false,
      });

      if (spawnResult.error) {
        throw spawnResult.error;
      }

      this.bus.emit(createEvent('TASK_PROGRESS', task.agentId, {
        action: 'terminal-tab-opened',
        cli: this.config.cliCommand,
      }, task.id, 'cli'));
    } catch (err: any) {
      // WT not available — fall back to spawning a hidden process
      return this.executeFallback(task, promptFile, resolvedAuth, beforeSnapshot, startTime, cliLogFile, stdoutFile, stderrFile);
    }

    // 6. Monitor completion via lifecycle hierarchy
    const result = await this.monitorCompletion(
      task,
      exitFile,
      livenessFile,
      beforeSnapshot,
      startTime,
      stdoutFile,
      stderrFile,
    );

    // 7. Archive task logs (non-blocking) so the logs/ dir doesn't fill up.
    // Logs are moved to logs/archive/ and kept for 7 days before deletion.
    setImmediate(() => {
      this.archiveTaskLogs(
        [cliLogFile, stdoutFile, stderrFile, exitFile, livenessFile, launcherFile],
        archiveDir,
      );
    });

    return result;
  }

  /**
   * Fallback: if Windows Terminal is not available, spawn the CLI as a
   * direct child process. Less visual, but works everywhere.
   */
  private async executeFallback(
    task: RuntimeTask,
    promptFile: string,
    resolvedAuth: Record<string, string>,
    beforeSnapshot: Map<string, number>,
    startTime: number,
    cliLogFile: string,
    stdoutFile: string,
    stderrFile: string,
  ): Promise<RuntimeResult> {
    const profile = CLI_PROFILES[this.config.cliCommand];
    const command = profile?.command || this.config.cliCommand;
    const args = [
      ...(profile?.buildArgs(promptFile) || [promptFile]),
      ...this.config.cliArgs,
    ];

    return new Promise((resolve) => {
      const child = child_process.spawn(command, args, {
        cwd: task.projectRoot,
        env: { ...process.env, ...resolvedAuth },
        stdio: 'pipe',
        shell: true,
      });

      this.childProcess = child;
      let output = '';
      let lastOutputTime = Date.now();
      let interactiveDetected = false;
      let interactivePattern = '';

      // Write log file header
      const logHeader = `[MAOS CLI LOG] Agent: ${task.agentId} | CLI: ${this.config.cliCommand} | Started: ${new Date().toISOString()}\n${'='.repeat(80)}\n`;
      fs.writeFileSync(cliLogFile, logHeader, 'utf-8');

      const appendLog = (data: string) => {
        try { fs.appendFileSync(cliLogFile, data, 'utf-8'); } catch { /* ignore */ }
      };

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        lastOutputTime = Date.now();
        try { fs.appendFileSync(stdoutFile, chunk, 'utf-8'); } catch {}
        try { fs.appendFileSync(cliLogFile, `[stdout] ${chunk}`, 'utf-8'); } catch {}

        // Check for interactive mode patterns
        if (!interactiveDetected) {
          const match = detectInteractiveMode(output);
          if (match) {
            interactiveDetected = true;
            interactivePattern = match;
          }
        }
      });
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        lastOutputTime = Date.now();
        try { fs.appendFileSync(stderrFile, chunk, 'utf-8'); } catch {}
        try { fs.appendFileSync(cliLogFile, `[stderr] ${chunk}`, 'utf-8'); } catch {}
      });

      // ---- Interactive Mode Detection (first 15 seconds) ----
      const interactiveCheckTimer = setTimeout(() => {
        // Check 1: No output at all — CLI is stuck waiting for input
        if (output.trim().length === 0) {
          child.kill('SIGTERM');
          this.childProcess = null;

          const msg = [
            `CLI entered interactive shell instead of autonomous execution mode.`,
            `Possible causes:`,
            `  - missing --prompt flag`,
            `  - auth incomplete (run: maos login --cli ${this.config.cliCommand})`,
            `  - unsupported runtime mode`,
            `No output received in first 15 seconds.`,
          ].join('\n');
          appendLog(`\n[MAOS] INTERACTIVE MODE DETECTED: ${msg}\n`);

          this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
            reason: 'interactive-mode',
            cli: this.config.cliCommand,
            taskResult: 'failed',
          }, task.id, 'cli'));

          resolve({
            success: false,
            summary: msg,
            filesChanged: [],
            iterations: 0,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: Date.now() - startTime,
            runtimeType: 'cli',
            error: msg,
            taskResult: 'failed',
            exitCode: 1,
          });
          return;
        }

        // Check 2: Interactive prompt pattern detected
        if (interactiveDetected) {
          child.kill('SIGTERM');
          this.childProcess = null;

          const lastOut = lastLines(output, 5);
          const msg = [
            `CLI entered interactive shell instead of autonomous execution mode.`,
            `Detected interactive pattern: "${interactivePattern}"`,
            `Possible causes:`,
            `  - missing --prompt flag`,
            `  - auth incomplete (run: maos login --cli ${this.config.cliCommand})`,
            `  - unsupported runtime mode`,
            `Last output:`,
            lastOut,
          ].join('\n');
          appendLog(`\n[MAOS] INTERACTIVE MODE DETECTED: ${msg}\n`);

          this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
            reason: 'interactive-mode',
            pattern: interactivePattern,
            taskResult: 'failed',
          }, task.id, 'cli'));

          resolve({
            success: false,
            summary: msg,
            filesChanged: [],
            iterations: 0,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: Date.now() - startTime,
            runtimeType: 'cli',
            error: msg,
            taskResult: 'failed',
            exitCode: 1,
          });
          return;
        }
      }, 15_000);

      // Timeout
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        const lastOut = lastLines(output, 20);
        appendLog(`\n[MAOS] TIMEOUT after ${this.config.timeoutMs}ms\n`);

        this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
          reason: 'timeout',
          timeoutMs: this.config.timeoutMs,
          lastOutput: lastOut.substring(0, 200),
          taskResult: 'failed',
        }, task.id, 'cli'));
      }, this.config.timeoutMs);

      child.on('exit', (code) => {
        clearTimeout(timer);
        clearTimeout(interactiveCheckTimer);
        this.childProcess = null;

        appendLog(`\n[MAOS] Process exited with code: ${code}\n`);

        const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
        const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);
        const success = code === 0;

        let taskResult: 'success' | 'partial_success' | 'failed' | 'no_mutation' = 'success';
        if (code !== 0) {
          taskResult = 'failed';
        } else if (filesChanged.length === 0) {
          taskResult = 'no_mutation';
        }

        this.bus.emit(createEvent(
          success ? 'TASK_COMPLETED' : 'TASK_FAILED',
          task.agentId,
          { exitCode: code, filesChanged: filesChanged.length, taskResult },
          task.id, 'cli',
        ));

        resolve({
          success,
          summary: success
            ? `CLI agent (${this.config.cliCommand}) completed. ${filesChanged.length} files changed.`
            : `CLI agent (${this.config.cliCommand}) failed with exit code ${code}.\nLast output:\n${lastLines(output, 20)}`,
          filesChanged,
          iterations: 1,
          totalTokens: 0,
          costUSD: 0,
          latencyMs: Date.now() - startTime,
          runtimeType: 'cli',
          error: success ? undefined : `CLI agent failed with exit code ${code}.\nOutput:\n${output}`,
          taskResult,
          exitCode: code !== null ? code : 1,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(interactiveCheckTimer);
        this.childProcess = null;

        appendLog(`\n[MAOS] Process error: ${err.message}\n`);

        this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
          error: err.message,
          taskResult: 'failed',
        }, task.id, 'cli'));

        resolve({
          success: false,
          summary: `CLI agent failed to start: ${err.message}`,
          filesChanged: [],
          iterations: 0,
          totalTokens: 0,
          costUSD: 0,
          latencyMs: Date.now() - startTime,
          runtimeType: 'cli',
          error: err.message,
          taskResult: 'failed',
          exitCode: 1,
        });
      });
    });
  }

  /**
   * Monitor a visible WT tab agent for completion.
   *
   * Lifecycle hierarchy (in priority order):
   *   1. exit.txt written by launcher  →  graceful exit (success or failure)
   *   2. Liveness file stale (>15s)    →  launcher killed abruptly → RUNTIME_CRASHED
   *   3. Interactive-mode detection    →  stuck waiting for input → TASK_FAILED
   *   4. Filesystem quiescence         →  files settled (only if liveness still fresh)
   *   5. Timeout                       →  hard stop with diagnostics
   *
   * The liveness file is written by the PS1 launcher every 5s while it is
   * alive.  When the WT tab is force-closed, the PowerShell process dies
   * instantly and the liveness file stops being updated.  After 15s of
   * staleness (3× the write interval, resilient to I/O hiccups) the monitor
   * concludes the launcher was killed.
   */
  private async monitorCompletion(
    task: RuntimeTask,
    exitFile: string,
    livenessFile: string,
    beforeSnapshot: Map<string, number>,
    startTime: number,
    stdoutFile: string,
    stderrFile: string,
  ): Promise<RuntimeResult> {
    const pollInterval = 3000;  // Check every 3 seconds
    // Liveness staleness window: 15s = 3× the 5s write cadence in the PS1.
    // After a force-close the file goes stale; we detect it within one poll cycle.
    const livenessStaleMs = 15_000;
    // Delay before we start enforcing liveness checks, to allow the launcher
    // to start up and write its first heartbeat (allow 20s for slow machines).
    const livenessGracePeriodMs = 20_000;
    let lastChangeTime = Date.now();
    let lastSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
    let quiescentCount = 0;
    const quiescentThreshold = Math.ceil(this.config.quiescenceMs / pollInterval);
    // Track whether liveness file ever appeared (it may not on very old launchers)
    let livenessEverSeen = false;

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime;

        // ── 0. Liveness check — detect abrupt launcher termination ────────────
        // Only enforce after the grace period so the launcher has time to start.
        if (elapsed > livenessGracePeriodMs) {
          try {
            if (fs.existsSync(livenessFile)) {
              livenessEverSeen = true;
              const stat = fs.statSync(livenessFile);
              const livenessAge = Date.now() - stat.mtimeMs;
              if (livenessAge > livenessStaleMs) {
                // Liveness file went stale — launcher was killed abruptly.
                clearInterval(timer);

                const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
                const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);

                const crashMsg = [
                  `RUNTIME_CRASHED: Launcher liveness heartbeat went stale after ${Math.round(livenessAge / 1000)}s.`,
                  `The Windows Terminal tab was likely force-closed or the process was killed (SIGKILL/OOM).`,
                  `exitType: forced_termination`,
                  `filesChangedBeforeCrash: ${filesChanged.length}`,
                ].join('\n');

                // Emit RUNTIME_CRASHED so HealthMonitor immediately sets DEAD
                this.bus.emit(createEvent(
                  'RUNTIME_CRASHED' as any,
                  task.agentId,
                  {
                    exitType: 'forced_termination',
                    livenessStaleMs: livenessAge,
                    filesChangedBeforeCrash: filesChanged.length,
                    taskId: task.id,
                  },
                  task.id, 'cli',
                ));

                // Also emit TASK_FAILED for queue / telemetry
                this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
                  reason: 'runtime_crashed',
                  exitType: 'forced_termination',
                  filesChanged: filesChanged.length,
                  taskResult: 'failed',
                }, task.id, 'cli'));

                resolve({
                  success: false,
                  summary: crashMsg,
                  filesChanged,
                  iterations: 1,
                  totalTokens: 0,
                  costUSD: 0,
                  latencyMs: elapsed,
                  runtimeType: 'cli',
                  error: crashMsg,
                  taskResult: 'failed',
                  exitCode: -1,
                });
                return;
              }
            } else if (livenessEverSeen) {
              // Liveness file disappeared after being present — treat as crash.
              clearInterval(timer);

              const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
              const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);

              const crashMsg = [
                `RUNTIME_CRASHED: Launcher liveness file disappeared unexpectedly.`,
                `exitType: forced_termination`,
              ].join('\n');

              this.bus.emit(createEvent(
                'RUNTIME_CRASHED' as any,
                task.agentId,
                { exitType: 'forced_termination', livenessDisappeared: true, taskId: task.id },
                task.id, 'cli',
              ));
              this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
                reason: 'runtime_crashed',
                exitType: 'forced_termination',
                filesChanged: filesChanged.length,
                taskResult: 'failed',
              }, task.id, 'cli'));

              resolve({
                success: false,
                summary: crashMsg,
                filesChanged,
                iterations: 1,
                totalTokens: 0,
                costUSD: 0,
                latencyMs: elapsed,
                runtimeType: 'cli',
                error: crashMsg,
                taskResult: 'failed',
                exitCode: -1,
              });
              return;
            }
          } catch { /* I/O error reading liveness file — non-fatal, continue */ }
        } else {
          // Within grace period — track if liveness file appears
          try {
            if (fs.existsSync(livenessFile)) livenessEverSeen = true;
          } catch { /* ignore */ }
        }

        // ── 1. Check exit file FIRST (launcher completed gracefully) ──────
        // Priority: exit file is checked before interactive mode detection
        // to prevent false positives when the agent has already completed
        // (stdout log may contain prompt-like text from final output).
        if (fs.existsSync(exitFile)) {
          clearInterval(timer);
          let exitCode = 0;
          try {
            const content = fs.readFileSync(exitFile, 'utf-8').trim();
            exitCode = parseInt(content, 10);
            if (isNaN(exitCode)) exitCode = 0;
          } catch {
            exitCode = 0;
          }

          const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
          const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);
          const success = exitCode === 0;

          let taskResult: 'success' | 'partial_success' | 'failed' | 'no_mutation' = 'success';
          if (!success) {
            taskResult = 'failed';
          } else if (filesChanged.length === 0) {
            taskResult = 'no_mutation';
          }

          // (no early return here — fall through to the resolve below)

          const summary = success
            ? `CLI agent completed gracefully. ${filesChanged.length} files changed.`
            : `CLI agent failed with exit code ${exitCode}.`;

          let errorMsg: string | undefined = undefined;
          if (!success) {
            errorMsg = `CLI agent execution failed with exit code ${exitCode}`;
            try {
              if (fs.existsSync(stderrFile)) {
                const stderrContent = fs.readFileSync(stderrFile, 'utf-8').trim();
                if (stderrContent) errorMsg += `\nStderr:\n${stderrContent}`;
              }
            } catch {}
          }

          if (success) {
            this.bus.emit(createEvent('TASK_COMPLETED', task.agentId, {
              method: 'exit-file',
              filesChanged: filesChanged.length,
              taskResult,
              exitCode,
              exitType: 'graceful_exit',
            }, task.id, 'cli'));
          } else {
            this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
              method: 'exit-file',
              error: errorMsg,
              filesChanged: filesChanged.length,
              taskResult,
              exitCode,
              exitType: 'graceful_exit',  // exited via launcher — graceful (just non-zero)
            }, task.id, 'cli'));
          }

          resolve({
            success,
            summary,
            filesChanged,
            iterations: 1,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: elapsed,
            runtimeType: 'cli',
            taskResult,
            exitCode,
            error: success ? undefined : errorMsg,
          });
          return;
        }

        // ── 2. Check stdout file for activity (extends quiescence awareness) ──
        let logFileActive = false;
        try {
          if (fs.existsSync(stdoutFile)) {
            const stat = fs.statSync(stdoutFile);
            const logAge = Date.now() - stat.mtimeMs;
            if (logAge < pollInterval * 2) {
              logFileActive = true;
            }
          }
        } catch { /* ignore */ }

        // ── 3. Interactive Mode Detection ──────────────────────────────────
        // Only checked here (after exit file) so a completed agent whose
        // stdout contained a bare `>` or `(y/n)` is never falsely failed.
        let interactiveDetected = false;
        let interactivePattern = '';
        try {
          if (fs.existsSync(stdoutFile)) {
            const content = fs.readFileSync(stdoutFile, 'utf-8');
            const match = detectInteractiveMode(content);
            if (match) {
              interactiveDetected = true;
              interactivePattern = match;
            }
          }
        } catch { /* ignore */ }

        if (interactiveDetected) {
          clearInterval(timer);
          const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
          const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);

          this.bus.emit(createEvent('AGENT_PHASE', task.agentId, {
            phase: 'WAITING_FOR_USER_INPUT',
            reason: 'interactive-mode',
            cli: this.config.cliCommand,
          }, task.id, 'cli'));

          const lastOut = lastLines(fs.existsSync(stdoutFile) ? fs.readFileSync(stdoutFile, 'utf-8') : '', 5);
          const errorMsg = `INTERACTIVE_MODE_DETECTED: Pattern '${interactivePattern}' found in CLI output. Agent may be stuck.\nLast output:\n${lastOut}`;

          this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
            reason: 'interactive-mode',
            pattern: interactivePattern,
            taskResult: 'failed',
          }, task.id, 'cli'));

          resolve({
            success: false,
            summary: errorMsg,
            filesChanged,
            iterations: 1,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: elapsed,
            runtimeType: 'cli',
            error: errorMsg,
            taskResult: 'failed',
            exitCode: 1,
          });
          return;
        }

        // ── 4. Filesystem quiescence ──────────────────────────────────────
        // IMPORTANT: Only resolve quiescence as SUCCESS if the liveness file
        // is still fresh (launcher is still alive). If liveness is not
        // enforced yet (within grace period), allow quiescence to proceed.
        const currentSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
        const changed = this.diffSnapshots(lastSnapshot, currentSnapshot);

        if (changed.length > 0 || logFileActive) {
          quiescentCount = 0;
          lastChangeTime = Date.now();
          lastSnapshot = currentSnapshot;

          this.bus.emit(createEvent('TASK_PROGRESS', task.agentId, {
            filesModified: changed.length,
            logFileActive,
            elapsed,
          }, task.id, 'cli'));
        } else {
          quiescentCount++;

          const totalFilesChanged = this.diffSnapshots(beforeSnapshot, currentSnapshot);
          if (quiescentCount >= quiescentThreshold) {
            // Final liveness check before declaring quiescence success.
            // If liveness is enforced and file is stale → crash takes priority.
            let livenessOk = true;
            if (elapsed > livenessGracePeriodMs && livenessEverSeen) {
              try {
                if (fs.existsSync(livenessFile)) {
                  const stat = fs.statSync(livenessFile);
                  if (Date.now() - stat.mtimeMs > livenessStaleMs) {
                    livenessOk = false;
                  }
                } else {
                  livenessOk = false;
                }
              } catch { /* I/O error — be conservative, allow quiescence */ }
            }

            if (!livenessOk) {
              // Liveness stale at quiescence threshold — crash takes priority,
              // the liveness-stale branch above will handle it on next tick.
              // Just skip this quiescence resolution.
            } else {
              clearInterval(timer);

              this.bus.emit(createEvent('TASK_COMPLETED', task.agentId, {
                method: 'quiescence',
                quiescentMs: quiescentCount * pollInterval,
                filesChanged: totalFilesChanged.length,
                taskResult: 'success',
                exitType: 'graceful_exit',
              }, task.id, 'cli'));

              resolve({
                success: true,
                summary: `CLI agent (${this.config.cliCommand}) completed via quiescence. ${totalFilesChanged.length} files changed.`,
                filesChanged: totalFilesChanged,
                iterations: 1,
                totalTokens: 0,
                costUSD: 0,
                latencyMs: elapsed,
                runtimeType: 'cli',
                taskResult: 'success',
                exitCode: 0,
              });
              return;
            }
          }
        }

        // ── 5. Timeout — hard stop with diagnostics ────────────────────────
        if (elapsed >= this.config.timeoutMs) {
          clearInterval(timer);
          const afterSnapshot = this.snapshotFiles(task.projectRoot, task.scope);
          const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);
          const madeProgress = filesChanged.length > 0;
          const taskResult = madeProgress ? 'partial_success' : 'failed';

          let lastOutput = '';
          try {
            if (fs.existsSync(stdoutFile)) {
              const logContent = fs.readFileSync(stdoutFile, 'utf-8');
              lastOutput = lastLines(logContent, 20);
            }
          } catch { /* ignore */ }

          const timeoutDetail = lastOutput
            ? `\nLast CLI output:\n${lastOutput}`
            : '\nNo CLI output captured.';

          this.bus.emit(createEvent(
            madeProgress ? 'TASK_COMPLETED' : 'TASK_FAILED',
            task.agentId,
            {
              method: 'timeout',
              filesChanged: filesChanged.length,
              lastOutput: lastOutput.substring(0, 200),
              taskResult,
              exitType: 'timeout_kill',
            },
            task.id, 'cli',
          ));

          resolve({
            success: madeProgress,
            summary: madeProgress
              ? `CLI agent timed out but modified ${filesChanged.length} files. Partial success.`
              : `CLI agent timed out with no file changes.${timeoutDetail}`,
            filesChanged,
            iterations: 1,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: elapsed,
            runtimeType: 'cli',
            error: madeProgress ? undefined : `TIMEOUT${timeoutDetail}`,
            taskResult,
            exitCode: 1,
          });
          return;
        }

        // Heartbeat
        this.bus.emit(createEvent('HEARTBEAT', task.agentId, {
          elapsed,
          quiescentCount,
          logFileActive,
          livenessEverSeen,
          cli: this.config.cliCommand,
        }, task.id, 'cli'));

      }, pollInterval);
    });
  }

  /**
   * Build the prompt text for the CLI agent.
   */
  private buildPrompt(task: RuntimeTask): string {
    return `You are ${task.agentId}, a ${this.config.role} agent.

## Task
${task.description}

## Scope
You may ONLY modify files in: [${task.scope.join(', ')}]
Project root: ${task.projectRoot}
Git branch: ${task.branch}

## Rules
1. Read existing code first to understand the project.
2. Follow existing patterns and conventions.
3. Write clean, production-quality code.
4. Commit your work with a descriptive message.
5. When finished, create the file: .maos/agent-done-${task.agentId}
   with a brief summary of what you accomplished.

## Capabilities
${this.config.capabilities.join(', ')}
`;
  }

  private buildLauncher(
    task: RuntimeTask,
    promptFile: string,
    resolvedAuth: Record<string, string>,
    stdoutFile: string,
    stderrFile: string,
    exitFile: string,
    livenessFile: string,
  ): string {
    const profile = CLI_PROFILES[this.config.cliCommand];
    const command = profile?.command || this.config.cliCommand;
    const timestamp = new Date().toISOString();

    // Build auth env var lines (escaped safely as double-quoted PowerShell string literals)
    const authLines = Object.entries(resolvedAuth)
      .map(([key, val]) => `$env:${key} = "${val.replace(/`/g, '``').replace(/"/g, '`"')}"`)
      .join('\n');

    // Build the PowerShell arguments array dynamically to use native splatting.
    // This is 100% immune to command injection.
    const promptFileEscaped = promptFile.replace(/\\/g, '\\\\');
    
    let baseArgsPs: string[] = [];
    if (this.config.cliCommand === 'copilot') {
      baseArgsPs = ['"-p"', '$taskText', '"--yolo"', '"--no-ask-user"'];
    } else if (this.config.cliCommand === 'codex') {
      baseArgsPs = ['"exec"', '$taskText', '"--dangerously-bypass-approvals-and-sandbox"'];
    } else if (this.config.cliCommand === 'opencode') {
      baseArgsPs = ['"run"', '$taskText', '"--dangerously-skip-permissions"'];
    } else if (this.config.cliCommand === 'claude') {
      baseArgsPs = ['"-p"', '$taskText', '"--dangerously-skip-permissions"'];
    } else if (this.config.cliCommand === 'antigravity') {
      baseArgsPs = ['"--prompt-file"', `"${promptFileEscaped}"`];
    } else {
      // Default fallback
      baseArgsPs = ['"-p"', '$taskText', '"--yolo"', '"--no-ask-user"'];
    }

    // Escape user arguments safely for PowerShell double-quoted string literals
    const userArgsPs = this.config.cliArgs.map(arg => {
      const escaped = arg
        .replace(/`/g, '``')
        .replace(/"/g, '`"');
      return `"${escaped}"`;
    });

    const allArgsPs = [...baseArgsPs, ...userArgsPs].join(', ');

    const livenessFileEscaped = livenessFile.replace(/\\/g, '\\\\');
    const stdoutFileEscaped  = stdoutFile.replace(/\\/g, '\\\\');
    const stderrFileEscaped  = stderrFile.replace(/\\/g, '\\\\');
    const exitFileEscaped    = exitFile.replace(/\\/g, '\\\\');

    return `# Auto-generated MAOS launcher for ${task.agentId} at ${timestamp}
# Runtime: ${this.config.cliCommand}-cli | Task: ${task.id}
# Do NOT edit manually - regenerated on each dispatch.

Set-Location "${task.projectRoot.replace(/`/g, '``').replace(/"/g, '`"')}"

# ── Set isolated auth credentials ──
${authLines}

Write-Host ''
Write-Host '  +==========================================+' -ForegroundColor Cyan
Write-Host '  |  MAOS AGENT: ${task.agentId.padEnd(28)}|' -ForegroundColor Cyan
Write-Host '  |  Runtime: ${(this.config.cliCommand + '-cli').padEnd(29)}|' -ForegroundColor Cyan
Write-Host '  +==========================================+' -ForegroundColor Cyan
Write-Host ''
Write-Host "  Working Dir : ${task.projectRoot}" -ForegroundColor DarkGray
Write-Host "  Task ID     : ${task.id}" -ForegroundColor DarkGray
Write-Host "  Branch      : ${task.branch}" -ForegroundColor DarkGray
${Object.entries(resolvedAuth).map(([k, v]) => `Write-Host "  ${k}: ${v}" -ForegroundColor DarkGray`).join('\n')}
Write-Host ''

# ── Display task ──
Write-Host '  -- TASK --' -ForegroundColor Yellow
Get-Content "${promptFileEscaped}" | ForEach-Object { Write-Host "  $\_" -ForegroundColor DarkYellow }
Write-Host ''

# ── Liveness heartbeat (background job) ────────────────────────────
# This job writes a timestamp every 5s while the launcher is alive.
# The MAOS orchestrator watches this file; if it goes stale (>15s),
# it classifies the runtime as RUNTIME_CRASHED (forced termination).
$livenessPath = "${livenessFileEscaped}"
$livenessJob = Start-Job -ScriptBlock {
  param($p)
  while ($true) {
    try { [DateTime]::UtcNow.ToString('o') | Out-File -FilePath $p -Encoding ASCII -Force } catch {}
    Start-Sleep -Seconds 5
  }
} -ArgumentList $livenessPath

# Write initial liveness immediately
try { [DateTime]::UtcNow.ToString('o') | Out-File -FilePath $livenessPath -Encoding ASCII -Force } catch {}

# ── Launch CLI safely with native argument splatting ──
$taskText = Get-Content -Raw "${promptFileEscaped}"
$cliArgs = @(${allArgsPs})

# Start PowerShell transcript to capture stdout/stderr natively without breaking TTY
Start-Transcript -Path "${stdoutFileEscaped}" -Force -ErrorAction SilentlyContinue

& "${command}" @cliArgs 2> "${stderrFileEscaped}"
$exitCode = $LASTEXITCODE

Stop-Transcript -ErrorAction SilentlyContinue

# ── Stop liveness heartbeat ──
Stop-Job -Job $livenessJob -ErrorAction SilentlyContinue
Remove-Job -Job $livenessJob -Force -ErrorAction SilentlyContinue

# ── Output stderr if any was captured ──
if (Test-Path "${stderrFileEscaped}") {
  $stderrContent = Get-Content "${stderrFileEscaped}" -Raw
  if ($stderrContent) {
    Write-Host '  -- STDERR --' -ForegroundColor Red
    Write-Host $stderrContent -ForegroundColor Red
  }
}

# ── Write exit code (graceful completion contract) ──
$exitCode | Out-File -FilePath "${exitFileEscaped}" -Encoding ASCII

if ($exitCode -eq 0) {
  Write-Host ''
  Write-Host "  [MAOS] Agent finished successfully. Exit code: $exitCode." -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host "  [MAOS] Agent failed. Exit code: $exitCode." -ForegroundColor Red
}
`;
  }



  /**
   * Archive completed task log files to logs/archive/.
   * Files older than LOG_RETENTION_DAYS are deleted from the archive.
   */
  private archiveTaskLogs(files: string[], archiveDir: string, retentionDays = 7): void {
    const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Move current task's log files to archive
    for (const src of files) {
      try {
        if (fs.existsSync(src)) {
          const dest = path.join(archiveDir, path.basename(src));
          fs.renameSync(src, dest);
        }
      } catch { /* non-fatal — leave in place if rename fails (e.g. cross-device) */ }
    }

    // Prune archived files older than retention window
    try {
      const archived = fs.readdirSync(archiveDir);
      for (const name of archived) {
        const full = path.join(archiveDir, name);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > cutoffMs) {
            fs.unlinkSync(full);
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Snapshot all files in the project (path -> mtime).
   */
  private snapshotFiles(dir: string, scope: string[]): Map<string, number> {
    const snapshot = new Map<string, number>();

    function walk(d: string, depth: number) {
      if (depth > 6) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(full);
              snapshot.set(full, stat.mtimeMs);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    const cleanScopes = scope.filter(s => s !== '/' && s !== '*' && s !== '**/*');
    if (cleanScopes.length > 0) {
      for (const sc of cleanScopes) {
        const fullScopePath = path.resolve(dir, sc);
        if (fs.existsSync(fullScopePath)) {
          try {
            const stat = fs.statSync(fullScopePath);
            if (stat.isDirectory()) {
              walk(fullScopePath, 0);
            } else if (stat.isFile()) {
              snapshot.set(fullScopePath, stat.mtimeMs);
            }
          } catch { /* skip */ }
        }
      }
    } else {
      walk(dir, 0);
    }

    return snapshot;
  }

  /**
   * Diff two snapshots — return list of new or modified file paths.
   */
  private diffSnapshots(
    before: Map<string, number>,
    after: Map<string, number>,
  ): string[] {
    const changed: string[] = [];

    for (const [filePath, mtime] of after) {
      const prevMtime = before.get(filePath);
      if (prevMtime === undefined || prevMtime !== mtime) {
        changed.push(filePath);
      }
    }

    return changed;
  }

  getCapabilityProfile(): RuntimeCapabilityProfile {
    return {
      runtimeId:              this.name,          // e.g. 'copilot-cli'
      runtimeType:            'cli',
      provider:               this.config.cliCommand,
      supportsTools:          false,  // CLI manages its own tool loop internally
      supportsCodeMutation:   true,   // Primary purpose of CLI agents
      supportsLongContext:    true,   // CLI manages own context window
      supportsStreaming:      false,
      supportsParallelism:    false,  // one WT tab per agent
      estimatedAvgLatencyMs:  120_000, // CLIs are typically slower (no streaming, WT launch overhead)
      estimatedCostPerTask:   0,       // Subscription-based; zero marginal cost
      concurrencyLimit:       1,
    };
  }

  async dispose(): Promise<void> {
    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
      this.childProcess = null;
    }
    this.bus.emit(createEvent('AGENT_DISPOSED', this.name, {
      cli: this.config.cliCommand,
    }));
  }
}
