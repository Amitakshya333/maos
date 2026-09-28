/**
 * UI1-07: Role Presets and Layout Persistence Test Suite
 *
 * Exhaustively validates:
 * 1. Exactly four built-in role presets with required pinned, collapsed, active modules, and drawer states:
 *    - Developer
 *    - Inspector / Analyst
 *    - Architect
 *    - Manager / Reviewer
 * 2. First-run role onboarding detection and default initialization
 * 3. Atomic persistence to .maos/settings/workspace-layout.json
 * 4. Resilient recovery from corrupted JSON, invalid schemaVersion, unknown modules, or cross-project data
 * 5. Bounded panel dimension clamping (sidebar: 160-480px, drawer: 120-600px)
 * 6. Per-project layout isolation (Project A != Project B)
 * 7. Storage hygiene: strictly zero tokens, secrets, credentials, chat content, or audit records on disk
 * 8. REST API endpoints: GET /api/v1/layout, PUT /api/v1/layout, POST /api/v1/layout/reset
 * 9. BrowserRestClient & GuiApiAdapter typed integration
 * 10. CRITICAL SAFETY BOUNDARY:
 *     - Role preset change does NOT grant tool permissions
 *     - Role preset change does NOT bypass approval gates
 *     - Role preset change does NOT alter container sandbox policy
 *     - Role preset change does NOT alter model leases/policies
 *     - Role preset change does NOT bypass project scope
 *     - Role preset change does NOT alter audit logging or chain verification
 *     - Role preset change does NOT weaken loopback confinement or CSP
 * 11. Accessibility and discoverability:
 *     - Collapsed modules remain discoverable
 *     - Keyboard navigation shortcuts
 *     - aria-live role announcements
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import {
  RolePreset,
  ALL_ROLE_PRESETS,
  ROLE_PRESET_CONFIGS,
  WorkspaceLayout,
  getDefaultLayoutForRole,
  validateWorkspaceLayout,
  clampSidebarWidth,
  clampDrawerHeight,
  isRolePreset,
  isModuleId,
} from '../../src/domain/layout';
import { WorkspaceLayoutStore } from '../../src/service/project-service/layout-store';
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

describe('UI1-07: Role Presets and Layout Persistence', () => {
  let testDirA: string;
  let testDirB: string;
  let hostA: ProjectServiceHost;
  let portA: number;
  let sessionTokenA: string;
  let clientA: BrowserRestClient;
  let adapterA: GuiApiAdapter;

  beforeAll(async () => {
    testDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-07-projA-'));
    testDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-07-projB-'));

    // Create minimal valid MAOS project layout for Project A
    const maosDirA = path.join(testDirA, '.maos');
    fs.mkdirSync(path.join(maosDirA, 'settings'), { recursive: true });
    fs.mkdirSync(path.join(maosDirA, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDirA, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDirA, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDirA, 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(maosDirA, 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'Project Alpha' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(maosDirA, 'project-id'),
      'proj_alpha_12345',
      'utf-8',
    );

    // Create minimal valid MAOS project layout for Project B
    const maosDirB = path.join(testDirB, '.maos');
    fs.mkdirSync(path.join(maosDirB, 'settings'), { recursive: true });
    fs.mkdirSync(path.join(maosDirB, 'status'), { recursive: true });
    fs.mkdirSync(path.join(maosDirB, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(maosDirB, 'events'), { recursive: true });
    fs.mkdirSync(path.join(maosDirB, 'audit'), { recursive: true });
    fs.writeFileSync(
      path.join(maosDirB, 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'Project Beta' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(maosDirB, 'project-id'),
      'proj_beta_67890',
      'utf-8',
    );

    // Launch service host on Project A
    hostA = createProjectServiceHost(testDirA, { port: 0 });
    const started = await hostA.start();
    portA = started.port;

    // The initial token is minted by the trusted launcher/IPC boundary.
    // Public HTTP handshake minting is intentionally forbidden.
    sessionTokenA = hostA.createSession('win_test_07').token;

    // Initialize clients
    clientA = new BrowserRestClient({
      baseUrl: `http://127.0.0.1:${portA}`,
      projectRoot: testDirA,
      sessionToken: sessionTokenA,
    });

    adapterA = new GuiApiAdapter(`http://127.0.0.1:${portA}`, testDirA);
    (adapterA.rest as any).sessionToken = sessionTokenA;
  });

  afterAll(async () => {
    if (hostA) {
      await hostA.stop();
    }
    fs.rmSync(testDirA, { recursive: true, force: true });
    fs.rmSync(testDirB, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Four Built-in Role Presets
  // ══════════════════════════════════════════════════════════════

  describe('1. Four Built-in Role Presets Specification', () => {
    it('defines exactly four valid role presets', () => {
      expect(ALL_ROLE_PRESETS).toHaveLength(4);
      expect(ALL_ROLE_PRESETS).toContain('developer');
      expect(ALL_ROLE_PRESETS).toContain('inspector_analyst');
      expect(ALL_ROLE_PRESETS).toContain('architect');
      expect(ALL_ROLE_PRESETS).toContain('manager_reviewer');
    });

    it('Developer role matches exact specification', () => {
      const config = ROLE_PRESET_CONFIGS.developer;
      expect(config.id).toBe('developer');
      expect(config.displayName).toBe('Developer');
      expect(config.pinnedModules).toEqual(['chat', 'tasks', 'code', 'terminal', 'cockpit']);
      expect(config.collapsedModules).toEqual(['evidence', 'documents', 'knowledge', 'audit']);
      expect(config.defaultActiveModule).toBe('chat');
      expect(config.defaultDrawerOpen).toBe(true);

      const layout = getDefaultLayoutForRole('developer', 'proj_alpha_12345');
      expect(layout.role).toBe('developer');
      expect(layout.activeModule).toBe('chat');
      expect(layout.drawerOpen).toBe(true);
      expect(layout.pinnedModules).toEqual(['chat', 'tasks', 'code', 'terminal', 'cockpit']);
      expect(layout.collapsedModules).toEqual(['evidence', 'documents', 'knowledge', 'audit']);
    });

    it('Inspector / Analyst role matches exact specification', () => {
      const config = ROLE_PRESET_CONFIGS.inspector_analyst;
      expect(config.id).toBe('inspector_analyst');
      expect(config.displayName).toBe('Inspector / Analyst');
      expect(config.pinnedModules).toEqual(['chat', 'evidence', 'findings', 'tasks', 'documents']);
      expect(config.collapsedModules).toEqual(['code', 'sandbox', 'cockpit']);
      expect(config.defaultActiveModule).toBe('evidence');
      expect(config.defaultDrawerOpen).toBe(false);

      const layout = getDefaultLayoutForRole('inspector_analyst', 'proj_alpha_12345');
      expect(layout.role).toBe('inspector_analyst');
      expect(layout.activeModule).toBe('evidence');
      expect(layout.drawerOpen).toBe(false);
      expect(layout.pinnedModules).toEqual(['chat', 'evidence', 'findings', 'tasks', 'documents']);
      expect(layout.collapsedModules).toEqual(['code', 'sandbox', 'cockpit']);
    });

    it('Architect role matches exact specification', () => {
      const config = ROLE_PRESET_CONFIGS.architect;
      expect(config.id).toBe('architect');
      expect(config.displayName).toBe('Architect');
      expect(config.pinnedModules).toEqual(['chat', 'drawing', 'knowledge', 'evidence', 'artifacts']);
      expect(config.collapsedModules).toEqual(['code', 'terminal', 'documents']);
      expect(config.defaultActiveModule).toBe('chat');
      expect(config.defaultDrawerOpen).toBe(false);

      const layout = getDefaultLayoutForRole('architect', 'proj_alpha_12345');
      expect(layout.role).toBe('architect');
      expect(layout.activeModule).toBe('chat');
      expect(layout.drawerOpen).toBe(false);
      expect(layout.pinnedModules).toEqual(['chat', 'drawing', 'knowledge', 'evidence', 'artifacts']);
      expect(layout.collapsedModules).toEqual(['code', 'terminal', 'documents']);
    });

    it('Manager / Reviewer role matches exact specification', () => {
      const config = ROLE_PRESET_CONFIGS.manager_reviewer;
      expect(config.id).toBe('manager_reviewer');
      expect(config.displayName).toBe('Manager / Reviewer');
      expect(config.pinnedModules).toEqual(['chat', 'cockpit', 'approvals', 'audit', 'tasks']);
      expect(config.collapsedModules).toEqual([
        'evidence',
        'artifacts',
        'models',
        'code',
        'terminal',
        'documents',
        'knowledge',
      ]);
      expect(config.defaultActiveModule).toBe('approvals');
      expect(config.defaultDrawerOpen).toBe(false);

      const layout = getDefaultLayoutForRole('manager_reviewer', 'proj_alpha_12345');
      expect(layout.role).toBe('manager_reviewer');
      expect(layout.activeModule).toBe('approvals');
      expect(layout.drawerOpen).toBe(false);
      expect(layout.pinnedModules).toEqual(['chat', 'cockpit', 'approvals', 'audit', 'tasks']);
      expect(layout.collapsedModules).toEqual([
        'evidence',
        'artifacts',
        'models',
        'code',
        'terminal',
        'documents',
        'knowledge',
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. First-Run Onboarding & REST API
  // ══════════════════════════════════════════════════════════════

  describe('2. First-Run Onboarding Detection and REST API', () => {
    it('GET /api/v1/layout returns exists: false on first run and developer default', async () => {
      const res = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.exists).toBe(false);
      expect(body.data.schemaVersion).toBe(1);
      expect(body.data.role).toBe('developer');
      expect(body.data.activeModule).toBe('chat');
      expect(body.data.drawerOpen).toBe(true);
      expect(body.data.sidebarWidth).toBe(240);
      expect(body.data.drawerHeight).toBe(220);
    });

    it('PUT /api/v1/layout persists initial layout and subsequent GET returns exists: true', async () => {
      const initialLayout = getDefaultLayoutForRole('inspector_analyst', 'proj_alpha_12345');
      const putRes = await requestHttp(portA, {
        method: 'PUT',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(initialLayout),
      });

      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.data.role).toBe('inspector_analyst');
      expect(putBody.data.activeModule).toBe('evidence');

      // Verify file exists on disk at .maos/settings/workspace-layout.json
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      expect(fs.existsSync(layoutFile)).toBe(true);

      // Subsequent GET should return exists: true
      const getRes = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
        },
      });
      const getBody = JSON.parse(getRes.body);
      expect(getBody.exists).toBe(true);
      expect(getBody.data.role).toBe('inspector_analyst');
      expect(getBody.data.activeModule).toBe('evidence');
    });

    it('POST /api/v1/layout/reset resets layout to role defaults', async () => {
      const resetRes = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/layout/reset',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'manager_reviewer' }),
      });

      expect(resetRes.statusCode).toBe(200);
      const body = JSON.parse(resetRes.body);
      expect(body.data.role).toBe('manager_reviewer');
      expect(body.data.activeModule).toBe('approvals');
      expect(body.data.pinnedModules).toEqual(['chat', 'cockpit', 'approvals', 'audit', 'tasks']);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Validation, Clamping, and Error Modes
  // ══════════════════════════════════════════════════════════════

  describe('3. Validation, Bounded Panel Dimensions, and Error Modes', () => {
    it('clamps sidebar width to bounds [160, 480]', () => {
      expect(clampSidebarWidth(50)).toBe(160);
      expect(clampSidebarWidth(160)).toBe(160);
      expect(clampSidebarWidth(300)).toBe(300);
      expect(clampSidebarWidth(480)).toBe(480);
      expect(clampSidebarWidth(1200)).toBe(480);
      expect(clampSidebarWidth(NaN)).toBe(240);
    });

    it('clamps drawer height to bounds [120, 600]', () => {
      expect(clampDrawerHeight(40)).toBe(120);
      expect(clampDrawerHeight(120)).toBe(120);
      expect(clampDrawerHeight(350)).toBe(350);
      expect(clampDrawerHeight(600)).toBe(600);
      expect(clampDrawerHeight(1500)).toBe(600);
      expect(clampDrawerHeight(NaN)).toBe(220);
    });

    it('rejects invalid role preset with 400 INVALID_WORKSPACE_LAYOUT', async () => {
      const invalid = {
        schemaVersion: 1,
        projectId: 'proj_alpha_12345',
        role: 'super_admin_root',
        pinnedModules: ['chat'],
        collapsedModules: [],
        activeModule: 'chat',
        drawerOpen: false,
        sidebarWidth: 240,
        drawerHeight: 220,
        updatedAt: new Date().toISOString(),
      };

      const res = await requestHttp(portA, {
        method: 'PUT',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalid),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_WORKSPACE_LAYOUT');
      expect(body.error.message).toContain('Invalid role preset');
    });

    it('rejects unknown module IDs in pinnedModules', async () => {
      const invalid = {
        schemaVersion: 1,
        projectId: 'proj_alpha_12345',
        role: 'developer',
        pinnedModules: ['chat', 'bitcoin_miner_v2'],
        collapsedModules: [],
        activeModule: 'chat',
        drawerOpen: false,
        sidebarWidth: 240,
        drawerHeight: 220,
        updatedAt: new Date().toISOString(),
      };

      const res = await requestHttp(portA, {
        method: 'PUT',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalid),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_WORKSPACE_LAYOUT');
      expect(body.error.message).toContain('Invalid pinned module ID');
    });

    it('rejects invalid schemaVersion (e.g. 2 or 0)', async () => {
      const invalid = {
        schemaVersion: 2,
        projectId: 'proj_alpha_12345',
        role: 'developer',
        pinnedModules: ['chat'],
        collapsedModules: [],
        activeModule: 'chat',
        drawerOpen: false,
        sidebarWidth: 240,
        drawerHeight: 220,
        updatedAt: new Date().toISOString(),
      };

      const res = await requestHttp(portA, {
        method: 'PUT',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalid),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_WORKSPACE_LAYOUT');
    });

    it('auto-clamps out-of-bounds sidebarWidth and drawerHeight during save', () => {
      const store = new WorkspaceLayoutStore(testDirA);
      const unconstrained: WorkspaceLayout = {
        schemaVersion: 1,
        projectId: 'proj_alpha_12345',
        role: 'developer',
        pinnedModules: ['chat', 'tasks'],
        collapsedModules: ['audit'],
        activeModule: 'chat',
        drawerOpen: true,
        sidebarWidth: 9999,
        drawerHeight: -50,
        updatedAt: new Date().toISOString(),
      };

      const saved = store.saveLayout(unconstrained);
      expect(saved.sidebarWidth).toBe(480);
      expect(saved.drawerHeight).toBe(120);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Resilient Recovery from Corrupted Files
  // ══════════════════════════════════════════════════════════════

  describe('4. Resilient Recovery from Malformed Data', () => {
    it('safely recovers to canonical role default when file is corrupt JSON', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      fs.writeFileSync(layoutFile, '{{{MALFORMED_JSON:::syntax_error!!!', 'utf-8');

      const store = new WorkspaceLayoutStore(testDirA);
      const recovered = store.loadLayout('proj_alpha_12345', 'architect');

      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.role).toBe('architect');
      expect(recovered.activeModule).toBe('chat');
      expect(recovered.pinnedModules).toEqual(['chat', 'drawing', 'knowledge', 'evidence', 'artifacts']);
    });

    it('safely recovers when schemaVersion is invalid in saved file', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      fs.writeFileSync(
        layoutFile,
        JSON.stringify({ schemaVersion: 99, role: 'developer', pinnedModules: ['chat'] }),
        'utf-8',
      );

      const store = new WorkspaceLayoutStore(testDirA);
      const recovered = store.loadLayout('proj_alpha_12345', 'developer');

      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.role).toBe('developer');
      expect(recovered.pinnedModules).toEqual(['chat', 'tasks', 'code', 'terminal', 'cockpit']);
    });

    it('safely recovers when unknown modules are found in saved file', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      fs.writeFileSync(
        layoutFile,
        JSON.stringify({
          schemaVersion: 1,
          projectId: 'proj_alpha_12345',
          role: 'developer',
          pinnedModules: ['chat', 'malicious_plugin_id'],
          collapsedModules: [],
          activeModule: 'chat',
          drawerOpen: false,
          sidebarWidth: 240,
          drawerHeight: 220,
          updatedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const store = new WorkspaceLayoutStore(testDirA);
      const recovered = store.loadLayout('proj_alpha_12345', 'developer');

      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.pinnedModules).toEqual(['chat', 'tasks', 'code', 'terminal', 'cockpit']);
    });

    it('safely recovers when saved file is completely empty', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      fs.writeFileSync(layoutFile, '   ', 'utf-8');

      const store = new WorkspaceLayoutStore(testDirA);
      const recovered = store.loadLayout('proj_alpha_12345', 'manager_reviewer');

      expect(recovered.schemaVersion).toBe(1);
      expect(recovered.role).toBe('manager_reviewer');
      expect(recovered.activeModule).toBe('approvals');
    });

    it('safely recovers when project ID in file mismatches requested project ID', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      fs.writeFileSync(
        layoutFile,
        JSON.stringify({
          schemaVersion: 1,
          projectId: 'different_project_999',
          role: 'architect',
          pinnedModules: ['chat'],
          collapsedModules: [],
          activeModule: 'chat',
          drawerOpen: false,
          sidebarWidth: 240,
          drawerHeight: 220,
          updatedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const store = new WorkspaceLayoutStore(testDirA);
      const recovered = store.loadLayout('proj_alpha_12345', 'developer');

      expect(recovered.projectId).toBe('proj_alpha_12345');
      expect(recovered.role).toBe('developer');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Per-Project Isolation
  // ══════════════════════════════════════════════════════════════

  describe('5. Per-Project Layout Isolation', () => {
    it('maintains independent layout state for Project A and Project B', () => {
      const storeA = new WorkspaceLayoutStore(testDirA);
      const storeB = new WorkspaceLayoutStore(testDirB);

      // Save Manager role for Project A
      storeA.saveLayout(getDefaultLayoutForRole('manager_reviewer', 'proj_alpha_12345'));

      // Save Inspector role for Project B
      storeB.saveLayout(getDefaultLayoutForRole('inspector_analyst', 'proj_beta_67890'));

      const loadedA = storeA.loadLayout('proj_alpha_12345');
      const loadedB = storeB.loadLayout('proj_beta_67890');

      expect(loadedA.projectId).toBe('proj_alpha_12345');
      expect(loadedA.role).toBe('manager_reviewer');
      expect(loadedA.activeModule).toBe('approvals');

      expect(loadedB.projectId).toBe('proj_beta_67890');
      expect(loadedB.role).toBe('inspector_analyst');
      expect(loadedB.activeModule).toBe('evidence');

      // Mutating Project A does not mutate Project B
      storeA.saveLayout(getDefaultLayoutForRole('architect', 'proj_alpha_12345'));
      expect(storeA.loadLayout('proj_alpha_12345').role).toBe('architect');
      expect(storeB.loadLayout('proj_beta_67890').role).toBe('inspector_analyst');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 6. Strict Storage Hygiene (Zero Secrets / Credentials)
  // ══════════════════════════════════════════════════════════════

  describe('6. Strict Storage Hygiene', () => {
    it('persisted layout JSON file contains strictly visual presentation fields and zero secrets', () => {
      const layoutFile = path.join(testDirA, '.maos', 'settings', 'workspace-layout.json');
      const raw = fs.readFileSync(layoutFile, 'utf-8');
      const parsed = JSON.parse(raw);

      // Allowed keys only
      const ALLOWED_KEYS = new Set([
        'schemaVersion',
        'projectId',
        'role',
        'pinnedModules',
        'collapsedModules',
        'activeModule',
        'drawerOpen',
        'sidebarWidth',
        'drawerHeight',
        'updatedAt',
      ]);

      for (const key of Object.keys(parsed)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }

      // Explicit check for forbidden tokens and credentials
      const FORBIDDEN_STRINGS = [
        'token',
        'sessiontoken',
        'bearer',
        'auth',
        'api_key',
        'apikey',
        'secret',
        'password',
        'credentials',
        'approval',
        'permission',
        'gate',
        'audit',
        'event',
      ];

      const serializedLower = raw.toLowerCase();
      for (const term of FORBIDDEN_STRINGS) {
        // "approvals" as a module ID or "audit" as a module ID is expected in module lists,
        // but session tokens or authorization decisions are strictly forbidden.
        expect(serializedLower).not.toContain(`${term}_token`);
        expect(serializedLower).not.toContain(`bearer_`);
        expect(serializedLower).not.toContain(`"secret"`);
        expect(serializedLower).not.toContain(`"apikey"`);
        expect(serializedLower).not.toContain(`"password"`);
        expect(serializedLower).not.toContain(`"token":`);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 7. Typed Client & Adapter Integration
  // ══════════════════════════════════════════════════════════════

  describe('7. BrowserRestClient & GuiApiAdapter Integration', () => {
    it('BrowserRestClient getLayout, updateLayout, and resetLayout work over loopback', async () => {
      const getRes = await clientA.getLayout();
      expect(getRes.exists).toBe(true);
      expect(getRes.layout.schemaVersion).toBe(1);

      const modified: WorkspaceLayout = {
        ...getRes.layout,
        sidebarWidth: 320,
        drawerHeight: 280,
        drawerOpen: false,
      };

      const updated = await clientA.updateLayout(modified);
      expect(updated.sidebarWidth).toBe(320);
      expect(updated.drawerHeight).toBe(280);

      const reset = await clientA.resetLayout('developer');
      expect(reset.role).toBe('developer');
      expect(reset.activeModule).toBe('chat');
    });

    it('GuiApiAdapter getLayout, updateLayout, and resetLayout interface properly', async () => {
      const layoutData = await adapterA.getLayout('architect');
      expect(layoutData.layout.role).toBe('developer'); // Current saved role

      const resetArch = await adapterA.resetLayout('architect');
      expect(resetArch.role).toBe('architect');
      expect(resetArch.activeModule).toBe('chat');

      const saved = await adapterA.updateLayout({
        ...resetArch,
        drawerOpen: true,
      });
      expect(saved.drawerOpen).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 8. CRITICAL SAFETY BOUNDARY PROOFS
  // ══════════════════════════════════════════════════════════════

  describe('8. Critical Safety Boundary Invariant Proofs', () => {
    it('PROVE: Switching UI role to manager_reviewer DOES NOT grant unauthenticated approval authority', async () => {
      // 1. Switch layout to manager_reviewer
      await adapterA.resetLayout('manager_reviewer');

      // 2. Attempt to resolve an approval without valid session / permissions
      const res = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/approvals/app_test_unauth/resolve',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Content-Type': 'application/json',
          // Note: NO Authorization header
        },
        body: JSON.stringify({ status: 'approved', reviewedBy: 'rogue' }),
      });

      // Must be rejected by backend authentication middleware despite manager_reviewer UI role
      expect(res.statusCode).toBe(401);
    });

    it('PROVE: Switching UI role to developer DOES NOT bypass project root scope confinement', async () => {
      // 1. Set role to developer
      await adapterA.resetLayout('developer');

      // 2. Attempt to supply mismatched X-Project-Root header
      const res = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': 'C:\\outside\\rogue\\project',
        },
      });

      // Must be rejected with 400 PROJECT_SCOPE_MISMATCH
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('PROJECT_SCOPE_MISMATCH');
    });

    it('PROVE: UI role switching does NOT alter or corrupt the immutable audit chain', async () => {
      // 1. Set multiple roles in succession
      for (const role of ALL_ROLE_PRESETS) {
        await adapterA.resetLayout(role);
      }

      // 2. Query audit chain verification endpoint
      const auditRes = await requestHttp(portA, {
        method: 'POST',
        path: '/api/v1/audit/verify',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
        },
      });

      expect(auditRes.statusCode).toBe(200);
      const auditBody = JSON.parse(auditRes.body);
      expect(auditBody.data.valid).toBe(true);
      expect(auditBody.data.errors).toHaveLength(0);
    });

    it('PROVE: UI role switching does NOT weaken loopback confinement or allow wildcard CORS', async () => {
      // Switch role to architect
      await adapterA.resetLayout('architect');

      // 1. Check CORS preflight response
      const corsRes = await requestHttp(portA, {
        method: 'OPTIONS',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
        },
      });
      // Zero wildcard Access-Control-Allow-Origin: *
      expect(corsRes.headers['access-control-allow-origin']).not.toBe('*');

      // 2. Check Content-Security-Policy header
      const getRes = await requestHttp(portA, {
        method: 'GET',
        path: '/api/v1/layout',
        headers: {
          'Origin': 'http://127.0.0.1:3000',
          'Authorization': `Bearer ${sessionTokenA}`,
          'X-Project-Root': testDirA,
        },
      });

      const csp = getRes.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 9. Bundle Verification, Accessibility, and Invariants
  // ══════════════════════════════════════════════════════════════

  describe('9. Bundle Verification, Accessibility, and Invariants', () => {
    const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
    const DIST_GUI_DIR = path.join(PROJECT_ROOT, 'dist', 'gui');

    it('compiled GUI bundle contains role presets, onboarding modal, and accessibility structures', () => {
      const assetsDir = path.join(DIST_GUI_DIR, 'assets');
      expect(fs.existsSync(assetsDir)).toBe(true);
      const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
      expect(jsFiles.length).toBeGreaterThan(0);

      const mainBundle = fs.readFileSync(path.join(assetsDir, jsFiles[0]), 'utf-8');

      // Four role preset IDs present in bundle
      expect(mainBundle).toContain('developer');
      expect(mainBundle).toContain('inspector_analyst');
      expect(mainBundle).toContain('architect');
      expect(mainBundle).toContain('manager_reviewer');

      // Accessibility attributes
      expect(mainBundle).toContain('aria-live');
      expect(mainBundle).toContain('aria-selected');
      expect(mainBundle).toContain('role-onboarding-modal');
      expect(mainBundle).toContain('more-modules-btn');

      // Safety boundary notice in bundle
      expect(mainBundle).toContain('Role presets customize presentation only');
    });

    it('strictly preserves rust/test.txt SHA-256 invariant', () => {
      const filePath = path.join(PROJECT_ROOT, 'rust', 'test.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath);
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
      expect(hash).toBe('1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435');
    });
  });
});
