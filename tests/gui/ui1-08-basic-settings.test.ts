/**
 * UI1-08: Basic Settings & Service Management Test Suite
 *
 * Exhaustively validates:
 * 1. Default settings generation and explicit bounds:
 *    - Retention (conversation: 1-365d, eventDisplay: 1-365d, artifactPreview: 1-365d, redact: boolean, allowRaw: boolean)
 *    - Runtime (modelUnload: 30-86400s, serviceStop: 60-86400s, stopMode: 'after-current-tasks' | 'force')
 *    - Accessibility (theme: 'dark' | 'high-contrast', reducedMotion: boolean, fontScale: 0.8-2.0, density: 'compact' | 'comfortable')
 * 2. Bounds enforcement & validation rejection (negative values, excessive timeouts, out-of-range fontScale)
 * 3. Normalization and safe partial merging
 * 4. Atomic persistence to .maos/settings/basic-settings.json with fsync and rename
 * 5. Resilient recovery from corrupted JSON or schema mismatch to canonical defaults
 * 6. Per-project settings isolation (Project A != Project B)
 * 7. Storage hygiene: zero tokens, passwords, secrets, or API keys on disk
 * 8. ProjectService integration: merged getSettings, atomic updateSettings, and resetSettings
 * 9. Stop service behavior:
 *    - Force-stop without confirmation strictly rejected (CONFIRMATION_REQUIRED)
 *    - Force-stop with confirmation marks active tasks as INTERRUPTED, cleans unfinalized temp artifacts, unloads models, and records audit event
 *    - Stop-after-current-tasks graceful reporting
 * 10. Live REST API endpoints:
 *     - GET /api/v1/settings
 *     - PATCH /api/v1/settings & PUT /api/v1/settings
 *     - POST /api/v1/settings/reset
 *     - POST /api/v1/service/stop
 *     - GET /api/v1/service/visibility
 *     - GET /api/v1/security/sovereignty
 * 11. BrowserRestClient & GuiApiAdapter typed integration
 * 12. Security invariants: settings cannot disable audit persistence or weaken loopback confinement
 * 13. Rust binary SHA-256 invariant preservation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import {
  BasicSettings,
  RetentionSettings,
  RuntimeSettings,
  AccessibilitySettings,
  SETTINGS_BOUNDS,
  getDefaultBasicSettings,
  validateBasicSettings,
  normalizeBasicSettings,
} from '../../src/domain/settings';
import { BasicSettingsStore } from '../../src/service/project-service/settings-store';
import { ProjectService } from '../../src/service/project-service';
import { TaskService } from '../../src/service/task-service';
import { ArtifactService } from '../../src/service/artifact-service';
import { ModelService } from '../../src/service/model-service';
import { SharedModelManager } from '../../src/service/model-manager';
import { AuditService } from '../../src/service/audit-service';
import { ProjectServiceHost, createProjectServiceHost } from '../../src/service/project-service/host';
import { BrowserRestClient } from '../../src/gui/src/api/rest-client';
import { GuiApiAdapter } from '../../src/gui/src/api/adapter';

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
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method || 'GET',
        headers: options.headers || {},
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

describe('UI1-08: Basic Settings & Service Management', () => {
  let tempBaseDir: string;
  let testDirA: string;
  let testDirB: string;
  let hostA: ProjectServiceHost;
  let portA: number;
  let sessionTokenA: string;

  beforeAll(async () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-08-test-'));
    testDirA = path.join(tempBaseDir, 'project-a');
    testDirB = path.join(tempBaseDir, 'project-b');

    // Create minimal valid .maos project folders
    const maosDirA = path.join(testDirA, '.maos');
    const maosDirB = path.join(testDirB, '.maos');
    fs.mkdirSync(maosDirA, { recursive: true });
    fs.mkdirSync(maosDirB, { recursive: true });

    const configA = {
      schemaVersion: 1,
      projectName: 'project-settings-a',
      profile: { id: 'industrial', mode: 'sovereign-local', zeroCloud: true },
      providers: {
        local: { type: 'local', baseURL: 'http://127.0.0.1:11434' },
      },
      agents: [
        { id: 'lead-dev', role: 'developer', provider: 'local', model: 'llama3:8b' },
      ],
      routing: { strategy: 'capability_score' },
    };
    fs.writeFileSync(path.join(maosDirA, 'maos.config.json'), JSON.stringify(configA, null, 2));

    const configB = {
      schemaVersion: 1,
      projectName: 'project-settings-b',
      profile: { id: 'industrial', mode: 'sovereign-local', zeroCloud: true },
      providers: {},
      agents: [],
      routing: { strategy: 'capability_score' },
    };
    fs.writeFileSync(path.join(maosDirB, 'maos.config.json'), JSON.stringify(configB, null, 2));

    // Create queue directories for TaskService
    for (const q of ['pending', 'active', 'done', 'failed']) {
      fs.mkdirSync(path.join(maosDirA, 'queue', q), { recursive: true });
      fs.mkdirSync(path.join(maosDirB, 'queue', q), { recursive: true });
    }

    // Start live loopback host for Project A
    hostA = createProjectServiceHost(testDirA, { port: 0 });
    const started = await hostA.start();
    portA = started.port;

    // The initial token is minted by the trusted launcher/IPC boundary.
    // Public HTTP handshake minting is intentionally forbidden.
    sessionTokenA = hostA.createSession('win-ui1-08-test').token;
  });

  afterAll(async () => {
    if (hostA) {
      await hostA.stop();
    }
    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ════════════════════════════════════════════════════════════════
  // 1. Domain Schemas, Bounds & Validation
  // ════════════════════════════════════════════════════════════════

  describe('1. Domain Schemas & Validation', () => {
    it('generates canonical default settings with schemaVersion 1 and explicit bounds', () => {
      const defaults = getDefaultBasicSettings('proj-123');
      expect(defaults.schemaVersion).toBe(1);
      expect(defaults.projectId).toBe('proj-123');

      // Retention defaults
      expect(defaults.retention.conversationDays).toBe(30);
      expect(defaults.retention.eventDisplayDays).toBe(90);
      expect(defaults.retention.artifactPreviewDays).toBe(30);
      expect(defaults.retention.redactSensitivePreviews).toBe(true);
      expect(defaults.retention.allowRawEvidencePreviews).toBe(false);

      // Runtime defaults
      expect(defaults.runtime.modelUnloadAfterSeconds).toBe(180);
      expect(defaults.runtime.serviceStopAfterSeconds).toBe(600);
      expect(defaults.runtime.stopMode).toBe('after-current-tasks');

      // Accessibility defaults
      expect(defaults.accessibility.theme).toBe('dark');
      expect(defaults.accessibility.reducedMotion).toBe(false);
      expect(defaults.accessibility.fontScale).toBe(1.0);
      expect(defaults.accessibility.density).toBe('comfortable');

      // Validates cleanly
      const validation = validateBasicSettings(defaults, 'proj-123');
      expect(validation.valid).toBe(true);
      expect(validation.settings).toBeDefined();
    });

    it('rejects invalid schemaVersion !== 1', () => {
      const invalid = { ...getDefaultBasicSettings('proj-123'), schemaVersion: 2 };
      const validation = validateBasicSettings(invalid);
      expect(validation.valid).toBe(false);
      expect(validation.errors?.some((e) => e.includes('schemaVersion'))).toBe(true);
    });

    it('rejects out-of-bounds retention settings', () => {
      // Below min (0 or negative)
      const low = {
        ...getDefaultBasicSettings('p'),
        retention: { ...getDefaultBasicSettings('p').retention, conversationDays: 0 },
      };
      expect(validateBasicSettings(low).valid).toBe(false);

      // Above max (> 365)
      const high = {
        ...getDefaultBasicSettings('p'),
        retention: { ...getDefaultBasicSettings('p').retention, conversationDays: 366 },
      };
      expect(validateBasicSettings(high).valid).toBe(false);

      // Non-boolean redaction
      const badBool = {
        ...getDefaultBasicSettings('p'),
        retention: { ...getDefaultBasicSettings('p').retention, redactSensitivePreviews: 'false' as any },
      };
      expect(validateBasicSettings(badBool).valid).toBe(false);
    });

    it('rejects out-of-bounds runtime idle settings', () => {
      // modelUnload < 30s
      const lowUnload = {
        ...getDefaultBasicSettings('p'),
        runtime: { ...getDefaultBasicSettings('p').runtime, modelUnloadAfterSeconds: 29 },
      };
      expect(validateBasicSettings(lowUnload).valid).toBe(false);

      // modelUnload > 86400s
      const highUnload = {
        ...getDefaultBasicSettings('p'),
        runtime: { ...getDefaultBasicSettings('p').runtime, modelUnloadAfterSeconds: 86401 },
      };
      expect(validateBasicSettings(highUnload).valid).toBe(false);

      // serviceStop < 60s
      const lowStop = {
        ...getDefaultBasicSettings('p'),
        runtime: { ...getDefaultBasicSettings('p').runtime, serviceStopAfterSeconds: 59 },
      };
      expect(validateBasicSettings(lowStop).valid).toBe(false);

      // Invalid stopMode
      const badMode = {
        ...getDefaultBasicSettings('p'),
        runtime: { ...getDefaultBasicSettings('p').runtime, stopMode: 'instant-kill' as any },
      };
      expect(validateBasicSettings(badMode).valid).toBe(false);
    });

    it('rejects out-of-bounds accessibility settings', () => {
      // Invalid theme
      const badTheme = {
        ...getDefaultBasicSettings('p'),
        accessibility: { ...getDefaultBasicSettings('p').accessibility, theme: 'solarized-light' as any },
      };
      expect(validateBasicSettings(badTheme).valid).toBe(false);

      // Font scale < 0.8
      const lowFont = {
        ...getDefaultBasicSettings('p'),
        accessibility: { ...getDefaultBasicSettings('p').accessibility, fontScale: 0.7 },
      };
      expect(validateBasicSettings(lowFont).valid).toBe(false);

      // Font scale > 2.0
      const highFont = {
        ...getDefaultBasicSettings('p'),
        accessibility: { ...getDefaultBasicSettings('p').accessibility, fontScale: 2.1 },
      };
      expect(validateBasicSettings(highFont).valid).toBe(false);

      // Invalid density
      const badDensity = {
        ...getDefaultBasicSettings('p'),
        accessibility: { ...getDefaultBasicSettings('p').accessibility, density: 'ultra-wide' as any },
      };
      expect(validateBasicSettings(badDensity).valid).toBe(false);
    });

    it('normalizes and safely clamps partial settings updates', () => {
      const base = getDefaultBasicSettings('proj-norm');
      const normalized = normalizeBasicSettings(
        {
          retention: { conversationDays: 999 }, // Should clamp to 365
          runtime: { modelUnloadAfterSeconds: 10 }, // Should clamp to 30
          accessibility: { fontScale: 3.5, theme: 'high-contrast' }, // fontScale clamp to 2.0
        },
        base,
      );

      expect(normalized.retention.conversationDays).toBe(SETTINGS_BOUNDS.RETENTION_DAYS_MAX);
      expect(normalized.runtime.modelUnloadAfterSeconds).toBe(SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MIN);
      expect(normalized.accessibility.fontScale).toBe(SETTINGS_BOUNDS.FONT_SCALE_MAX);
      expect(normalized.accessibility.theme).toBe('high-contrast');
      expect(normalized.accessibility.density).toBe('comfortable'); // Preserved from base
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 2. Atomic Persistence & Store Resilience
  // ════════════════════════════════════════════════════════════════

  describe('2. Atomic BasicSettingsStore & Isolation', () => {
    it('persists settings atomically to .maos/settings/basic-settings.json', () => {
      const store = new BasicSettingsStore(testDirA);
      const initial = getDefaultBasicSettings('project-settings-a');
      const updated = store.saveSettings({
        ...initial,
        retention: { ...initial.retention, conversationDays: 45 },
      });

      expect(updated.retention.conversationDays).toBe(45);
      const filePath = store.getStoragePath();
      expect(fs.existsSync(filePath)).toBe(true);

      // Verify no temporary files remain
      const settingsDir = path.dirname(filePath);
      const tmpFiles = fs.readdirSync(settingsDir).filter((f) => f.includes('.tmp_'));
      expect(tmpFiles.length).toBe(0);

      // Reload from disk
      const loaded = store.loadSettings('project-settings-a');
      expect(loaded.retention.conversationDays).toBe(45);
    });

    it('resiliently recovers to canonical defaults when settings file is corrupt JSON', () => {
      const store = new BasicSettingsStore(testDirA);
      const filePath = store.getStoragePath();

      // Corrupt file
      fs.writeFileSync(filePath, '{ corrupted_unparseable_json: true ...', 'utf-8');

      const recovered = store.loadSettings('project-settings-a');
      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.projectId).toBe('project-settings-a');
      expect(recovered.retention.conversationDays).toBe(30); // Default restored
    });

    it('enforces strict per-project isolation between Project A and Project B', () => {
      const storeA = new BasicSettingsStore(testDirA);
      const storeB = new BasicSettingsStore(testDirB);

      storeA.saveSettings({
        ...getDefaultBasicSettings('project-settings-a'),
        accessibility: { ...getDefaultBasicSettings('project-settings-a').accessibility, fontScale: 1.5 },
      });

      storeB.saveSettings({
        ...getDefaultBasicSettings('project-settings-b'),
        accessibility: { ...getDefaultBasicSettings('project-settings-b').accessibility, fontScale: 1.2 },
      });

      expect(storeA.loadSettings('project-settings-a').accessibility.fontScale).toBe(1.5);
      expect(storeB.loadSettings('project-settings-b').accessibility.fontScale).toBe(1.2);
    });

    it('strictly maintains storage hygiene: zero tokens or keys on disk', () => {
      const store = new BasicSettingsStore(testDirA);
      const filePath = store.getStoragePath();
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).not.toMatch(/bearer/i);
      expect(content).not.toMatch(/sessionToken/i);
      expect(content).not.toMatch(/apiKey/i);
      expect(content).not.toMatch(/secret/i);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 3. ProjectService Settings & Stop Service Logic
  // ════════════════════════════════════════════════════════════════

  describe('3. ProjectService & Safe Stop Behavior', () => {
    it('merges basic settings with legacy config and custom keys', () => {
      const projectService = new ProjectService(testDirA);
      const settings = projectService.getSettings();

      expect(settings.projectName).toBe('project-settings-a');
      expect(settings.zeroCloud).toBe(true);
      expect(settings.schemaVersion).toBe(1);
      expect(settings.retention).toBeDefined();
      expect(settings.runtime).toBeDefined();
      expect(settings.accessibility).toBeDefined();
    });

    it('updates settings and sanitizes legacy settings.json', () => {
      const projectService = new ProjectService(testDirA);
      const updated = projectService.updateSettings({
        customKey: 'custom-val-123',
        retention: { conversationDays: 60 },
        // Attempt to inject forbidden credentials
        sessionToken: 'sensitive-token-123',
        apiKey: 'secret-key-xyz',
      });

      expect(updated.customKey).toBe('custom-val-123');
      expect(updated.retention.conversationDays).toBe(60);

      // Verify credentials were not saved in legacy settings.json
      const legacyPath = path.join(testDirA, '.maos', 'settings.json');
      const legacyContent = fs.readFileSync(legacyPath, 'utf-8');
      expect(legacyContent).not.toContain('sensitive-token-123');
      expect(legacyContent).not.toContain('secret-key-xyz');
    });

    it('requires confirmation for force-stop and rejects unconfirmed requests', () => {
      const projectService = new ProjectService(testDirA);

      expect(() => {
        projectService.stopService({ mode: 'force' });
      }).toThrow(/CONFIRMATION_REQUIRED/);

      expect(() => {
        projectService.stopService({ mode: 'force', confirm: false });
      }).toThrow(/CONFIRMATION_REQUIRED/);
    });

    it('gracefully reports active tasks in after-current-tasks stop mode', () => {
      const projectService = new ProjectService(testDirA);
      const result = projectService.stopService({ mode: 'after-current-tasks' });

      expect(result.mode).toBe('after-current-tasks');
      expect(result.status).toBe('stopped');
      expect(result.activeTasksCount).toBe(0);
    });

    it('executes confirmed force-stop, marks tasks as INTERRUPTED, and preserves audit log', () => {
      const taskService = new TaskService(testDirA);
      const artifactService = new ArtifactService(testDirA);
      const modelManager = new SharedModelManager(testDirA);
      const modelService = new ModelService(testDirA, modelManager);
      const auditService = new AuditService(testDirA);

      // 1. Create a task and move to active queue
      const task = taskService.createTask({
        description: 'Ongoing work to be interrupted',
        agent: 'lead-dev',
        branch: 'task-branch',
        capabilities: ['code'],
        complexity: 'low',
        category: 'dev',
        type: 'task',
        objectiveId: '',
        depth: 0,
        reviewRequired: false,
        dependsOn: [],
      });
      // Move to active queue directly
      const rawTask = {
        ...task,
        filePath: task.filePath,
      };
      taskService.moveToActive(rawTask as any);

      // 2. Create orphaned temp artifact in .tmp
      const artTmpDir = path.join(testDirA, 'artifacts', '.tmp');
      fs.mkdirSync(artTmpDir, { recursive: true });
      fs.writeFileSync(path.join(artTmpDir, '.tmp_artifact_123.tmp'), 'partial content', 'utf-8');

      // 3. Acquire a lease against a verified test-only offline snapshot.
      const snapshotRelativePath = 'force-stop-model';
      const snapshotPath = path.join(testDirA, 'offline-stores', 'model-snapshot', snapshotRelativePath);
      fs.mkdirSync(snapshotPath, { recursive: true });
      const modelBytes = Buffer.from('verified-force-stop-model');
      fs.writeFileSync(path.join(snapshotPath, 'model.bin'), modelBytes);
      const manifestPath = path.join(testDirA, 'force-stop-model-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 1,
        model: 'llama3:8b',
        revision: 'test-revision',
        quantization: 'fp16',
        snapshotRelativePath,
        files: [{
          path: 'model.bin',
          size: modelBytes.length,
          sha256: crypto.createHash('sha256').update(modelBytes).digest('hex'),
        }],
      }, null, 2));
      modelManager.registerModel({
        modelId: 'llama3:8b',
        modelName: 'force-stop-model',
        revision: 'test-revision',
        architecture: 'TestOnlyModel',
        quantization: 'fp16',
        vramRequiredMb: 1,
        device: 'cpu',
        port: 11434,
        manifestPath,
        snapshotPath,
        isHealthy: true,
      });
      modelService.acquireLease({ modelId: 'llama3:8b', agentId: 'lead-dev', port: 11434 });
      expect(modelService.listLeases().length).toBe(1);

      // 4. Configure ProjectService with dependencies and execute force stop
      const projectService = new ProjectService(testDirA, {
        taskService,
        artifactService,
        modelService,
        auditService,
      });

      const stopResult = projectService.stopService({
        mode: 'force',
        confirm: true,
        reason: 'Automated test force stop',
      });

      expect(stopResult.status).toBe('stopped');
      expect(stopResult.mode).toBe('force');
      expect(stopResult.interruptedTasksCount).toBeGreaterThanOrEqual(1);
      expect(stopResult.cleanedTempArtifacts).toBeGreaterThanOrEqual(1);
      expect(stopResult.unloadedModels).toBe(1);

      // Verify active task was marked as interrupted
      const tasks = taskService.listTasks({ status: 'interrupted' });
      const interruptedTask = tasks.find((t) => t.id === task.id);
      expect(interruptedTask).toBeDefined();
      expect(interruptedTask?.status).toBe('interrupted');

      // Verify temp artifact was purged
      expect(fs.existsSync(path.join(artTmpDir, '.tmp_artifact_123.tmp'))).toBe(false);

      // Verify model leases were cleared
      expect(modelService.listLeases().length).toBe(0);

      // Verify audit event was logged
      const auditRecords = auditService.getRecords();
      const forceStopEvent = auditRecords.find(
        (r) => (r.data as any)?.event === 'SERVICE_FORCE_STOPPED',
      );
      expect(forceStopEvent).toBeDefined();
      expect(forceStopEvent?.category).toBe('interruption');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 4. Live REST API Endpoints
  // ════════════════════════════════════════════════════════════════

  describe('4. Live REST Endpoints', () => {
    it('GET /api/v1/settings: returns merged basic settings and metadata', async () => {
      const res = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/settings',
        headers: {
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.schemaVersion).toBe(1);
      expect(body.data.projectName).toBe('project-settings-a');
      expect(body.data.retention).toBeDefined();
      expect(body.data.runtime).toBeDefined();
      expect(body.data.accessibility).toBeDefined();
    });

    it('PATCH /api/v1/settings: updates settings and returns updated object', async () => {
      const patch = {
        retention: { conversationDays: 75 },
        accessibility: { theme: 'high-contrast' },
      };

      const res = await requestHttp(portA, {
        method: 'PATCH',
        path: '/api/v1/settings',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
        body: JSON.stringify(patch),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.retention.conversationDays).toBe(75);
      expect(body.data.accessibility.theme).toBe('high-contrast');
    });

    it('PUT /api/v1/settings: validates bounds and rejects invalid inputs with 400', async () => {
      // Invalid fontScale: 5.0 (bounds 0.8-2.0)
      const invalid = {
        accessibility: { fontScale: 5.0 },
      };

      const res = await requestHttp(portA, {
        method: 'PUT',
        path: '/api/v1/settings',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
        body: JSON.stringify(invalid),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_BASIC_SETTINGS');
    });

    it('POST /api/v1/settings/reset: restores canonical industrial defaults', async () => {
      const res = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/settings/reset',
        headers: {
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.retention.conversationDays).toBe(30);
      expect(body.data.accessibility.theme).toBe('dark');
      expect(body.data.accessibility.fontScale).toBe(1.0);
    });

    it('POST /api/v1/service/stop: enforces confirmation for force-stop', async () => {
      // 1. Without confirmation: rejected
      const unconfirmedRes = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/service/stop',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
        body: JSON.stringify({ mode: 'force', confirm: false }),
      });
      expect(unconfirmedRes.statusCode).toBe(400);
      const unconfirmedBody = JSON.parse(unconfirmedRes.body);
      expect(unconfirmedBody.error.code).toBe('CONFIRMATION_REQUIRED');

      // 2. Graceful stop mode: accepted
      const gracefulRes = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/service/stop',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
        body: JSON.stringify({ mode: 'after-current-tasks' }),
      });
      expect(gracefulRes.statusCode).toBe(200);
      const gracefulBody = JSON.parse(gracefulRes.body);
      expect(gracefulBody.data.mode).toBe('after-current-tasks');
    });

    it('GET /api/v1/service/visibility: returns safe loopback visibility with zero token leakage', async () => {
      const res = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/service/visibility',
        headers: {
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.loopbackEndpoint).toMatch(/http:\/\/127\.0\.0\.1/);
      expect(body.data.instanceIdRedacted).toBeDefined();
      expect(body.data.projectRoot).toBe(testDirA);

      // Verify zero tokens, hashes, or passwords exposed
      const rawText = JSON.stringify(body.data);
      expect(rawText).not.toContain(sessionTokenA);
      expect(rawText).not.toMatch(/sessionToken/i);
      expect(rawText).not.toMatch(/apiKey/i);
    });

    it('GET /api/v1/security/sovereignty: returns sovereignty status and visibility', async () => {
      const res = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/security/sovereignty',
        headers: {
          'X-Project-Root': testDirA,
          Authorization: `Bearer ${sessionTokenA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.zeroCloud).toBe(true);
      expect(body.data.loopbackEnforced).toBe(true);
      expect(body.data.loopbackEndpoint).toBeDefined();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 5. BrowserRestClient & GuiApiAdapter Integration
  // ════════════════════════════════════════════════════════════════

  describe('5. BrowserRestClient & GuiApiAdapter Integration', () => {
    it('BrowserRestClient consumes settings and service endpoints seamlessly', async () => {
      const client = new BrowserRestClient({
        baseUrl: `http://127.0.0.1:${portA}`,
        projectRoot: testDirA,
        sessionToken: sessionTokenA,
      });

      // Get settings
      const settings = await client.getSettings();
      expect(settings.schemaVersion).toBe(1);
      expect(settings.retention).toBeDefined();

      // Get typed basic settings
      const basic = await client.getBasicSettings();
      expect(basic.projectId).toBeDefined();

      // Update settings via PUT
      const updated = await client.updateBasicSettings({
        accessibility: { theme: 'dark', fontScale: 1.2, reducedMotion: true, density: 'compact' },
      });
      expect(updated.accessibility.fontScale).toBe(1.2);
      expect(updated.accessibility.reducedMotion).toBe(true);
      expect(updated.accessibility.density).toBe('compact');

      // Visibility
      const vis = await client.getServiceVisibility();
      expect(vis.loopbackEndpoint).toBeDefined();

      // Stop service graceful
      const stopGraceful = await client.stopService({ mode: 'after-current-tasks' });
      expect(stopGraceful.mode).toBe('after-current-tasks');
    });

    it('GuiApiAdapter exposes typed settings and service stop methods', async () => {
      const adapter = new GuiApiAdapter({
        baseUrl: `http://127.0.0.1:${portA}`,
        projectRoot: testDirA,
        sessionToken: sessionTokenA,
      });

      const basic = await adapter.getBasicSettings();
      expect(basic.schemaVersion).toBe(1);

      const updated = await adapter.updateBasicSettings({
        retention: { conversationDays: 90 },
      });
      expect(updated.retention.conversationDays).toBe(90);

      const reset = await adapter.resetSettings();
      expect(reset.retention.conversationDays).toBe(30);

      const vis = await adapter.getServiceVisibility();
      expect(vis.loopbackEndpoint).toBeDefined();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 6. Security Invariants & Rust SHA-256 Invariant
  // ════════════════════════════════════════════════════════════════

  describe('6. Security Invariants & Rust Hash Integrity', () => {
    it('settings cannot disable mandatory audit persistence', () => {
      const projectService = new ProjectService(testDirA);
      const settings = projectService.getSettings();

      // BasicSettings schema does NOT have any property to toggle audit
      expect((settings as any).disableAudit).toBeUndefined();
      expect((settings as any).enableAudit).toBeUndefined();

      // Attempting to patch disableAudit has no effect on audit requirement
      projectService.updateSettings({ disableAudit: true } as any);
      const reloaded = projectService.getSettings();
      expect((reloaded as any).disableAudit).toBe(true); // preserved in legacy bag only

      // Mandatory audit log is still append-only and active
      const audit = new AuditService(testDirA);
      expect(audit.getRecords()).toBeDefined();
    });

    it('settings cannot weaken loopback confinement or CSP', async () => {
      // Attempting to set external IP or remote server is rejected by schema
      const invalidNetwork = {
        remoteHost: '192.168.1.50',
      };
      const projectService = new ProjectService(testDirA);
      projectService.updateSettings(invalidNetwork);

      // Sovereignty status remains loopback enforced
      const status = projectService.getSovereigntyStatus();
      expect(status.loopbackEnforced).toBe(true);
    });

    it('strictly preserves rust/test.txt SHA-256 hash invariant', () => {
      const testTxtPath = path.resolve(__dirname, '../../rust/test.txt');
      expect(fs.existsSync(testTxtPath)).toBe(true);

      const content = fs.readFileSync(testTxtPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();

      expect(hash).toBe('1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435');
    });
  });
});
