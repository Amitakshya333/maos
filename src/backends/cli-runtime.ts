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
import { IRuntime, RuntimeTask, RuntimeResult } from './runtime';
import { MessageBus, createEvent } from '../core/message-bus';

// ---- CLI Profiles ----
// Maps CLI names to their invocation patterns + auth env vars.
// Users can also define custom CLIs in config.

interface CliProfile {
  command: string;
  buildArgs: (promptFile: string) => string[];
  authEnvKey?: string;
}

const CLI_PROFILES: Record<string, CliProfile> = {
  copilot: {
    command: 'copilot',
    buildArgs: (promptFile) => ['-i', fs.readFileSync(promptFile, 'utf-8')],
    authEnvKey: 'COPILOT_HOME',
  },
  codex: {
    command: 'codex',
    buildArgs: (promptFile) => ['-q', fs.readFileSync(promptFile, 'utf-8')],
    authEnvKey: 'CODEX_HOME',
  },
  claude: {
    command: 'claude',
    buildArgs: (promptFile) => ['-p', fs.readFileSync(promptFile, 'utf-8'), '--dangerously-skip-permissions'],
    authEnvKey: 'CLAUDE_CONFIG_DIR',
  },
  antigravity: {
    command: 'antigravity',
    buildArgs: (promptFile) => ['--prompt-file', promptFile],
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
    const startTime = Date.now();
    const maosDir = path.join(task.projectRoot, '.maos');
    const promptsDir = path.join(maosDir, 'prompts');
    const launchersDir = path.join(maosDir, 'launchers');
    const authDir = path.join(maosDir, 'auth', task.agentId);
    const sentinelFile = path.join(maosDir, `agent-done-${task.agentId}`);

    // Ensure directories exist
    for (const dir of [promptsDir, launchersDir, authDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // Clear any stale sentinel
    if (fs.existsSync(sentinelFile)) fs.unlinkSync(sentinelFile);

    // Emit TASK_STARTED
    this.bus.emit(createEvent('TASK_STARTED', task.agentId, {
      taskId: task.id,
      cli: this.config.cliCommand,
      mode: 'visible-terminal',
    }, task.id, 'cli'));

    // 1. Take filesystem snapshot (before)
    const beforeSnapshot = this.snapshotFiles(task.projectRoot);

    // 2. Write task prompt file
    const promptFile = path.join(promptsDir, `${task.agentId}_task.md`);
    const prompt = this.buildPrompt(task);
    fs.writeFileSync(promptFile, prompt, 'utf-8');

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
    const launcherFile = path.join(launchersDir, `${task.agentId}_launcher.ps1`);
    const launcherContent = this.buildLauncher(task, promptFile, resolvedAuth);
    fs.writeFileSync(launcherFile, launcherContent, 'utf-8');

    // 5. Open Windows Terminal tab
    try {
      const wtArgs = `new-tab --title "${task.agentId}" -- pwsh.exe -NoExit -File "${launcherFile}"`;
      child_process.execSync(`wt.exe ${wtArgs}`, {
        cwd: task.projectRoot,
        stdio: 'ignore',
        windowsHide: false,
      });

      this.bus.emit(createEvent('TASK_PROGRESS', task.agentId, {
        action: 'terminal-tab-opened',
        cli: this.config.cliCommand,
      }, task.id, 'cli'));
    } catch (err: any) {
      // WT not available — fall back to spawning a hidden process
      return this.executeFallback(task, promptFile, resolvedAuth, beforeSnapshot, startTime);
    }

    // 6. Monitor completion via lifecycle hierarchy
    const result = await this.monitorCompletion(
      task,
      sentinelFile,
      beforeSnapshot,
      startTime,
    );

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

      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      // Timeout
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
          reason: 'timeout',
          timeoutMs: this.config.timeoutMs,
        }, task.id, 'cli'));
      }, this.config.timeoutMs);

      child.on('exit', (code) => {
        clearTimeout(timer);
        this.childProcess = null;

        const afterSnapshot = this.snapshotFiles(task.projectRoot);
        const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);
        const success = code === 0 || filesChanged.length > 0;

        this.bus.emit(createEvent(
          success ? 'TASK_COMPLETED' : 'TASK_FAILED',
          task.agentId,
          { exitCode: code, filesChanged: filesChanged.length },
          task.id, 'cli',
        ));

        resolve({
          success,
          summary: success
            ? `CLI agent (${this.config.cliCommand}) completed. ${filesChanged.length} files changed.`
            : `CLI agent (${this.config.cliCommand}) failed with exit code ${code}.`,
          filesChanged,
          iterations: 1, // CLI = single execution
          totalTokens: 0, // Subscription-based, no token tracking
          costUSD: 0,
          latencyMs: Date.now() - startTime,
          runtimeType: 'cli',
          error: success ? undefined : `Exit code: ${code}`,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.childProcess = null;

        this.bus.emit(createEvent('TASK_FAILED', task.agentId, {
          error: err.message,
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
        });
      });
    });
  }

  /**
   * Monitor a visible WT tab agent for completion.
   * Uses the lifecycle hierarchy:
   *   1. Sentinel file (.maos/agent-done-{agentId})
   *   2. Filesystem quiescence (no changes for N seconds)
   *   3. Timeout (hard kill)
   */
  private async monitorCompletion(
    task: RuntimeTask,
    sentinelFile: string,
    beforeSnapshot: Map<string, number>,
    startTime: number,
  ): Promise<RuntimeResult> {
    const pollInterval = 3000; // Check every 3 seconds
    let lastChangeTime = Date.now();
    let lastSnapshot = this.snapshotFiles(task.projectRoot);
    let quiescentCount = 0;
    const quiescentThreshold = Math.ceil(this.config.quiescenceMs / pollInterval);

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime;

        // 1. Check sentinel file (explicit completion signal)
        if (fs.existsSync(sentinelFile)) {
          clearInterval(timer);
          const afterSnapshot = this.snapshotFiles(task.projectRoot);
          const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);

          // Read sentinel for summary
          let summary = 'CLI agent completed (sentinel)';
          try {
            const sentinelContent = fs.readFileSync(sentinelFile, 'utf-8').trim();
            if (sentinelContent) summary = sentinelContent;
          } catch { /* use default */ }

          this.bus.emit(createEvent('TASK_COMPLETED', task.agentId, {
            method: 'sentinel',
            filesChanged: filesChanged.length,
          }, task.id, 'cli'));

          resolve({
            success: true,
            summary,
            filesChanged,
            iterations: 1,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: elapsed,
            runtimeType: 'cli',
          });
          return;
        }

        // 2. Check filesystem quiescence
        const currentSnapshot = this.snapshotFiles(task.projectRoot);
        const changed = this.diffSnapshots(lastSnapshot, currentSnapshot);

        if (changed.length > 0) {
          // Files are still being modified — reset quiescent counter
          quiescentCount = 0;
          lastChangeTime = Date.now();
          lastSnapshot = currentSnapshot;

          this.bus.emit(createEvent('TASK_PROGRESS', task.agentId, {
            filesModified: changed.length,
            elapsed,
          }, task.id, 'cli'));
        } else {
          quiescentCount++;

          // Quiescent for long enough — consider done
          // BUT only if the agent actually changed something (not just sitting idle from the start)
          const totalFilesChanged = this.diffSnapshots(beforeSnapshot, currentSnapshot);
          if (quiescentCount >= quiescentThreshold && totalFilesChanged.length > 0) {
            clearInterval(timer);

            this.bus.emit(createEvent('TASK_COMPLETED', task.agentId, {
              method: 'quiescence',
              quiescentMs: quiescentCount * pollInterval,
              filesChanged: totalFilesChanged.length,
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
            });
            return;
          }
        }

        // 3. Timeout — hard stop
        if (elapsed >= this.config.timeoutMs) {
          clearInterval(timer);
          const afterSnapshot = this.snapshotFiles(task.projectRoot);
          const filesChanged = this.diffSnapshots(beforeSnapshot, afterSnapshot);
          const madeProgress = filesChanged.length > 0;

          this.bus.emit(createEvent(
            madeProgress ? 'TASK_COMPLETED' : 'TASK_FAILED',
            task.agentId,
            { method: 'timeout', filesChanged: filesChanged.length },
            task.id, 'cli',
          ));

          resolve({
            success: madeProgress,
            summary: madeProgress
              ? `CLI agent timed out but modified ${filesChanged.length} files. Partial success.`
              : `CLI agent timed out with no file changes.`,
            filesChanged,
            iterations: 1,
            totalTokens: 0,
            costUSD: 0,
            latencyMs: elapsed,
            runtimeType: 'cli',
            error: madeProgress ? undefined : 'TIMEOUT',
          });
        }

        // Heartbeat
        this.bus.emit(createEvent('HEARTBEAT', task.agentId, {
          elapsed,
          quiescentCount,
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

  /**
   * Build a PowerShell launcher script (like ARIOTH's launcher).
   */
  private buildLauncher(
    task: RuntimeTask,
    promptFile: string,
    resolvedAuth: Record<string, string>,
  ): string {
    const profile = CLI_PROFILES[this.config.cliCommand];
    const command = profile?.command || this.config.cliCommand;
    const timestamp = new Date().toISOString();

    // Build auth env var lines
    const authLines = Object.entries(resolvedAuth)
      .map(([key, val]) => `$env:${key} = "${val}"`)
      .join('\n');

    // Build CLI invocation
    const cliArgsStr = this.config.cliArgs.length > 0
      ? ' ' + this.config.cliArgs.join(' ')
      : '';

    return `# Auto-generated MAOS launcher for ${task.agentId} at ${timestamp}
# Runtime: ${this.config.cliCommand}-cli | Task: ${task.id}
# Do NOT edit manually - regenerated on each dispatch.

Set-Location "${task.projectRoot}"

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
Get-Content "${promptFile}" | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
Write-Host ''

# ── Launch CLI ──
$taskText = Get-Content "${promptFile}" -Raw
${command} -i $taskText${cliArgsStr}

# ── Signal completion ──
$sentinelFile = "${path.join(task.projectRoot, '.maos', `agent-done-${task.agentId}`).replace(/\\/g, '\\\\')}"
"Task completed by ${task.agentId} at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $sentinelFile -Encoding UTF8
Write-Host ''
Write-Host '  [MAOS] Agent ${task.agentId} finished. Sentinel written.' -ForegroundColor Green
`;
  }

  /**
   * Snapshot all files in the project (path -> mtime).
   */
  private snapshotFiles(dir: string): Map<string, number> {
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

    walk(dir, 0);
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
