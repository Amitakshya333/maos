/**
 * TASK DEV-A-01 (Dev A): analyze_telemetry tool module.
 *
 * Migrated verbatim from `RingAgentService.toolAnalyzeTelemetry`: same
 * input (project-relative CSV path or run context default), same
 * telemetry-analysis code path, same output fields. Path checks reuse the
 * `isStrictlyWithin(projectRoot)` pattern. `ctx.runContext.csvPath` carries
 * the run's configured default, exactly as `run.context.csvPath` did.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RingToolDefinition } from '../ring-contract';
import { analyzeTelemetryCsv, loadTelemetryDemoThresholds } from '../../industrial/telemetry-analysis';
import { isStrictlyWithin } from './common';
import type { RingToolDeps } from './tool-deps';

export function createAnalyzeTelemetryTool(_deps: RingToolDeps): RingToolDefinition {
  return {
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
    execute: (ctx, args) => {
      const runCsvPath = (ctx.runContext as Record<string, unknown> | undefined)?.csvPath;
      const requested =
        (typeof args.csvPath === 'string' && (args.csvPath as string).trim()) ||
        (typeof runCsvPath === 'string' && runCsvPath.trim()) ||
        'demo/industrial/turbine_vibration_log.csv';
      let resolved: string;
      if (path.isAbsolute(requested)) {
        resolved = path.resolve(requested);
        if (!isStrictlyWithin(ctx.projectRoot, resolved)) {
          throw new Error(`PATH_OUTSIDE_PROJECT_ROOT: telemetry CSV path is outside the project root: ${requested}`);
        }
      } else {
        resolved = path.resolve(ctx.projectRoot, requested);
        if (!isStrictlyWithin(ctx.projectRoot, resolved)) {
          throw new Error(`PATH_OUTSIDE_PROJECT_ROOT: telemetry CSV path is outside the project root: ${requested}`);
        }
      }
      if (!fs.existsSync(resolved)) throw new Error(`Telemetry CSV not found: ${requested}`);
      const thresholds = loadTelemetryDemoThresholds(ctx.projectRoot);
      const metrics = analyzeTelemetryCsv(fs.readFileSync(resolved), thresholds);
      return {
        verdict: metrics.verdict,
        overallVibrationRms: Number(metrics.overallVibrationRms.toFixed(3)),
        peakVibration: Number(metrics.peakVibration.toFixed(3)),
        peakTemperature: Number(metrics.peakTemperature.toFixed(1)),
        rowsAnalyzed: metrics.rowsAnalyzed,
        warningCount: metrics.warningCount,
        criticalCount: metrics.criticalCount,
        findings: metrics.findings.slice(0, 20).map((f) => ({
          row: f.row,
          timestamp: f.timestamp,
          field: f.field,
          value: f.value,
          threshold: f.threshold,
          unit: f.unit,
          severity: f.severity,
        })),
        source: path.relative(ctx.projectRoot, resolved).split(path.sep).join('/'),
        disclaimer: 'Deterministic summary only; raw telemetry rows were not sent to the model.',
      };
    },
  };
}
