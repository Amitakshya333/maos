import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeTelemetryCsv,
  loadTelemetryDemoThresholds,
  storeTelemetryAnalysis,
  verifyTelemetryAnalysis,
} from '../../src/industrial/telemetry-analysis';

const projectRoot = path.resolve(__dirname, '../..');
const temporaryRoots: string[] = [];

function createTemporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-telemetry-test-'));
  temporaryRoots.push(root);
  const thresholdDir = path.join(root, 'demo', 'industrial');
  fs.mkdirSync(thresholdDir, { recursive: true });
  fs.copyFileSync(path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json'), path.join(thresholdDir, 'safety_thresholds.json'));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Industrial local telemetry analysis', () => {
  it('analyzes the bundled 500-row synthetic CSV against demo thresholds', () => {
    const csv = fs.readFileSync(path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'));
    const thresholds = loadTelemetryDemoThresholds(projectRoot);
    const result = analyzeTelemetryCsv(csv, thresholds);

    expect(result.rowsAnalyzed).toBe(500);
    expect(result.overallVibrationRms).toBeCloseTo(2.63711, 4);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.findings.map((finding) => [finding.row, finding.field, finding.severity])).toEqual([
      [121, 'vibration_rms_mm_s', 'WARNING'],
      [238, 'bearing_temperature_c', 'WARNING'],
      [367, 'vibration_rms_mm_s', 'CRITICAL'],
      [442, 'bearing_temperature_c', 'CRITICAL'],
    ]);
  });

  it('supports quoted CSV fields and rejects missing or malformed values', () => {
    const thresholds = loadTelemetryDemoThresholds(projectRoot);
    const valid = Buffer.from('timestamp,asset_id,vibration_rms_mm_s,bearing_temperature_c\n"2026-01-01, 09:00","T-07",5.1,74\n');
    const result = analyzeTelemetryCsv(valid, thresholds);
    expect(result.rowsAnalyzed).toBe(1);
    expect(result.findings[0].timestamp).toBe('2026-01-01, 09:00');
    expect(() => analyzeTelemetryCsv(Buffer.from('x,y\n1,2\n'), thresholds)).toThrow(/needs vibration_rms/);
    expect(() => analyzeTelemetryCsv(Buffer.from('vibration_rms_mm_s,bearing_temperature_c\nnope,90\n'), thresholds)).toThrow(/invalid vibration/);
  });

  it('stores a local receipt that CLI verification can deterministically replay', () => {
    const root = createTemporaryProject();
    const source = fs.readFileSync(path.join(projectRoot, 'demo', 'industrial', 'turbine_vibration_log.csv'));
    const stored = storeTelemetryAnalysis(root, 'sample.csv', source, 'bundled-synthetic-sample');
    const verified = verifyTelemetryAnalysis(root, stored.receipt.analysisId);

    expect(verified.valid).toBe(true);
    expect(verified.sourceHashMatched).toBe(true);
    expect(verified.rulesetHashMatched).toBe(true);
    expect(verified.recomputationMatched).toBe(true);
    expect(verified.result?.rowsAnalyzed).toBe(500);

    const evidencePath = path.join(root, stored.receipt.source.relativePath);
    fs.appendFileSync(evidencePath, '\n');
    const tampered = verifyTelemetryAnalysis(root, stored.receipt.analysisId);
    expect(tampered.valid).toBe(false);
    expect(tampered.sourceHashMatched).toBe(false);
  });

  it('rejects an analysis after its demonstration ruleset changes', () => {
    const root = createTemporaryProject();
    const source = Buffer.from('vibration_rms_mm_s,bearing_temperature_c\n2.5,75\n');
    const stored = storeTelemetryAnalysis(root, 'small.csv', source, 'device-upload');
    const thresholdPath = path.join(root, 'demo', 'industrial', 'safety_thresholds.json');
    fs.appendFileSync(thresholdPath, '\n');

    const verification = verifyTelemetryAnalysis(root, stored.receipt.analysisId);
    expect(verification.valid).toBe(false);
    expect(verification.rulesetHashMatched).toBe(false);
  });
});
