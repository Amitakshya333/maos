/**
 * UI1-05: Recent Projects and Relocation Store
 *
 * Manages the launcher's global project history outside project directories:
 *   - Platform-appropriate global storage location
 *   - Non-sensitive metadata: projectId, displayName, canonicalPath, rootHash, timestamps, status
 *   - Available, unavailable, and relocation_required status tracking
 *   - Explicit relocation with project identity verification and confirmation requirement
 *   - Deterministic ordering by lastOpenedAt descending
 *   - Duplicate consolidation and bounded history (maxEntries)
 *   - Atomic temp-file write and rename
 *   - Corrupt metadata recovery (never crash, recovers to empty list)
 *   - Concurrent update safety (lockfile with retry)
 *   - Zero secrets / tokens written to disk
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  validateProjectFolder,
  assertValidProjectFolder,
  CanonicalProjectFolder,
  ProjectValidationOptions,
} from './validator';
import { computeProjectRootHash } from './instance-identity';

export type RecentProjectStatus = 'available' | 'unavailable' | 'relocation_required';

export interface RecentProject {
  readonly projectId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly projectRootHash: string;
  readonly lastOpenedAt: string;
  readonly lastKnownAt: string;
  readonly status: RecentProjectStatus;
  readonly schemaVersion: 1;
}

export interface RecentProjectsFile {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly projects: RecentProject[];
}

export interface RecentProjectStoreOptions {
  /**
   * Explicit file path for storing recent-projects.json.
   * Defaults to platform-appropriate app-data path or MAOS_RECENT_PROJECTS_PATH env var.
   */
  readonly storagePath?: string;

  /**
   * Maximum number of recent projects to retain (default: 50).
   */
  readonly maxEntries?: number;

  /**
   * Whether to allow projects in temp directories during status checks (default: false).
   */
  readonly allowTemp?: boolean;

  /**
   * Whether to allow symlinks during status checks (default: false).
   */
  readonly allowSymlinks?: boolean;
}

export interface RelocateProjectOptions extends ProjectValidationOptions {
  /**
   * Explicit confirmation flag if the target folder has a different project identity.
   * If false, throws RelocationConfirmationRequiredError.
   */
  readonly confirmDifferentIdentity?: boolean;
}

export class RecentProjectError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'RecentProjectError';
    this.code = code;
  }
}

export class RelocationConfirmationRequiredError extends RecentProjectError {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly targetDisplayName: string;

  constructor(sourceProjectId: string, targetProjectId: string, targetDisplayName: string) {
    super(
      'RELOCATION_CONFIRMATION_REQUIRED',
      `Target folder contains a different project identity ('${targetDisplayName}', ID: ${targetProjectId}). User confirmation required to proceed with relocation.`,
    );
    this.name = 'RelocationConfirmationRequiredError';
    this.sourceProjectId = sourceProjectId;
    this.targetProjectId = targetProjectId;
    this.targetDisplayName = targetDisplayName;
  }
}

/**
 * Resolve the platform-appropriate path for global recent-projects.json.
 */
export function getDefaultRecentProjectsPath(): string {
  if (process.env.MAOS_RECENT_PROJECTS_PATH) {
    return path.resolve(process.env.MAOS_RECENT_PROJECTS_PATH);
  }

  if (process.env.MAOS_GLOBAL_DIR) {
    return path.resolve(process.env.MAOS_GLOBAL_DIR, 'recent-projects.json');
  }

  const platform = process.platform;
  let baseDir: string;

  if (platform === 'win32') {
    baseDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    baseDir = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    // Linux / POSIX
    baseDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }

  return path.join(baseDir, 'maos', 'recent-projects.json');
}

/**
 * Retrieve or durably initialize a stable project identifier.
 * Stored in `.maos/project-id` or derived from `profile.id`.
 */
export function getOrGenerateProjectId(projectRoot: string, parsedConfig?: any): string {
  const canonical = path.resolve(projectRoot);
  const maosDir = path.join(canonical, '.maos');

  // 1. If profile.id is set in config, prefer it
  if (parsedConfig?.profile?.id && typeof parsedConfig.profile.id === 'string' && parsedConfig.profile.id.trim()) {
    return parsedConfig.profile.id.trim();
  }

  // 2. Check for durable marker file: .maos/project-id
  const markerPath = path.join(maosDir, 'project-id');
  if (fs.existsSync(markerPath)) {
    try {
      const content = fs.readFileSync(markerPath, 'utf-8').trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Fall through to generation
    }
  }

  // 3. Generate a stable random project ID and save it to .maos/project-id if .maos exists
  const generatedId = `proj_${crypto.randomBytes(12).toString('hex')}`;
  if (fs.existsSync(maosDir)) {
    try {
      fs.writeFileSync(markerPath, generatedId, 'utf-8');
    } catch {
      // Ignored if read-only
    }
  }

  return generatedId;
}

/**
 * Global store for recent MAOS projects and explicit relocation.
 */
export class RecentProjectStore {
  private readonly storagePath: string;
  private readonly maxEntries: number;
  private readonly allowTemp: boolean;
  private readonly allowSymlinks: boolean;
  private lastDiagnostic?: string;

  constructor(options: RecentProjectStoreOptions = {}) {
    this.storagePath = options.storagePath
      ? path.resolve(options.storagePath)
      : getDefaultRecentProjectsPath();
    this.maxEntries = options.maxEntries && options.maxEntries > 0 ? options.maxEntries : 50;
    this.allowTemp = options.allowTemp ?? false;
    this.allowSymlinks = options.allowSymlinks ?? false;
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  getLastDiagnostic(): string | undefined {
    return this.lastDiagnostic;
  }

  /**
   * Acquire a file lock for safe concurrent updates across processes.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = this.storagePath + '.lock';
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    const maxRetries = 40;
    const retryDelayMs = 25;
    let acquired = false;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check if lock file is stale (> 5000ms old)
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 5000) {
              try {
                fs.unlinkSync(lockPath);
              } catch {}
            }
          } catch {}
          await new Promise((r) => setTimeout(r, retryDelayMs));
        } else {
          throw err;
        }
      }
    }

    if (!acquired) {
      throw new RecentProjectError(
        'CONCURRENT_LOCK_TIMEOUT',
        `Failed to acquire lock for '${this.storagePath}' after ${maxRetries * retryDelayMs}ms.`,
      );
    }

    try {
      return await fn();
    } finally {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }
  }

  /**
   * Read and parse recent projects file. Recovers safely to empty state if corrupt.
   */
  private readFileUnsafe(): RecentProjectsFile {
    if (!fs.existsSync(this.storagePath)) {
      return {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        projects: [],
      };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.storagePath, 'utf-8');
    } catch (err: any) {
      this.lastDiagnostic = `Cannot read metadata file: ${err.message}`;
      return { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [] };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      this.lastDiagnostic = `Corrupt metadata JSON: ${err.message}`;
      return { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [] };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.lastDiagnostic = 'Corrupt metadata: root is not an object';
      return { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [] };
    }

    if (parsed.schemaVersion !== 1) {
      this.lastDiagnostic = `Incompatible metadata schemaVersion: ${parsed.schemaVersion}`;
      return { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [] };
    }

    if (!Array.isArray(parsed.projects)) {
      this.lastDiagnostic = "Corrupt metadata: 'projects' is not an array";
      return { schemaVersion: 1, updatedAt: new Date().toISOString(), projects: [] };
    }

    const sanitizedProjects: RecentProject[] = [];
    for (const item of parsed.projects) {
      if (
        item &&
        typeof item === 'object' &&
        typeof item.projectId === 'string' &&
        typeof item.displayName === 'string' &&
        typeof item.canonicalPath === 'string' &&
        typeof item.projectRootHash === 'string' &&
        typeof item.lastOpenedAt === 'string' &&
        typeof item.lastKnownAt === 'string' &&
        (item.status === 'available' ||
          item.status === 'unavailable' ||
          item.status === 'relocation_required') &&
        item.schemaVersion === 1
      ) {
        sanitizedProjects.push(item);
      }
    }

    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      projects: sanitizedProjects,
    };
  }

  /**
   * Atomically write recent projects file using temp-file + fsync + rename.
   */
  private writeFileUnsafe(file: RecentProjectsFile): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempFile = path.join(
      dir,
      `.recent-projects.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );

    const payload = JSON.stringify(file, null, 2);

    let fd: number | null = null;
    try {
      fd = fs.openSync(tempFile, 'w');
      fs.writeSync(fd, payload, 0, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }

    try {
      fs.renameSync(tempFile, this.storagePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {}
      throw err;
    }
  }

  /**
   * Sort projects by lastOpenedAt descending and enforce bounded size.
   */
  private sortAndBound(projects: RecentProject[]): void {
    projects.sort((a, b) => {
      const timeA = new Date(a.lastOpenedAt).getTime();
      const timeB = new Date(b.lastOpenedAt).getTime();
      if (timeB !== timeA) {
        return timeB - timeA; // Descending: newest first
      }
      return a.projectId.localeCompare(b.projectId);
    });

    if (projects.length > this.maxEntries) {
      projects.splice(this.maxEntries);
    }
  }

  /**
   * Determine project availability status against current filesystem state.
   */
  private evaluateProjectStatus(
    record: RecentProject,
    allowTemp = this.allowTemp,
    allowSymlinks = this.allowSymlinks,
  ): RecentProjectStatus {
    if (!fs.existsSync(record.canonicalPath)) {
      return 'unavailable';
    }

    const validation = validateProjectFolder(record.canonicalPath, {
      allowTemp,
      allowSymlinks,
    });

    if (!validation.valid || !validation.project) {
      return 'unavailable';
    }

    const project = validation.project;
    const currentId = getOrGenerateProjectId(project.canonicalPath, project.config);

    if (currentId !== record.projectId) {
      return 'relocation_required';
    }

    if (project.projectRootHash !== record.projectRootHash) {
      return 'relocation_required';
    }

    return 'available';
  }

  /**
   * List all recent projects, deterministically ordered (newest first).
   * Optionally re-verifies availability status on each record.
   */
  async listRecentProjects(options: { verifyStatus?: boolean } = {}): Promise<RecentProject[]> {
    return this.withLock(async () => {
      const file = this.readFileUnsafe();

      if (options.verifyStatus) {
        let changed = false;
        const now = new Date().toISOString();
        const updatedProjects = file.projects.map((p) => {
          const freshStatus = this.evaluateProjectStatus(p);
          if (freshStatus !== p.status) {
            changed = true;
            return {
              ...p,
              status: freshStatus,
              lastKnownAt: now,
            };
          }
          return p;
        });

        if (changed) {
          const updatedFile: RecentProjectsFile = {
            schemaVersion: 1,
            updatedAt: now,
            projects: updatedProjects,
          };
          this.writeFileUnsafe(updatedFile);
          return updatedProjects;
        }
      }

      this.sortAndBound(file.projects);
      return file.projects;
    });
  }

  /**
   * Get a single recent project by projectId or canonicalPath.
   */
  async getRecentProject(idOrPath: string): Promise<RecentProject | undefined> {
    const projects = await this.listRecentProjects();
    const query = idOrPath.trim();
    const resolvedPath = path.resolve(query).toLowerCase();

    return projects.find(
      (p) => p.projectId === query || path.resolve(p.canonicalPath).toLowerCase() === resolvedPath,
    );
  }

  /**
   * Record a project as opened.
   * Validates folder, updates lastOpenedAt, consolidates duplicates, bounds history, and persists atomically.
   */
  async recordProjectOpened(
    folderPath: string,
    options: ProjectValidationOptions = {},
  ): Promise<RecentProject> {
    const allowTemp = options.allowTemp ?? this.allowTemp;
    const allowSymlinks = options.allowSymlinks ?? this.allowSymlinks;

    const project = assertValidProjectFolder(folderPath, {
      allowTemp,
      allowSymlinks,
      requiredSchemaVersion: options.requiredSchemaVersion,
    });

    const projectId = getOrGenerateProjectId(project.canonicalPath, project.config);
    const now = new Date().toISOString();

    return this.withLock(async () => {
      const file = this.readFileUnsafe();

      const newRecord: RecentProject = {
        projectId,
        displayName: project.projectName,
        canonicalPath: project.canonicalPath,
        projectRootHash: project.projectRootHash,
        lastOpenedAt: now,
        lastKnownAt: now,
        status: 'available',
        schemaVersion: 1,
      };

      // Consolidate duplicates: remove any record with same projectId or same canonical path
      const canonicalLower = project.canonicalPath.toLowerCase();
      const filtered = file.projects.filter(
        (p) =>
          p.projectId !== projectId &&
          path.resolve(p.canonicalPath).toLowerCase() !== canonicalLower,
      );

      const updatedProjects = [newRecord, ...filtered];
      this.sortAndBound(updatedProjects);

      const updatedFile: RecentProjectsFile = {
        schemaVersion: 1,
        updatedAt: now,
        projects: updatedProjects,
      };

      this.writeFileUnsafe(updatedFile);
      return newRecord;
    });
  }

  /**
   * Refresh the availability status of a single project in the store.
   */
  async refreshProjectStatus(projectId: string): Promise<RecentProject | undefined> {
    return this.withLock(async () => {
      const file = this.readFileUnsafe();
      const index = file.projects.findIndex((p) => p.projectId === projectId);
      if (index === -1) return undefined;

      const record = file.projects[index];
      const freshStatus = this.evaluateProjectStatus(record);
      const now = new Date().toISOString();

      const updated: RecentProject = {
        ...record,
        status: freshStatus,
        lastKnownAt: now,
      };

      file.projects[index] = updated;
      const updatedFile: RecentProjectsFile = {
        schemaVersion: 1,
        updatedAt: now,
        projects: file.projects,
      };

      this.writeFileUnsafe(updatedFile);
      return updated;
    });
  }

  /**
   * Explicitly relocate an unavailable or moved project to a new folder path.
   *
   * Verifies that the target folder is a valid MAOS project.
   * If the target folder represents a different project identity (different projectId),
   * confirmation is required (`options.confirmDifferentIdentity = true`).
   * Never silently substitutes a different project.
   */
  async relocateProject(
    projectId: string,
    newFolderPath: string,
    options: RelocateProjectOptions = {},
  ): Promise<RecentProject> {
    if (!newFolderPath || typeof newFolderPath !== 'string' || !newFolderPath.trim()) {
      throw new RecentProjectError('INVALID_RELOCATION_PATH', 'Relocation target path must be a non-empty string.');
    }

    const rawTarget = newFolderPath.trim();
    const allowTemp = options.allowTemp ?? this.allowTemp;
    const allowSymlinks = options.allowSymlinks ?? this.allowSymlinks;

    // 1. Validate target folder with UI1-04 project folder validator
    let targetProject: CanonicalProjectFolder;
    try {
      targetProject = assertValidProjectFolder(rawTarget, {
        allowTemp,
        allowSymlinks,
        requiredSchemaVersion: options.requiredSchemaVersion,
      });
    } catch (err: any) {
      throw new RecentProjectError(
        err.code || 'INVALID_RELOCATION_TARGET',
        `Relocation target folder failed validation: ${err.message}`,
      );
    }

    return this.withLock(async () => {
      const file = this.readFileUnsafe();
      const index = file.projects.findIndex((p) => p.projectId === projectId);
      if (index === -1) {
        throw new RecentProjectError(
          'PROJECT_NOT_FOUND',
          `Recent project with ID '${projectId}' was not found in registry.`,
        );
      }

      const existingRecord = file.projects[index];
      const targetProjectId = getOrGenerateProjectId(targetProject.canonicalPath, targetProject.config);
      const targetDisplayName = targetProject.config.projectName || path.basename(targetProject.canonicalPath);

      // Identity verification: compare durable project ID
      const isIdentityDifferent = targetProjectId !== existingRecord.projectId;
      if (isIdentityDifferent && !options.confirmDifferentIdentity) {
        throw new RelocationConfirmationRequiredError(
          existingRecord.projectId,
          targetProjectId,
          targetDisplayName,
        );
      }

      const now = new Date().toISOString();
      const updatedRecord: RecentProject = {
        projectId: isIdentityDifferent ? targetProjectId : existingRecord.projectId,
        displayName: targetDisplayName,
        canonicalPath: targetProject.canonicalPath,
        projectRootHash: targetProject.projectRootHash,
        lastOpenedAt: now,
        lastKnownAt: now,
        status: 'available',
        schemaVersion: 1,
      };

      // Consolidate duplicates: remove any other project that matches new path or new ID
      const targetCanonicalLower = targetProject.canonicalPath.toLowerCase();
      const filtered = file.projects.filter(
        (p, idx) =>
          idx !== index &&
          p.projectId !== updatedRecord.projectId &&
          path.resolve(p.canonicalPath).toLowerCase() !== targetCanonicalLower,
      );

      const merged = [updatedRecord, ...filtered];
      this.sortAndBound(merged);

      const updatedFile: RecentProjectsFile = {
        schemaVersion: 1,
        updatedAt: now,
        projects: merged,
      };

      this.writeFileUnsafe(updatedFile);
      return updatedRecord;
    });
  }

  /**
   * Remove a project from recent history. Returns true if removed, false if not found.
   */
  async removeRecentProject(projectId: string): Promise<boolean> {
    return this.withLock(async () => {
      const file = this.readFileUnsafe();
      const initialCount = file.projects.length;
      const filtered = file.projects.filter((p) => p.projectId !== projectId);

      if (filtered.length === initialCount) {
        return false;
      }

      const updatedFile: RecentProjectsFile = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        projects: filtered,
      };

      this.writeFileUnsafe(updatedFile);
      return true;
    });
  }

  /**
   * Clear all recent project records.
   */
  async clearRecentProjects(): Promise<void> {
    return this.withLock(async () => {
      const updatedFile: RecentProjectsFile = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        projects: [],
      };
      this.writeFileUnsafe(updatedFile);
    });
  }
}
