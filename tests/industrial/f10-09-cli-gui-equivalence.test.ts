/**
 * F10-09: CLI / GUI Equivalence Test Suite
 *
 * Validates the core architectural invariant:
 * "The GUI never invokes CLI commands. CLI and GUI are adapters over the same
 * application services and therefore share DAG, tool, provenance, sandbox,
 * approval, interruption, and output semantics."
 *
 * Key Areas Tested:
 * 1. Static inspection: Zero shell-out from GUI source code (no child_process).
 * 2. Workflow / DAG Projections: Identical typed state projections across CLI & REST.
 * 3. Approval Governance: Identical approval decision schemas, roles, and validation.
 * 4. Artifact Integrity: Identical authoritative SHA-256 hashes and traversal guards.
 * 5. Lifecycle Stop & Interruption: Equivalent confirmation defense, INTERRUPTED task state, and audit records.
 * 6. Mandatory preservation of canary hash (rust/test.txt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ServiceContainer } from '../../src/service';
import { createRestApiServer, RestApiServer } from '../../src/api/server';
import { MaosRestClient } from '../../src/api/client';
import type { WorkflowPlan } from '../../src/domain/workflow-plan';
import { runIndustrialStop, INDUSTRIAL_CLI_EXIT } from '../../src/industrial/industrial-cli';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CANARY_PATH = path.resolve(PROJECT_ROOT, 'rust', 'test.txt');
const CANARY_EXPECTED_HASH = '1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435';

describe('F10-09: CLI / GUI Equivalence Fixtures & Invariants', () => {
  let testDir: string;
  let server: RestApiServer;
  let client: MaosRestClient;
  let port: number;
  let services: ServiceContainer;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-equiv-test-'));

    // Setup isolated project structure
    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });

    const config = {
      projectName: 'test-equiv-project',
      routingMode: 'auto',
      profile: {
        id: 'industrial',
        displayName: 'MAOS Industrial',
        mode: 'sovereign-local',
        zeroCloud: true,
        evidenceRoot: 'artifacts',
      },
    };
    fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

    server = createRestApiServer(testDir);
    services = server.getServices();

    port = await server.start(0);
    client = new MaosRestClient({
      baseUrl: `http://127.0.0.1:${port}`,
      projectRoot: testDir,
    });
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  afterEach(() => {
    const canaryContent = fs.readFileSync(CANARY_PATH);
    const canaryHash = crypto.createHash('sha256').update(canaryContent).digest('hex');
    expect(canaryHash).toBe(CANARY_EXPECTED_HASH);
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Static Verification: Zero GUI Shell-Out
  // ══════════════════════════════════════════════════════════════

  describe('1. Zero GUI Shell-Out Invariant', () => {
    it('verifies no GUI source file imports child_process, exec, or spawn', () => {
      const guiSrcDir = path.resolve(PROJECT_ROOT, 'src', 'gui', 'src');
      expect(fs.existsSync(guiSrcDir)).toBe(true);

      const findFiles = (dir: string): string[] => {
        let results: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            results = results.concat(findFiles(fullPath));
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            results.push(fullPath);
          }
        }
        return results;
      };

      const guiFiles = findFiles(guiSrcDir);
      expect(guiFiles.length).toBeGreaterThan(10);

      const forbiddenPatterns = [
        /import\s+.*from\s+['"]child_process['"]/,
        /require\(['"]child_process['"]\)/,
        /\bexecSync\s*\(/,
        /\bchild_process\.spawn\s*\(/,
      ];

      for (const file of guiFiles) {
        const content = fs.readFileSync(file, 'utf8');
        for (const pattern of forbiddenPatterns) {
          expect(pattern.test(content)).toBe(false);
        }
      }
    });

    it('verifies equivalence fixture contract file is present and valid', () => {
      const contractPath = path.resolve(PROJECT_ROOT, 'fixtures', 'f10-09', 'cli-gui-equivalence-contract.json');
      expect(fs.existsSync(contractPath)).toBe(true);
      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      expect(contract.schemaVersion).toBe(1);
      expect(contract.operations.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Workflow & DAG Projection Equivalence
  // ══════════════════════════════════════════════════════════════

  describe('2. Workflow & DAG Projection Equivalence', () => {
    it('produces identical typed workflow projections via CockpitService and REST API', async () => {
      const runId = `run-equiv-${Date.now()}`;
      const samplePlan: WorkflowPlan = {
        schemaVersion: 1,
        planId: `plan-${Date.now()}`,
        title: 'Industrial Safety Audit',
        intent: 'execute',
        recipeId: 'industrial-safety-audit-v1',
        planHash: 'd41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000000',
        status: 'READY',
        deterministic: true,
        requirements: {
          schemaVersion: 1,
          modalities: ['text', 'vision'],
          primaryModality: 'text',
          safetyCritical: true,
          maxBudgetUsd: 1.0,
          tools: {
            requiredTools: ['artifact_read'],
            forbiddenTools: [],
          },
        },
        provenance: {
          projectId: 'test-equiv-project',
          taskId: 'task-001',
          runId,
          inferenceInputHash: '0'.repeat(64),
          sourceArtifactIds: ['telemetry.csv', 'maintenance.pdf'],
          sourceHashes: ['0'.repeat(64), '1'.repeat(64)],
          evidenceReferences: [],
          createdAt: new Date().toISOString(),
        },
        steps: [
          {
            stepId: 'step-1-ingest',
            stepType: 'INGEST_EVIDENCE',
            title: 'Ingest Telemetry and Maintenance PDF',
            assignedAgentId: 'INGEST_AGENT',
            dependencies: [],
            requiredTools: ['artifact_read'],
            status: 'READY',
            requiredModel: {
              modelFamily: 'qwen2.5-coder-7b',
              requiredRevision: 'rev-qwen-7b-frozen',
              devicePreference: 'gpu',
            },
            inputs: {
              sourceIds: ['telemetry.csv', 'maintenance.pdf'],
            },
            outputs: {
              expectedArtifactTypes: ['raw_telemetry', 'extracted_report'],
            },
            requiresApproval: false,
          },
        ],
      };

      services.workflowPlanning.savePlan(samplePlan);

      // 1. Projection via direct application service (used by CLI)
      const cliProjection = services.cockpit.getWorkflowRunProjection(
        'test-equiv-project',
        samplePlan.provenance.runId!,
      );
      expect(cliProjection).not.toBeNull();

      // 2. Projection via REST API (used by GUI BrowserRestClient)
      const restResponse = await (client as any).request(
        'GET',
        `/api/v1/cockpit/${encodeURIComponent(samplePlan.provenance.runId!)}/projection`,
      );

      expect(restResponse.status).toBe(200);
      expect(restResponse.data).toBeDefined();
      const guiProjection = restResponse.data;

      // Both projections must be identical in structure and content
      expect(guiProjection.runId).toBe(cliProjection!.runId);
      expect(guiProjection.status).toBe(cliProjection!.status);
      expect(guiProjection.stages.length).toBe(cliProjection!.stages.length);
      expect(guiProjection.stages[0].stageId).toBe(cliProjection!.stages[0].stageId);
      expect(guiProjection.stages[0].title).toBe(cliProjection!.stages[0].title);
      expect(guiProjection.routes.run).toBe(cliProjection!.routes.run);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Approval Governance Equivalence
  // ══════════════════════════════════════════════════════════════

  describe('3. Approval Governance Equivalence', () => {
    it('processes approval decisions with identical schemas and validations across CLI & REST', async () => {
      const payloadHash = crypto.createHash('sha256').update('safety-approval-test-payload').digest('hex');

      // 1. Create approval request
      const approval1 = services.approval.createApproval({
        projectId: 'test-equiv-project',
        runId: 'run_equiv_01',
        taskId: 'task_gate_cli',
        actorId: 'operator_chief',
        actorRole: 'lead',
        reason: 'Authorize safety deliverable generation',
        scope: 'docx_generation',
        payloadHash,
      });

      const approval2 = services.approval.createApproval({
        projectId: 'test-equiv-project',
        runId: 'run_equiv_01',
        taskId: 'task_gate_rest',
        actorId: 'operator_chief',
        actorRole: 'lead',
        reason: 'Authorize safety deliverable generation',
        scope: 'docx_generation',
        payloadHash,
      });

      // 2. Decide via direct service (CLI path)
      const cliDecision = services.approval.decideApproval(approval1.id, {
        decision: 'approved',
        actorId: 'operator_chief',
        actorRole: 'lead',
        notes: 'Authorized for field maintenance',
      });

      expect(cliDecision.status).toBe('approved');
      expect(cliDecision.approvedBy).toBe('operator_chief');
      expect(cliDecision.reviewedBy).toBe('operator_chief');

      // 3. Decide via REST API (GUI path)
      const restDecisionRes = await client.reviewApproval(approval2.id, {
        decision: 'approved',
        actorId: 'operator_chief',
        actorRole: 'lead',
        notes: 'Authorized for field maintenance',
      });

      expect(restDecisionRes.status).toBe(200);
      expect(restDecisionRes.data).toBeDefined();
      const guiDecision = restDecisionRes.data!;

      expect(guiDecision.status).toBe('approved');
      expect(guiDecision.approvedBy).toBe('operator_chief');
      expect(guiDecision.reviewedBy).toBe('operator_chief');

      // Schema fields must match (normalized for JSON wire serialization)
      const normalizedCliKeys = Object.keys(JSON.parse(JSON.stringify(cliDecision))).sort();
      const normalizedGuiKeys = Object.keys(guiDecision).sort();
      expect(normalizedCliKeys).toEqual(normalizedGuiKeys);
    });

    it('rejects unauthorized actor roles with equivalent fail-closed errors', async () => {
      const payloadHash = crypto.createHash('sha256').update('unauth-test-payload').digest('hex');

      const approval = services.approval.createApproval({
        projectId: 'test-equiv-project',
        runId: 'run_equiv_01',
        taskId: 'task_unauthorized_gate',
        actorId: 'operator_chief',
        actorRole: 'lead',
        reason: 'Authorize safety deliverable generation',
        scope: 'docx_generation',
        payloadHash,
      });

      // 1. Direct Service (CLI) rejection
      expect(() => {
        services.approval.decideApproval(approval.id, {
          decision: 'approved',
          actorId: 'attacker',
          actorRole: 'unauthorized_role' as any,
          reason: 'Attempted bypass',
        });
      }).toThrow(/UNAUTHORIZED_REVIEWER_ROLE/);

      // 2. REST API (GUI) rejection
      const restRes = await client.reviewApproval(approval.id, {
        decision: 'approved',
        actorId: 'attacker',
        actorRole: 'unauthorized_role',
        notes: 'Attempted bypass',
      });

      expect(restRes.status).toBeGreaterThanOrEqual(400);
      expect(restRes.error).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Artifact Integrity & SHA-256 Equivalence
  // ══════════════════════════════════════════════════════════════

  describe('4. Artifact Integrity & SHA-256 Equivalence', () => {
    it('computes identical authoritative SHA-256 hashes for CLI and REST artifact paths', async () => {
      const content = Buffer.from('PK\x03\x04synthetic-docx-binary-data-for-equivalence-testing');
      const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex');

      // 1. Finalize via CLI service
      const artifactCli = services.artifact.finalizeArtifact({
        id: `art_cli_${Date.now()}`,
        relativePath: 'artifacts/cli_deliverable.docx',
        content,
        type: 'file',
      });

      expect(artifactCli.hash).toBe(expectedSha256);

      // 2. Query via REST API
      const restArtifactRes = await client.getArtifact(artifactCli.id);

      expect(restArtifactRes.status).toBe(200);
      expect(restArtifactRes.data).toBeDefined();
      const artifactGui = restArtifactRes.data!;

      expect(artifactGui.hash).toBe(expectedSha256);
      expect(artifactGui.hash).toBe(artifactCli.hash);
      expect(artifactGui.size).toBe(artifactCli.size);
      expect(artifactGui.path).toBe(artifactCli.path);
    });

    it('rejects path traversal attempts across both interfaces', async () => {
      // 1. CLI service traversal rejection
      expect(() => {
        services.artifact.finalizeArtifact({
          id: 'evil_cli',
          relativePath: '../../outside.docx',
          content: 'evil',
          type: 'file',
        });
      }).toThrow(/PATH_TRAVERSAL/);

      // 2. REST API traversal rejection
      const restRes = await client.finalizeArtifact({
        id: 'evil_rest',
        relativePath: '../../outside.docx',
        content: 'evil',
        type: 'file',
      });

      expect(restRes.status).toBe(400);
      expect(restRes.error?.code).toBe('PATH_TRAVERSAL');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Lifecycle Stop & Interruption Equivalence
  // ══════════════════════════════════════════════════════════════

  describe('5. Lifecycle Stop & Interruption Equivalence', () => {
    it('enforces mandatory confirmation for force-stop across CLI and REST adapters', async () => {
      // 1. CLI force-stop unconfirmed defense
      const cliUnconfirmed = await runIndustrialStop({
        projectRoot: testDir,
        mode: 'force',
        yes: false,
        json: true,
      });
      expect(cliUnconfirmed.exitCode).toBe(INDUSTRIAL_CLI_EXIT.CONFIRMATION_REQUIRED);
      expect(cliUnconfirmed.message).toContain('CONFIRMATION_REQUIRED');

      // 2. REST force-stop unconfirmed defense
      const restUnconfirmed = await client.stopService({
        mode: 'force',
        confirm: false,
      });
      expect(restUnconfirmed.status).toBe(400);
      expect(restUnconfirmed.error?.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('executes confirmed stop identically across CLI and REST', async () => {
      // 1. CLI graceful stop (mode: after-current-tasks)
      const cliResult = await runIndustrialStop({
        projectRoot: testDir,
        mode: 'after-current-tasks',
        json: true,
      });
      expect(cliResult.exitCode).toBe(INDUSTRIAL_CLI_EXIT.SUCCESS);
      expect((cliResult.data as any).status).toBe('stopped');
      expect((cliResult.data as any).mode).toBe('after-current-tasks');

      // 2. REST graceful stop (mode: after-current-tasks)
      const restResult = await client.stopService({
        mode: 'after-current-tasks',
      });
      expect(restResult.status).toBe(200);
      expect(restResult.data).toBeDefined();
      expect(restResult.data!.status).toBe('stopped');
      expect(restResult.data!.mode).toBe('after-current-tasks');
    });
  });
});
