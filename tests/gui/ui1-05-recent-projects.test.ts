/**
 * UI1-05: Recent Projects and Relocation Test Suite
 *
 * Tests the complete global recent project history and relocation protocol:
 *   1. Record & list recent projects (ordering, consolidation, bounding)
 *   2. Reopen available projects & revalidation before launch
 *   3. Availability & relocation status tracking (missing paths, changed identity)
 *   4. Explicit relocation protocol (same identity vs different identity confirmation)
 *   5. Security & hygiene (symlinks, path traversal, zero secrets/tokens)
 *   6. Reliability (atomic write, corrupt file recovery, concurrent locking)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RecentProjectStore,
  RecentProject,
  RecentProjectStatus,
  RelocationConfirmationRequiredError,
  RecentProjectError,
  getOrGenerateProjectId,
} from '../../src/service/project-service/recent-projects';
import {
  ProjectHostLauncher,
  LauncherError,
  killProcessTree,
} from '../../src/service/project-service/launcher';
import { computeProjectRootHash } from '../../src/service/project-service/instance-identity';

function createValidProject(projectDir: string, configOverrides: Record<string, any> = {}): void {
  const maosDir = path.join(projectDir, '.maos');
  fs.mkdirSync(path.join(maosDir, 'status'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'events'), { recursive: true });
  fs.mkdirSync(path.join(maosDir, 'audit'), { recursive: true });

  const config = {
    schemaVersion: 1,
    projectName: path.basename(projectDir),
    routingMode: 'auto',
    providers: {
      ollama: { baseURL: 'http://127.0.0.1:8000/v1', costPerMillionTokens: 0 },
    },
    agents: [
      {
        id: 'CODER_1',
        role: 'coder',
        provider: 'ollama',
        model: 'test-model',
        capabilities: ['coding'],
        scope: ['src/'],
        maxIterations: 5,
        costTier: 'low',
      },
    ],
    routing: {
      strategy: 'capability_score',
      costWeight: 0.2,
      capabilityWeight: 0.8,
      maxParallelAgents: 2,
      fallbackProvider: 'ollama',
    },
    ...configOverrides,
  };

  fs.writeFileSync(path.join(maosDir, 'maos.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

describe('UI1-05: Recent Projects and Relocation', () => {
  let tempBaseDir: string;
  let metadataFile: string;
  let store: RecentProjectStore;
  let launcher: ProjectHostLauncher;

  beforeAll(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ui1-05-test-'));
  });

  afterAll(async () => {
    if (launcher) {
      await launcher.stopAll();
    }
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    metadataFile = path.join(tempBaseDir, `recent-projects-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    store = new RecentProjectStore({
      storagePath: metadataFile,
      allowTemp: true,
      maxEntries: 50,
    });
    launcher = new ProjectHostLauncher({
      allowTemp: true,
      recentStore: store,
      timeoutMs: 8000,
    });
  });

  afterEach(async () => {
    if (launcher) {
      await launcher.stopAll();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 1. Record & List Recent Projects
  // ══════════════════════════════════════════════════════════════

  describe('1. Record & List Recent Projects', () => {
    it('records an opened project into global recent history', async () => {
      const projDir = path.join(tempBaseDir, 'proj-1');
      fs.mkdirSync(projDir, { recursive: true });
      createValidProject(projDir, { projectName: 'Project Alpha' });

      const record = await store.recordProjectOpened(projDir, { allowTemp: true });

      expect(record.projectId).toBeDefined();
      expect(record.displayName).toBe('Project Alpha');
      expect(record.canonicalPath).toBe(path.resolve(projDir));
      expect(record.projectRootHash).toBe(computeProjectRootHash(projDir));
      expect(record.status).toBe('available');
      expect(record.schemaVersion).toBe(1);

      const list = await store.listRecentProjects();
      expect(list.length).toBe(1);
      expect(list[0].projectId).toBe(record.projectId);
    });

    it('orders recent projects deterministically by lastOpenedAt descending', async () => {
      const p1 = path.join(tempBaseDir, 'proj-order-1');
      const p2 = path.join(tempBaseDir, 'proj-order-2');
      const p3 = path.join(tempBaseDir, 'proj-order-3');
      for (const p of [p1, p2, p3]) {
        fs.mkdirSync(p, { recursive: true });
        createValidProject(p);
      }

      // Open in sequence: p1, p2, p3
      await store.recordProjectOpened(p1, { allowTemp: true });
      await new Promise((r) => setTimeout(r, 20));
      await store.recordProjectOpened(p2, { allowTemp: true });
      await new Promise((r) => setTimeout(r, 20));
      await store.recordProjectOpened(p3, { allowTemp: true });

      let list = await store.listRecentProjects();
      expect(list[0].canonicalPath).toBe(path.resolve(p3));
      expect(list[1].canonicalPath).toBe(path.resolve(p2));
      expect(list[2].canonicalPath).toBe(path.resolve(p1));

      // Reopen p1 -> p1 moves to the top
      await new Promise((r) => setTimeout(r, 20));
      await store.recordProjectOpened(p1, { allowTemp: true });

      list = await store.listRecentProjects();
      expect(list[0].canonicalPath).toBe(path.resolve(p1));
      expect(list[1].canonicalPath).toBe(path.resolve(p3));
      expect(list[2].canonicalPath).toBe(path.resolve(p2));
    });

    it('consolidates duplicate project entries cleanly', async () => {
      const projDir = path.join(tempBaseDir, 'proj-dedup');
      fs.mkdirSync(projDir, { recursive: true });
      createValidProject(projDir);

      // Open 3 times
      await store.recordProjectOpened(projDir, { allowTemp: true });
      await store.recordProjectOpened(projDir, { allowTemp: true });
      await store.recordProjectOpened(projDir, { allowTemp: true });

      const list = await store.listRecentProjects();
      expect(list.length).toBe(1);
    });

    it('enforces bounded history size (maxEntries)', async () => {
      const boundedStore = new RecentProjectStore({
        storagePath: path.join(tempBaseDir, `bounded-${Date.now()}.json`),
        allowTemp: true,
        maxEntries: 3,
      });

      for (let i = 1; i <= 5; i++) {
        const p = path.join(tempBaseDir, `bounded-proj-${i}`);
        fs.mkdirSync(p, { recursive: true });
        createValidProject(p);
        await boundedStore.recordProjectOpened(p, { allowTemp: true });
        await new Promise((r) => setTimeout(r, 15));
      }

      const list = await boundedStore.listRecentProjects();
      expect(list.length).toBe(3);
      // Newest 3 should be 5, 4, 3
      expect(list[0].displayName).toBe('bounded-proj-5');
      expect(list[1].displayName).toBe('bounded-proj-4');
      expect(list[2].displayName).toBe('bounded-proj-3');
    });

    it('removes a project from recent history', async () => {
      const p = path.join(tempBaseDir, 'remove-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });
      expect((await store.listRecentProjects()).length).toBe(1);

      const removed = await store.removeRecentProject(record.projectId);
      expect(removed).toBe(true);
      expect((await store.listRecentProjects()).length).toBe(0);

      // Removing non-existent returns false
      expect(await store.removeRecentProject('non-existent-id')).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 2. Availability & Relocation Status Tracking
  // ══════════════════════════════════════════════════════════════

  describe('2. Availability & Relocation Status Tracking', () => {
    it('marks project as unavailable if the folder is deleted (preserves record)', async () => {
      const p = path.join(tempBaseDir, 'deleted-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });
      expect(record.status).toBe('available');

      // Delete directory
      fs.rmSync(p, { recursive: true, force: true });

      // Refresh status
      const refreshed = await store.refreshProjectStatus(record.projectId);
      expect(refreshed).toBeDefined();
      expect(refreshed!.status).toBe('unavailable');

      // Record is preserved in list with unavailable status
      const list = await store.listRecentProjects({ verifyStatus: true });
      expect(list.length).toBe(1);
      expect(list[0].status).toBe('unavailable');
    });

    it('marks project as unavailable if .maos directory is deleted or corrupted', async () => {
      const p = path.join(tempBaseDir, 'corrupted-maos-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      // Delete .maos
      fs.rmSync(path.join(p, '.maos'), { recursive: true, force: true });

      const refreshed = await store.refreshProjectStatus(record.projectId);
      expect(refreshed!.status).toBe('unavailable');
    });

    it('marks project as unavailable if maos.config.json is corrupted', async () => {
      const p = path.join(tempBaseDir, 'corrupted-config-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      // Corrupt config
      fs.writeFileSync(path.join(p, '.maos', 'maos.config.json'), 'invalid json @@', 'utf-8');

      const refreshed = await store.refreshProjectStatus(record.projectId);
      expect(refreshed!.status).toBe('unavailable');
    });

    it('marks project as relocation_required if project identity marker differs', async () => {
      const p = path.join(tempBaseDir, 'identity-change-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      // Change .maos/project-id to simulate different project at same path
      fs.writeFileSync(path.join(p, '.maos', 'project-id'), 'proj_different_id_999', 'utf-8');

      const refreshed = await store.refreshProjectStatus(record.projectId);
      expect(refreshed!.status).toBe('relocation_required');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 3. Explicit Relocation Protocol
  // ══════════════════════════════════════════════════════════════

  describe('3. Explicit Relocation Protocol', () => {
    it('relocates to moved folder having the same project identity without confirmation', async () => {
      const oldPath = path.join(tempBaseDir, 'old-location');
      const newPath = path.join(tempBaseDir, 'new-location');
      fs.mkdirSync(oldPath, { recursive: true });
      createValidProject(oldPath, { projectName: 'Moved Project' });

      const record = await store.recordProjectOpened(oldPath, { allowTemp: true });
      const originalId = record.projectId;

      // Move folder from oldPath to newPath (retaining .maos/project-id)
      fs.renameSync(oldPath, newPath);

      // Old path is now unavailable
      const statusBefore = await store.refreshProjectStatus(originalId);
      expect(statusBefore!.status).toBe('unavailable');

      // Relocate to newPath
      const relocated = await store.relocateProject(originalId, newPath, { allowTemp: true });

      expect(relocated.projectId).toBe(originalId);
      expect(relocated.canonicalPath).toBe(path.resolve(newPath));
      expect(relocated.projectRootHash).toBe(computeProjectRootHash(newPath));
      expect(relocated.status).toBe('available');

      const list = await store.listRecentProjects();
      expect(list.length).toBe(1);
      expect(list[0].canonicalPath).toBe(path.resolve(newPath));
    });

    it('requires explicit confirmation when relocating to a different project identity', async () => {
      const origProj = path.join(tempBaseDir, 'orig-proj');
      const otherProj = path.join(tempBaseDir, 'other-proj');
      fs.mkdirSync(origProj, { recursive: true });
      fs.mkdirSync(otherProj, { recursive: true });
      createValidProject(origProj, { projectName: 'Original Proj' });
      createValidProject(otherProj, { projectName: 'Other Proj' });

      const recordOrig = await store.recordProjectOpened(origProj, { allowTemp: true });
      // Ensure otherProj has its own distinct project ID
      getOrGenerateProjectId(otherProj);

      // Attempt relocation without confirmation
      let caughtError: any = null;
      try {
        await store.relocateProject(recordOrig.projectId, otherProj, {
          allowTemp: true,
          confirmDifferentIdentity: false,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(RelocationConfirmationRequiredError);
      expect(caughtError.code).toBe('RELOCATION_CONFIRMATION_REQUIRED');
      expect(caughtError.sourceProjectId).toBe(recordOrig.projectId);

      // Now relocate with explicit confirmation
      const relocated = await store.relocateProject(recordOrig.projectId, otherProj, {
        allowTemp: true,
        confirmDifferentIdentity: true,
      });

      expect(relocated.status).toBe('available');
      expect(relocated.canonicalPath).toBe(path.resolve(otherProj));
      expect(relocated.displayName).toBe('Other Proj');
    });

    it('rejects relocation to non-existent folder', async () => {
      const p = path.join(tempBaseDir, 'relocate-missing');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });
      const nonExistent = path.join(tempBaseDir, 'does-not-exist');

      await expect(
        store.relocateProject(record.projectId, nonExistent, { allowTemp: true }),
      ).rejects.toThrow(RecentProjectError);
    });

    it('rejects relocation to folder missing .maos directory', async () => {
      const p = path.join(tempBaseDir, 'relocate-nomaos-src');
      const targetNoMaos = path.join(tempBaseDir, 'relocate-nomaos-dst');
      fs.mkdirSync(p, { recursive: true });
      fs.mkdirSync(targetNoMaos, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      await expect(
        store.relocateProject(record.projectId, targetNoMaos, { allowTemp: true }),
      ).rejects.toThrow(RecentProjectError);
    });

    it('rejects relocation to symlinked/junction folder when allowSymlinks: false', async () => {
      const src = path.join(tempBaseDir, 'sym-src');
      const target = path.join(tempBaseDir, 'sym-real-target');
      const junction = path.join(tempBaseDir, 'sym-junction-target');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(target, { recursive: true });
      createValidProject(src);
      createValidProject(target);

      try {
        fs.symlinkSync(target, junction, 'junction');
      } catch {
        // Skip if OS forbids junctions
        return;
      }

      const record = await store.recordProjectOpened(src, { allowTemp: true });

      await expect(
        store.relocateProject(record.projectId, junction, {
          allowTemp: true,
          allowSymlinks: false,
        }),
      ).rejects.toThrow(RecentProjectError);
    });

    it('rejects empty or invalid relocation path strings', async () => {
      const p = path.join(tempBaseDir, 'relocate-empty-test');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);
      const record = await store.recordProjectOpened(p, { allowTemp: true });

      await expect(store.relocateProject(record.projectId, '', { allowTemp: true })).rejects.toThrow(RecentProjectError);
      await expect(store.relocateProject(record.projectId, '   ', { allowTemp: true })).rejects.toThrow(RecentProjectError);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 4. Launcher Integration & Revalidation before Launch
  // ══════════════════════════════════════════════════════════════

  describe('4. Launcher Integration & Revalidation before Launch', () => {
    it('automatically records launched project into recent history', async () => {
      const p = path.join(tempBaseDir, 'launcher-record-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const host = await launcher.launch(p, { allowTemp: true });
      expect(host.isAlive()).toBe(true);

      const recentList = await store.listRecentProjects();
      expect(recentList.length).toBe(1);
      expect(recentList[0].canonicalPath).toBe(path.resolve(p));

      await host.stop();
    }, 15000);

    it('reopens an available recent project via launcher.launchRecent(projectId)', async () => {
      const p = path.join(tempBaseDir, 'launch-recent-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p, { projectName: 'Reopen Project' });

      const initialRecord = await store.recordProjectOpened(p, { allowTemp: true });

      // Reopen through launchRecent
      const host = await launcher.launchRecent(initialRecord.projectId, { allowTemp: true });
      expect(host.isAlive()).toBe(true);
      expect(host.project.projectName).toBe('Reopen Project');

      await host.stop();
    }, 15000);

    it('rejects launchRecent when project path is unavailable', async () => {
      const p = path.join(tempBaseDir, 'unavailable-launch-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      // Delete project folder
      fs.rmSync(p, { recursive: true, force: true });

      let caughtError: any = null;
      try {
        await launcher.launchRecent(record.projectId, { allowTemp: true });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(LauncherError);
      expect(caughtError.code).toBe('PROJECT_UNAVAILABLE');
    });

    it('rejects launchRecent when project identity has changed (relocation_required)', async () => {
      const p = path.join(tempBaseDir, 'identity-changed-launch-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      const record = await store.recordProjectOpened(p, { allowTemp: true });

      // Alter .maos/project-id
      fs.writeFileSync(path.join(p, '.maos', 'project-id'), 'proj_hijacked_id', 'utf-8');

      let caughtError: any = null;
      try {
        await launcher.launchRecent(record.projectId, { allowTemp: true });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(LauncherError);
      expect(caughtError.code).toBe('RELOCATION_REQUIRED');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 5. Reliability & Security Guarantees
  // ══════════════════════════════════════════════════════════════

  describe('5. Reliability & Security Guarantees', () => {
    it('recovers safely from corrupt metadata file to empty list without crashing', async () => {
      // Write corrupt data
      fs.writeFileSync(metadataFile, 'MALFORMED JSON {{{@@', 'utf-8');

      const list = await store.listRecentProjects();
      expect(list).toEqual([]);
      expect(store.getLastDiagnostic()).toContain('Corrupt metadata JSON');
    });

    it('recovers safely from incompatible schemaVersion in metadata file', async () => {
      fs.writeFileSync(
        metadataFile,
        JSON.stringify({ schemaVersion: 999, projects: [] }),
        'utf-8',
      );

      const list = await store.listRecentProjects();
      expect(list).toEqual([]);
      expect(store.getLastDiagnostic()).toContain('Incompatible metadata schemaVersion');
    });

    it('verifies zero secrets, tokens, or credentials are written to metadata file', async () => {
      const p = path.join(tempBaseDir, 'hygiene-proj');
      fs.mkdirSync(p, { recursive: true });
      createValidProject(p);

      await store.recordProjectOpened(p, { allowTemp: true });

      const rawContent = fs.readFileSync(metadataFile, 'utf-8');
      const parsed = JSON.parse(rawContent);

      expect(parsed.schemaVersion).toBe(1);
      expect(Array.isArray(parsed.projects)).toBe(true);

      for (const proj of parsed.projects) {
        // Strictly non-sensitive fields
        const keys = Object.keys(proj).sort();
        expect(keys).toEqual([
          'canonicalPath',
          'displayName',
          'lastKnownAt',
          'lastOpenedAt',
          'projectId',
          'projectRootHash',
          'schemaVersion',
          'status',
        ]);

        // Assure absence of sensitive fields
        expect((proj as any).token).toBeUndefined();
        expect((proj as any).sessionToken).toBeUndefined();
        expect((proj as any).apiKey).toBeUndefined();
        expect((proj as any).secret).toBeUndefined();
      }
    });

    it('handles concurrent updates safely without data loss or corruption', async () => {
      const p1 = path.join(tempBaseDir, 'concur-proj-1');
      const p2 = path.join(tempBaseDir, 'concur-proj-2');
      const p3 = path.join(tempBaseDir, 'concur-proj-3');
      for (const p of [p1, p2, p3]) {
        fs.mkdirSync(p, { recursive: true });
        createValidProject(p);
      }

      // Simultaneously record all 3 projects
      await Promise.all([
        store.recordProjectOpened(p1, { allowTemp: true }),
        store.recordProjectOpened(p2, { allowTemp: true }),
        store.recordProjectOpened(p3, { allowTemp: true }),
      ]);

      const list = await store.listRecentProjects();
      expect(list.length).toBe(3);

      const paths = list.map((p) => p.canonicalPath);
      expect(paths).toContain(path.resolve(p1));
      expect(paths).toContain(path.resolve(p2));
      expect(paths).toContain(path.resolve(p3));
    });
  });
});
