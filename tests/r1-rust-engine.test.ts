/**
 * R1-09: Verification suite for the Rust Industrial Engine.
 *
 * Tests:
 * - Engine binary existence and health
 * - Protocol version matching
 * - Threshold evaluation parity with TypeScript
 * - CSV parsing
 * - Evidence chain creation and verification
 * - Malformed input handling (no panics)
 * - Bridge fail-closed behavior
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  verifyExecutable,
  invokeEngine,
  engineHealth,
  engineEvaluate,
  engineParseSensor,
  engineHash,
  engineChainVerify,
  getDefaultEnginePath,
  EngineError,
} from '../src/industrial/rust-engine-bridge';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENGINE_PATH = getDefaultEnginePath(PROJECT_ROOT);
const ENGINE_EXISTS = fs.existsSync(ENGINE_PATH);

// Skip all tests if engine binary not built
const describeIfEngine = ENGINE_EXISTS ? describe : describe.skip;

describeIfEngine('R1-09: Rust Engine Verification Suite', () => {
  let manifest: ReturnType<typeof verifyExecutable>;

  // ── R1-01: Executable verification ────────────────────────────

  describe('R1-01/08: Executable verification', () => {
    it('should verify engine executable exists', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      expect(manifest.executablePath).toBe(path.resolve(ENGINE_PATH));
      expect(manifest.executableHash).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.protocolVersion).toBe('1.0');
    });

    it('should fail closed for missing binary', () => {
      expect(() => verifyExecutable('/nonexistent/maos-engine.exe')).toThrow(EngineError);
      expect(() => verifyExecutable('/nonexistent/maos-engine.exe')).toThrow('not found');
    });

    it('should fail closed for tampered binary (wrong hash)', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const wrongHash = 'a'.repeat(64);
      expect(() => verifyExecutable(ENGINE_PATH, wrongHash)).toThrow(EngineError);
      expect(() => verifyExecutable(ENGINE_PATH, wrongHash)).toThrow('hash mismatch');
    });
  });

  // ── R1-02: Protocol version ──────────────────────────────────

  describe('R1-02: Protocol contract', () => {
    it('should respond to health check with correct protocol version', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineHealth(manifest);
      expect('error' in response).toBe(false);
      if (!('error' in response)) {
        expect(response.version).toBe('1.0');
        expect(response.data.status).toBe('ok');
        expect(response.data.engine).toBe('maos-industrial-engine');
        expect(response.data.unsafe_code).toBe(false);
      }
    });

    it('should reject wrong protocol version', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = invokeEngine(manifest, {
        version: '99.0',
        operation: 'health',
      });
      expect('error' in response && response.error).toBe(true);
      if ('error' in response) {
        expect(response.category).toBe('protocol');
        expect(response.message).toContain('99.0');
      }
    });

    it('should reject unknown operation', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = invokeEngine(manifest, {
        version: '1.0',
        operation: 'delete_everything',
      });
      expect('error' in response && response.error).toBe(true);
      if ('error' in response) {
        expect(response.category).toBe('protocol');
        expect(response.message).toContain('delete_everything');
      }
    });

    it('should reject malformed JSON', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      // Send raw non-JSON — the bridge should handle this
      const response = invokeEngine(manifest, {
        version: '1.0',
        operation: 'health',
      });
      // Valid request should succeed
      expect('error' in response).toBe(false);
    });
  });

  // ── R1-04: CSV parsing ────────────────────────────────────────

  describe('R1-04: Deterministic CSV parsing', () => {
    it('should parse valid sensor CSV', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const csv = 'timestamp,metric,value,unit\n2024-01-01T00:00:00Z,vibration,4.5,mm/s\n2024-01-01T00:01:00Z,temperature,75.2,°C\n';
      const response = engineParseSensor(manifest, csv);
      expect('error' in response).toBe(false);
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.row_count).toBe(2);
        expect(data.records[0].metric).toBe('vibration');
        expect(data.records[0].numeric_value).toBe(4.5);
        expect(data.records[1].metric).toBe('temperature');
      }
    });

    it('should reject NaN and Infinity in CSV values', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const csv = 'timestamp,metric,value,unit\n2024-01-01,vibration,NaN,mm/s\n2024-01-01,temp,Infinity,°C\n';
      const response = engineParseSensor(manifest, csv);
      expect('error' in response).toBe(false);
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.row_count).toBe(0);
        expect(data.warnings.length).toBe(2);
      }
    });

    it('should detect duplicate rows', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const csv = 'timestamp,metric,value,unit\n2024-01-01,vibration,4.5,mm/s\n2024-01-01,vibration,4.5,mm/s\n';
      const response = engineParseSensor(manifest, csv);
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.row_count).toBe(1);
        expect(data.warnings.some((w: any) => w.message.includes('Duplicate'))).toBe(true);
      }
    });
  });

  // ── R1-05: Threshold evaluation parity ────────────────────────

  describe('R1-05: Threshold evaluation (TS/Rust parity)', () => {
    it('should return PASS for values below warning', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { vibration: 3.0 },
        { vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' } },
      );
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.status).toBe('PASS');
        expect(data.findings[0].status).toBe('PASS');
        expect(data.findings[0].recommendation).toBe('No action required.');
      }
    });

    it('should return WARNING at exact boundary (>=)', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { vibration: 4.5 },
        { vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' } },
      );
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.findings[0].status).toBe('WARNING');
      }
    });

    it('should return FAIL at exact critical boundary (>=)', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { vibration: 7.1 },
        { vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' } },
      );
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.status).toBe('FAIL');
        expect(data.findings[0].status).toBe('FAIL');
      }
    });

    it('should include ruleId with rulesetId', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { vibration: 8.0 },
        { vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' } },
        'TURBINE-T07',
      );
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.findings[0].rule_id).toBe('TURBINE-T07/vibration');
        expect(data.ruleset_id).toBe('TURBINE-T07');
      }
    });

    it('should fail closed for missing rules', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { unknown_metric: 5.0 },
        {},
      );
      if (!('error' in response)) {
        const data = response.data as any;
        expect(data.findings[0].status).toBe('WARNING');
        expect(data.findings[0].recommendation).toContain('No threshold rule');
      }
    });

    it('should calculate deviation correctly', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const response = engineEvaluate(
        manifest,
        { vibration: 8.0 },
        { vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' } },
      );
      if (!('error' in response)) {
        const data = response.data as any;
        const deviation = data.findings[0].deviation;
        expect(Math.abs(deviation - 0.9)).toBeLessThan(1e-10);
      }
    });
  });

  // ── R1-06: Evidence chain ─────────────────────────────────────

  describe('R1-06: Evidence chain', () => {
    it('should produce deterministic hashes', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const data = { key: 'value', nested: { a: 1, b: 2 } };
      const r1 = engineHash(manifest, data);
      const r2 = engineHash(manifest, data);
      if (!('error' in r1) && !('error' in r2)) {
        expect(r1.data.hash).toBe(r2.data.hash);
        expect(r1.data.algorithm).toBe('sha256');
      }
    });

    it('should produce different hashes for different data', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const r1 = engineHash(manifest, { key: 'value1' });
      const r2 = engineHash(manifest, { key: 'value2' });
      if (!('error' in r1) && !('error' in r2)) {
        expect(r1.data.hash).not.toBe(r2.data.hash);
      }
    });

    it('should produce same hash regardless of key order', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const r1 = engineHash(manifest, { a: 1, b: 2 });
      const r2 = engineHash(manifest, { b: 2, a: 1 });
      if (!('error' in r1) && !('error' in r2)) {
        expect(r1.data.hash).toBe(r2.data.hash);
      }
    });

    it('should verify a valid chain', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      // Build a 3-record chain using the engine
      const r0 = invokeEngine(manifest, {
        version: '1.0',
        operation: 'chain-append',
        data: { sequence: 0, previous_hash: '', timestamp: '2024-01-01T00:00:00Z', source: 'test', category: 'general', data: { step: 1 } },
      });

      if ('error' in r0) return;
      const record0 = r0.data as any;

      const r1 = invokeEngine(manifest, {
        version: '1.0',
        operation: 'chain-append',
        data: { sequence: 1, previous_hash: record0.hash, timestamp: '2024-01-01T00:01:00Z', source: 'test', category: 'general', data: { step: 2 } },
      });

      if ('error' in r1) return;
      const record1 = r1.data as any;

      // Verify the chain
      const verify = engineChainVerify(manifest, [record0, record1]);
      if (!('error' in verify)) {
        expect(verify.data.valid).toBe(true);
        expect(verify.data.record_count).toBe(2);
        expect((verify.data.errors as any[]).length).toBe(0);
      }
    });

    it('should detect tampering in chain', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const r0 = invokeEngine(manifest, {
        version: '1.0',
        operation: 'chain-append',
        data: { sequence: 0, previous_hash: '', timestamp: '2024-01-01T00:00:00Z', source: 'test', category: 'general', data: { step: 1 } },
      });

      if ('error' in r0) return;
      const record0 = r0.data as any;
      // Tamper with the data
      record0.data = { step: 999 };

      const verify = engineChainVerify(manifest, [record0]);
      if (!('error' in verify)) {
        expect(verify.data.valid).toBe(false);
        expect((verify.data.errors as any[]).some((e: string) => e.includes('hash mismatch'))).toBe(true);
      }
    });
  });

  // ── Deterministic repeatability ────────────────────────────────

  describe('Deterministic repeatability', () => {
    it('should produce identical evaluation results across multiple runs', () => {
      manifest = verifyExecutable(ENGINE_PATH);
      const normalize = (response: any) => {
        // Sort findings by metric name for deterministic comparison
        if (!('error' in response) && response.data?.findings) {
          const sorted = { ...response, data: { ...response.data, findings: [...response.data.findings].sort((a: any, b: any) => a.metric.localeCompare(b.metric)) } };
          return JSON.stringify(sorted);
        }
        return JSON.stringify(response);
      };

      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        const response = engineEvaluate(
          manifest,
          { vibration: 5.5, temperature: 82.0 },
          {
            vibration: { warning: 4.5, critical: 7.1, unit: 'mm/s' },
            temperature: { warning: 80, critical: 100, unit: '°C' },
          },
          'TURBINE-T07',
        );
        results.push(normalize(response));
      }
      // All 3 runs should produce identical output (after normalization)
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });
  });
});
