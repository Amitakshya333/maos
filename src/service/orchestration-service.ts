/**
 * MAOS Orchestration Service
 *
 * Wraps the orchestrator start/stop/status lifecycle.
 * Extracted from: cli/start.ts, core/orchestrator.ts lifecycle.
 */

import { startOrchestrator } from '../core/orchestrator';
import type { OrchestrationOptions, OrchestrationState } from '../domain/schemas';

export class OrchestrationService {
  private _running = false;

  constructor(private readonly projectRoot: string) {}

  /**
   * Start the orchestrator loop.
   */
  async start(opts?: OrchestrationOptions): Promise<void> {
    this._running = true;
    try {
      await startOrchestrator({
        providerOverride: opts?.providerOverride,
        pollIntervalMs: opts?.pollIntervalMs,
        cwd: opts?.cwd ?? this.projectRoot,
        force: opts?.force,
        onStatusUpdate: opts?.onStatusUpdate,
      });
    } finally {
      this._running = false;
    }
  }

  /**
   * Check whether the orchestrator is currently running.
   */
  isRunning(): boolean {
    return this._running;
  }
}
