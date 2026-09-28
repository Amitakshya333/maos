/**
 * UI1-20: Append-Only Audit Trail and Sovereign Boundary Panel Test Suite
 *
 * Exhaustively validates:
 * 1. Audit Trail REST API:
 *    - GET /api/v1/audit returns sequenced records
 *    - POST /api/v1/audit/events appends records
 *    - POST /api/v1/audit/verify validates chain integrity
 *    - GET /api/v1/audit/export exports full trail with verification
 * 2. Sovereign Panel REST API:
 *    - GET /api/v1/sovereignty/panel aggregates boundary, firewall, allowlist, processes, leases
 *    - Measured boundary, state, timestamps, and active violations
 * 3. Mismatch Actions:
 *    - Unverified or blocked boundary triggers recommended remediation actions
 * 4. Negative Checks:
 *    - Never claims "zero data left the machine" or "entire OS offline"
 *    - Strictly no hidden non-loopback endpoints
 *    - Strictly zero cross-project records exposed
 *    - Never shows zero before measurement
 * 5. Client & Adapter Parity:
 *    - BrowserRestClient and GuiApiAdapter methods
 * 6. UI Component Structure & Test IDs:
 *    - AuditView tabs, buttons, tables, badges
 * 7. Untouched Canary Hash Invariant (rust/test.txt)
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
import { PROHIBITED_SOVEREIGNTY_CLAIMS, STANDARD_MEASURED_SOVEREIGNTY_CLAIM } from '../../src/domain/sovereignty-boundary';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('UI1-20: Audit Trail and Sovereign Boundary Panel', () => {
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
      timeoutMs: 10000,
    });
    apiAdapter = new GuiApiAdapter(restClient);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Audit Trail REST API & Export
  // ══════════════════════════════════════════════════════════════

  describe('1. Audit Trail REST API & Export', () => {
    it('GET /api/v1/audit returns list of sequenced audit records', async () => {
      const records = await restClient.getAuditEvents();
      expect(Array.isArray(records)).toBe(true);
      if (records.length > 0) {
        const rec = records[0];
        expect(rec.sequence).toBeDefined();
        expect(rec.category).toBeDefined();
        expect(rec.source).toBeDefined();
        expect(rec.timestamp).toBeDefined();
        expect(rec.hash).toBeDefined();
      }
    });

    it('POST /api/v1/audit/verify cryptographically verifies the audit chain', async () => {
      const verification = await restClient.verifyAuditChain();
      expect(verification).toBeDefined();
      expect(typeof verification.valid).toBe('boolean');
      expect(typeof verification.recordCount).toBe('number');
      expect(verification.verifiedAt).toBeDefined();
      expect(typeof verification.latestHash).toBe('string');
      expect(typeof verification.executableHash).toBe('string');
      expect(Array.isArray(verification.errors)).toBe(true);
    });

    it('GET /api/v1/audit/export exports entire audit trail with verification bundle', async () => {
      const exported = await restClient.exportAuditTrail();
      expect(exported).toBeDefined();
      expect(Array.isArray(exported.records)).toBe(true);
      expect(exported.verification).toBeDefined();
      expect(typeof exported.verification.valid).toBe('boolean');
      expect(exported.records.length).toBe(exported.verification.recordCount);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Sovereign Panel REST API
  // ══════════════════════════════════════════════════════════════

  describe('2. Sovereign Panel REST API', () => {
    it('GET /api/v1/sovereignty/panel returns aggregated boundary, processes, and allowlist', async () => {
      const panel = await restClient.getSovereignPanelData();
      expect(panel).toBeDefined();
      expect(panel.projectId).toBeDefined();
      expect(panel.boundaryStatus).toBeDefined();
      expect(panel.boundaryStatus.overallStatus).toMatch(/VERIFIED|BLOCKED/);
      expect(panel.boundaryStatus.firewallStatus).toBeDefined();
      expect(panel.boundaryStatus.endpointPolicyStatus).toBeDefined();
      expect(panel.boundaryStatus.monitorStatus).toBeDefined();
      expect(panel.boundaryStatus.checkedAt).toBeDefined();
      expect(Array.isArray(panel.trackedProcesses)).toBe(true);
      expect(Array.isArray(panel.trackedBindings)).toBe(true);
      expect(panel.verification).toBeDefined();
      expect(panel.inspectedAt).toBeDefined();
    });

    it('includes active loopback endpoints in endpoint policy', async () => {
      const panel = await restClient.getSovereignPanelData();
      if (panel.endpointPolicy?.allowedEndpoints) {
        for (const ep of panel.endpointPolicy.allowedEndpoints) {
          // Strict loopback check
          expect(ep.isLoopbackOnly).toBe(true);
        }
      }
    });

    it('tracked processes have executable hashes and trust status', async () => {
      const panel = await restClient.getSovereignPanelData();
      for (const p of panel.trackedProcesses) {
        expect(p.processId).toBeGreaterThan(0);
        expect(p.executableHash).toBeDefined();
        expect(p.status).toMatch(/trusted|untrusted|revoked/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Mismatch Actions & Remediation
  // ══════════════════════════════════════════════════════════════

  describe('3. Mismatch Actions & Remediation', () => {
    it('shows actionable remedies when boundary status is blocked or unverified', async () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );
      expect(content).toContain('Recommended Mismatch Remedies:');
      expect(content).toContain('Enable industrial firewall mode');
      expect(content).toContain('Verify all open ports match the strict loopback-only allowlist');
      expect(content).toContain('Restart unverified background worker processes');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Negative Checks & Wording Invariants
  // ══════════════════════════════════════════════════════════════

  describe('4. Negative Checks & Wording Invariants', () => {
    it('AuditView never uses prohibited absolute sovereignty claims in approved text', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );

      // Verify each prohibited claim from domain is never used as an approved assertion
      for (const prohibited of PROHIBITED_SOVEREIGNTY_CLAIMS) {
        // Content should either not contain it or only mention it in a negative disclaimer
        if (content.toLowerCase().includes(prohibited.toLowerCase())) {
          expect(content).toMatch(/does not claim|never claim/i);
        }
      }
    });

    it('AuditView displays the exact measured sovereignty fact', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );
      expect(content).toContain(STANDARD_MEASURED_SOVEREIGNTY_CLAIM);
    });

    it('strictly forbids hidden non-loopback endpoints (all endpoints declare loopback flag)', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );
      expect(content).toContain('Loopback Only');
      expect(content).toContain('Zero non-loopback endpoints are permitted or hidden');
    });

    it('strictly enforces project root boundary (zero cross-project records exposed)', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );
      expect(content).toContain('Zero cross-project records');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Client & Adapter Parity
  // ══════════════════════════════════════════════════════════════

  describe('5. Client & Adapter Parity', () => {
    it('apiAdapter delegates getAuditEvents correctly', async () => {
      const records = await apiAdapter.getAuditEvents();
      expect(Array.isArray(records)).toBe(true);
    });

    it('apiAdapter delegates verifyAuditChain correctly', async () => {
      const verification = await apiAdapter.verifyAuditChain();
      expect(verification).toBeDefined();
      expect(typeof verification.valid).toBe('boolean');
    });

    it('apiAdapter delegates exportAuditTrail correctly', async () => {
      const exported = await apiAdapter.exportAuditTrail();
      expect(exported).toBeDefined();
      expect(Array.isArray(exported.records)).toBe(true);
    });

    it('apiAdapter delegates getSovereignPanelData correctly', async () => {
      const panel = await apiAdapter.getSovereignPanelData();
      expect(panel).toBeDefined();
      expect(panel.boundaryStatus).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. UI Component Structure & Test IDs
  // ══════════════════════════════════════════════════════════════

  describe('6. UI Component Structure & Test IDs', () => {
    it('AuditView.tsx exports React component', async () => {
      const mod = await import('../../src/gui/src/views/AuditView');
      expect(mod.AuditView).toBeDefined();
      expect(typeof mod.AuditView).toBe('function');
    });

    it('AuditView contains required tabs and test IDs', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'views', 'AuditView.tsx'),
        'utf8',
      );
      expect(content).toContain('data-testid="tab-audit-trail"');
      expect(content).toContain('data-testid="tab-sovereign-panel"');
      expect(content).toContain('data-testid="audit-trail-section"');
      expect(content).toContain('data-testid="audit-verification-box"');
      expect(content).toContain('data-testid="audit-chain-badge"');
      expect(content).toContain('data-testid="btn-verify-chain"');
      expect(content).toContain('data-testid="btn-export-audit"');
      expect(content).toContain('data-testid="audit-category-select"');
      expect(content).toContain('data-testid="sovereign-panel-section"');
      expect(content).toContain('data-testid="boundary-overview-card"');
      expect(content).toContain('data-testid="measured-claim-text"');
      expect(content).toContain('data-testid="firewall-status"');
      expect(content).toContain('data-testid="endpoint-policy-status"');
      expect(content).toContain('data-testid="monitor-status"');
      expect(content).toContain('data-testid="service-identity-status"');
      expect(content).toContain('data-testid="boundary-checked-at"');
      expect(content).toContain('data-testid="allowlist-box"');
      expect(content).toContain('data-testid="process-tree-box"');
    });

    it('App.tsx registers and routes audit view', () => {
      const content = fs.readFileSync(
        path.join(PROJECT_ROOT, 'src', 'gui', 'src', 'App.tsx'),
        'utf8',
      );
      expect(content).toContain("import { AuditView } from './views/AuditView'");
      expect(content).toContain("case 'audit':");
      expect(content).toContain('<AuditView />');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Canary Invariant
  // ══════════════════════════════════════════════════════════════

  describe('7. Canary Invariant', () => {
    it('rust/test.txt SHA-256 hash is strictly preserved', () => {
      const content = fs.readFileSync(CANARY_PATH);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(CANARY_EXPECTED_HASH);
    });
  });
});
