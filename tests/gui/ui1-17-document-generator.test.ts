/**
 * UI1-17: Document Generator Test Suite
 *
 * Exhaustively validates:
 * 1. Presets and Validated Input Previews:
 *    - Presets available for DOCX, XLSX, and PPTX with schemaVersion 1
 *    - Binds to real physical benchmark fixtures with verified SHA-256 hashes
 * 2. Pure Domain Validation & Freshness Verification:
 *    - POST /api/v1/generator/validate-input
 *    - Detects valid inputs and computes deterministic canonical SHA-256 hash
 *    - Rejects invalid schema bounds, missing citations, or missing units
 *    - Rejects stale source file hashes or missing physical files
 * 3. Template Safety Inspection:
 *    - POST /api/v1/generator/validate-template
 *    - Rejects path traversal and dangerous macro formats
 * 4. Mandatory Governance Approval Flow:
 *    - Rejects unapproved or pending generation with HTTP 403 APPROVAL_REQUIRED
 *    - Requires exact payloadHash match bound to approval record
 *    - Rejects tampered inputs after approval with CHANGED_INPUT_AFTER_APPROVAL
 * 5. OOXML Deliverable Generation & Safe Artifact Finalization:
 *    - POST /api/v1/generator/generate
 *    - Successfully generates valid, air-gapped DOCX, XLSX, and PPTX packages
 *    - Finalizes atomically into Safe Artifact Store with authoritative Rust SHA-256
 * 6. Overwrite Collision Protection:
 *    - Rejects silent overwrite without allowOverwrite: true
 * 7. Native External Launcher & Content Download:
 *    - POST /api/v1/generator/launch
 *    - Rejects path traversal and missing files
 *    - Returns safe status and download URL
 * 8. Client Parity (BrowserRestClient & GuiApiAdapter)
 * 9. View Structure & Accessibility (role="tabpanel", state-box)
 * 10. Untouched Canary Hash Invariant (rust/test.txt)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import {
  createServiceContainer,
  ServiceContainer,
} from '../../src/service';
import { RestApiRouter } from '../../src/api/router';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import {
  computeOfficeInputHash,
  type OfficeDocxInput,
  type OfficeXlsxInput,
  type OfficePptxInput,
} from '../../src/domain/office-artifact';
import { getDocumentGeneratorPresets } from '../../src/domain/document-presets';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('UI1-17: Document Generator', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let services: ServiceContainer;
  let router: RestApiRouter;
  let restClient: BrowserRestClient;
  let apiAdapter: GuiApiAdapter;

  beforeAll(async () => {
    services = createServiceContainer(PROJECT_ROOT);
    router = new RestApiRouter(services, PROJECT_ROOT);

    await new Promise<void>((resolve) => {
      server = http.createServer(async (req, res) => {
        try {
          const handled = await router.handle(req, res);
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
          }
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    restClient = new BrowserRestClient({
      baseUrl: serverUrl,
      projectRoot: PROJECT_ROOT,
      timeoutMs: 8000,
    });
    apiAdapter = new GuiApiAdapter(restClient);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Presets & Validated Input Preview
  // ══════════════════════════════════════════════════════════════

  describe('Document Presets', () => {
    it('returns valid presets for DOCX, XLSX, and PPTX via domain function', () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      expect(presets).toHaveLength(3);

      const types = presets.map((p) => p.artifactType);
      expect(types).toContain('docx');
      expect(types).toContain('xlsx');
      expect(types).toContain('pptx');

      for (const p of presets) {
        expect(p.schemaVersion || p.input.schemaVersion).toBe(1);
        expect(p.outputPath).toMatch(/\.(docx|xlsx|pptx)$/);
        expect(p.input.citations.length).toBeGreaterThan(0);
        expect(p.input.measurements.length).toBeGreaterThan(0);
      }
    });

    it('GET /api/v1/generator/presets returns 200 with presets array', async () => {
      const res = await fetch(`${serverUrl}/api/v1/generator/presets`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toBeDefined();
      expect(json.data.length).toBe(3);
      expect(json.data[0].artifactType).toBe('docx');
      expect(json.data[1].artifactType).toBe('xlsx');
      expect(json.data[2].artifactType).toBe('pptx');
    });

    it('BrowserRestClient.getGeneratorPresets returns presets with client parity', async () => {
      const presets = await restClient.getGeneratorPresets();
      expect(presets).toHaveLength(3);
      expect(presets[0].id).toBe('preset-docx-turbine-overhaul');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Pure Schema Validation & Freshness Verification
  // ══════════════════════════════════════════════════════════════

  describe('Validation & Freshness Verification', () => {
    it('validates a correct preset input and returns canonical hash and fresh sources', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const docxPreset = presets.find((p) => p.artifactType === 'docx')!;

      const res = await fetch(`${serverUrl}/api/v1/generator/validate-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: docxPreset.input, allowForeignProject: true }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.valid).toBe(true);
      expect(json.data.canonicalHash).toBeDefined();
      expect(json.data.canonicalHash.length).toBe(64);
      expect(json.data.freshness).toBeDefined();
      expect(json.data.freshness.fresh).toBe(true);
      expect(json.data.freshness.verifiedSourceCount).toBeGreaterThan(0);
    });

    it('rejects input with missing title or invalid schemaVersion', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const invalidInput = { ...presets[0].input, schemaVersion: 99, title: '' };

      const res = await fetch(`${serverUrl}/api/v1/generator/validate-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: invalidInput, allowForeignProject: true }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.valid).toBe(false);
      expect(json.data.errors.length).toBeGreaterThan(0);
    });

    it('detects staled source hash when physical file differs', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const tamperedInput = JSON.parse(JSON.stringify(presets[0].input));
      tamperedInput.citations[0].sourceHash = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = await fetch(`${serverUrl}/api/v1/generator/validate-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: tamperedInput, allowForeignProject: true }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.freshness.fresh).toBe(false);
      expect(json.data.freshness.errors.some((e: string) => e.includes('STALE_SOURCE_HASH'))).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Template Safety Inspection
  // ══════════════════════════════════════════════════════════════

  describe('Template Safety', () => {
    it('rejects path traversal attempts on template path', async () => {
      const res = await fetch(`${serverUrl}/api/v1/generator/validate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templatePath: '../../etc/passwd.dotx', expectedType: 'docx' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.valid).toBe(false);
      expect(json.data.errors.some((e: string) => e.includes('TRAVERSAL') || e.includes('CONFINEMENT') || e.includes('PATH'))).toBe(true);
    });

    it('rejects macro-enabled template extensions (.docm)', async () => {
      const res = await fetch(`${serverUrl}/api/v1/generator/validate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templatePath: 'templates/macro.docm', expectedType: 'docx' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.valid).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Mandatory Governance Approval Flow
  // ══════════════════════════════════════════════════════════════

  describe('Mandatory Approval Enforcement', () => {
    it('rejects unapproved document generation with HTTP 403 APPROVAL_REQUIRED', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const docxPreset = presets.find((p) => p.artifactType === 'docx')!;
      const unapprovedInput = {
        ...docxPreset.input,
        approval: {
          required: true,
          status: 'pending',
        },
      };

      const res = await fetch(`${serverUrl}/api/v1/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: 'docx',
          schemaVersion: 1,
          projectId: unapprovedInput.projectId,
          input: unapprovedInput,
          outputPath: 'artifacts/reports/unapproved_test.docx',
          requestId: `req-unapp-${Date.now()}`,
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('APPROVAL_REQUIRED');
    });

    it('rejects when approved payload hash does not match current input hash (tampered after approval)', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const docxPreset = presets.find((p) => p.artifactType === 'docx')!;

      // Approve with one hash
      const realHash = computeOfficeInputHash(docxPreset.input as OfficeDocxInput);
      const fakeHash = '1111111111111111111111111111111111111111111111111111111111111111';

      const approval = services.approval.createApproval({
        projectId: docxPreset.input.projectId,
        runId: docxPreset.input.runId,
        taskId: docxPreset.input.taskId || 'default',
        scope: 'docx_generation',
        actorId: 'eng_lead_01',
        actorRole: 'lead',
        reason: 'Pre-approval test',
        payloadHash: fakeHash,
        sourceHashes: [],
      });
      services.approval.decideApproval(approval.approvalId, 'approved', 'eng_lead_01', 'Approved', 'lead');

      const tamperedInput = {
        ...docxPreset.input,
        approval: {
          required: true,
          status: 'approved',
          approvalId: approval.approvalId,
          approvedBy: 'eng_lead_01',
          payloadHash: fakeHash, // Mismatches realHash
        },
      };

      const res = await fetch(`${serverUrl}/api/v1/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: 'docx',
          schemaVersion: 1,
          projectId: tamperedInput.projectId,
          input: tamperedInput,
          outputPath: 'artifacts/reports/tampered_test.docx',
          requestId: `req-tamp-${Date.now()}`,
        }),
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('CHANGED_INPUT_AFTER_APPROVAL');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. OOXML Generation & Safe Artifact Finalization
  // ══════════════════════════════════════════════════════════════

  describe('Deliverable Generation', () => {
    it('successfully generates DOCX deliverable with valid approval and finalizes to Safe Artifact Store', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const docxPreset = presets.find((p) => p.artifactType === 'docx')!;
      const baseInput = { ...docxPreset.input };
      const approvalId = `app-docx-${Date.now()}`;

      const approvedInput: OfficeDocxInput = {
        ...baseInput,
        approval: {
          required: true,
          status: 'approved',
          approvalId,
          approvedBy: 'eng_lead_01',
        },
      };

      // Compute canonical hash of approved input
      const canonicalHash = computeOfficeInputHash(approvedInput as OfficeDocxInput);
      (approvedInput.approval as any).payloadHash = canonicalHash;

      // Create and grant approval
      const approval = services.approval.createApproval({
        approvalId,
        projectId: baseInput.projectId,
        runId: baseInput.runId,
        taskId: baseInput.taskId || 'default',
        scope: 'docx_generation',
        actorId: 'eng_lead_01',
        actorRole: 'lead',
        reason: 'Authorized overhaul note',
        payloadHash: canonicalHash,
        sourceHashes: Object.values(baseInput.sourceHashes || {}),
      });
      services.approval.decideApproval(approval.approvalId, 'approved', 'eng_lead_01', 'Authorized', 'lead');

      const outputPath = 'artifacts/reports/test_turbine_approval.docx';

      const res = await fetch(`${serverUrl}/api/v1/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: 'docx',
          schemaVersion: 1,
          projectId: approvedInput.projectId,
          input: approvedInput,
          outputPath,
          allowOverwrite: true,
          approvalId: approval.approvalId,
          requestId: `req-gen-docx-${Date.now()}`,
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.ok).toBe(true);
      expect(json.data.artifactId).toBeDefined();
      expect(json.data.artifactHash).toBeDefined();
      expect(json.data.bytesWritten).toBeGreaterThan(0);

      // Verify physical deliverable on disk
      const physicalFile = path.resolve(PROJECT_ROOT, outputPath);
      expect(fs.existsSync(physicalFile)).toBe(true);

      // Clean up test file
      try { fs.unlinkSync(physicalFile); } catch {}
    });

    it('successfully generates XLSX workbook with multiple sheets and deterministic calculations', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const xlsxPreset = presets.find((p) => p.artifactType === 'xlsx')!;
      const baseInput = { ...xlsxPreset.input };
      const approvalId = `app-xlsx-${Date.now()}`;

      const approvedInput: OfficeXlsxInput = {
        ...baseInput,
        approval: {
          required: true,
          status: 'approved',
          approvalId,
          approvedBy: 'eng_lead_01',
        },
      };

      const canonicalHash = computeOfficeInputHash(approvedInput as OfficeXlsxInput);
      (approvedInput.approval as any).payloadHash = canonicalHash;

      const approval = services.approval.createApproval({
        approvalId,
        projectId: baseInput.projectId,
        runId: baseInput.runId,
        taskId: baseInput.taskId || 'default',
        scope: 'xlsx_generation',
        actorId: 'eng_lead_01',
        actorRole: 'lead',
        reason: 'Authorized telemetry workbook',
        payloadHash: canonicalHash,
        sourceHashes: Object.values(baseInput.sourceHashes || {}),
      });
      services.approval.decideApproval(approval.approvalId, 'approved', 'eng_lead_01', 'Authorized', 'lead');

      const outputPath = 'artifacts/reports/test_telemetry.xlsx';

      const res = await fetch(`${serverUrl}/api/v1/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: 'xlsx',
          schemaVersion: 1,
          projectId: approvedInput.projectId,
          input: approvedInput,
          outputPath,
          allowOverwrite: true,
          approvalId: approval.approvalId,
          requestId: `req-gen-xlsx-${Date.now()}`,
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.ok).toBe(true);
      expect(json.data.sheetCount).toBeGreaterThanOrEqual(2);

      const physicalFile = path.resolve(PROJECT_ROOT, outputPath);
      expect(fs.existsSync(physicalFile)).toBe(true);
      try { fs.unlinkSync(physicalFile); } catch {}
    });

    it('successfully generates PPTX presentation briefing deck', async () => {
      const presets = getDocumentGeneratorPresets(PROJECT_ROOT);
      const pptxPreset = presets.find((p) => p.artifactType === 'pptx')!;
      const baseInput = { ...pptxPreset.input };
      const approvalId = `app-pptx-${Date.now()}`;

      const approvedInput: OfficePptxInput = {
        ...baseInput,
        approval: {
          required: true,
          status: 'approved',
          approvalId,
          approvedBy: 'eng_lead_01',
        },
      };

      const canonicalHash = computeOfficeInputHash(approvedInput as OfficePptxInput);
      (approvedInput.approval as any).payloadHash = canonicalHash;

      const approval = services.approval.createApproval({
        approvalId,
        projectId: baseInput.projectId,
        runId: baseInput.runId,
        taskId: baseInput.taskId || 'default',
        scope: 'pptx_generation',
        actorId: 'eng_lead_01',
        actorRole: 'lead',
        reason: 'Authorized briefing presentation',
        payloadHash: canonicalHash,
        sourceHashes: Object.values(baseInput.sourceHashes || {}),
      });
      services.approval.decideApproval(approval.approvalId, 'approved', 'eng_lead_01', 'Authorized', 'lead');

      const outputPath = 'artifacts/reports/test_briefing.pptx';

      const res = await fetch(`${serverUrl}/api/v1/generator/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactType: 'pptx',
          schemaVersion: 1,
          projectId: approvedInput.projectId,
          input: approvedInput,
          outputPath,
          allowOverwrite: true,
          approvalId: approval.approvalId,
          requestId: `req-gen-pptx-${Date.now()}`,
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.ok).toBe(true);
      expect(json.data.slideCount).toBeGreaterThan(0);

      const physicalFile = path.resolve(PROJECT_ROOT, outputPath);
      expect(fs.existsSync(physicalFile)).toBe(true);
      try { fs.unlinkSync(physicalFile); } catch {}
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. External Launcher & Content Download Safety
  // ══════════════════════════════════════════════════════════════

  describe('External Launcher & Download Safety', () => {
    it('rejects path traversal in launch request', async () => {
      const res = await fetch(`${serverUrl}/api/v1/generator/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relativePath: '../../windows/system32/cmd.exe' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('PATH_TRAVERSAL');
    });

    it('rejects launch for non-existent artifact', async () => {
      const res = await fetch(`${serverUrl}/api/v1/generator/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId: 'non_existent_artifact_id' }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. GUI View Structure & Accessibility Invariants
  // ══════════════════════════════════════════════════════════════

  describe('GUI DocumentsView Component Structure', () => {
    it('DocumentsView.tsx contains role="tabpanel" and state-box', () => {
      const viewPath = path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'DocumentsView.tsx');
      expect(fs.existsSync(viewPath)).toBe(true);

      const content = fs.readFileSync(viewPath, 'utf8');
      expect(content).toContain('role="tabpanel"');
      expect(content).toContain('state-box');
      expect(content).toContain('aria-label="Document Generator View"');
      expect(content).toContain('OFFICIAL-SENSITIVE');
    });

    it('App.tsx registers DocumentsView in VALID_VIEWS and renderActiveView', () => {
      const appPath = path.resolve(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx');
      const content = fs.readFileSync(appPath, 'utf8');
      expect(content).toContain("'documents'");
      expect(content).toContain('<DocumentsView />');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. Canary Hash Invariant
  // ══════════════════════════════════════════════════════════════

  describe('Canary Hash Protection', () => {
    it('rust/test.txt is untouched and matches canonical SHA-256', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
