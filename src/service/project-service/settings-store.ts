/**
 * UI1-08: Basic Settings Store
 *
 * Implements durable, atomic, and crash-resilient persistence for user/project settings:
 *   - Stored at `.maos/settings/basic-settings.json` (per-project)
 *   - Atomic write semantics: temporary file -> fsync -> atomic rename
 *   - Resilient recovery: corrupted JSON, missing file, or schema mismatch recovers to defaults
 *   - Storage hygiene: strictly zero tokens, credentials, or API keys written to disk
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BasicSettings,
  getDefaultBasicSettings,
  validateBasicSettings,
} from '../../domain/settings';

export interface BasicSettingsStoreOptions {
  storagePath?: string;
}

export class BasicSettingsStore {
  private readonly projectRoot: string;
  private readonly storagePath: string;

  constructor(projectRoot: string, options: BasicSettingsStoreOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.storagePath =
      options.storagePath ||
      path.join(this.projectRoot, '.maos', 'settings', 'basic-settings.json');
  }

  getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Load the active settings for this project.
   * If the file does not exist, is malformed, or fails validation, safely recovers
   * to canonical defaults.
   */
  loadSettings(projectId?: string): BasicSettings {
    const fallbackProjectId = projectId || 'default';

    if (!fs.existsSync(this.storagePath)) {
      return getDefaultBasicSettings(fallbackProjectId);
    }

    try {
      const content = fs.readFileSync(this.storagePath, 'utf-8');
      if (!content.trim()) {
        return getDefaultBasicSettings(fallbackProjectId);
      }

      const parsed = JSON.parse(content);
      const validation = validateBasicSettings(parsed, projectId);

      if (!validation.valid || !validation.settings) {
        return getDefaultBasicSettings(fallbackProjectId);
      }

      return validation.settings;
    } catch {
      // Safe recovery from corrupt JSON
      return getDefaultBasicSettings(fallbackProjectId);
    }
  }

  /**
   * Atomically persist basic settings to disk.
   */
  saveSettings(settings: BasicSettings): BasicSettings {
    const validation = validateBasicSettings(settings);
    if (!validation.valid || !validation.settings) {
      throw new Error(
        `INVALID_BASIC_SETTINGS: ${validation.errors?.join('; ') || 'Validation failed'}`,
      );
    }

    const validated: BasicSettings = {
      ...validation.settings,
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
   * Reset settings to canonical defaults for this project.
   */
  resetSettings(projectId: string): BasicSettings {
    const defaults = getDefaultBasicSettings(projectId);
    return this.saveSettings(defaults);
  }
}
