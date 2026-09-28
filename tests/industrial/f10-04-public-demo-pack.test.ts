import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

describe('F10-04: Public Demo Pack Finalization & Provenance', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const demoDir = path.join(projectRoot, 'demo', 'industrial');
  const provenancePath = path.join(demoDir, 'DEMO_PACK_PROVENANCE.json');

  it('provides a valid DEMO_PACK_PROVENANCE.json manifest', () => {
    expect(fs.existsSync(provenancePath)).toBe(true);
    const raw = fs.readFileSync(provenancePath, 'utf8');
    const manifest = JSON.parse(raw);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packId).toBe('MAOS-INDUSTRIAL-PUBLIC-DEMO-PACK-V1');
    expect(manifest.license).toBe('CC0-1.0 Universal');
    expect(manifest.clearancePolicy.noProprietaryOrConfidentialData).toBe(true);
    expect(manifest.clearancePolicy.noMrplDataPresent).toBe(true);
    expect(manifest.clearancePolicy.regulatoryDisclaimerMandatory).toBe(true);
    expect(manifest.clearancePolicy.disclaimer).toContain('Hackathon demonstration rules only');
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(manifest.assets.length).toBeGreaterThanOrEqual(10);
  });

  it('guarantees cryptographic SHA-256 integrity for every cataloged asset', () => {
    const raw = fs.readFileSync(provenancePath, 'utf8');
    const manifest = JSON.parse(raw);

    for (const asset of manifest.assets) {
      const assetPath = path.join(projectRoot, asset.relativePath);
      expect(fs.existsSync(assetPath), `Asset file should exist: ${asset.relativePath}`).toBe(true);

      const buffer = fs.readFileSync(assetPath);
      const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');

      expect(computedHash).toBe(asset.sha256);
      expect(buffer.length).toBe(asset.byteSize);
    }
  });

  describe('Telemetry & Ground Truth Concordance', () => {
    const csvPath = path.join(demoDir, 'turbine_vibration_log.csv');
    const expectedPath = path.join(demoDir, 'expected_findings.json');
    const thresholdsPath = path.join(demoDir, 'safety_thresholds.json');
    const truthPath = path.join(demoDir, 'ground_truth.json');

    it('validates 500-row telemetry dataset with exact CSV columns', () => {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines.length).toBe(501); // 1 header + 500 data rows

      const header = lines[0].split(',');
      expect(header).toContain('timestamp');
      expect(header).toContain('vibration_rms_mm_s');
      expect(header).toContain('bearing_temperature_c');
    });

    it('verifies expected findings match actual CSV rows, fields, and values', () => {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.trim().split(/\r?\n/);
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

      expect(expected.dataset).toBe('turbine_vibration_log.csv');
      expect(expected.dataRows).toBe(500);
      expect(expected.expectedOverallVerdict).toBe('FAIL');

      const header = lines[0].split(',');
      const colMap: Record<string, number> = {};
      header.forEach((name, idx) => {
        colMap[name.trim()] = idx;
      });

      for (const finding of expected.documentedAnomalies) {
        const rowLine = lines[finding.row]; // 1-based index maps to lines[finding.row]
        expect(rowLine, `Row line ${finding.row} should exist`).toBeDefined();
        const cols = rowLine.split(',');

        const actualTimestamp = cols[colMap['timestamp']];
        const actualValue = parseFloat(cols[colMap[finding.field]]);

        expect(actualTimestamp).toBe(finding.timestamp);
        expect(actualValue).toBe(finding.value);
      }
    });

    it('verifies ground_truth.json aligns with safety thresholds and calculated RMS', () => {
      const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
      const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));

      expect(truth.telemetry.rowCount).toBe(500);
      expect(truth.telemetry.overallRmsVibrationRounded).toBe(2.63711);
      expect(truth.telemetry.vibrationThresholds.warning).toBe(thresholds.thresholds.vibration_rms_mm_s.warning);
      expect(truth.telemetry.vibrationThresholds.critical).toBe(thresholds.thresholds.vibration_rms_mm_s.critical);
      expect(truth.telemetry.expectedSummary.overallVerdict).toBe('FAIL');
    });
  });

  describe('Licensed Documents & Multimodal Images', () => {
    it('verifies licensed scan PDF is valid and has expected header', () => {
      const scanPath = path.join(demoDir, 'turbine_inspection_scan.pdf');
      expect(fs.existsSync(scanPath)).toBe(true);
      const buffer = fs.readFileSync(scanPath);
      // PDF magic bytes %PDF-
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('verifies SOP document contains mandatory disclaimer and procedure sections', () => {
      const sopPath = path.join(demoDir, 'sop_turbine_vibration_monitoring.md');
      expect(fs.existsSync(sopPath)).toBe(true);
      const content = fs.readFileSync(sopPath, 'utf8');

      expect(content).toContain('HACKATHON DEMONSTRATION RULES ONLY; NOT A CERTIFIED STANDARD OR OPERATING AUTHORIZATION');
      expect(content).toContain('Negative Clearance');
      expect(content).toContain('Evaluation Thresholds');
      expect(content).toContain('Multimodal Evidence Cross-Verification Protocol');
      expect(content).toContain('Sovereign Governance & Human Review Gate');
    });

    it('verifies multimodal demo images are valid PNGs with magic header', () => {
      const imageFiles = ['pid_drawing.png', 'pressure_gauge.png', 'turbine_nameplate.png'];

      for (const file of imageFiles) {
        const imgPath = path.join(demoDir, 'images', file);
        expect(fs.existsSync(imgPath), `Image ${file} should exist`).toBe(true);
        const buffer = fs.readFileSync(imgPath);
        // PNG magic bytes \x89PNG\r\n\x1a\n
        expect(buffer[0]).toBe(0x89);
        expect(buffer[1]).toBe(0x50); // 'P'
        expect(buffer[2]).toBe(0x4e); // 'N'
        expect(buffer[3]).toBe(0x47); // 'G'
      }
    });
  });

  describe('Negative Clearance & Non-Proprietary Invariants', () => {
    it('verifies zero confidential refinery or MRPL data exists across demo pack', () => {
      const allFiles = fs.readdirSync(demoDir, { recursive: true, withFileTypes: true });

      for (const entry of allFiles) {
        if (!entry.isFile()) continue;
        const filePath = path.join(entry.parentPath || (entry as any).path, entry.name);
        // Skip binary files (pdf, png) for text search
        if (filePath.endsWith('.png') || filePath.endsWith('.pdf')) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toMatch(/mangalore\s+refinery/i);
        expect(content).not.toMatch(/mrpl-confidential/i);
        expect(content).not.toMatch(/strictly\s+confidential/i);
        expect(content).not.toMatch(/proprietary\s+and\s+confidential/i);
      }
    });

    it('verifies all threshold files include the non-commercial demonstration disclaimer', () => {
      const thresholds = JSON.parse(fs.readFileSync(path.join(demoDir, 'safety_thresholds.json'), 'utf8'));
      expect(thresholds.disclaimer).toContain('Hackathon demonstration rules only');

      const truth = JSON.parse(fs.readFileSync(path.join(demoDir, 'ground_truth.json'), 'utf8'));
      expect(truth.disclaimer).toContain('Hackathon demonstration rules only');
    });

    it('preserves canary hash byte-for-byte', () => {
      const canaryPath = path.join(projectRoot, 'rust', 'test.txt');
      const content = fs.readFileSync(canaryPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe('1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435');
    });
  });
});
