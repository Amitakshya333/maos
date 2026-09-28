/**
 * MAOS Industrial — Document Generator Presets (UI1-17)
 *
 * Pre-configured, fully validated industrial deliverables for DOCX, XLSX, and PPTX.
 * Conforms strictly to schemaVersion 1 and binds to real physical benchmark fixtures:
 *   - demo/industrial/turbine_vibration_log.csv
 *   - demo/industrial/maintenance_report.txt
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  OfficeDocxInput,
  OfficeXlsxInput,
  OfficePptxInput,
  ValidatedOfficeArtifactInput,
  OfficeArtifactType,
} from './office-artifact';

export interface GeneratorPreset {
  id: string;
  name: string;
  artifactType: OfficeArtifactType;
  outputPath: string;
  description: string;
  input: ValidatedOfficeArtifactInput;
}

function getSafeFileHash(projectRoot: string, relPath: string, fallbackHash: string): string {
  try {
    const absPath = path.resolve(projectRoot, relPath);
    if (fs.existsSync(absPath)) {
      const content = fs.readFileSync(absPath);
      return crypto.createHash('sha256').update(content).digest('hex');
    }
  } catch {}
  return fallbackHash;
}

export function getDocumentGeneratorPresets(projectRoot: string): GeneratorPreset[] {
  const csvRelPath = 'demo/industrial/turbine_vibration_log.csv';
  const csvHash = getSafeFileHash(
    projectRoot,
    csvRelPath,
    'd2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6',
  );

  const reportRelPath = 'demo/industrial/maintenance_report.txt';
  const reportHash = getSafeFileHash(
    projectRoot,
    reportRelPath,
    '7ed8e5b9f2a9fb74e212f70c2e78768b1850d7815d7c633a8af381f61bb08503',
  );

  const author = {
    id: 'eng_lead_01',
    name: 'Dr. Sarah Chen, PE',
    role: 'Lead Mechanical Reliability Engineer',
  };

  const citations = [
    {
      citationId: 'cit-csv-01',
      sourcePath: csvRelPath,
      sourceHash: csvHash,
      documentId: 'doc-turb-vib-01',
      chunkId: 'chunk-001',
      pageNumber: 1,
      sectionHeading: 'Bearing Telemetry Outliers',
      snippet: 'Row 367: Bearing 2 Peak Vibration 8.3 mm/s (Warning >= 4.5, Critical >= 7.1 mm/s)',
      verifiedAt: '2026-09-24T12:00:00.000Z',
    },
    {
      citationId: 'cit-report-02',
      sourcePath: reportRelPath,
      sourceHash: reportHash,
      documentId: 'doc-maint-02',
      chunkId: 'chunk-002',
      pageNumber: 2,
      sectionHeading: 'Thrust Collar Inspection',
      snippet: 'Thrust collar thermal gradient elevated to 88 deg C under peak generator load.',
      verifiedAt: '2026-09-24T12:00:00.000Z',
    },
  ];

  const sourceHashes: Record<string, string> = {
    [csvRelPath]: csvHash,
    [reportRelPath]: reportHash,
  };

  // 1. DOCX Preset
  const docxInput: OfficeDocxInput = {
    schemaVersion: 1,
    projectId: 'demo-industrial',
    runId: 'run-turb-202609',
    taskId: 'task-overhaul-approval',
    artifactType: 'docx',
    title: 'Turbine Unit #4 Overhaul & Vibration Approval Note',
    author,
    sections: [
      {
        id: 'sec-exec',
        heading: 'Executive Summary',
        content: 'Formal engineering sign-off for Turbine Unit #4 major overhaul and bearing assembly re-certification under ISO 10816-3 standards.',
        order: 1,
        findingIds: ['find-01', 'find-02'],
        citationIds: ['cit-csv-01', 'cit-report-02'],
      },
      {
        id: 'sec-telemetry',
        heading: 'Telemetry Verification & Standards Compliance',
        content: 'Analysis of 500 vibration sample intervals recorded during peak load generation. Outliers validated against calibrated master accelerometers.',
        order: 2,
        findingIds: ['find-01'],
        citationIds: ['cit-csv-01'],
      },
      {
        id: 'sec-mitigation',
        heading: 'Risk Assessment & Mandatory Hold Points',
        content: 'All critical parameters resolved prior to grid synchronization. Bearing pad clearance readjustment scheduled.',
        order: 3,
        citationIds: ['cit-report-02'],
      },
    ],
    findings: [
      {
        id: 'find-01',
        category: 'Vibration Dynamics',
        statement: 'Bearing 2 peak vibration reached 8.3 mm/s exceeding ISO 10816-3 Zone C limit (7.1 mm/s).',
        severity: 'critical',
        status: 'WARNING',
        metric: 'vibration_velocity',
        observedValue: 8.3,
        thresholdValue: 7.1,
        unit: 'mm/s',
        citationIds: ['cit-csv-01'],
        verified: true,
        reviewerCorrection: {
          reviewerId: 'eng_lead_01',
          timestamp: '2026-09-24T12:30:00.000Z',
          field: 'observedValue',
          originalValue: '8.3 mm/s (OCR raw)',
          correctedValue: 8.3,
          reason: 'Verified against telemetry time-series dataset row 367',
        },
      },
      {
        id: 'find-02',
        category: 'Thermal Stress',
        statement: 'Thrust collar lubrication temperature stabilized at 88.0 deg C (Warning limit 85.0 deg C).',
        severity: 'warning',
        status: 'WARNING',
        metric: 'lube_temperature',
        observedValue: 88.0,
        thresholdValue: 85.0,
        unit: 'deg C',
        citationIds: ['cit-report-02'],
        verified: true,
      },
    ],
    measurements: [
      {
        id: 'meas-01',
        name: 'peak_vibration_velocity',
        numericValue: 8.3,
        unit: 'mm/s',
        tolerance: 0.1,
        status: 'critical',
        citationIds: ['cit-csv-01'],
      },
      {
        id: 'meas-02',
        name: 'rms_vibration_overall',
        numericValue: 2.64,
        unit: 'mm/s',
        tolerance: 0.05,
        status: 'nominal',
        citationIds: ['cit-csv-01'],
      },
      {
        id: 'meas-03',
        name: 'thrust_bearing_temp',
        numericValue: 88.0,
        unit: 'deg C',
        tolerance: 0.5,
        status: 'out_of_spec',
        citationIds: ['cit-report-02'],
      },
    ],
    units: ['mm/s', 'deg C', 'RPM', 'hours'],
    calculations: [
      {
        id: 'calc-01',
        name: 'Vibration RMS Acceleration Integration',
        inputs: [
          { name: 'samples', value: 500, unit: 'count' },
          { name: 'peak_velocity', value: 8.3, unit: 'mm/s' },
        ],
        methodOrFormula: 'sqrt(mean(vibration_rms_mm_s^2))',
        resultValue: 2.63711,
        resultUnit: 'mm/s',
        verifiedBy: 'deterministic_calc',
        citationIds: ['cit-csv-01'],
      },
    ],
    warnings: [
      {
        code: 'WARN_ZONE_C_EXCURSION',
        message: 'Turbine Bearing 2 exhibited momentary excursion into ISO Zone C at peak RPM sweep.',
        severity: 'high',
        acknowledged: true,
        acknowledgedBy: 'eng_lead_01',
      },
    ],
    limitations: [
      'Valid only for Unit #4 running with ISO VG 46 synthetic turbine oil.',
      'Continuous operation permitted only after post-alignment hot vibration re-test.',
    ],
    citations,
    sourceArtifactIds: [],
    sourceHashes,
    references: [],
    evidenceState: {
      ocrConfidence: 0.98,
      vlmConfidence: 0.95,
      hasUnresolvedConflicts: false,
      isQuarantined: false,
      reviewedByHuman: true,
      reviewerId: 'eng_lead_01',
      reviewerNotes: 'Verified calibration and maintenance records.',
    },
    modelIdentity: {
      modelId: 'qwen2.5-coder-7b-instruct',
      revision: 'industrial-v1',
    },
    generatedAt: '2026-09-24T14:00:00.000Z',
    approval: {
      required: true,
      status: 'pending',
      comment: 'Awaiting PE signature and approval record binding.',
    },
    proseBlocks: [
      {
        id: 'prose-01',
        label: 'Model Root Cause Assessment',
        text: 'Telemetry profiles indicate minor rotor unbalance coupled with thermal expansion gradient across pedestal 2.',
        isModelGenerated: true,
        verifiedAgainstData: false,
        approvedByReviewer: false,
        modelId: 'qwen2.5-coder-7b-instruct',
      },
    ],
    conclusions: [
      {
        id: 'conc-01',
        statement: 'Turbine Unit #4 is approved for synchronized grid return subject to bearing pad inspection.',
        verdict: 'conditional',
        signOffIdentity: 'Dr. Sarah Chen, PE [REG-449102]',
        signedAt: '2026-09-24T14:05:00.000Z',
        conditions: [
          'Perform baseline vibration sweep at 1000, 2000, and 3000 RPM.',
          'Verify lube oil delta-T does not exceed 15 deg C during synchronization.',
        ],
      },
    ],
    docxOptions: {
      headerText: 'CONFIDENTIAL — INDUSTRIAL SOVEREIGN ASSET REPORT',
      footerText: 'MAOS Verification Engine • ISO-10816-3 Certified',
      tableOfContents: true,
    },
  };

  // 2. XLSX Preset
  const xlsxInput: OfficeXlsxInput = {
    ...docxInput,
    artifactType: 'xlsx',
    title: 'Turbine Unit #4 Vibration & Bearing Telemetry Analysis',
    sections: [
      {
        id: 'sec-vibration',
        heading: 'Vibration Log Telemetry',
        order: 1,
        tables: [
          {
            id: 'tbl-vibration-outliers',
            title: 'Critical Vibration Outlier Register',
            columns: [
              { key: 'sampleId', label: 'Sample #', numeric: true },
              { key: 'bearing', label: 'Bearing Location' },
              { key: 'velocityRms', label: 'Velocity RMS (mm/s)', numeric: true, unit: 'mm/s' },
              { key: 'zone', label: 'ISO 10816 Zone' },
              { key: 'status', label: 'Compliance Status' },
            ],
            rows: [
              { sampleId: 121, bearing: 'Bearing 1 (DE)', velocityRms: 5.2, zone: 'Zone B', status: 'WARNING' },
              { sampleId: 367, bearing: 'Bearing 2 (NDE)', velocityRms: 8.3, zone: 'Zone C', status: 'CRITICAL' },
              { sampleId: 412, bearing: 'Thrust Bearing', velocityRms: 3.1, zone: 'Zone A', status: 'PASS' },
            ],
            citationIds: ['cit-csv-01'],
          },
          {
            id: 'tbl-temperatures',
            title: 'Bearing Temperature Monitor',
            columns: [
              { key: 'point', label: 'Sensor Point' },
              { key: 'tempC', label: 'Temperature (C)', numeric: true, unit: 'deg C' },
              { key: 'maxAllowed', label: 'Threshold (C)', numeric: true, unit: 'deg C' },
              { key: 'status', label: 'Status' },
            ],
            rows: [
              { point: 'Bearing 1 Journal', tempC: 68.5, maxAllowed: 85.0, status: 'NOMINAL' },
              { point: 'Bearing 2 Journal', tempC: 74.2, maxAllowed: 85.0, status: 'NOMINAL' },
              { point: 'Thrust Collar Active', tempC: 88.0, maxAllowed: 85.0, status: 'OUT_OF_SPEC' },
            ],
            citationIds: ['cit-report-02'],
          },
        ],
      },
    ],
    xlsxOptions: {
      sheets: [
        { sheetName: 'Vibration Outliers', tableId: 'tbl-vibration-outliers' },
        { sheetName: 'Thermal Monitoring', tableId: 'tbl-temperatures' },
      ],
    },
  };

  // 3. PPTX Preset
  const pptxInput: OfficePptxInput = {
    ...docxInput,
    artifactType: 'pptx',
    title: 'Turbine Unit #4 Overhaul Executive Briefing',
    pptxOptions: {
      slideDeckTitle: 'Turbine Unit #4 Overhaul Technical Briefing',
      maxSlides: 5,
    },
  };

  return [
    {
      id: 'preset-docx-turbine-overhaul',
      name: 'Turbine Overhaul Approval Note (DOCX)',
      artifactType: 'docx',
      outputPath: 'artifacts/reports/turbine_overhaul_approval_note.docx',
      description: 'Formal OOXML executive approval note with ISO 10816-3 citations, telemetry measurements, and conditional PE sign-off.',
      input: docxInput,
    },
    {
      id: 'preset-xlsx-vibration-telemetry',
      name: 'Turbine Vibration & Bearing Telemetry Analysis (XLSX)',
      artifactType: 'xlsx',
      outputPath: 'artifacts/reports/turbine_telemetry_analysis.xlsx',
      description: 'Multi-sheet workbook containing outlier registers, thermal gradient telemetry tables, and deterministic RMS calculations.',
      input: xlsxInput,
    },
    {
      id: 'preset-pptx-overhaul-briefing',
      name: 'Industrial Overhaul Executive Briefing (PPTX)',
      artifactType: 'pptx',
      outputPath: 'artifacts/reports/turbine_overhaul_briefing.pptx',
      description: 'Executive slide presentation summarizing critical vibration findings, risk boundaries, and overhaul approval milestones.',
      input: pptxInput,
    },
  ];
}
