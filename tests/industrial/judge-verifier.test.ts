/**
 * W1: Judge Verifier & Audit Export Verification Test Suite
 *
 * Verifies the "don't trust it — verify it" operator and judge journey:
 * 1. Valid authentic audit export passes with run ID, record count, and evidence hashes.
 * 2. Tampered numeric values fail closed with exact hash mismatch reporting.
 * 3. Tampered record hashes fail closed.
 * 4. Broken sequence numbers fail closed.
 * 5. Altered deliverable artifacts fail closed.
 * 6. Missing or malformed export inputs fail closed.
 * 7. Original artifact is never modified under any verification path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { createServiceContainer, ServiceContainer } from '../../src/service';
import {
  executeJudgedRun,
  verifyAuditExport,
  AuditExportVerificationResult,
} from '../../src/industrial/judged-run';
import {
  runIndustrialVerify,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('W1: Judge Audit Export Verifier', () => {
  let testProjectRoot: string;
  let services: ServiceContainer;
  let validExportPath: string;
  let validExportSha256: string;
  let runId: string;

  beforeAll(async () => {
    testProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-w1-verifier-'));
    fs.mkdirSync(path.join(testProjectRoot, '.maos'), { recursive: true });
    fs.writeFileSync(
      path.join(testProjectRoot, '.maos', 'maos.config.json'),
      JSON.stringify({ projectName: 'w1-verifier-test' }, null, 2),
    );

    const demoDir = path.join(testProjectRoot, 'demo', 'industrial');
    fs.mkdirSync(demoDir, { recursive: true });
    for (const name of [
      'safety_thresholds.json',
      'turbine_vibration_log.csv',
      'maintenance_report.txt',
      'turbine_inspection_scan.pdf',
    ]) {
      fs.copyFileSync(path.join(REPO_ROOT, 'demo', 'industrial', name), path.join(demoDir, name));
    }

    services = createServiceContainer(testProjectRoot);
    const runResult = await executeJudgedRun({
      projectRoot: testProjectRoot,
      services,
      autoApprove: true,
      yes: true,
      json: true,
    });

    expect(runResult.success).toBe(true);
    expect(runResult.auditExportPath).toBeDefined();

    runId = runResult.runId;
    validExportPath = path.join(testProjectRoot, runResult.auditExportPath!);
    expect(fs.existsSync(validExportPath)).toBe(true);

    validExportSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(validExportPath))
      .digest('hex');
  });

  afterAll(() => {
    if (testProjectRoot && fs.existsSync(testProjectRoot)) {
      fs.rmSync(testProjectRoot, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Valid Authentic Export Passes
  // ─────────────────────────────────────────────────────────────

  describe('1. Valid Export Verification', () => {
    it('verifies the original export and reports PASS with runId, record count, and hashes', () => {
      const result: AuditExportVerificationResult = verifyAuditExport(validExportPath, {
        projectRoot: testProjectRoot,
        services,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.runId).toBe(runId);
      expect(result.recordCount).toBeGreaterThan(0);
      expect(result.latestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.exportSha256).toBe(validExportSha256);
      expect(result.deliverableVerified).toBe(true);
      expect(result.manifestVerified).toBe(true);
      expect(result.deliverablePath).toBe('artifacts/generated/turbine_safety_approval_note.docx');
    });

    it('verifies via CLI runIndustrialVerify with target export', async () => {
      const cliResult = await runIndustrialVerify({
        target: 'export',
        exportPath: validExportPath,
        projectRoot: testProjectRoot,
        services,
        json: true,
      });

      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(cliResult.message).toContain('verified');
      const data = cliResult.data as any;
      expect(data?.verification?.valid).toBe(true);
      expect(data?.verification?.runId).toBe(runId);
    });

    it('verifies via CLI runIndustrialVerify when target is the JSON file path', async () => {
      const cliResult = await runIndustrialVerify({
        target: validExportPath as any,
        projectRoot: testProjectRoot,
        services,
        json: true,
      });

      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      const data = cliResult.data as any;
      expect(data?.verification?.valid).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Tampered Export Fails Closed
  // ─────────────────────────────────────────────────────────────

  describe('2. Tampered Export Fails Closed', () => {
    it('fails closed when exactly one numeric field is changed in a temporary copy', () => {
      const copyPath = path.join(testProjectRoot, 'tampered-numeric.json');
      const data = JSON.parse(fs.readFileSync(validExportPath, 'utf8'));

      // Find record with numeric data and alter it
      let targetRecord: any = null;
      for (const r of data.records) {
        if (r.data && typeof r.data === 'object') {
          for (const [k, v] of Object.entries(r.data)) {
            if (typeof v === 'number') {
              targetRecord = r;
              r.data[k] = v + 1; // alter single number
              break;
            }
          }
          if (targetRecord) break;
        }
      }
      expect(targetRecord).not.toBeNull();
      fs.writeFileSync(copyPath, JSON.stringify(data, null, 2), 'utf8');

      const result = verifyAuditExport(copyPath, {
        projectRoot: testProjectRoot,
        services,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Rust engine reports the exact hash mismatch
      expect(result.errors.some((e) => e.includes('hash mismatch') || e.includes('possible modification'))).toBe(true);

      fs.unlinkSync(copyPath);
    });

    it('fails closed when a record hash is tampered', () => {
      const copyPath = path.join(testProjectRoot, 'tampered-hash.json');
      const data = JSON.parse(fs.readFileSync(validExportPath, 'utf8'));

      // Alter hash of record 1
      data.records[1].hash = 'a'.repeat(64);
      fs.writeFileSync(copyPath, JSON.stringify(data, null, 2), 'utf8');

      const result = verifyAuditExport(copyPath, {
        projectRoot: testProjectRoot,
        services,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.errors.some(
          (e) => e.includes('hash mismatch') || e.includes('link break') || e.includes('previous_hash'),
        ),
      ).toBe(true);

      fs.unlinkSync(copyPath);
    });

    it('fails closed when a record sequence number is broken', () => {
      const copyPath = path.join(testProjectRoot, 'tampered-sequence.json');
      const data = JSON.parse(fs.readFileSync(validExportPath, 'utf8'));

      // Break sequence of record 2
      data.records[2].sequence = 999;
      fs.writeFileSync(copyPath, JSON.stringify(data, null, 2), 'utf8');

      const result = verifyAuditExport(copyPath, {
        projectRoot: testProjectRoot,
        services,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Sequence continuity break') || e.includes('sequence'))).toBe(true);

      fs.unlinkSync(copyPath);
    });

    it('fails closed when the associated deliverable file hash is altered', () => {
      // Modify deliverable docx on disk temporarily
      const deliverablePath = path.join(testProjectRoot, 'artifacts/generated/turbine_safety_approval_note.docx');
      const originalDeliverableBytes = fs.readFileSync(deliverablePath);

      // Append 1 byte to alter SHA-256
      fs.appendFileSync(deliverablePath, Buffer.from([0x00]));

      try {
        const result = verifyAuditExport(validExportPath, {
          projectRoot: testProjectRoot,
          services,
        });

        expect(result.valid).toBe(false);
        expect(result.deliverableVerified).toBe(false);
        expect(result.errors.some((e) => e.includes('Deliverable hash mismatch'))).toBe(true);
      } finally {
        // Restore deliverable
        fs.writeFileSync(deliverablePath, originalDeliverableBytes);
      }
    });

    it('fails closed when export header declared latestHash disagrees with chain', () => {
      const copyPath = path.join(testProjectRoot, 'tampered-header.json');
      const data = JSON.parse(fs.readFileSync(validExportPath, 'utf8'));

      if (data.verification) {
        data.verification.latestHash = 'f'.repeat(64);
      }
      fs.writeFileSync(copyPath, JSON.stringify(data, null, 2), 'utf8');

      const result = verifyAuditExport(copyPath, {
        projectRoot: testProjectRoot,
        services,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('latestHash'))).toBe(true);

      fs.unlinkSync(copyPath);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Missing and Malformed Inputs Fail Closed
  // ─────────────────────────────────────────────────────────────

  describe('3. Missing and Malformed Inputs Fail Closed', () => {
    it('fails closed on non-existent export path', () => {
      const nonExistent = path.join(testProjectRoot, 'does-not-exist.json');
      const result = verifyAuditExport(nonExistent, { projectRoot: testProjectRoot, services });

      expect(result.valid).toBe(false);
      expect(result.recordCount).toBe(0);
      expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
    });

    it('fails closed on malformed JSON file', () => {
      const malformedPath = path.join(testProjectRoot, 'malformed.json');
      fs.writeFileSync(malformedPath, '{ "records": [ invalid json syntax', 'utf8');

      const result = verifyAuditExport(malformedPath, { projectRoot: testProjectRoot, services });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('not valid JSON'))).toBe(true);

      fs.unlinkSync(malformedPath);
    });

    it('fails closed when records array is missing', () => {
      const missingRecordsPath = path.join(testProjectRoot, 'missing-records.json');
      fs.writeFileSync(missingRecordsPath, JSON.stringify({ note: 'no records' }), 'utf8');

      const result = verifyAuditExport(missingRecordsPath, { projectRoot: testProjectRoot, services });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('missing "records" array'))).toBe(true);

      fs.unlinkSync(missingRecordsPath);
    });

    it('fails closed when records array is empty', () => {
      const emptyRecordsPath = path.join(testProjectRoot, 'empty-records.json');
      fs.writeFileSync(emptyRecordsPath, JSON.stringify({ records: [] }), 'utf8');

      const result = verifyAuditExport(emptyRecordsPath, { projectRoot: testProjectRoot, services });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('zero records'))).toBe(true);

      fs.unlinkSync(emptyRecordsPath);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Artifact Preservation Invariant
  // ─────────────────────────────────────────────────────────────

  describe('4. Original Artifact Preservation', () => {
    it('strictly preserves the original export artifact SHA-256 after all verifications', () => {
      const postTestSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(validExportPath))
        .digest('hex');

      expect(postTestSha256).toBe(validExportSha256);
    });
  });
});
