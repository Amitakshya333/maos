/**
 * TASK RING-CONTRACT-01 (Dev C stub): analyze_telemetry tool module.
 *
 * MIGRATION CONTRACT (behavior unchanged from `RingAgentService.toolAnalyzeTelemetry`):
 * same input (project-relative CSV path or run context default), same
 * telemetry-analysis code path, same output fields (verdict,
 * overallVibrationRms, peakVibration, peakTemperature, rowsAnalyzed,
 * warningCount, criticalCount, findings[0..20], source, disclaimer).
 * Path checks reuse the `isStrictlyWithin(projectRoot)` pattern.
 * Results are truncated via the shared `truncate()` pattern only at the
 * presentation layer, never here.
 *
 * Dev C implements `execute` by moving the method body verbatim; this stub
 * is intentionally unregistered until then.
 */

import type { RingToolDefinition } from '../ring-contract';

export const analyzeTelemetryTool: RingToolDefinition = {
  name: 'analyze_telemetry',
  description:
    'Run the deterministic telemetry analysis on the bundled turbine vibration sample or a project-relative CSV path. Returns verdict, RMS and threshold breaches only; never raw CSV rows.',
  parameters: {
    type: 'object',
    properties: {
      csvPath: { type: 'string', description: 'Optional project-root-relative CSV path. Defaults to the bundled sample.' },
    },
  },
  consequential: false,
  execute: () => {
    throw new Error('RING_TOOL_NOT_MIGRATED: analyze_telemetry still executes in ring-agent-service; Dev C migrates it.');
  },
};
