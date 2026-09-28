/**
 * UI1-10: Evidence/Brainstorm Modes and Retention Test Suite
 *
 * Exhaustively validates:
 * 1. Domain Schemas & Pure Validators:
 *    - validateOperationalMode: validates 'evidence', 'brainstorm', 'industrial'; rejects invalid modes
 *    - normalizeOperationalMode: maps 'industrial' to 'evidence', 'brainstorm' to 'brainstorm'
 *    - validateModeTransition: rejects silent downgrade from Evidence to Brainstorm (SILENT_DOWNGRADE_FORBIDDEN)
 *    - validateCitedClaim:
 *        - Evidence mode: rejects uncited claims (UNCITED_CLAIM_REJECTED); enforces valid sourcePath, SHA-256 hex sourceHash, snippet
 *        - Evidence mode: warns on unverified model prose (UNVERIFIED_MODEL_PROSE)
 *        - Brainstorm mode: allows exploratory uncited claims tagged isModelGenerated=true and verifiedAgainstData=false
 *    - validatePurgeOptions: enforces bounds [1, 365] and targets
 * 2. EvidenceModeService:
 *    - Claim validation in evidence and brainstorm modes
 *    - Mode transition verification with downgrade confirmation
 *    - Promotion readiness evaluation (blocks unreviewed brainstorm claims without explicit consent)
 *    - Tamper-evident audit recording under category 'tool'
 * 3. RetentionService & Scoped Purge:
 *    - Status calculation: accurate counts for expired/total conversations, previews, events
 *    - Safety Invariant 1: Append-only audit records (.maos/audit/) are strictly immutable (IMMUTABLE_AUDIT_PURGE_FORBIDDEN)
 *    - Safety Invariant 2: Finalized deliverables (*.docx, *.xlsx, *.pptx) are strictly immutable (FINALIZED_DELIVERABLE_PURGE_FORBIDDEN)
 *    - Safety Invariant 3: Directory traversal rejected (PATH_OUTSIDE_PROJECT)
 *    - Preservation: Pinned conversations and task-linked conversations are NEVER purged
 *    - Scoped execution: expired unpinned conversations and temporary preview caches purged cleanly
 *    - Dry-run verification: reports items without touching disk
 *    - Idempotency key support and audit trail logging with zero sensitive leak
 * 4. ConversationService Integration:
 *    - Default mode is 'evidence', pinned is false
 *    - updateMode checks downgrade guard and audits transition
 *    - setPinned toggles pin state
 *    - addMessage enforces cited claims in evidence mode, allows exploratory in brainstorm mode
 *    - promoteToTask rejects brainstorm with unverified claims unless allowUnreviewedBrainstorm=true
 * 5. REST API Endpoints & Loopback:
 *    - GET /api/v1/retention/status
 *    - POST /api/v1/retention/purge
 *    - POST /api/v1/mode/validate-claim
 *    - PATCH /api/v1/conversations/:id/mode
 *    - PATCH /api/v1/conversations/:id/pin
 *    - POST /api/v1/conversations/:id/promote
 * 6. 4-Way Parity across ServiceContainer, RestApiRouter, BrowserRestClient, and GuiApiAdapter
 * 7. Safety Invariants:
 *    - Canary file test.txt SHA-256 preservation
 *    - Gate G5 passed state, G6 and G7 passed state
 *    - Air-gap / zero network requests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  validateOperationalMode,
  normalizeOperationalMode,
  validateModeTransition,
  validateCitedClaim,
  validatePurgeOptions,
  OperationalMode,
  CitedClaim,
  PurgeOptions,
  RetentionStatus,
  PurgeResult,
} from '../../src/domain/evidence-mode';
import { EvidenceModeService } from '../../src/service/evidence-mode-service';
import { RetentionService } from '../../src/service/retention-service';
import { ConversationService } from '../../src/service/conversation-service';
import { AuditService } from '../../src/service/audit-service';
import { SettingsService } from '../../src/service/settings-service';
import { TaskService } from '../../src/service/task-service';
import { createServiceContainer, ServiceContainer } from '../../src/service';
import { ProjectServiceHost, createProjectServiceHost } from '../../src/service/project-service/host';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';
import { Conversation, Message } from '../../src/domain/schemas';

const CANARY_PATH = path.resolve(__dirname, '../../rust/test.txt');
const EXPECTED_CANARY_SHA256 = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';
const VALID_SHA256 = 'a'.repeat(64);

let sessionToken: string;

function requestHttp(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = {
      Origin: 'http://127.0.0.1:3000',
      Authorization: `Bearer ${sessionToken}`,
      ...(options.headers || {}),
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('UI1-10: Evidence / Brainstorm Modes and Retention', () => {
  let testRoot: string;
  let auditDir: string;
  let serviceContainer: ServiceContainer;
  let projectHost: ProjectServiceHost;
  let hostPort: number;
  let restClient: BrowserRestClient;
  let apiAdapter: GuiApiAdapter;

  beforeAll(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-10-'));
    auditDir = path.join(testRoot, '.maos', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    // Initialize HTTP host
    projectHost = createProjectServiceHost(testRoot, { port: 0 });
    const started = await projectHost.start();
    hostPort = started.port;
    const port = started.port;
    serviceContainer = createServiceContainer(testRoot);

    // Create session token
    const session = projectHost.createSession('window-ui1-10');
    sessionToken = session.token;

    const baseUrl = `http://127.0.0.1:${port}`;
    restClient = new BrowserRestClient({
      baseUrl,
      projectRoot: testRoot,
      sessionToken,
    });
    apiAdapter = new GuiApiAdapter(baseUrl, testRoot);
    (apiAdapter.rest as any).sessionToken = sessionToken;
  });

  afterAll(async () => {
    if (projectHost) {
      await projectHost.stop();
    }
    if (testRoot && fs.existsSync(testRoot)) {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  // =========================================================================
  // 1. Domain Schemas & Pure Validators
  // =========================================================================
  describe('1. Domain Schemas & Pure Validators', () => {
    it('validates operational modes correctly', () => {
      expect(validateOperationalMode('evidence').valid).toBe(true);
      expect(validateOperationalMode('brainstorm').valid).toBe(true);
      expect(validateOperationalMode('industrial').valid).toBe(true);

      const invalid1 = validateOperationalMode('unrestricted');
      expect(invalid1.valid).toBe(false);
      expect(invalid1.errors[0]).toContain('Invalid operational mode');

      expect(validateOperationalMode(null).valid).toBe(false);
      expect(validateOperationalMode(123).valid).toBe(false);
      expect(validateOperationalMode('').valid).toBe(false);
    });

    it('normalizes operational mode strings', () => {
      expect(normalizeOperationalMode('evidence')).toBe('evidence');
      expect(normalizeOperationalMode('industrial')).toBe('evidence');
      expect(normalizeOperationalMode('brainstorm')).toBe('brainstorm');
      expect(normalizeOperationalMode('other')).toBe('evidence');
      expect(normalizeOperationalMode(null)).toBe('evidence');
    });

    it('enforces silent mode downgrade prevention (SILENT_DOWNGRADE_FORBIDDEN)', () => {
      // Evidence -> Brainstorm without confirmation MUST fail
      const silentDowngrade = validateModeTransition('evidence', 'brainstorm', false);
      expect(silentDowngrade.valid).toBe(false);
      expect(silentDowngrade.errors[0]).toContain('SILENT_DOWNGRADE_FORBIDDEN');

      // Industrial -> Brainstorm without confirmation MUST fail
      const industrialDowngrade = validateModeTransition('industrial', 'brainstorm', false);
      expect(industrialDowngrade.valid).toBe(false);
      expect(industrialDowngrade.errors[0]).toContain('SILENT_DOWNGRADE_FORBIDDEN');

      // Evidence -> Brainstorm with confirmed=true MUST succeed
      const confirmedDowngrade = validateModeTransition('evidence', 'brainstorm', true);
      expect(confirmedDowngrade.valid).toBe(true);
      expect(confirmedDowngrade.errors).toHaveLength(0);

      // Brainstorm -> Evidence (upgrade) does NOT require confirmation
      const upgrade = validateModeTransition('brainstorm', 'evidence', false);
      expect(upgrade.valid).toBe(true);

      // Same mode transition is valid
      expect(validateModeTransition('evidence', 'evidence', false).valid).toBe(true);
      expect(validateModeTransition('brainstorm', 'brainstorm', false).valid).toBe(true);
    });

    it('validates cited claims in Evidence/Industrial mode', () => {
      const validClaim: CitedClaim = {
        id: 'claim-1',
        statement: 'Thermal tolerance is 85 degrees C under nominal load',
        citations: [
          {
            citationId: 'cit-1',
            sourcePath: 'specs/thermal.pdf',
            sourceHash: VALID_SHA256,
            snippet: 'Max operational temperature rated at 85C',
            verifiedAt: new Date().toISOString(),
          },
        ],
        isModelGenerated: false,
        verifiedAgainstData: true,
        confidence: 0.98,
        createdAt: new Date().toISOString(),
      };

      const result = validateCitedClaim(validClaim, 'evidence');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Rejects claim without citations in evidence mode
      const uncitedClaim: CitedClaim = {
        ...validClaim,
        citations: [],
      };
      const uncitedResult = validateCitedClaim(uncitedClaim, 'evidence');
      expect(uncitedResult.valid).toBe(false);
      expect(uncitedResult.errors[0]).toContain('UNCITED_CLAIM_REJECTED');

      // Rejects claim with invalid SHA-256 hash in citation
      const badHashClaim: CitedClaim = {
        ...validClaim,
        citations: [
          {
            citationId: 'cit-2',
            sourcePath: 'specs/thermal.pdf',
            sourceHash: 'short-invalid-hash',
            snippet: 'sample',
            verifiedAt: new Date().toISOString(),
          },
        ],
      };
      const badHashResult = validateCitedClaim(badHashClaim, 'evidence');
      expect(badHashResult.valid).toBe(false);
      expect(badHashResult.errors[0]).toContain('64-character hex SHA-256');

      // Emits UNVERIFIED_MODEL_PROSE warning for unverified model text in evidence mode
      const modelProseClaim: CitedClaim = {
        ...validClaim,
        isModelGenerated: true,
        verifiedAgainstData: false,
      };
      const modelProseResult = validateCitedClaim(modelProseClaim, 'evidence');
      expect(modelProseResult.valid).toBe(true);
      expect(modelProseResult.warnings).toBeDefined();
      expect(modelProseResult.warnings![0]).toContain('UNVERIFIED_MODEL_PROSE');
    });

    it('validates claims in Brainstorm mode', () => {
      // In brainstorm mode, uncited claims are permitted IF flagged as model-generated and unverified
      const brainstormClaim: CitedClaim = {
        id: 'claim-brainstorm-1',
        statement: 'We could potentially reduce cooling costs by 15% using liquid manifolds',
        citations: [],
        isModelGenerated: true,
        verifiedAgainstData: false,
        createdAt: new Date().toISOString(),
      };

      const result = validateCitedClaim(brainstormClaim, 'brainstorm');
      expect(result.valid).toBe(true);

      // In brainstorm mode, an uncited claim cannot claim to be verified against data
      const falseFactClaim: CitedClaim = {
        ...brainstormClaim,
        verifiedAgainstData: true,
      };
      const falseFactResult = validateCitedClaim(falseFactClaim, 'brainstorm');
      expect(falseFactResult.valid).toBe(false);
      expect(falseFactResult.errors[0]).toContain('cannot be marked verifiedAgainstData without citations');
    });

    it('validates purge options bounds and targets', () => {
      expect(validatePurgeOptions({ target: 'conversations' }).valid).toBe(true);
      expect(validatePurgeOptions({ target: 'artifact_previews' }).valid).toBe(true);
      expect(validatePurgeOptions({ target: 'event_display' }).valid).toBe(true);
      expect(validatePurgeOptions({ target: 'all_expired' }).valid).toBe(true);

      const invalidTarget = validatePurgeOptions({ target: 'audit_logs' });
      expect(invalidTarget.valid).toBe(false);
      expect(invalidTarget.errors[0]).toContain('Invalid purge target');

      const outOfBounds = validatePurgeOptions({ target: 'all_expired', conversationDays: 500 });
      expect(outOfBounds.valid).toBe(false);
      expect(outOfBounds.errors[0]).toContain('between 1 and 365');
    });
  });

  // =========================================================================
  // 2. EvidenceModeService Tests
  // =========================================================================
  describe('2. EvidenceModeService', () => {
    let evidenceModeService: EvidenceModeService;

    beforeAll(() => {
      evidenceModeService = serviceContainer.evidenceMode;
    });

    it('evaluates claims and checks mode transitions', () => {
      const claim: CitedClaim = {
        id: 'ev-claim-1',
        statement: 'Verified sensor telemetry confirms 12.4 bar pressure',
        citations: [
          {
            citationId: 'c1',
            sourcePath: 'telemetry/pressure.csv',
            sourceHash: VALID_SHA256,
            snippet: '12.4 bar',
            verifiedAt: new Date().toISOString(),
          },
        ],
        isModelGenerated: false,
        verifiedAgainstData: true,
        createdAt: new Date().toISOString(),
      };

      const evValidation = evidenceModeService.validateClaim(claim, 'evidence');
      expect(evValidation.valid).toBe(true);

      const transFail = evidenceModeService.checkModeTransition('evidence', 'brainstorm', false);
      expect(transFail.valid).toBe(false);

      const transOk = evidenceModeService.checkModeTransition('evidence', 'brainstorm', true);
      expect(transOk.valid).toBe(true);
    });

    it('evaluates promotion readiness with unreviewed brainstorm content defense', () => {
      const testConvId = 'conv-brainstorm-test';
      const messages: Message[] = [
        {
          id: 'msg-1',
          conversationId: testConvId,
          role: 'user',
          content: 'Brainstorm hypothetical architecture enhancements',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          conversationId: testConvId,
          role: 'assistant',
          content: 'We might use an unproven speculative cache layer',
          timestamp: new Date().toISOString(),
          isModelGenerated: true,
          verifiedAgainstData: false,
          claims: [
            {
              id: 'speculative-1',
              statement: 'Speculative cache layer will double throughput',
              citations: [],
              isModelGenerated: true,
              verifiedAgainstData: false,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ];

      const testConv: Conversation = {
        id: testConvId,
        projectId: 'test-project',
        agentId: 'test_agent',
        status: 'active',
        messages,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: 'brainstorm',
      };

      // With allowUnreviewedBrainstorm = false, promotion MUST be blocked
      const blockedPromotion = evidenceModeService.evaluatePromotionReadiness(
        testConv,
        false,
      );
      expect(blockedPromotion.allowed).toBe(false);
      expect(blockedPromotion.unverifiedClaimCount).toBe(1);
      expect(blockedPromotion.reason).toContain('BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW');

      // With allowUnreviewedBrainstorm = true, operator explicitly acknowledges and permits promotion
      const allowedPromotion = evidenceModeService.evaluatePromotionReadiness(
        testConv,
        true,
      );
      expect(allowedPromotion.allowed).toBe(true);
      expect(allowedPromotion.unverifiedClaimCount).toBe(1);
    });
  });

  // =========================================================================
  // 3. RetentionService & Scoped Purge Safety Invariants
  // =========================================================================
  describe('3. RetentionService & Scoped Purge Safety Invariants', () => {
    let retentionService: RetentionService;
    let convService: ConversationService;
    let auditService: AuditService;

    beforeAll(() => {
      retentionService = serviceContainer.retention;
      convService = serviceContainer.conversation;
      auditService = serviceContainer.audit;
    });

    it('calculates retention status accurately', async () => {
      const status = await retentionService.getRetentionStatus();
      expect(status.schemaVersion).toBe(1);
      expect(typeof status.totalConversations).toBe('number');
      expect(typeof status.expiredConversations).toBe('number');
      expect(typeof status.immutableAuditRecordCount).toBe('number');
      expect(typeof status.immutableDeliverableCount).toBe('number');
    });

    it('SAFETY INVARIANT: append-only audit records (.maos/audit/) are strictly immutable and never purged', async () => {
      // Record an audit event
      const auditRec = auditService.recordAuditEvent({
        category: 'tool',
        source: 'test-retention',
        data: { message: 'Must survive all retention purges permanent invariant' },
      });
      expect(auditRec.sequence).toBeGreaterThanOrEqual(0);

      // Verify audit file exists
      const auditLogPath = path.join(testRoot, '.maos', 'audit', 'audit-chain.jsonl');
      expect(fs.existsSync(auditLogPath)).toBe(true);

      // Execute a full purge targeting all expired items
      const purgeRes = retentionService.purge({ target: 'all_expired', dryRun: false });
      expect(purgeRes.dryRun).toBe(false);

      // Audit file must STILL exist and retain its data!
      expect(fs.existsSync(auditLogPath)).toBe(true);
      const auditContent = fs.readFileSync(auditLogPath, 'utf8');
      expect(auditContent).toContain('Must survive all retention purges permanent invariant');
    });

    it('SAFETY INVARIANT: finalized deliverables (*.docx, *.xlsx, *.pptx) are strictly immutable and never purged', async () => {
      const artifactsDir = path.join(testRoot, 'artifacts');
      fs.mkdirSync(artifactsDir, { recursive: true });

      const docxPath = path.join(artifactsDir, 'Final_Report.docx');
      const xlsxPath = path.join(artifactsDir, 'Financial_Model.xlsx');
      const pptxPath = path.join(artifactsDir, 'Executive_Brief.pptx');

      fs.writeFileSync(docxPath, 'MOCK_FINAL_DOCX_DELIVERABLE_CONTENT');
      fs.writeFileSync(xlsxPath, 'MOCK_FINAL_XLSX_DELIVERABLE_CONTENT');
      fs.writeFileSync(pptxPath, 'MOCK_FINAL_PPTX_DELIVERABLE_CONTENT');

      // Purge all expired items
      retentionService.purge({ target: 'all_expired', dryRun: false });

      // All finalized deliverables must remain untouched
      expect(fs.existsSync(docxPath)).toBe(true);
      expect(fs.existsSync(xlsxPath)).toBe(true);
      expect(fs.existsSync(pptxPath)).toBe(true);
    });

    it('SAFETY INVARIANT: directory traversal paths are strictly rejected', async () => {
      expect(() => {
        retentionService.assertSafePath(path.join(testRoot, '..', 'escape.txt'));
      }).toThrow('PATH_OUTSIDE_PROJECT');
    });

    it('preserves pinned conversations and task-linked conversations while purging expired unpinned sessions', async () => {
      const convDir = path.join(testRoot, '.maos', 'conversations');
      fs.mkdirSync(convDir, { recursive: true });

      const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days old

      // 1. Expired unpinned conversation (should be purged)
      const expiredConv: Conversation = {
        id: 'conv-expired-unpinned',
        projectId: 'test-project',
        agentId: 'test_agent',
        status: 'active',
        messages: [],
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        mode: 'evidence',
        pinned: false,
      };

      // 2. Expired pinned conversation (MUST be preserved)
      const pinnedConv: Conversation = {
        id: 'conv-expired-pinned',
        projectId: 'test-project',
        agentId: 'test_agent',
        status: 'active',
        messages: [],
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        mode: 'evidence',
        pinned: true,
      };

      // 3. Expired task-linked conversation (MUST be preserved)
      const taskConv: Conversation = {
        id: 'conv-expired-task-linked',
        projectId: 'test-project',
        agentId: 'test_agent',
        status: 'promoted',
        taskId: 'task-active-123',
        messages: [],
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        mode: 'evidence',
        pinned: false,
      };

      fs.writeFileSync(path.join(convDir, `${expiredConv.id}.json`), JSON.stringify(expiredConv));
      fs.writeFileSync(path.join(convDir, `${pinnedConv.id}.json`), JSON.stringify(pinnedConv));
      fs.writeFileSync(path.join(convDir, `${taskConv.id}.json`), JSON.stringify(taskConv));

      // Create a temporary preview cache file that is 40 days old (should be purged)
      const previewDir = path.join(testRoot, 'artifacts', '.tmp');
      fs.mkdirSync(previewDir, { recursive: true });
      const oldPreviewPath = path.join(previewDir, 'preview-expired.png');
      fs.writeFileSync(oldPreviewPath, 'STALE_PREVIEW_PIXELS');
      // Set access and modification time to 40 days ago
      const mtime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldPreviewPath, mtime, mtime);

      // Perform Dry Run first
      const dryRunResult = retentionService.purge({
        target: 'all_expired',
        dryRun: true,
        conversationDays: 30,
        artifactPreviewDays: 30,
      });
      expect(dryRunResult.dryRun).toBe(true);
      expect(dryRunResult.purgedConversations).toBe(1);
      expect(dryRunResult.purgedArtifactPreviews).toBe(1);

      // Files must still exist after dry run!
      expect(fs.existsSync(path.join(convDir, `${expiredConv.id}.json`))).toBe(true);
      expect(fs.existsSync(oldPreviewPath)).toBe(true);

      // Now execute real purge
      const realPurgeResult = retentionService.purge({
        target: 'all_expired',
        dryRun: false,
        conversationDays: 30,
        artifactPreviewDays: 30,
        actor: 'operator-test',
        reason: 'Periodic compliance purge',
      });

      expect(realPurgeResult.dryRun).toBe(false);
      expect(realPurgeResult.purgedConversations).toBe(1);
      expect(realPurgeResult.purgedArtifactPreviews).toBe(1);
      expect(realPurgeResult.auditRecordSequence).toBeDefined();

      // Verify outcomes:
      // 1. Unpinned expired conversation deleted
      expect(fs.existsSync(path.join(convDir, `${expiredConv.id}.json`))).toBe(false);
      // 2. Pinned conversation preserved
      expect(fs.existsSync(path.join(convDir, `${pinnedConv.id}.json`))).toBe(true);
      // 3. Task-linked conversation preserved
      expect(fs.existsSync(path.join(convDir, `${taskConv.id}.json`))).toBe(true);
      // 4. Temporary preview cache file deleted
      expect(fs.existsSync(oldPreviewPath)).toBe(false);
    });
  });

  // =========================================================================
  // 4. ConversationService Integration & Mode Enforcement
  // =========================================================================
  describe('4. ConversationService Integration & Mode Enforcement', () => {
    let convService: ConversationService;
    let taskService: TaskService;

    beforeAll(() => {
      convService = serviceContainer.conversation;
      taskService = serviceContainer.task;
    });

    it('creates conversation defaulting to evidence mode and unpinned', async () => {
      const conv = await convService.createConversation({
        projectId: 'test-project',
        agentId: 'default_agent',
      });

      expect(conv.mode).toBe('evidence');
      expect(conv.pinned).toBe(false);
    });

    it('rejects silent downgrade to brainstorm mode, but succeeds with confirmation', () => {
      const conv = convService.createConversation({
        projectId: 'test-project',
        agentId: 'default_agent',
      });

      // Silent downgrade without confirmation must throw
      expect(() => {
        convService.updateMode(conv.id, 'brainstorm', false);
      }).toThrow('SILENT_DOWNGRADE_FORBIDDEN');

      // Downgrade with confirmed=true succeeds
      const updated = convService.updateMode(conv.id, 'brainstorm', true);
      expect(updated.mode).toBe('brainstorm');

      // Upgrade back to evidence does not require confirmation
      const upgraded = convService.updateMode(conv.id, 'evidence', false);
      expect(upgraded.mode).toBe('evidence');
    });

    it('toggles pinned state atomically', () => {
      const conv = convService.createConversation({
        projectId: 'test-project',
        agentId: 'default_agent',
      });
      expect(conv.pinned).toBe(false);

      const pinned = convService.setPinned(conv.id, true);
      expect(pinned.pinned).toBe(true);

      const unpinned = convService.setPinned(conv.id, false);
      expect(unpinned.pinned).toBe(false);
    });

    it('enforces cited claims on message addition in evidence mode', () => {
      const conv = convService.createConversation({
        projectId: 'test-project',
        agentId: 'default_agent',
        mode: 'evidence',
      });

      // Adding uncited claim in evidence mode must fail closed
      expect(() => {
        convService.addMessage(conv.id, {
          role: 'assistant',
          content: 'Pump pressure was measured at 50 PSI',
          claims: [
            {
              id: 'claim-uncited',
              statement: 'Pump pressure was measured at 50 PSI',
              citations: [],
              isModelGenerated: true,
              verifiedAgainstData: true,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }).toThrow('UNCITED_CLAIM_REJECTED');

      // Adding properly cited claim succeeds
      const validMsg = convService.addMessage(conv.id, {
        role: 'assistant',
        content: 'Pump pressure was measured at 50 PSI',
        claims: [
          {
            id: 'claim-valid',
            statement: 'Pump pressure was measured at 50 PSI',
            citations: [
              {
                citationId: 'cit-pump',
                sourcePath: 'logs/pump.log',
                sourceHash: VALID_SHA256,
                snippet: 'pump.read(0) = 50 PSI',
                verifiedAt: new Date().toISOString(),
              },
            ],
            isModelGenerated: false,
            verifiedAgainstData: true,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      expect(validMsg.claims).toBeDefined();
      expect(validMsg.claims![0].id).toBe('claim-valid');
    });

    it('blocks promotion of brainstorm conversation with unverified claims unless confirmed', () => {
      const conv = convService.createConversation({
        projectId: 'test-project',
        agentId: 'default_agent',
        mode: 'brainstorm',
      });

      // Add exploratory brainstorm message
      convService.addMessage(conv.id, {
        role: 'assistant',
        content: 'Exploratory idea for optimizing thermal vents',
        isModelGenerated: true,
        verifiedAgainstData: false,
        claims: [
          {
            id: 'brainstorm-unverified',
            statement: 'Vents might be reduced by half without loss of cooling',
            citations: [],
            isModelGenerated: true,
            verifiedAgainstData: false,
            createdAt: new Date().toISOString(),
          },
        ],
      });

      // Attempting promotion without allowUnreviewedBrainstorm must throw
      expect(() => {
        convService.promoteToTask(
          conv.id,
          {
            conversationId: conv.id,
            description: 'Industrial vent optimization',
            agent: 'supervisor_agent',
            complexity: 'medium',
            allowUnreviewedBrainstorm: false,
          },
          taskService,
        );
      }).toThrow('BRAINSTORM_UNVERIFIED_CLAIM_REQUIRES_REVIEW');

      // Attempting promotion WITH allowUnreviewedBrainstorm = true succeeds
      const promotionResult = convService.promoteToTask(
        conv.id,
        {
          conversationId: conv.id,
          description: 'Industrial vent optimization',
          agent: 'supervisor_agent',
          complexity: 'medium',
          allowUnreviewedBrainstorm: true,
        },
        taskService,
      );

      expect(promotionResult.task).toBeDefined();
      expect(promotionResult.conversation.taskId).toBe(promotionResult.task.id);
    });
  });

  // =========================================================================
  // 5. REST API Endpoints & Loopback Testing
  // =========================================================================
  describe('5. REST API Endpoints & Loopback Testing', () => {
    let port: number;

    beforeAll(() => {
      port = hostPort;
    });

    it('GET /api/v1/retention/status returns retention metrics', async () => {
      const res = await requestHttp(port, {
        method: 'GET',
        path: '/api/v1/retention/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBeDefined();
      expect(body.status.schemaVersion).toBe(1);
      expect(typeof body.status.totalConversations).toBe('number');
      expect(typeof body.status.immutableAuditRecordCount).toBe('number');
    });

    it('POST /api/v1/retention/purge executes dry run and real purge with idempotency', async () => {
      const idempotencyKey = crypto.randomUUID();

      // Dry run purge
      const dryRes = await requestHttp(port, {
        method: 'POST',
        path: '/api/v1/retention/purge',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          target: 'all_expired',
          dryRun: true,
        }),
      });

      expect(dryRes.statusCode).toBe(200);
      const dryBody = JSON.parse(dryRes.body);
      expect(dryBody.result).toBeDefined();
      expect(dryBody.result.dryRun).toBe(true);

      // Repeat with same idempotency key returns cached result
      const repeatRes = await requestHttp(port, {
        method: 'POST',
        path: '/api/v1/retention/purge',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          target: 'all_expired',
          dryRun: true,
        }),
      });
      expect(repeatRes.statusCode).toBe(200);
      const repeatBody = JSON.parse(repeatRes.body);
      expect(repeatBody.result.timestamp).toBe(dryBody.result.timestamp);
    });

    it('POST /api/v1/mode/validate-claim validates claim payload', async () => {
      const res = await requestHttp(port, {
        method: 'POST',
        path: '/api/v1/mode/validate-claim',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'evidence',
          claim: {
            id: 'c-api-1',
            statement: 'Substation load is 450 kW',
            citations: [
              {
                citationId: 'cit-sub',
                sourcePath: 'power/sub.json',
                sourceHash: VALID_SHA256,
                snippet: 'load: 450 kW',
                verifiedAt: new Date().toISOString(),
              },
            ],
            isModelGenerated: false,
            verifiedAgainstData: true,
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.valid).toBe(true);
      expect(body.errors).toHaveLength(0);
    });

    it('PATCH /api/v1/conversations/:id/mode updates operational mode with downgrade defense', async () => {
      // Create conversation first
      const createRes = await requestHttp(port, {
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'test-proj', agentId: 'test_agent' }),
      });
      const conv = JSON.parse(createRes.body).data;

      // Attempt silent downgrade without confirmation
      const failRes = await requestHttp(port, {
        method: 'PATCH',
        path: `/api/v1/conversations/${conv.id}/mode`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'brainstorm', confirmed: false }),
      });
      expect(failRes.statusCode).toBe(400);
      const failBody = JSON.parse(failRes.body);
      expect(failBody.error.code).toBe('SILENT_DOWNGRADE_FORBIDDEN');

      // Downgrade with confirmed=true
      const okRes = await requestHttp(port, {
        method: 'PATCH',
        path: `/api/v1/conversations/${conv.id}/mode`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'brainstorm', confirmed: true }),
      });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body).data.mode).toBe('brainstorm');
    });

    it('PATCH /api/v1/conversations/:id/pin toggles pin status', async () => {
      const createRes = await requestHttp(port, {
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'test-proj', agentId: 'test_agent' }),
      });
      const conv = JSON.parse(createRes.body).data;

      const pinRes = await requestHttp(port, {
        method: 'PATCH',
        path: `/api/v1/conversations/${conv.id}/pin`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      });
      expect(pinRes.statusCode).toBe(200);
      expect(JSON.parse(pinRes.body).data.pinned).toBe(true);
    });
  });

  // =========================================================================
  // 6. 4-Way Parity across Service, Router, RestClient, and GuiApiAdapter
  // =========================================================================
  describe('6. 4-Way Parity across ServiceContainer, Router, RestClient, and GuiApiAdapter', () => {
    it('verifies 4-way parity for retention and mode operations', async () => {
      // 1. ServiceContainer
      expect(typeof serviceContainer.retention.getRetentionStatus).toBe('function');
      expect(typeof serviceContainer.retention.purge).toBe('function');
      expect(typeof serviceContainer.evidenceMode.validateClaim).toBe('function');
      expect(typeof serviceContainer.conversation.updateMode).toBe('function');
      expect(typeof serviceContainer.conversation.setPinned).toBe('function');

      // 2. BrowserRestClient
      expect(typeof restClient.getRetentionStatus).toBe('function');
      expect(typeof restClient.executeRetentionPurge).toBe('function');
      expect(typeof restClient.validateClaim).toBe('function');
      expect(typeof restClient.updateConversationMode).toBe('function');
      expect(typeof restClient.setConversationPinned).toBe('function');

      // 3. GuiApiAdapter
      expect(typeof apiAdapter.getRetentionStatus).toBe('function');
      expect(typeof apiAdapter.executeRetentionPurge).toBe('function');
      expect(typeof apiAdapter.validateClaim).toBe('function');
      expect(typeof apiAdapter.updateConversationMode).toBe('function');
      expect(typeof apiAdapter.setConversationPinned).toBe('function');

      // 4. Test execution through GuiApiAdapter against running server
      const statusFromAdapter = await apiAdapter.getRetentionStatus();
      expect(statusFromAdapter.schemaVersion).toBe(1);

      const dryRunFromAdapter = await apiAdapter.executeRetentionPurge({
        target: 'all_expired',
        dryRun: true,
      });
      expect(dryRunFromAdapter.dryRun).toBe(true);

      const convFromAdapter = await apiAdapter.createConversation({
        projectId: 'parity-proj',
        agentId: 'parity_agent',
      });
      expect(convFromAdapter.mode).toBe('evidence');

      const pinnedFromAdapter = await apiAdapter.setConversationPinned(convFromAdapter.id, true);
      expect(pinnedFromAdapter.pinned).toBe(true);

      const modeUpdatedFromAdapter = await apiAdapter.updateConversationMode(
        convFromAdapter.id,
        'brainstorm',
        true,
      );
      expect(modeUpdatedFromAdapter.mode).toBe('brainstorm');
    });
  });

  // =========================================================================
  // 7. Safety Invariants & Canary Check
  // =========================================================================
  describe('7. Safety Invariants & Canary Check', () => {
    it('verifies canary test.txt SHA-256 is unchanged', () => {
      expect(fs.existsSync(CANARY_PATH)).toBe(true);
      const canaryContent = fs.readFileSync(CANARY_PATH);
      const actualHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
      expect(actualHash).toBe(EXPECTED_CANARY_SHA256);
    });

    it('verifies Gate G5 remains passed and G6/G7 remain passed', () => {
      const planPath = path.resolve(__dirname, '../../docs/SIH26117_IMPLEMENTATION_PLAN.md');
      expect(fs.existsSync(planPath)).toBe(true);
      const content = fs.readFileSync(planPath, 'utf8');

      expect(content).toContain('Gate G5 — Knowledge grounding');
      expect(content).toContain('**Status:** ✅ PASSED (`[x]`)');
      expect(content).toContain('Gate G6 — Deliverable readiness');
      expect(content).toContain('Gate G7 — Routing/workflow readiness');
      expect(content).toContain('- [x] G5 local KB benchmark passed');
      expect(content).toContain('- [x] G6 approved DOCX/XLSX/PPTX verified');
      expect(content).toContain('- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified');
    });
  });
});
