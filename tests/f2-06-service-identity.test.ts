/**
 * F2-06: Service Health & Identity Manifests Tests
 *
 * Tests:
 * - Manifest creation for all 5 service types
 * - Health probe: matching identity → healthy
 * - Health probe: version mismatch → unhealthy
 * - Health probe: protocol mismatch → unhealthy
 * - Health probe: executable hash mismatch → unhealthy
 * - Health probe: model revision mismatch → unhealthy
 * - Health probe: device mismatch → unhealthy
 * - Health probe: absent service → unhealthy
 * - Health probe: offline mode mismatch → unhealthy
 * - Full summary: all healthy, some mismatched, all absent
 * - Manifest I/O: write/read/register roundtrip
 * - Registry: register, get, clear
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  createLauncherManifest,
  createProjectServiceManifest,
  createModelManagerManifest,
  createModelEndpointManifest,
  createRustEngineManifest,
  registerManifest,
  getManifest,
  getAllManifests,
  clearManifests,
  probeServiceHealth,
  probeAllServices,
  writeManifests,
  loadManifests,
  writeHealthSummary,
  ServiceIdentityManifest,
} from '../src/industrial/service-identity';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('F2-06: Service Health & Identity Manifests', () => {
  beforeEach(() => {
    clearManifests();
  });

  // ══════════════════════════════════════════════════════════════
  // Manifest creation
  // ══════════════════════════════════════════════════════════════

  describe('Manifest creation', () => {
    it('should create launcher manifest', () => {
      const m = createLauncherManifest('0.3.0');
      expect(m.serviceId).toBe('launcher');
      expect(m.version).toBe('0.3.0');
      expect(m.offlineOnly).toBe(true);
      expect(m.host).toBe('127.0.0.1');
      expect(m.platform).toBe(process.platform);
    });

    it('should create project service manifest', () => {
      const m = createProjectServiceManifest('0.3.0', 8080);
      expect(m.serviceId).toBe('project-service');
      expect(m.port).toBe(8080);
      expect(m.offlineOnly).toBe(true);
    });

    it('should create model manager manifest', () => {
      const m = createModelManagerManifest('0.3.0', 'cuda');
      expect(m.serviceId).toBe('model-manager');
      expect(m.device).toBe('cuda');
    });

    it('should create model endpoint manifest', () => {
      const m = createModelEndpointManifest(
        'text-model', 'Text Model Server', '1.0.0', 8081,
        'Qwen/Qwen2.5-3B-Instruct', 'aa8e7253', 'cuda',
      );
      expect(m.serviceId).toBe('text-model');
      expect(m.modelName).toBe('Qwen/Qwen2.5-3B-Instruct');
      expect(m.modelRevision).toBe('aa8e7253');
      expect(m.device).toBe('cuda');
      expect(m.port).toBe(8081);
    });

    it('should create Rust engine manifest', () => {
      const m = createRustEngineManifest('0.1.0', 'abc123');
      expect(m.serviceId).toBe('rust-engine');
      expect(m.executableHash).toBe('abc123');
      expect(m.port).toBe(0); // stdin/stdout
    });

    it('should set offlineOnly=true for all services', () => {
      const manifests = [
        createLauncherManifest('1.0'),
        createProjectServiceManifest('1.0', 8080),
        createModelManagerManifest('1.0', 'cpu'),
        createModelEndpointManifest('ep', 'EP', '1.0', 8081),
        createRustEngineManifest('1.0', 'hash'),
      ];
      for (const m of manifests) {
        expect(m.offlineOnly).toBe(true);
      }
    });

    it('should set loopback host for all services', () => {
      const manifests = [
        createLauncherManifest('1.0'),
        createProjectServiceManifest('1.0', 8080),
        createModelManagerManifest('1.0', 'cpu'),
        createModelEndpointManifest('ep', 'EP', '1.0', 8081),
        createRustEngineManifest('1.0', 'hash'),
      ];
      for (const m of manifests) {
        expect(m.host).toBe('127.0.0.1');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Registry
  // ══════════════════════════════════════════════════════════════

  describe('Registry', () => {
    it('should register and retrieve manifests', () => {
      const m = createLauncherManifest('1.0');
      registerManifest(m);
      expect(getManifest('launcher')).toBe(m);
    });

    it('should return undefined for unregistered service', () => {
      expect(getManifest('nonexistent')).toBeUndefined();
    });

    it('should list all registered manifests', () => {
      registerManifest(createLauncherManifest('1.0'));
      registerManifest(createRustEngineManifest('0.1', 'h'));
      expect(getAllManifests().length).toBe(2);
    });

    it('should clear all manifests', () => {
      registerManifest(createLauncherManifest('1.0'));
      clearManifests();
      expect(getAllManifests().length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Health probes — identity match
  // ══════════════════════════════════════════════════════════════

  describe('Health probes — matching', () => {
    it('should be healthy when all fields match', () => {
      const m = createRustEngineManifest('0.1.0', 'abc123');
      const result = probeServiceHealth(m, {
        version: '0.1.0',
        protocolVersion: '1.0',
        executableHash: 'abc123',
        device: 'cpu',
        offlineOnly: true,
        host: '127.0.0.1',
      });

      expect(result.healthy).toBe(true);
      expect(result.identityMatch).toBe(true);
      for (const check of result.checks) {
        expect(check.passed).toBe(true);
      }
    });

    it('should record latency', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, { version: '1.0' });
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Health probes — mismatches
  // ══════════════════════════════════════════════════════════════

  describe('Health probes — mismatches', () => {
    it('should be unhealthy on version mismatch', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, { version: '2.0' });
      expect(result.healthy).toBe(false);
      expect(result.identityMatch).toBe(false);

      const vCheck = result.checks.find(c => c.name === 'version');
      expect(vCheck?.passed).toBe(false);
      expect(vCheck?.expected).toBe('1.0');
      expect(vCheck?.actual).toBe('2.0');
    });

    it('should be unhealthy on protocol mismatch', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, { version: '1.0', protocolVersion: '2.0' });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on executable hash mismatch', () => {
      const m = createRustEngineManifest('0.1', 'expected_hash');
      const result = probeServiceHealth(m, {
        version: '0.1',
        protocolVersion: '1.0',
        executableHash: 'wrong_hash',
      });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on model revision mismatch', () => {
      const m = createModelEndpointManifest(
        'text', 'Text', '1.0', 8081, 'Qwen/Qwen2.5', 'rev-abc',
      );
      const result = probeServiceHealth(m, {
        version: '1.0',
        modelRevision: 'rev-xyz',
      });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on model name mismatch', () => {
      const m = createModelEndpointManifest(
        'text', 'Text', '1.0', 8081, 'ModelA', 'rev',
      );
      const result = probeServiceHealth(m, {
        version: '1.0',
        modelName: 'ModelB',
      });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on device mismatch', () => {
      const m = createModelManagerManifest('1.0', 'cuda');
      const result = probeServiceHealth(m, {
        version: '1.0',
        device: 'cpu',
      });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on offline mode mismatch', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, {
        version: '1.0',
        offlineOnly: false,
      });
      expect(result.identityMatch).toBe(false);
    });

    it('should be unhealthy on host mismatch', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, {
        version: '1.0',
        host: '0.0.0.0',
      });
      expect(result.identityMatch).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Health probes — absent service
  // ══════════════════════════════════════════════════════════════

  describe('Health probes — absent', () => {
    it('should be unhealthy when service is absent', () => {
      const m = createLauncherManifest('1.0');
      const result = probeServiceHealth(m, undefined);

      expect(result.healthy).toBe(false);
      expect(result.identityMatch).toBe(false);
      expect(result.checks[0].name).toBe('reachable');
      expect(result.checks[0].actual).toBe('absent');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Full health summary
  // ══════════════════════════════════════════════════════════════

  describe('Full health summary', () => {
    it('should report healthy when all services match', () => {
      registerManifest(createLauncherManifest('1.0'));
      registerManifest(createRustEngineManifest('0.1', 'h'));

      const liveMap = new Map<string, Partial<ServiceIdentityManifest>>();
      liveMap.set('launcher', { version: '1.0', protocolVersion: '1.0', device: 'cpu', offlineOnly: true, host: '127.0.0.1' });
      liveMap.set('rust-engine', { version: '0.1', protocolVersion: '1.0', executableHash: 'h', device: 'cpu', offlineOnly: true, host: '127.0.0.1' });

      const summary = probeAllServices(liveMap);
      expect(summary.status).toBe('healthy');
      expect(summary.mismatched.length).toBe(0);
      expect(summary.absent.length).toBe(0);
    });

    it('should report unhealthy when services are mismatched', () => {
      registerManifest(createLauncherManifest('1.0'));

      const liveMap = new Map<string, Partial<ServiceIdentityManifest>>();
      liveMap.set('launcher', { version: '2.0' }); // mismatch

      const summary = probeAllServices(liveMap);
      expect(summary.status).toBe('unhealthy');
      expect(summary.mismatched).toContain('launcher');
    });

    it('should report unhealthy when services are absent', () => {
      registerManifest(createLauncherManifest('1.0'));
      registerManifest(createRustEngineManifest('0.1', 'h'));

      const summary = probeAllServices(new Map()); // no live data
      expect(summary.status).toBe('unhealthy');
      expect(summary.absent).toContain('launcher');
      expect(summary.absent).toContain('rust-engine');
    });

    it('should report unknown when no services registered', () => {
      const summary = probeAllServices(new Map());
      expect(summary.status).toBe('unknown');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Manifest I/O
  // ══════════════════════════════════════════════════════════════

  describe('Manifest I/O', () => {
    const outDir = path.resolve(PROJECT_ROOT, '.maos', 'test-identity');

    it('should write and load manifests', () => {
      registerManifest(createLauncherManifest('1.0'));
      registerManifest(createRustEngineManifest('0.1', 'hash'));

      try {
        writeManifests(outDir);

        // Verify files exist
        expect(fs.existsSync(path.join(outDir, 'launcher.identity.json'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'rust-engine.identity.json'))).toBe(true);

        // Clear and reload
        clearManifests();
        expect(getAllManifests().length).toBe(0);

        const loaded = loadManifests(outDir);
        expect(loaded.length).toBe(2);
        expect(getAllManifests().length).toBe(2);
        expect(getManifest('launcher')?.version).toBe('1.0');
      } finally {
        // Cleanup
        if (fs.existsSync(outDir)) {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      }
    });

    it('should handle non-existent input directory', () => {
      const loaded = loadManifests('/nonexistent');
      expect(loaded.length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Health summary I/O
  // ══════════════════════════════════════════════════════════════

  describe('Health summary I/O', () => {
    it('should write health summary to file', () => {
      registerManifest(createLauncherManifest('1.0'));
      const summary = probeAllServices(new Map());
      const outPath = path.resolve(PROJECT_ROOT, '.maos', 'test-health-summary.json');

      try {
        writeHealthSummary(summary, outPath);
        expect(fs.existsSync(outPath)).toBe(true);

        const loaded = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        expect(loaded.status).toBeDefined();
        expect(loaded.services.length).toBe(1);
      } finally {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      }
    });
  });
});
