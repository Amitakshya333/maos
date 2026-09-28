/**
 * MAOS Industrial — F9-11: Audit Chain Append Lock
 *
 * The audit chain append is a read-modify-write across processes: read the log,
 * derive `sequence` from the record count, compute the hash (spawning the Rust
 * engine, which takes milliseconds), append, then commit the head. Two processes
 * interleaving in that window derive the same sequence and link to the same
 * predecessor, forking the chain and desynchronising the head. After a fork every
 * subsequent append throws `CORRUPT_AUDIT_LOG`, so the chain can neither be
 * extended nor verified — the product is bricked.
 *
 * This suite covers:
 *  1. Serialisation — the critical section is held exclusively.
 *  2. Fail-closed — an append that cannot take the lock refuses rather than forks.
 *  3. Recovery — dead-owner and corrupt locks are reclaimed.
 *  4. Hygiene — the lock never outlives an append.
 *  5. End-to-end — two real OS processes appending concurrently produce a linear
 *     chain with a consistent head.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AuditService } from '../../src/service/audit-service';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function readChain(projectRoot: string) {
  const chainPath = path.join(projectRoot, '.maos', 'audit', 'audit-chain.jsonl');
  if (!fs.existsSync(chainPath)) return [];
  const content = fs.readFileSync(chainPath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map((l) => JSON.parse(l));
}

function chainAnomalies(records: any[]) {
  let sequenceAnomalies = 0;
  let linkBreaks = 0;
  for (let i = 0; i < records.length; i++) {
    if (records[i].sequence !== i) sequenceAnomalies++;
    if (i > 0 && records[i].previous_hash !== records[i - 1].hash) linkBreaks++;
  }
  return { sequenceAnomalies, linkBreaks };
}

function headOf(projectRoot: string) {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.maos', 'audit', 'audit-head.json'), 'utf8'),
  );
}

describe('F9-11: Audit chain append lock', () => {
  const suiteDir = path.join(PROJECT_ROOT, '.maos', 'test-temp-f911-' + Date.now());
  let testTempDir: string;
  const lockPath = () => path.join(testTempDir, '.maos', 'audit', 'audit-chain.lock');

  beforeAll(() => {
    fs.mkdirSync(suiteDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(suiteDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  let audit: AuditService;

  // Each test gets its own project root so chain lengths are absolute, not
  // relative to whatever earlier tests happened to write.
  let caseIndex = 0;
  beforeEach(() => {
    testTempDir = path.join(suiteDir, `case-${caseIndex++}`);
    fs.mkdirSync(testTempDir, { recursive: true });
    audit = new AuditService(testTempDir, undefined, { lockTimeoutMs: 150 });
  });

  // ── 1. Serialisation ──────────────────────────────────────────────

  describe('1. Serialisation', () => {
    it('appends a linear, head-consistent chain', () => {
      for (let i = 0; i < 5; i++) {
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { i } });
      }

      const records = readChain(testTempDir);
      const { sequenceAnomalies, linkBreaks } = chainAnomalies(records);
      const head = headOf(testTempDir);

      expect(records).toHaveLength(5);
      expect(sequenceAnomalies).toBe(0);
      expect(linkBreaks).toBe(0);
      expect(head.recordCount).toBe(5);
      expect(records[records.length - 1].hash).toBe(head.latestHash);
    });

    it('verifies the chain through the product verifier', () => {
      for (let i = 0; i < 3; i++) {
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { i } });
      }
      expect(audit.verifyChain().valid).toBe(true);
    });
  });

  // ── 2. Fail-Closed ────────────────────────────────────────────────

  describe('2. Fail-closed on a held lock', () => {
    it('refuses to append while another live process holds the lock', () => {
      audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { seed: true } });
      const before = readChain(testTempDir).length;

      // Simulate a competing writer: a lock owned by a live PID (our own).
      fs.writeFileSync(
        lockPath(),
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );

      expect(() =>
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { blocked: true } }),
      ).toThrow(/AUDIT_LOCK_TIMEOUT/);

      // The refusal must leave the chain untouched and un-forked.
      const records = readChain(testTempDir);
      expect(records).toHaveLength(before);
      expect(chainAnomalies(records).sequenceAnomalies).toBe(0);
      expect(chainAnomalies(records).linkBreaks).toBe(0);
    });

    it('reports the reason honestly rather than appending unlocked', () => {
      fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid }));
      try {
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: {} });
        throw new Error('expected the append to be refused');
      } catch (err: any) {
        expect(err.message).toContain('AUDIT_LOCK_TIMEOUT');
        expect(err.message).toContain('fork the chain');
      }
    });
  });

  // ── 3. Recovery ───────────────────────────────────────────────────

  describe('3. Recovery from abandoned locks', () => {
    it('reclaims a lock whose owner process is dead', () => {
      // A PID that cannot be alive.
      fs.writeFileSync(
        lockPath(),
        JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }),
      );

      expect(() =>
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { recovered: true } }),
      ).not.toThrow();

      const records = readChain(testTempDir);
      expect(records).toHaveLength(1);
      expect(chainAnomalies(records).sequenceAnomalies).toBe(0);
    });

    it('reclaims an unreadable lock file', () => {
      fs.writeFileSync(lockPath(), 'not json at all');

      expect(() =>
        audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: { recovered: true } }),
      ).not.toThrow();

      const records = readChain(testTempDir);
      expect(records).toHaveLength(1);
      expect(chainAnomalies(records).sequenceAnomalies).toBe(0);
    });
  });

  // ── 4. Hygiene ────────────────────────────────────────────────────

  describe('4. Lock hygiene', () => {
    it('releases the lock after a successful append', () => {
      audit.recordAuditEvent({ category: 'stage', source: 'f9-11', data: {} });
      expect(fs.existsSync(lockPath())).toBe(false);
    });

    it('releases the lock when the append throws', () => {
      // A non-existent engine path makes the hash step fail inside the section.
      const broken = new AuditService(testTempDir, '/nonexistent/engine-binary', {
        lockTimeoutMs: 150,
      });

      expect(() =>
        broken.recordAuditEvent({ category: 'stage', source: 'f9-11', data: {} }),
      ).toThrow();

      expect(fs.existsSync(lockPath())).toBe(false);
    });
  });

  // ── 5. End-to-End Cross-Process ───────────────────────────────────

  describe('5. Concurrent OS processes', () => {
    const distAudit = path.join(PROJECT_ROOT, 'dist', 'service', 'audit-service.js');

    it('two concurrent processes produce a linear chain with a consistent head', async () => {
      if (!fs.existsSync(distAudit)) {
        throw new Error(
          `Compiled build required for the cross-process test: ${distAudit} not found. Run "npm run build:backend" first.`,
        );
      }

      const raceProject = path.join(PROJECT_ROOT, '.maos', 'test-temp-f911-race-' + Date.now());
      fs.mkdirSync(raceProject, { recursive: true });

      const childScript = `
        const { AuditService } = require(${JSON.stringify(distAudit)});
        const projectRoot = process.argv[1];
        const tag = process.argv[2];
        const audit = new AuditService(projectRoot);
        for (let i = 0; i < 20; i++) {
          audit.recordAuditEvent({ category: 'stage', source: 'race-' + tag, data: { i, tag } });
        }
      `;

      const runChild = (tag: string) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', childScript, raceProject, tag], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => (stderr += String(d)));
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}: ${stderr}`)),
          );
          child.on('error', reject);
        });

      // Both processes start together and contend for the same append lock.
      await Promise.all([runChild('a'), runChild('b')]);

      const records = readChain(raceProject);
      const { sequenceAnomalies, linkBreaks } = chainAnomalies(records);
      const head = headOf(raceProject);

      // Every append from both writers landed, in a single linear order.
      expect(records).toHaveLength(40);
      expect(sequenceAnomalies).toBe(0);
      expect(linkBreaks).toBe(0);
      expect(head.recordCount).toBe(40);
      expect(records[records.length - 1].hash).toBe(head.latestHash);

      const tags = new Set(records.map((r: any) => r.source));
      expect(tags).toEqual(new Set(['race-a', 'race-b']));

      // And the product's own verifier accepts it.
      const verifyService = new AuditService(raceProject);
      expect(verifyService.verifyChain().valid).toBe(true);

      fs.rmSync(raceProject, { recursive: true, force: true });
    }, 120_000);
  });
});
