/**
 * F3-06 — Append-Only Redacted Audit Events Tests
 *
 * Verifies:
 * 1. Deep sensitive-data redaction engine (API keys, passwords, bearer/JWT tokens, private keys)
 * 2. Coverage of all 10 required audit categories:
 *    stage, tool, model, endpoint, lease, io_hash, duration, warning, approval, interruption
 * 3. Authoritative Rust engine hash chain construction (0..N-1, previous_hash linking)
 * 4. Zero plaintext secrets invariant in disk file (.maos/audit/audit-chain.jsonl)
 * 5. Negative tamper tests:
 *    - Payload modification detection
 *    - Stored hash modification detection
 *    - Middle record deletion detection
 *    - First record deletion / sequence gap detection
 *    - Record reordering detection
 *    - Invalid category rejection
 *    - Missing source rejection
 * 6. REST API contract (GET /api/v1/audit, POST /api/v1/audit/events, POST /api/v1/audit/verify)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { redactSensitive, redactSensitiveString, isSensitiveKey } from '../src/core/redaction';
import { AuditService } from '../src/service/audit-service';
import { createRestApiServer, RestApiServer } from '../src/api/server';
import { MaosRestClient } from '../src/api/client';
import { AUDIT_CATEGORIES, AuditCategory } from '../src/domain';
import {
  engineChainVerifyRequestSizeBytes,
  MAX_ENGINE_REQUEST_BYTES,
} from '../src/industrial/rust-engine-bridge';

describe('F3-06 Append-Only Redacted Audit Events', () => {
  // ── 1. Sensitive-Data Redaction Engine Tests ───────────────────────

  describe('1. Redaction Engine', () => {
    it('should detect sensitive key names case-insensitively', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('PASSWORD')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('clientSecret')).toBe(true);
      expect(isSensitiveKey('accessToken')).toBe(true);
      expect(isSensitiveKey('private_key')).toBe(true);
      expect(isSensitiveKey('normalField')).toBe(false);
    });

    it('should redact OpenAI, Anthropic, and generic API keys from strings', () => {
      const input = 'OpenAI: sk-proj-1234567890abcdef12345678, Claude: sk-ant-api03-abcdef1234567890123456, Generic: key-abcdef1234567890';
      const { sanitized, redactedCount } = redactSensitiveString(input);
      expect(sanitized).not.toContain('sk-proj-');
      expect(sanitized).not.toContain('sk-ant-');
      expect(sanitized).not.toContain('key-abcdef');
      expect(sanitized).toContain('[REDACTED]');
      expect(redactedCount).toBe(3);
    });

    it('should redact Bearer, Basic auth, and JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const input = `Authorization: Bearer my_secret_token_1234567890\nProxy: Basic dXNlcjpwYXNzd29yZDEyMzQ=\nToken: ${jwt}`;
      const { sanitized, redactedCount } = redactSensitiveString(input);
      expect(sanitized).not.toContain('my_secret_token');
      expect(sanitized).not.toContain('dXNlcjpwYXNzd29yZDEyMzQ=');
      expect(sanitized).not.toContain(jwt);
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('Basic [REDACTED]');
      expect(sanitized).toContain('[REDACTED_JWT]');
      expect(redactedCount).toBeGreaterThanOrEqual(3);
    });

    it('should redact PEM private keys', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y1+...\n-----END RSA PRIVATE KEY-----';
      const input = `Server config: ${pem}\nRunning nominal.`;
      const { sanitized, redactedCount } = redactSensitiveString(input);
      expect(sanitized).not.toContain('MIIEowIBAAKCAQEA0Y1+');
      expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
      expect(redactedCount).toBe(1);
    });

    it('should redact inline credentials (password=... / secret: ...)', () => {
      const input = 'Connection url postgres://user:password123@localhost:5432 or password=MySecretPassword123; api_key="secretKey999"';
      const { sanitized } = redactSensitiveString(input);
      expect(sanitized).not.toContain('MySecretPassword123');
      expect(sanitized).not.toContain('secretKey999');
      expect(sanitized).toContain('password=[REDACTED]');
      expect(sanitized).toContain('api_key=[REDACTED]');
    });

    it('should deeply redact nested objects, arrays, and sensitive keys', () => {
      const payload = {
        tool: 'model_inference',
        params: {
          apiKey: 'sk-proj-supersecretkey12345678901234',
          model: 'qwen2.5-coder',
          headers: {
            Authorization: 'Bearer auth_secret_token_123456789',
          },
        },
        credentials: {
          password: 'plainPassword123!',
          secretKey: 'topsecret',
        },
        items: [
          { token: 'key-9876543210123456' },
          { name: 'safe_item', count: 42 },
        ],
      };

      const { sanitized, redactedCount } = redactSensitive(payload);

      expect(sanitized.params.apiKey).toBe('[REDACTED]');
      expect(sanitized.params.model).toBe('qwen2.5-coder');
      expect(sanitized.params.headers.Authorization).toBe('Bearer [REDACTED]');
      expect(sanitized.credentials.password).toBe('[REDACTED]');
      expect(sanitized.credentials.secretKey).toBe('[REDACTED]');
      expect(sanitized.items[0].token).toBe('[REDACTED]');
      expect(sanitized.items[1].name).toBe('safe_item');
      expect(sanitized.items[1].count).toBe(42);
      expect(redactedCount).toBeGreaterThanOrEqual(5);
    });

    it('should handle circular references without throwing', () => {
      const circular: any = { name: 'circular_test' };
      circular.self = circular;
      const { sanitized } = redactSensitive(circular);
      expect(sanitized.name).toBe('circular_test');
      expect(sanitized.self).toBe('[CIRCULAR]');
    });
  });

  // ── 2. Audit Service & 10 Audit Categories ─────────────────────────

  describe('2. Audit Service & 10 Categories Coverage', () => {
    let testDir: string;
    let auditService: AuditService;

    beforeAll(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-audit-test-'));
      auditService = new AuditService(testDir);
    });

    afterAll(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should verify an empty chain', () => {
      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.recordCount).toBe(0);
      expect(verification.errors.length).toBe(0);
    });

    it('should record events across all 10 required audit categories', () => {
      const testEvents: Array<{ category: AuditCategory; data: Record<string, unknown> }> = [
        {
          category: 'stage',
          data: { stageId: 'STAGE_INGEST', status: 'started', stageIndex: 1 },
        },
        {
          category: 'tool',
          data: { tool: 'ocr_document', agentId: 'agent_ocr', duration_ms: 142 },
        },
        {
          category: 'model',
          data: { modelId: 'qwen2.5-coder-7b', promptTokens: 512, completionTokens: 88 },
        },
        {
          category: 'endpoint',
          data: { endpoint: 'http://127.0.0.1:8000/v1/ocr', method: 'POST', status: 200 },
        },
        {
          category: 'lease',
          data: { leaseId: 'lease_gpu_01', model: 'vision-local', device: 'cuda:0' },
        },
        {
          category: 'io_hash',
          data: { file: 'artifacts/specs.pdf', hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
        },
        {
          category: 'duration',
          data: { operation: 'workflow_run', duration_ms: 4320, target: 'RUN-2026-A' },
        },
        {
          category: 'warning',
          data: { code: 'VIBRATION_THRESHOLD_HIGH', metric: 'vibration', value: 5.8, limit: 4.5 },
        },
        {
          category: 'approval',
          data: { gateId: 'G3', approvalId: 'appr_01', decision: 'approved', decidedBy: 'compliance_lead' },
        },
        {
          category: 'interruption',
          data: { runId: 'run-interrupted', reason: 'USER_CANCELLED', interruptedAtStage: 'STAGE_AUDIT' },
        },
      ];

      for (let i = 0; i < testEvents.length; i++) {
        const { category, data } = testEvents[i];
        const record = auditService.recordAuditEvent({
          source: 'test_runner',
          category,
          data,
        });

        expect(record.sequence).toBe(i);
        expect(record.category).toBe(category);
        expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
        if (i === 0) {
          expect(record.previous_hash).toBe('');
        } else {
          const prev = auditService.getRecordBySequence(i - 1);
          expect(record.previous_hash).toBe(prev?.hash);
        }
      }

      // Verify all 10 records are present
      const records = auditService.getRecords();
      expect(records.length).toBe(10);

      // Verify the chain authoritatively using the Rust engine
      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.recordCount).toBe(10);
      expect(verification.errors.length).toBe(0);
      expect(verification.latestHash).toBe(records[9].hash);
    });

    it('should query audit records with category and sequence filters', () => {
      const stageRecords = auditService.getRecords({ category: 'stage' });
      expect(stageRecords.length).toBe(1);
      expect(stageRecords[0].category).toBe('stage');

      const warningRecords = auditService.getRecords({ category: 'warning' });
      expect(warningRecords.length).toBe(1);
      expect(warningRecords[0].category).toBe('warning');

      const bounded = auditService.getRecords({ fromSeq: 2, toSeq: 4 });
      expect(bounded.length).toBe(3);
      expect(bounded[0].sequence).toBe(2);
      expect(bounded[2].sequence).toBe(4);

      const limited = auditService.getRecords({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  // ── 3. Zero Plaintext Secrets Invariant ────────────────────────────

  describe('3. Zero Plaintext Secrets Invariant on Disk', () => {
    let testDir: string;
    let auditService: AuditService;

    beforeAll(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-audit-secret-'));
      auditService = new AuditService(testDir);
    });

    afterAll(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should never write raw secrets to .maos/audit/audit-chain.jsonl', () => {
      const secretApiKey = 'sk-proj-SECRETKEY998877665544332211';
      const secretPassword = 'SUPER_SECRET_DB_PASSWORD_XYZ';
      const secretToken = 'Bearer SECRET_TOKEN_ABCDEF1234567890';

      const record = auditService.recordAuditEvent({
        source: 'auth_worker',
        category: 'tool',
        data: {
          tool: 'connect_database',
          apiKey: secretApiKey,
          password: secretPassword,
          authHeader: secretToken,
          status: 'authenticated',
        },
      });

      // Record in memory has redacted fields
      expect(record.data.apiKey).toBe('[REDACTED]');
      expect(record.data.password).toBe('[REDACTED]');
      expect(record.data.authHeader).toBe('Bearer [REDACTED]');

      // Read raw file from disk
      const filePath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');
      const fileContent = fs.readFileSync(filePath, 'utf-8');

      // Assert secrets are NOT present anywhere in file
      expect(fileContent).not.toContain(secretApiKey);
      expect(fileContent).not.toContain(secretPassword);
      expect(fileContent).not.toContain(secretToken);
      expect(fileContent).toContain('[REDACTED]');

      // Chain still verifies through Rust engine
      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.recordCount).toBe(1);
    });
  });

  // ── 4. Negative & Adversarial Tamper Tests ─────────────────────────

  describe('4. Negative & Adversarial Tamper Tests', () => {
    let testDir: string;
    let auditService: AuditService;
    let logPath: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-audit-tamper-'));
      auditService = new AuditService(testDir);
      logPath = path.join(testDir, '.maos', 'audit', 'audit-chain.jsonl');

      // Populate 4 valid records
      auditService.recordAuditEvent({ source: 'svc', category: 'stage', data: { step: 0 } });
      auditService.recordAuditEvent({ source: 'svc', category: 'tool', data: { step: 1 } });
      auditService.recordAuditEvent({ source: 'svc', category: 'model', data: { step: 2 } });
      auditService.recordAuditEvent({ source: 'svc', category: 'approval', data: { step: 3 } });
    });

    afterEach(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should reject unknown audit category', () => {
      expect(() => {
        auditService.recordAuditEvent({
          source: 'test',
          category: 'invalid_category_xyz' as any,
          data: {},
        });
      }).toThrow(/INVALID_AUDIT_CATEGORY/);
    });

    it('should reject missing source identifier', () => {
      expect(() => {
        auditService.recordAuditEvent({
          source: '',
          category: 'stage',
          data: {},
        });
      }).toThrow(/INVALID_AUDIT_SOURCE/);
    });

    it('should detect data payload tampering via Rust engine', () => {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const record1 = JSON.parse(lines[1]);
      // Tamper data payload
      record1.data = { step: 9999, tampered: true };
      lines[1] = JSON.stringify(record1);
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes('hash mismatch') || e.includes('modification'))).toBe(true);
    });

    it('should detect stored hash tampering via Rust engine', () => {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      const record2 = JSON.parse(lines[2]);
      // Tamper hash
      record2.hash = '0'.repeat(64);
      lines[2] = JSON.stringify(record2);
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
    });

    it('should detect middle record deletion (broken link & sequence jump)', () => {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      // Delete record 1 (keep 0, 2, 3)
      lines.splice(1, 1);
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes('sequence') || e.includes('previous_hash'))).toBe(true);
    });

    it('should detect deletion of the first record (sequence starts > 0)', () => {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      // Delete record 0 (starts at sequence 1)
      lines.shift();
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes('First record has sequence 1') || e.includes('sequence 1'))).toBe(true);
    });

    it('should detect record reordering / swap', () => {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      // Swap records 1 and 2
      const temp = lines[1];
      lines[1] = lines[2];
      lines[2] = temp;
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

      const verification = auditService.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
    });

    it('should fail closed when Rust engine fails during append or verify', () => {
      expect(() => {
        auditService.recordAuditEvent({ source: 'test', category: 'stage', data: {} }, true);
      }).toThrow(/RUST_CHAIN_FAILED/);

      expect(() => {
        auditService.verifyChain(true);
      }).toThrow(/RUST_VERIFY_FAILED/);
    });
  });

  // ── 5. REST API Contract Integration ───────────────────────────────

  describe('5. REST API Contract Integration', () => {
    let testDir: string;
    let server: RestApiServer;
    let client: MaosRestClient;

    beforeAll(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-audit-rest-'));

      const maosDir = path.join(testDir, '.maos');
      fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
      fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });

      const config = {
        projectName: 'test-audit-project',
        routingMode: 'auto',
        profile: {
          id: 'industrial',
          displayName: 'MAOS Industrial',
          mode: 'sovereign-local',
          zeroCloud: true,
        },
        providers: {},
        agents: [],
        routing: {},
      };
      fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2));

      server = createRestApiServer(testDir);
      const port = await server.start(0);
      client = new MaosRestClient({ baseUrl: `http://127.0.0.1:${port}`, projectRoot: testDir });
    });

    afterAll(async () => {
      await server.stop();
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('POST /api/v1/audit/events: should record an event with sensitive-data redaction', async () => {
      const res = await client.recordAuditEvent({
        source: 'rest_client',
        category: 'tool',
        data: {
          tool: 'eval_model',
          apiKey: 'sk-proj-APIKEYTEST999988887777',
          status: 'success',
        },
      });

      expect(res.status).toBe(201);
      expect(res.data?.sequence).toBe(0);
      expect(res.data?.category).toBe('tool');
      expect(res.data?.hash).toBeDefined();
      expect(res.data?.data.apiKey).toBe('[REDACTED]');
    });

    it('POST /api/v1/audit/events: should reject invalid category with 400', async () => {
      const res = await client.rawRequest('POST', '/api/v1/audit/events', {
        source: 'rest_client',
        category: 'invalid_category',
        data: {},
      });

      expect(res.status).toBe(400);
      expect(res.error?.code).toBe('VALIDATION_FAILED');
    });

    it('GET /api/v1/audit: should list and filter audit records', async () => {
      // Append second event
      await client.recordAuditEvent({
        source: 'rest_client',
        category: 'warning',
        data: { warning: 'high_load' },
      });

      const listRes = await client.listAuditRecords();
      expect(listRes.status).toBe(200);
      expect(listRes.data?.length).toBe(2);

      const filtered = await client.listAuditRecords({ category: 'warning' });
      expect(filtered.status).toBe(200);
      expect(filtered.data?.length).toBe(1);
      expect(filtered.data?.[0].category).toBe('warning');
    });

    it('POST /api/v1/audit/verify: should verify audit chain through HTTP', async () => {
      const res = await client.verifyAuditChain();
      expect(res.status).toBe(200);
      expect(res.data?.valid).toBe(true);
      expect(res.data?.recordCount).toBe(2);
      expect(res.data?.errors.length).toBe(0);
      expect(res.data?.executableHash).toBeDefined();
    });

    it('Idempotency: duplicate request with same key should return cached response', async () => {
      const key = 'idem_audit_key_001';
      const first = await client.recordAuditEvent(
        { source: 'idem_test', category: 'stage', data: { step: 'stage1' } },
        key,
      );
      expect(first.status).toBe(201);

      const second = await client.recordAuditEvent(
        { source: 'idem_test', category: 'stage', data: { step: 'stage1' } },
        key,
      );
      expect(second.status).toBe(201);
      expect(second.isReplay).toBe(true);
      expect(second.data?.sequence).toBe(first.data?.sequence);
    });
  });
});

function canonicalAuditJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAuditJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAuditJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

describe('Bounded audit-chain verification', () => {
  it('verifies and detects tampering across request windows without raising the engine limit', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-audit-window-test-'));
    try {
      const audit = new AuditService(projectRoot);
      const auditDir = path.join(projectRoot, '.maos', 'audit');
      const auditPath = path.join(auditDir, 'audit-chain.jsonl');
      const headPath = path.join(auditDir, 'audit-head.json');
      const padding = 'x'.repeat(650);
      const records: Array<{
        schemaVersion: 1;
        sequence: number;
        previous_hash: string;
        timestamp: string;
        source: string;
        category: 'stage';
        data: Record<string, unknown>;
        hash: string;
      }> = [];
      let previousHash = '';
      const timestamp = '2026-09-27T00:00:00.000Z';

      for (let sequence = 0; sequence < 2_100; sequence++) {
        const data = { index: sequence, padding };
        const canonicalData = canonicalAuditJson(data);
        const hash = createHash('sha256')
          .update(`${sequence}|${previousHash}|${timestamp}|window-test|stage|${canonicalData}`)
          .digest('hex');
        records.push({
          schemaVersion: 1,
          sequence,
          previous_hash: previousHash,
          timestamp,
          source: 'window-test',
          category: 'stage',
          data,
          hash,
        });
        previousHash = hash;
      }

      const engineRecords = records.map(({ sequence, previous_hash, timestamp: recordTimestamp, source, category, data, hash }) => ({
        sequence,
        previous_hash,
        timestamp: recordTimestamp,
        source,
        category,
        data,
        hash,
      }));
      expect(engineChainVerifyRequestSizeBytes(engineRecords)).toBeGreaterThan(MAX_ENGINE_REQUEST_BYTES);

      fs.writeFileSync(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      fs.writeFileSync(
        headPath,
        JSON.stringify({ schemaVersion: 1, recordCount: records.length, latestHash: previousHash, updatedAt: timestamp }),
        'utf8',
      );

      const valid = audit.verifyChain();
      expect(valid.valid).toBe(true);
      expect(valid.recordCount).toBe(records.length);
      expect(valid.errors).toEqual([]);

      // Corrupt a record after the first request window. Its stored hash and
      // the subsequent chain links remain unchanged, so Rust must catch the
      // record-level hash mismatch in the later window.
      records[1_300].data = { index: 1_300, padding: `${padding}tampered` };
      fs.writeFileSync(auditPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      const tampered = audit.verifyChain();
      expect(tampered.valid).toBe(false);
      expect(tampered.errors.some((error) => error.includes('Record 1300 hash mismatch'))).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
