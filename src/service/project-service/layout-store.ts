/**
 * Workspace Layout Store (UI1-07)
 *
 * Implements durable, atomic, and crash-resilient persistence for workspace layout:
 *   - Stored at `.maos/settings/workspace-layout.json` (per-project)
 *   - Atomic write semantics: temp file -> fsync -> atomic rename
 *   - Safe recovery from corrupt JSON, invalid schemaVersion, unknown modules, or cross-project data
 *   - Zero tokens, credentials, audit events, or sensitive data written to disk
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  WorkspaceLayout,
  RolePreset,
  getDefaultLayoutForRole,
  validateWorkspaceLayout,
  isRolePreset,
} from '../../domain/layout';

export interface WorkspaceLayoutStoreOptions {
  storagePath?: string;
}

export class WorkspaceLayoutStore {
  private readonly projectRoot: string;
  private readonly storagePath: string;

  constructor(projectRoot: string, options: WorkspaceLayoutStoreOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.storagePath =
      options.storagePath ||
      path.join(this.projectRoot, '.maos', 'settings', 'workspace-layout.json');
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Load the active layout for this project.
   * If the file does not exist, is malformed, or fails validation, safely recovers
   * to the default layout for the given role (default: 'developer').
   */
  loadLayout(projectId?: string, defaultRole: RolePreset = 'developer'): WorkspaceLayout {
    const fallbackProjectId = projectId || 'default';

    if (!fs.existsSync(this.storagePath)) {
      return getDefaultLayoutForRole(defaultRole, fallbackProjectId);
    }

    try {
      const content = fs.readFileSync(this.storagePath, 'utf-8');
      if (!content.trim()) {
        return getDefaultLayoutForRole(defaultRole, fallbackProjectId);
      }

      const parsed = JSON.parse(content);
      const validation = validateWorkspaceLayout(parsed, projectId);

      if (!validation.valid || !validation.layout) {
        // Safe recovery: corrupt layout resets safely to built-in default
        return getDefaultLayoutForRole(defaultRole, fallbackProjectId);
      }

      return validation.layout;
    } catch {
      // Safe recovery: corrupt JSON resets safely to built-in default
      return getDefaultLayoutForRole(defaultRole, fallbackProjectId);
    }
  }

  /**
   * Atomically persist workspace layout to disk.
   */
  saveLayout(layout: WorkspaceLayout): WorkspaceLayout {
    const validation = validateWorkspaceLayout(layout);
    if (!validation.valid || !validation.layout) {
      throw new Error(
        `INVALID_WORKSPACE_LAYOUT: ${validation.errors?.join('; ') || 'Validation failed'}`,
      );
    }

    const validated = {
      ...validation.layout,
      updatedAt: new Date().toISOString(),
    };

    const targetDir = path.dirname(this.storagePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const serialized = JSON.stringify(validated, null, 2);
    const tempPath = `${this.storagePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const fd = fs.openSync(tempPath, 'w');
    try {
      fs.writeFileSync(fd, serialized, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, this.storagePath);
    return validated;
  }

  /**
   * Reset the layout for a project to its canonical role default.
   */
  resetLayout(projectId: string, role?: RolePreset): WorkspaceLayout {
    const targetRole = role && isRolePreset(role) ? role : 'developer';
    const defaultLayout = getDefaultLayoutForRole(targetRole, projectId);
    return this.saveLayout(defaultLayout);
  }
}
