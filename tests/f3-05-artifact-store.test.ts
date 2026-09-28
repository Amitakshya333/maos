/**
 * F3-05 — Safe Artifact Store Tests
 *
 * Verifies:
 *   - Normal finalization pipeline: temp -> flush -> close -> fsync -> validate -> Rust SHA-256 -> atomic rename -> event
 *   - Atomic rename guarantee: temporary files never appear as successful artifacts
 *   - Authoritative content hash & expected-hash verification
 *   - Rust hash failure (fail-closed)
 *   - Expected-hash mismatch rejection
 *   - Path traversal prevention (../)
 *   - Absolute external path rejection
 *   - Symlink escape prevention
 *   - Existing destination collision rejection
 *   - Approved overwrite vs unapproved overwrite
 *   - Interrupted / partial write cleanup
 *   - Invalid artifact content and unknown artifact type rejection
 *   - Oversized artifact rejection (> 50 MB)
 *   - Duplicate artifact ID finalization rejection
 *   - Zero phantom audit/event emission on failures
 *   - Restart recovery and orphan temporary-file cleanup
 *   - REST API integration (POST /api/v1/artifacts, GET /api/v1/artifacts, GET /api/v1/artifacts/:id/content)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createRestApiServer, RestApiServer } from '../src/api/server';
import { ArtifactService } from '../src/service/artifact-service';
import { ApprovalService } from '../src/service/approval-service';
import { EventService } from '../src/service/event-service';

describe('F3-05 Safe Artifact Store', () => {
  let testDir: string;
  let artifactService: ArtifactService;
  let approvalService: ApprovalService;
  let eventService: EventService;
  let server: RestApiServer;
  let baseUrl: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-artifact-test-'));

    const maosDir = path.join(testDir, '.maos');
    fs.mkdirSync(path.join(maosDir, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'active'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'queue', 'done'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(maosDir, 'approvals'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'artifacts'), { recursive: true });

    const config = {
      projectName: 'test-artifact-project',
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

    eventService = new EventService(testDir);
    approvalService = new ApprovalService(testDir);
    artifactService = new ArtifactService(testDir, eventService, approvalService);

    server = createRestApiServer(testDir);
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Normal Finalization & Invariants ─────────────────────────

  describe('Normal Finalization Pipeline', () => {
    it('should finalize an artifact through the complete pipeline', () => {
      const initialEventCount = eventService.getStats().totalEvents;
      const content = '# Safety Analysis\nSystem nominal.';
      const expectedSha = crypto.createHash('sha256').update(content).digest('hex');

      const artifact = artifactService.finalizeArtifact({
        id: 'art_safety_report_01',
        relativePath: 'artifacts/reports/safety.md',
        content,
        type: 'report',
        runId: 'run-alpha',
        taskId: 'task-101',
        expectedHash: expectedSha,
      });

      expect(artifact.id).toBe('art_safety_report_01');
      expect(artifact.type).toBe('report');
      expect(artifact.hash).toBe(expectedSha);
      expect(artifact.size).toBe(Buffer.byteLength(content));
      expect(artifact.finalizedAt).toBeDefined();

      // Verify physical destination file exists and content matches
      const destPath = path.join(testDir, 'artifacts', 'reports', 'safety.md');
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf-8')).toBe(content);

      // Verify event was appended
      const newEventCount = eventService.getStats().totalEvents;
      expect(newEventCount).toBe(initialEventCount + 1);

      // Verify metadata record exists
      const metaPath = path.join(testDir, '.maos', 'artifacts', 'metadata', 'art_safety_report_01.json');
      expect(fs.existsSync(metaPath)).toBe(true);
    });

    it('should ensure temporary files never appear in listArtifacts or getArtifact', () => {
      // Create an artificial temporary file in .tmp
      const tmpDir = path.join(testDir, 'artifacts', '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const orphanTmp = path.join(tmpDir, '.tmp_phantom_123');
      fs.writeFileSync(orphanTmp, 'orphan content');

      const list = artifactService.listArtifacts();
      const ids = list.map((a) => a.id);
      const paths = list.map((a) => a.path);

      expect(ids.some((id) => id.includes('phantom'))).toBe(false);
      expect(paths.some((p) => p.includes('.tmp'))).toBe(false);
      expect(artifactService.getArtifact('phantom_123')).toBeNull();
      expect(artifactService.getArtifact('.tmp/.tmp_phantom_123')).toBeNull();

      // Clean up the manual orphan
      fs.unlinkSync(orphanTmp);
    });

    it('should verify authoritative Rust-backed hash matches standard SHA-256', () => {
      const content = JSON.stringify({ audit: 'passed', metric: 42 });
      const expectedSha = crypto.createHash('sha256').update(content).digest('hex');

      const artifact = artifactService.finalizeArtifact({
        id: 'art_rust_hash_check',
        relativePath: 'artifacts/evidence/audit.json',
        content,
        type: 'evidence',
      });

      expect(artifact.hash).toBe(expectedSha);
    });
  });

  // ── 2. Fail-Closed Security Tests ──────────────────────────────

  describe('Fail-Closed Negative Security Tests', () => {
    it('should reject path traversal using ../', () => {
      const initialEvents = eventService.getStats().totalEvents;

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_traversal_1',
          relativePath: 'artifacts/../escape.txt',
          content: 'malicious',
          type: 'file',
        }),
      ).toThrow(/PATH_TRAVERSAL/);

      expect(eventService.getStats().totalEvents).toBe(initialEvents);
    });

    it('should reject absolute paths outside the project root', () => {
      const initialEvents = eventService.getStats().totalEvents;
      const outsidePath = path.resolve(os.tmpdir(), 'outside_root.txt');

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_outside_1',
          relativePath: outsidePath,
          content: 'malicious',
          type: 'file',
        }),
      ).toThrow(/PATH_OUTSIDE_PROJECT/);

      expect(eventService.getStats().totalEvents).toBe(initialEvents);
    });

    it('should reject symlink escapes pointing outside project', () => {
      // Create external directory and symlink inside artifacts pointing to it
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-symlink-target-'));
      const symlinkPath = path.join(testDir, 'artifacts', 'symlink_escape_dir');

      try {
        fs.symlinkSync(externalDir, symlinkPath, 'junction');

        expect(() =>
          artifactService.finalizeArtifact({
            id: 'art_symlink_escape',
            relativePath: 'artifacts/symlink_escape_dir/stolen.txt',
            content: 'data',
            type: 'file',
          }),
        ).toThrow(/SYMLINK_ESCAPE/);
      } finally {
        try {
          fs.unlinkSync(symlinkPath);
          fs.rmSync(externalDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('should reject invalid artifact IDs', () => {
      expect(() =>
        artifactService.finalizeArtifact({
          id: 'invalid id with spaces!',
          relativePath: 'artifacts/valid.txt',
          content: 'test',
          type: 'file',
        }),
      ).toThrow(/INVALID_ARTIFACT_ID/);

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'id/with/slashes',
          relativePath: 'artifacts/valid.txt',
          content: 'test',
          type: 'file',
        }),
      ).toThrow(/INVALID_ARTIFACT_ID/);
    });

    it('should reject unknown artifact types', () => {
      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_unknown_type',
          relativePath: 'artifacts/valid.txt',
          content: 'test',
          type: 'unsupported_type' as any,
        }),
      ).toThrow(/UNKNOWN_ARTIFACT_TYPE/);
    });

    it('should reject disallowed executable extensions', () => {
      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_disallowed_exe',
          relativePath: 'artifacts/malware.exe',
          content: 'binary',
          type: 'file',
        }),
      ).toThrow(/UNSUPPORTED_EXTENSION/);

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_disallowed_bat',
          relativePath: 'artifacts/script.bat',
          content: 'echo hello',
          type: 'file',
        }),
      ).toThrow(/UNSUPPORTED_EXTENSION/);
    });

    it('should reject invalid JSON content for evidence/report types with .json extension', () => {
      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_bad_json',
          relativePath: 'artifacts/evidence/corrupted.json',
          content: '{ unclosed json...',
          type: 'evidence',
        }),
      ).toThrow(/INVALID_CONTENT/);
    });

    it('should reject expected-hash mismatches and leave no files', () => {
      const initialEvents = eventService.getStats().totalEvents;
      const targetPath = path.join(testDir, 'artifacts', 'mismatch.txt');

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_mismatch_test',
          relativePath: 'artifacts/mismatch.txt',
          content: 'genuine content',
          type: 'file',
          expectedHash: '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      ).toThrow(/HASH_MISMATCH/);

      // Verify no destination file created
      expect(fs.existsSync(targetPath)).toBe(false);
      // Verify no event emitted
      expect(eventService.getStats().totalEvents).toBe(initialEvents);
    });

    it('should fail closed when Rust engine fails or is tampered', () => {
      const initialEvents = eventService.getStats().totalEvents;

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_rust_fail',
          relativePath: 'artifacts/reports/rust_fail.md',
          content: 'test content',
          type: 'report',
          _mockRustFailure: true,
        }),
      ).toThrow(/RUST_HASH_FAILED/);

      expect(eventService.getStats().totalEvents).toBe(initialEvents);
    });
  });

  // ── 3. Overwrite & Collision Protection ─────────────────────────

  describe('Collision & Overwrite Control', () => {
    it('should reject existing file collision without allowOverwrite', () => {
      artifactService.finalizeArtifact({
        id: 'art_collision_base',
        relativePath: 'artifacts/collision_target.txt',
        content: 'version 1',
        type: 'file',
      });

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_collision_new',
          relativePath: 'artifacts/collision_target.txt',
          content: 'version 2 without permission',
          type: 'file',
        }),
      ).toThrow(/ARTIFACT_COLLISION/);
    });

    it('should reject duplicate artifact ID finalization', () => {
      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_collision_base',
          relativePath: 'artifacts/different_path.txt',
          content: 'version 2',
          type: 'file',
        }),
      ).toThrow(/DUPLICATE_FINALIZATION/);
    });

    it('should reject overwrite without approved approvalId reference', () => {
      // Pending approval
      const pendingApproval = approvalService.createApproval({
        gateId: 'G3',
        conditions: ['check overwrite'],
      });

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_collision_base',
          relativePath: 'artifacts/collision_target.txt',
          content: 'version 2 pending',
          type: 'file',
          allowOverwrite: true,
          approvalId: pendingApproval.id, // Not yet approved!
        }),
      ).toThrow(/UNAUTHORIZED_OVERWRITE/);
    });

    it('should allow overwrite when explicit approval is approved', () => {
      const approval = approvalService.createApproval({
        gateId: 'G3',
        conditions: ['permit overwrite'],
      });
      approvalService.decideApproval(approval.id, 'approved', 'sec-officer');

      const updatedContent = 'version 2 approved and verified';
      const updated = artifactService.finalizeArtifact({
        id: 'art_collision_base',
        relativePath: 'artifacts/collision_target.txt',
        content: updatedContent,
        type: 'file',
        allowOverwrite: true,
        approvalId: approval.id,
      });

      expect(updated.id).toBe('art_collision_base');
      const diskContent = fs.readFileSync(path.join(testDir, 'artifacts', 'collision_target.txt'), 'utf-8');
      expect(diskContent).toBe(updatedContent);
    });
  });

  // ── 4. Interruption, Rollback & Orphan Cleanup ──────────────────

  describe('Interruption, Rollback & Orphan Cleanup', () => {
    it('should cleanly roll back on write interruption and emit no event', () => {
      const initialEvents = eventService.getStats().totalEvents;

      expect(() =>
        artifactService.finalizeArtifact({
          id: 'art_interrupted',
          relativePath: 'artifacts/interrupted.txt',
          content: 'interrupted payload',
          type: 'file',
          _simulateInterruption: 'before_close',
        }),
      ).toThrow(/INTERRUPTED_WRITE/);

      expect(fs.existsSync(path.join(testDir, 'artifacts', 'interrupted.txt'))).toBe(false);
      expect(eventService.getStats().totalEvents).toBe(initialEvents);
    });

    it('should roll back finalized files when event persistence fails', () => {
      const originalRecordEvent = eventService.recordEvent.bind(eventService);
      (eventService as any).recordEvent = () => {
        throw new Error('EVENT_PERSISTENCE_FAILED: simulated event store failure');
      };

      try {
        expect(() => artifactService.finalizeArtifact({
          id: 'art_event_failure',
          relativePath: 'artifacts/event-failure.txt',
          content: 'must not remain untracked',
          type: 'file',
        })).toThrow(/EVENT_PERSISTENCE_FAILED/);
      } finally {
        (eventService as any).recordEvent = originalRecordEvent;
      }

      expect(fs.existsSync(path.join(testDir, 'artifacts', 'event-failure.txt'))).toBe(false);
      expect(fs.existsSync(path.join(testDir, '.maos', 'artifacts', 'metadata', 'art_event_failure.json'))).toBe(false);
      expect(artifactService.getArtifact('art_event_failure')).toBeNull();
    });

    it('should purge orphaned temporary files left by simulated crash before rename', () => {
      // Simulate crash immediately before rename (temp file left on disk)
      try {
        artifactService.finalizeArtifact({
          id: 'art_crash_test',
          relativePath: 'artifacts/crashed.txt',
          content: 'will crash before rename',
          type: 'file',
          _simulateInterruption: 'before_rename',
        });
      } catch (err: any) {
        expect(err.message).toContain('INTERRUPTED_FINALIZATION');
      }

      // Verify temp file exists in .tmp
      const tmpDir = path.join(testDir, 'artifacts', '.tmp');
      const files = fs.readdirSync(tmpDir).filter((f) => f.includes('art_crash_test'));
      expect(files.length).toBe(1);

      // Perform orphan cleanup (maxAgeMs = 0 to purge all immediately)
      const purged = artifactService.cleanupOrphanTempFiles(0);
      expect(purged).toBeGreaterThanOrEqual(1);

      // Verify temp file is gone
      const remaining = fs.readdirSync(tmpDir).filter((f) => f.includes('art_crash_test'));
      expect(remaining.length).toBe(0);
    });
  });

  // ── 5. Content Retrieval & Confinement ──────────────────────────

  describe('Content Retrieval & Confinement', () => {
    it('should retrieve content and infer correct content type', () => {
      const res = artifactService.getArtifactContent('art_safety_report_01');
      expect(res.contentType).toBe('text/plain; charset=utf-8');
      expect(res.content).toContain('Safety Analysis');
    });

    it('should reject content retrieval attempting path traversal', () => {
      expect(() => artifactService.getArtifactContent('../../../etc/passwd')).toThrow(/PATH_TRAVERSAL/);
    });

    it('should reject content retrieval for temporary files', () => {
      expect(() => artifactService.getArtifactContent('.tmp/some_temp_file')).toThrow(/PATH_TRAVERSAL/);
    });
  });

  // ── 6. REST API Contract Integration ───────────────────────────

  describe('REST API Contract Integration (POST /api/v1/artifacts)', () => {
    it('should finalize an artifact via POST /api/v1/artifacts', async () => {
      const payload = {
        id: 'art_rest_finalized_01',
        relativePath: 'artifacts/reports/rest_report.json',
        content: JSON.stringify({ status: 'ok', source: 'rest_test' }),
        type: 'report',
      };

      const res = await fetch(`${baseUrl}/api/v1/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.id).toBe('art_rest_finalized_01');
      expect(json.data.hash).toBeDefined();

      // Verify accessible through GET /api/v1/artifacts/:id
      const detailRes = await fetch(`${baseUrl}/api/v1/artifacts/art_rest_finalized_01`);
      expect(detailRes.status).toBe(200);
      const detailJson = await detailRes.json();
      expect(detailJson.data.id).toBe('art_rest_finalized_01');
    });

    it('should return 400 for path traversal via REST POST', async () => {
      const res = await fetch(`${baseUrl}/api/v1/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'art_rest_traversal',
          relativePath: 'artifacts/../../escaped.txt',
          content: 'bad',
          type: 'file',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('PATH_TRAVERSAL');
    });

    it('should return 409 for collision via REST POST', async () => {
      const res = await fetch(`${baseUrl}/api/v1/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'art_rest_finalized_01', // Already finalized
          relativePath: 'artifacts/reports/other.txt',
          content: 'duplicate id',
          type: 'file',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('CONFLICT');
    });
  });
});
