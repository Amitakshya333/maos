import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface TelemetryThresholds {
  vibration: { warning: number; critical: number; unit: string };
  temperature: { warning: number; critical: number; unit: string };
}

export interface TelemetryFinding {
  row: number;
  timestamp: string | null;
  field: 'vibration_rms_mm_s' | 'bearing_temperature_c';
  value: number;
  threshold: number;
  unit: string;
  severity: 'WARNING' | 'CRITICAL';
}

export interface TelemetryMetrics {
  rowsAnalyzed: number;
  overallVibrationRms: number;
  peakVibration: number;
  peakTemperature: number;
  warningCount: number;
  criticalCount: number;
  verdict: 'PASS' | 'WARNING' | 'CRITICAL';
  findings: TelemetryFinding[];
}

export interface TelemetryAnalysisReceipt {
  schemaVersion: 1;
  analysisId: string;
  createdAt: string;
  source: {
    filename: string;
    relativePath: string;
    sha256: string;
    bytes: number;
    kind: 'device-upload' | 'bundled-synthetic-sample';
  };
  rulesetSha256: string;
  thresholds: TelemetryThresholds;
  disclaimer: string;
  result: TelemetryMetrics;
}

export const TELEMETRY_DEMO_DISCLAIMER =
  'Demonstration thresholds only. Not a certified standard, diagnosis, or operating authorization.';

const MAX_ANALYSIS_ROWS = 100_000;
const ANALYSIS_ID_PATTERN = /^telemetry-\d{10,}-[a-f0-9]{8}$/;

function finiteThreshold(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid demonstration threshold: ${label}`);
  }
  return value;
}

function isStrictlyWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function loadTelemetryDemoThresholds(projectRoot: string): TelemetryThresholds {
  const filePath = path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const vibration = config?.thresholds?.vibration_rms_mm_s;
  const temperature = config?.thresholds?.bearing_temperature_c;
  const result: TelemetryThresholds = {
    vibration: {
      warning: finiteThreshold(vibration?.warning, 'vibration warning'),
      critical: finiteThreshold(vibration?.critical, 'vibration critical'),
      unit: typeof vibration?.unit === 'string' ? vibration.unit : 'mm/s RMS',
    },
    temperature: {
      warning: finiteThreshold(temperature?.warning, 'temperature warning'),
      critical: finiteThreshold(temperature?.critical, 'temperature critical'),
      unit: typeof temperature?.unit === 'string' ? temperature.unit : 'deg C',
    },
  };
  if (result.vibration.warning > result.vibration.critical || result.temperature.warning > result.temperature.critical) {
    throw new Error('Demonstration warning thresholds must not exceed critical thresholds.');
  }
  return result;
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field.replace(/\r$/, ''));
      if (record.some((cell) => cell.trim() !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field.length > 0 || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    if (record.some((cell) => cell.trim() !== '')) records.push(record);
  }
  return records;
}

function parseNumber(value: string | undefined, label: string, row: number): number {
  if (value === undefined || value.trim() === '') throw new Error(`CSV row ${row} is missing ${label}.`);
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new Error(`CSV row ${row} has an invalid ${label}.`);
  return parsed;
}

export function analyzeTelemetryCsv(buffer: Buffer, thresholds: TelemetryThresholds): TelemetryMetrics {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const records = parseCsvRecords(text);
  if (records.length < 2) throw new Error('CSV must contain a header and at least one data row.');

  const headers = records[0].map((header) => header.trim());
  const vibrationIndex = headers.indexOf('vibration_rms_mm_s');
  const temperatureIndex = headers.indexOf('bearing_temperature_c');
  const timestampIndex = headers.indexOf('timestamp');
  if (vibrationIndex < 0 || temperatureIndex < 0) {
    throw new Error('CSV needs vibration_rms_mm_s and bearing_temperature_c columns.');
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ANALYSIS_ROWS) {
    throw new Error(`CSV exceeds the ${MAX_ANALYSIS_ROWS.toLocaleString()} row demo limit.`);
  }

  const vibrations: number[] = [];
  let peakTemperature = Number.NEGATIVE_INFINITY;
  const findings: TelemetryFinding[] = [];
  dataRecords.forEach((record, index) => {
    if (record.length !== headers.length) throw new Error(`CSV row ${index + 1} has the wrong number of columns.`);
    const row = index + 1;
    const vibration = parseNumber(record[vibrationIndex], 'vibration_rms_mm_s', row);
    const temperature = parseNumber(record[temperatureIndex], 'bearing_temperature_c', row);
    const timestamp = timestampIndex >= 0 ? record[timestampIndex]?.trim() || null : null;
    vibrations.push(vibration);
    peakTemperature = Math.max(peakTemperature, temperature);

    const vibrationSeverity = vibration >= thresholds.vibration.critical
      ? 'CRITICAL'
      : vibration >= thresholds.vibration.warning ? 'WARNING' : null;
    if (vibrationSeverity) {
      findings.push({
        row,
        timestamp,
        field: 'vibration_rms_mm_s',
        value: vibration,
        threshold: vibrationSeverity === 'CRITICAL' ? thresholds.vibration.critical : thresholds.vibration.warning,
        unit: thresholds.vibration.unit,
        severity: vibrationSeverity,
      });
    }

    const temperatureSeverity = temperature >= thresholds.temperature.critical
      ? 'CRITICAL'
      : temperature >= thresholds.temperature.warning ? 'WARNING' : null;
    if (temperatureSeverity) {
      findings.push({
        row,
        timestamp,
        field: 'bearing_temperature_c',
        value: temperature,
        threshold: temperatureSeverity === 'CRITICAL' ? thresholds.temperature.critical : thresholds.temperature.warning,
        unit: thresholds.temperature.unit,
        severity: temperatureSeverity,
      });
    }
  });

  const overallVibrationRms = Math.sqrt(vibrations.reduce((sum, value) => sum + value * value, 0) / vibrations.length);
  const peakVibration = vibrations.reduce((peak, value) => Math.max(peak, value), Number.NEGATIVE_INFINITY);
  const warningCount = findings.filter((finding) => finding.severity === 'WARNING').length;
  const criticalCount = findings.filter((finding) => finding.severity === 'CRITICAL').length;
  return {
    rowsAnalyzed: vibrations.length,
    overallVibrationRms,
    peakVibration,
    peakTemperature,
    warningCount,
    criticalCount,
    verdict: criticalCount > 0 ? 'CRITICAL' : warningCount > 0 ? 'WARNING' : 'PASS',
    findings,
  };
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export interface StoredTelemetryAnalysis {
  receipt: TelemetryAnalysisReceipt;
  receiptPath: string;
  receiptSha256: string;
}

export function storeTelemetryAnalysis(
  projectRoot: string,
  filename: string,
  csvBuffer: Buffer,
  kind: TelemetryAnalysisReceipt['source']['kind'],
): StoredTelemetryAnalysis {
  if (csvBuffer.length === 0 || csvBuffer.length > 5 * 1024 * 1024) {
    throw new Error('CSV must be between 1 byte and 5 MB.');
  }
  const extension = path.extname(filename).toLowerCase();
  if (extension !== '.csv') throw new Error('Telemetry analysis accepts CSV files only.');

  const thresholdPath = path.join(projectRoot, 'demo', 'industrial', 'safety_thresholds.json');
  const thresholdBytes = fs.readFileSync(thresholdPath);
  const thresholds = loadTelemetryDemoThresholds(projectRoot);
  const result = analyzeTelemetryCsv(csvBuffer, thresholds);
  const basename = path.basename(filename, extension)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64) || 'telemetry';
  const analysisId = `telemetry-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const evidenceRelativePath = `.maos/industrial/evidence/${analysisId}-${basename}.csv`;
  const evidencePath = path.resolve(projectRoot, evidenceRelativePath);
  const evidenceRoot = path.resolve(projectRoot, '.maos', 'industrial', 'evidence');
  const analysisRoot = path.resolve(projectRoot, '.maos', 'industrial', 'telemetry-analyses');
  if (path.dirname(evidencePath) !== evidenceRoot) throw new Error('Invalid evidence destination.');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(analysisRoot, { recursive: true });
  const realProjectRoot = fs.realpathSync(projectRoot);
  if (!isStrictlyWithin(realProjectRoot, fs.realpathSync(evidenceRoot))) {
    throw new Error('Evidence store resolves outside the project root.');
  }
  if (!isStrictlyWithin(realProjectRoot, fs.realpathSync(analysisRoot))) {
    throw new Error('Analysis store resolves outside the project root.');
  }
  fs.writeFileSync(evidencePath, csvBuffer, { flag: 'wx' });

  const receipt: TelemetryAnalysisReceipt = {
    schemaVersion: 1,
    analysisId,
    createdAt: new Date().toISOString(),
    source: {
      filename: path.basename(filename),
      relativePath: evidenceRelativePath,
      sha256: sha256(csvBuffer),
      bytes: csvBuffer.length,
      kind,
    },
    rulesetSha256: sha256(thresholdBytes),
    thresholds,
    disclaimer: TELEMETRY_DEMO_DISCLAIMER,
    result,
  };
  const receiptPath = path.join(analysisRoot, `${analysisId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const receiptSha256 = sha256(fs.readFileSync(receiptPath));
  return { receipt, receiptPath: path.relative(projectRoot, receiptPath).split(path.sep).join('/'), receiptSha256 };
}

export interface TelemetryVerificationResult {
  valid: boolean;
  analysisId: string;
  sourceHashMatched: boolean;
  rulesetHashMatched: boolean;
  recomputationMatched: boolean;
  sourcePath?: string;
  sourceSha256?: string;
  receiptSha256?: string;
  result?: TelemetryMetrics;
  errors: string[];
}

export function verifyTelemetryAnalysis(projectRoot: string, analysisId: string): TelemetryVerificationResult {
  const errors: string[] = [];
  const invalid = (): TelemetryVerificationResult => ({
    valid: false, analysisId, sourceHashMatched: false, rulesetHashMatched: false, recomputationMatched: false, errors,
  });
  if (!ANALYSIS_ID_PATTERN.test(analysisId)) {
    errors.push('Invalid telemetry analysis ID.');
    return invalid();
  }

  try {
    const root = path.resolve(projectRoot);
    const analysisRoot = path.resolve(root, '.maos', 'industrial', 'telemetry-analyses');
    const receiptPath = path.resolve(analysisRoot, `${analysisId}.json`);
    if (path.dirname(receiptPath) !== analysisRoot || !fs.existsSync(receiptPath)) {
      errors.push('Analysis receipt was not found.');
      return invalid();
    }
    const realRoot = fs.realpathSync(root);
    const realAnalysisRoot = fs.realpathSync(analysisRoot);
    if (!isStrictlyWithin(realRoot, realAnalysisRoot) || !isStrictlyWithin(realAnalysisRoot, fs.realpathSync(receiptPath))) {
      errors.push('Analysis receipt resolves outside the project analysis store.');
      return invalid();
    }
    const receiptBytes = fs.readFileSync(receiptPath);
    const receipt = JSON.parse(receiptBytes.toString('utf8')) as TelemetryAnalysisReceipt;
    if (receipt.schemaVersion !== 1 || receipt.analysisId !== analysisId) {
      errors.push('Analysis receipt identity or schema does not match.');
      return invalid();
    }

    const evidenceRoot = path.resolve(root, '.maos', 'industrial', 'evidence');
    const sourcePath = path.resolve(root, receipt.source.relativePath);
    const relativeToEvidence = path.relative(evidenceRoot, sourcePath);
    if (!relativeToEvidence || relativeToEvidence.startsWith('..') || path.isAbsolute(relativeToEvidence) || !fs.existsSync(sourcePath)) {
      errors.push('Source file is missing or outside the local evidence store.');
      return invalid();
    }
    const realEvidenceRoot = fs.realpathSync(evidenceRoot);
    const realSourcePath = fs.realpathSync(sourcePath);
    const realRelative = path.relative(realEvidenceRoot, realSourcePath);
    if (!isStrictlyWithin(realRoot, realEvidenceRoot) || !isStrictlyWithin(realEvidenceRoot, realSourcePath) || !realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      errors.push('Source file resolves outside the local evidence store.');
      return invalid();
    }

    const sourceBytes = fs.readFileSync(realSourcePath);
    const actualSourceHash = sha256(sourceBytes);
    const sourceHashMatched = actualSourceHash === receipt.source.sha256 && sourceBytes.length === receipt.source.bytes;
    if (!sourceHashMatched) errors.push('Source hash or size differs from the analysis receipt.');

    const thresholdPath = path.join(root, 'demo', 'industrial', 'safety_thresholds.json');
    const thresholdBytes = fs.readFileSync(thresholdPath);
    const currentThresholds = loadTelemetryDemoThresholds(root);
    const rulesetHashMatched = sha256(thresholdBytes) === receipt.rulesetSha256 &&
      JSON.stringify(currentThresholds) === JSON.stringify(receipt.thresholds);
    if (!rulesetHashMatched) errors.push('Demonstration threshold ruleset differs from the analysis receipt.');

    const recomputed = analyzeTelemetryCsv(sourceBytes, receipt.thresholds);
    const recomputationMatched = JSON.stringify(recomputed) === JSON.stringify(receipt.result);
    if (!recomputationMatched) errors.push('Recomputed results differ from the stored analysis receipt.');

    return {
      valid: sourceHashMatched && rulesetHashMatched && recomputationMatched,
      analysisId,
      sourceHashMatched,
      rulesetHashMatched,
      recomputationMatched,
      sourcePath: receipt.source.relativePath,
      sourceSha256: actualSourceHash,
      receiptSha256: sha256(receiptBytes),
      result: recomputed,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return invalid();
  }
}
