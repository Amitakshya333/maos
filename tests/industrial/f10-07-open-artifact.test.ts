/**
 * F10-07: Open-Artifact Integration Test Suite
 *
 * Validates safe, authenticated local deliverable opening using installed
 * desktop office applications (Microsoft Office / LibreOffice / system viewer).
 *
 * Strict Negative & Safety Invariants:
 * 1. Zero shell injection: Rejects command separators, redirection, control characters.
 * 2. Strictly local artifacts: Rejects remote URLs (http, https, ftp, file, UNC shares).
 * 3. Strict containment: Rejects path traversal (..) escaping projectRoot.
 * 4. Strictly allowed extensions: Only .docx, .xlsx, .pptx, .pdf.
 * 5. Rejects executable types: No .exe, .bat, .cmd, .ps1, .sh, .vbs, etc.
 * 6. Explicit user action only: No implicit/automatic execution without explicit command.
 * 7. No embedded editor claim: Explicitly documents delegation to installed desktop office software.
 * 8. Cryptographic verification: Calculates SHA-256 and detects tampering against artifact registry.
 * 9. Privacy-preserving audit: Emits ARTIFACT_OPENED audit event with deliverable hash and path.
 * 10. Mandatory preservation of canary hash (rust/test.txt).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  openLocalArtifact,
  validateOpenTargetSafety,
  formulateLaunchCommand,
  ALLOWED_DELIVERABLE_EXTENSIONS,
  NO_EMBEDDED_EDITOR_DISCLAIMER,
} from '../../src/industrial/open-artifact';
import {
  runIndustrialOpen,
  INDUSTRIAL_CLI_EXIT,
} from '../../src/industrial/industrial-cli';
import { createServiceContainer } from '../../src/service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('F10-07: Open-Artifact Integration', () => {
  const testTmpDir = path.resolve(PROJECT_ROOT, '.maos', 'tmp', `f10-07-test-${Date.now()}`);

  beforeEach(() => {
    // Assert canary invariant prior to each test
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);

    if (!fs.existsSync(testTmpDir)) {
      fs.mkdirSync(testTmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up temporary test files
    if (fs.existsSync(testTmpDir)) {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    }

    // Assert canary invariant after each test
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Target Safety Validation (Unit)
  // ══════════════════════════════════════════════════════════════

  describe('1. Target Safety Validation', () => {
    it('approves clean relative paths', () => {
      const check = validateOpenTargetSafety('artifacts/generated/turbine_safety_approval_note.docx');
      expect(check.valid).toBe(true);
      expect(check.reason).toBeUndefined();
    });

    it('approves alphanumeric artifact IDs', () => {
      const check = validateOpenTargetSafety('art-turbine-note-2026');
      expect(check.valid).toBe(true);
    });

    it('rejects empty or whitespace targets', () => {
      expect(validateOpenTargetSafety('').valid).toBe(false);
      expect(validateOpenTargetSafety('   ').valid).toBe(false);
    });

    it('rejects http/https/ftp/file URLs (REMOTE_URL_FORBIDDEN)', () => {
      const urls = [
        'http://example.com/doc.docx',
        'https://malicious.org/report.xlsx',
        'ftp://internal.repo/data.pdf',
        'file:///c:/secret/doc.docx',
        'smb://server/share/file.docx',
      ];
      for (const url of urls) {
        const check = validateOpenTargetSafety(url);
        expect(check.valid).toBe(false);
        expect(check.reason).toContain('REMOTE_URL_FORBIDDEN');
      }
    });

    it('rejects UNC network paths (REMOTE_URL_FORBIDDEN)', () => {
      const uncPaths = [
        '\\\\attacker-srv\\share\\doc.docx',
        '//attacker-srv/share/doc.docx',
      ];
      for (const unc of uncPaths) {
        const check = validateOpenTargetSafety(unc);
        expect(check.valid).toBe(false);
        expect(check.reason).toContain('REMOTE_URL_FORBIDDEN');
      }
    });

    it('rejects shell injection characters (SHELL_INJECTION_DETECTED)', () => {
      const injections = [
        'doc.docx; calc.exe',
        'doc.docx & notepad.exe',
        'doc.docx | whoami',
        'doc.docx `calc`',
        'doc.docx $(calc)',
        'doc.docx > out.txt',
        'doc.docx < in.txt',
        'doc.docx\0evil.bat',
        'doc.docx\nevil.bat',
        'doc.docx\revil.bat',
      ];
      for (const inj of injections) {
        const check = validateOpenTargetSafety(inj);
        expect(check.valid).toBe(false);
        expect(check.reason).toContain('SHELL_INJECTION_DETECTED');
      }
    });

    it('rejects directory traversal sequences (PATH_TRAVERSAL_DETECTED)', () => {
      const traversals = [
        '../secret.docx',
        '..\\secret.docx',
        'artifacts/../../system32/cmd.exe',
        'nested/dir/../../../etc/passwd',
      ];
      for (const trav of traversals) {
        const check = validateOpenTargetSafety(trav);
        expect(check.valid).toBe(false);
        expect(check.reason).toContain('PATH_TRAVERSAL_DETECTED');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Launch Command Formulation Across Platforms
  // ══════════════════════════════════════════════════════════════

  describe('2. Launch Command Formulation', () => {
    const docxPath = 'C:\\maos\\artifacts\\generated\\test.docx';
    const xlsxPath = 'C:\\maos\\artifacts\\generated\\test.xlsx';
    const pptxPath = 'C:\\maos\\artifacts\\generated\\test.pptx';

    it('formulates Windows default desktop launch command using cmd.exe start', () => {
      const { command, args } = formulateLaunchCommand(docxPath, 'auto', 'win32');
      expect(command).toBe('cmd.exe');
      expect(args).toEqual(['/c', 'start', '', docxPath]);
    });

    it('formulates Windows Microsoft Office specific commands', () => {
      const docxCmd = formulateLaunchCommand(docxPath, 'office', 'win32');
      expect(docxCmd.command).toBe('winword');
      expect(docxCmd.args).toEqual([docxPath]);

      const xlsxCmd = formulateLaunchCommand(xlsxPath, 'office', 'win32');
      expect(xlsxCmd.command).toBe('excel');
      expect(xlsxCmd.args).toEqual([xlsxPath]);

      const pptxCmd = formulateLaunchCommand(pptxPath, 'office', 'win32');
      expect(pptxCmd.command).toBe('powerpnt');
      expect(pptxCmd.args).toEqual([pptxPath]);
    });

    it('formulates Windows LibreOffice command', () => {
      const { command, args } = formulateLaunchCommand(docxPath, 'libreoffice', 'win32');
      expect(command).toBe('soffice');
      expect(args).toEqual([docxPath]);
    });

    it('formulates macOS open command', () => {
      const autoCmd = formulateLaunchCommand('/path/to/test.docx', 'auto', 'darwin');
      expect(autoCmd.command).toBe('open');
      expect(autoCmd.args).toEqual(['/path/to/test.docx']);

      const libreCmd = formulateLaunchCommand('/path/to/test.docx', 'libreoffice', 'darwin');
      expect(libreCmd.command).toBe('open');
      expect(libreCmd.args).toEqual(['-a', 'LibreOffice', '/path/to/test.docx']);
    });

    it('formulates Linux xdg-open / libreoffice command', () => {
      const autoCmd = formulateLaunchCommand('/path/to/test.docx', 'auto', 'linux');
      expect(autoCmd.command).toBe('xdg-open');
      expect(autoCmd.args).toEqual(['/path/to/test.docx']);

      const libreCmd = formulateLaunchCommand('/path/to/test.docx', 'libreoffice', 'linux');
      expect(libreCmd.command).toBe('libreoffice');
      expect(libreCmd.args).toEqual(['/path/to/test.docx']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Dry-Run Deliverable Opening (Positive Path)
  // ══════════════════════════════════════════════════════════════

  describe('3. Positive Path Deliverable Opening (Dry Run)', () => {
    it('validates existing turbine_safety_approval_note.docx in dry-run mode', async () => {
      const targetPath = 'artifacts/generated/turbine_safety_approval_note.docx';
      const absPath = path.resolve(PROJECT_ROOT, targetPath);

      // Verify file exists
      expect(fs.existsSync(absPath)).toBe(true);
      const expectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: targetPath,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.dryRun).toBe(true);
      expect(result.launched).toBe(false);
      expect(result.fileExtension).toBe('.docx');
      expect(result.sha256).toBe(expectedSha256);
      expect(result.disclaimer).toBe(NO_EMBEDDED_EDITOR_DISCLAIMER);
      expect(result.command).toBeDefined();
      expect(result.args).toBeDefined();
    });

    it('validates existing PDF scan in dry-run mode', async () => {
      const targetPath = 'demo/industrial/turbine_inspection_scan.pdf';
      const absPath = path.resolve(PROJECT_ROOT, targetPath);

      expect(fs.existsSync(absPath)).toBe(true);
      const expectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: targetPath,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(result.fileExtension).toBe('.pdf');
      expect(result.sha256).toBe(expectedSha256);
      expect(result.disclaimer).toBe(NO_EMBEDDED_EDITOR_DISCLAIMER);
    });

    it('validates XLSX and PPTX deliverables in dry-run mode', async () => {
      const relXlsx = path.relative(PROJECT_ROOT, path.join(testTmpDir, 'report.xlsx'));
      const relPptx = path.relative(PROJECT_ROOT, path.join(testTmpDir, 'briefing.pptx'));

      // Create dummy valid non-empty files
      fs.writeFileSync(path.resolve(PROJECT_ROOT, relXlsx), 'PK\x03\x04mock-xlsx-content');
      fs.writeFileSync(path.resolve(PROJECT_ROOT, relPptx), 'PK\x03\x04mock-pptx-content');

      const xlsxResult = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: relXlsx,
        dryRun: true,
      });
      expect(xlsxResult.success).toBe(true);
      expect(xlsxResult.fileExtension).toBe('.xlsx');

      const pptxResult = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: relPptx,
        dryRun: true,
      });
      expect(pptxResult.success).toBe(true);
      expect(pptxResult.fileExtension).toBe('.pptx');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Artifact ID Resolution & Tamper Detection
  // ══════════════════════════════════════════════════════════════

  describe('4. Artifact Registry Resolution & Tamper Detection', () => {
    it('resolves deliverable by registered artifact ID and checks hash', async () => {
      const services = createServiceContainer(PROJECT_ROOT);
      const testFileRel = path.relative(PROJECT_ROOT, path.join(testTmpDir, 'registered_doc.docx'));
      const testContent = Buffer.from('PK\x03\x04synthetic-docx-data-for-f10-07');
      const artifactId = `art_test_${Date.now()}`;

      // Finalize in artifact service
      const artifact = services.artifact.finalizeArtifact({
        id: artifactId,
        taskId: 'f10-07-test-task',
        relativePath: testFileRel,
        content: testContent,
        type: 'file',
      });

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: artifactId,
        services,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.artifactId).toBe(artifactId);
      expect(result.resolvedRelativePath?.replace(/\\/g, '/')).toBe(testFileRel.replace(/\\/g, '/'));
      expect(result.sha256).toBe(artifact.hash);
    });

    it('detects tampering when on-disk file hash differs from registered artifact hash', async () => {
      const services = createServiceContainer(PROJECT_ROOT);
      const testFileRel = path.relative(PROJECT_ROOT, path.join(testTmpDir, 'tampered_doc.docx'));
      const testFileAbs = path.resolve(PROJECT_ROOT, testFileRel);
      const originalContent = Buffer.from('PK\x03\x04original-docx-data');
      const artifactId = `art_tamper_${Date.now()}`;

      // Finalize original artifact
      services.artifact.finalizeArtifact({
        id: artifactId,
        taskId: 'f10-07-test-task',
        relativePath: testFileRel,
        content: originalContent,
        type: 'file',
      });

      // Now tamper with the file on disk
      fs.writeFileSync(testFileAbs, Buffer.from('PK\x03\x04TAMPERED-CONTENT-MALICIOUS-MODIFICATION'));

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: artifactId,
        services,
        dryRun: true,
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.FAILURE);
      expect(result.message).toContain('TAMPER_DETECTED');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Negative Security & Confinement Invariants
  // ══════════════════════════════════════════════════════════════

  describe('5. Negative Security & Confinement Invariants', () => {
    it('rejects remote URLs with exit code 2 (INVALID_ARGS)', async () => {
      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: 'https://evil.com/malicious.docx',
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(result.message).toContain('REMOTE_URL_FORBIDDEN');
    });

    it('rejects shell injection with exit code 2 (INVALID_ARGS)', async () => {
      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: 'doc.docx; calc.exe',
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(result.message).toContain('SHELL_INJECTION_DETECTED');
    });

    it('rejects directory traversal escaping project containment with exit code 2', async () => {
      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: '../../windows/system32/cmd.exe',
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(result.message).toContain('PATH_TRAVERSAL_DETECTED');
    });

    it('rejects executable formats (.exe, .bat, .cmd, .ps1, .sh, etc.)', async () => {
      const forbiddenExts = ['test.exe', 'test.bat', 'test.cmd', 'test.ps1', 'test.sh', 'test.vbs', 'test.js'];
      for (const f of forbiddenExts) {
        const result = await openLocalArtifact({
          projectRoot: PROJECT_ROOT,
          target: f,
          dryRun: true,
        });
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
        expect(result.message).toContain('UNSUPPORTED_ARTIFACT_TYPE');
      }
    });

    it('rejects non-existent file with exit code 11 (NOT_FOUND)', async () => {
      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: 'artifacts/generated/nonexistent_file_xyz_12345.docx',
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.NOT_FOUND);
      expect(result.message).toContain('NOT_FOUND');
    });

    it('rejects 0-byte empty file with exit code 1 (FAILURE)', async () => {
      const emptyRel = path.relative(PROJECT_ROOT, path.join(testTmpDir, 'empty.docx'));
      fs.writeFileSync(path.resolve(PROJECT_ROOT, emptyRel), '');

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: emptyRel,
        dryRun: true,
      });
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(INDUSTRIAL_CLI_EXIT.FAILURE);
      expect(result.message).toContain('INVALID_FILE');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Audit Logging & Disclaimer Assertions
  // ══════════════════════════════════════════════════════════════

  describe('6. Audit Logging & Disclaimer Verification', () => {
    it('records ARTIFACT_OPENED audit event with delivery hash upon open', async () => {
      const services = createServiceContainer(PROJECT_ROOT);
      const targetPath = 'artifacts/generated/turbine_safety_approval_note.docx';

      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: targetPath,
        services,
        dryRun: true,
      });

      expect(result.success).toBe(true);

      const records = services.audit.getRecords();
      const openEvents = records.filter((r) => (r.data as any)?.event === 'ARTIFACT_OPENED');
      expect(openEvents.length).toBeGreaterThan(0);

      const latestEvent = openEvents[openEvents.length - 1];
      expect(latestEvent.source).toBe('open-artifact');
      expect((latestEvent.data as any).target).toBe(targetPath);
      expect((latestEvent.data as any).sha256).toBe(result.sha256);
      expect((latestEvent.data as any).dryRun).toBe(true);
    });

    it('always includes explicit no-embedded-editor disclaimer', async () => {
      const result = await openLocalArtifact({
        projectRoot: PROJECT_ROOT,
        target: 'artifacts/generated/turbine_safety_approval_note.docx',
        dryRun: true,
      });
      expect(result.disclaimer).toBe(NO_EMBEDDED_EDITOR_DISCLAIMER);
      expect(result.disclaimer).toContain('delegates viewing/editing to installed desktop office applications');
      expect(result.disclaimer).toContain('No embedded editor claim');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Industrial CLI Command Wrapper (runIndustrialOpen)
  // ══════════════════════════════════════════════════════════════

  describe('7. Industrial CLI Command Wrapper (runIndustrialOpen)', () => {
    it('executes CLI wrapper successfully with valid deliverable in json mode', async () => {
      const cliResult = await runIndustrialOpen({
        projectRoot: PROJECT_ROOT,
        target: 'artifacts/generated/turbine_safety_approval_note.docx',
        dryRun: true,
        json: true,
      });

      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect(cliResult.data).toBeDefined();
      expect((cliResult.data as any).dryRun).toBe(true);
      expect((cliResult.data as any).fileExtension).toBe('.docx');
      expect((cliResult.data as any).disclaimer).toBe(NO_EMBEDDED_EDITOR_DISCLAIMER);
    });

    it('returns exit code 2 on invalid target via CLI wrapper', async () => {
      const cliResult = await runIndustrialOpen({
        projectRoot: PROJECT_ROOT,
        target: 'http://malicious.org/sheet.xlsx',
        dryRun: true,
        json: true,
      });

      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.INVALID_ARGS);
      expect(cliResult.message).toContain('REMOTE_URL_FORBIDDEN');
    });

    it('returns exit code 11 on missing target via CLI wrapper', async () => {
      const cliResult = await runIndustrialOpen({
        projectRoot: PROJECT_ROOT,
        target: 'artifacts/generated/does_not_exist.docx',
        dryRun: true,
        json: true,
      });

      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.NOT_FOUND);
      expect(cliResult.message).toContain('NOT_FOUND');
    });
  });
});
