/**
 * UI1-08: Basic Settings Domain Schemas and Validators
 *
 * Defines versioned, bounded schemas for:
 *   - Retention & Redaction: conversation retention, event display, artifact preview, preview redaction
 *   - Runtime & Idle Model Behavior: GPU model unload timeout, service idle stop, stop mode
 *   - Accessibility & Display: theme, reduced motion, font scale, spacing density
 *
 * All values have explicit bounds. Arbitrary or out-of-range settings are strictly rejected.
 * Settings can never weaken security redaction or disable mandatory audit persistence.
 */

export interface RetentionSettings {
  readonly conversationDays: number;
  readonly eventDisplayDays: number;
  readonly artifactPreviewDays: number;
  readonly redactSensitivePreviews: boolean;
  readonly allowRawEvidencePreviews?: boolean;
}

export interface RuntimeSettings {
  readonly modelUnloadAfterSeconds: number;
  readonly serviceStopAfterSeconds: number;
  readonly stopMode: 'after-current-tasks' | 'force';
}

export interface AccessibilitySettings {
  readonly theme: 'dark' | 'high-contrast';
  readonly reducedMotion: boolean;
  readonly fontScale: number;
  readonly density: 'compact' | 'comfortable';
}

export interface BasicSettings {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly retention: RetentionSettings;
  readonly runtime: RuntimeSettings;
  readonly accessibility: AccessibilitySettings;
  readonly updatedAt: string;
}

export const SETTINGS_BOUNDS = Object.freeze({
  RETENTION_DAYS_MIN: 1,
  RETENTION_DAYS_MAX: 365,
  MODEL_UNLOAD_SECONDS_MIN: 30,
  MODEL_UNLOAD_SECONDS_MAX: 86400, // 24 hours
  SERVICE_STOP_SECONDS_MIN: 60,
  SERVICE_STOP_SECONDS_MAX: 86400, // 24 hours
  FONT_SCALE_MIN: 0.8,
  FONT_SCALE_MAX: 2.0,
});

export const DEFAULT_RETENTION_SETTINGS: Readonly<RetentionSettings> = Object.freeze({
  conversationDays: 30,
  eventDisplayDays: 90,
  artifactPreviewDays: 30,
  redactSensitivePreviews: true,
  allowRawEvidencePreviews: false,
});

export const DEFAULT_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
  modelUnloadAfterSeconds: 180, // 3 minutes idle
  serviceStopAfterSeconds: 600, // 10 minutes idle
  stopMode: 'after-current-tasks',
});

export const DEFAULT_ACCESSIBILITY_SETTINGS: Readonly<AccessibilitySettings> = Object.freeze({
  theme: 'dark',
  reducedMotion: false,
  fontScale: 1.0,
  density: 'comfortable',
});

export function getDefaultBasicSettings(projectId: string): BasicSettings {
  return {
    schemaVersion: 1,
    projectId: projectId || 'default',
    retention: { ...DEFAULT_RETENTION_SETTINGS },
    runtime: { ...DEFAULT_RUNTIME_SETTINGS },
    accessibility: { ...DEFAULT_ACCESSIBILITY_SETTINGS },
    updatedAt: new Date().toISOString(),
  };
}

export interface SettingsValidationResult {
  valid: boolean;
  errors?: string[];
  settings?: BasicSettings;
}

/**
 * Validates a BasicSettings object against explicit bounds and schemaVersion 1.
 */
export function validateBasicSettings(
  input: unknown,
  expectedProjectId?: string,
): SettingsValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Settings must be a non-null JSON object'] };
  }

  const raw = input as Record<string, any>;
  const allowedTopLevel = new Set(['schemaVersion', 'projectId', 'retention', 'runtime', 'accessibility', 'updatedAt']);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) errors.push(`Unknown top-level settings field: ${key}`);
  }

  // schemaVersion
  if (raw.schemaVersion !== 1) {
    errors.push(`Invalid schemaVersion: expected 1, received ${raw.schemaVersion}`);
  }

  // projectId
  if (typeof raw.projectId !== 'string' || !raw.projectId.trim()) {
    errors.push('Missing or invalid projectId');
  } else if (expectedProjectId && raw.projectId !== expectedProjectId) {
    errors.push(
      `ProjectId mismatch: expected '${expectedProjectId}', received '${raw.projectId}'`,
    );
  }

  // Retention block
  if (!raw.retention || typeof raw.retention !== 'object') {
    errors.push('Missing or invalid retention block');
  } else {
    const ret = raw.retention;
    for (const key of Object.keys(ret)) {
      if (!['conversationDays', 'eventDisplayDays', 'artifactPreviewDays', 'redactSensitivePreviews', 'allowRawEvidencePreviews'].includes(key)) {
        errors.push(`Unknown retention field: ${key}`);
      }
    }
    if (
      typeof ret.conversationDays !== 'number' ||
      !Number.isInteger(ret.conversationDays) ||
      ret.conversationDays < SETTINGS_BOUNDS.RETENTION_DAYS_MIN ||
      ret.conversationDays > SETTINGS_BOUNDS.RETENTION_DAYS_MAX
    ) {
      errors.push(
        `retention.conversationDays must be an integer between ${SETTINGS_BOUNDS.RETENTION_DAYS_MIN} and ${SETTINGS_BOUNDS.RETENTION_DAYS_MAX}`,
      );
    }
    if (
      typeof ret.eventDisplayDays !== 'number' ||
      !Number.isInteger(ret.eventDisplayDays) ||
      ret.eventDisplayDays < SETTINGS_BOUNDS.RETENTION_DAYS_MIN ||
      ret.eventDisplayDays > SETTINGS_BOUNDS.RETENTION_DAYS_MAX
    ) {
      errors.push(
        `retention.eventDisplayDays must be an integer between ${SETTINGS_BOUNDS.RETENTION_DAYS_MIN} and ${SETTINGS_BOUNDS.RETENTION_DAYS_MAX}`,
      );
    }
    if (
      typeof ret.artifactPreviewDays !== 'number' ||
      !Number.isInteger(ret.artifactPreviewDays) ||
      ret.artifactPreviewDays < SETTINGS_BOUNDS.RETENTION_DAYS_MIN ||
      ret.artifactPreviewDays > SETTINGS_BOUNDS.RETENTION_DAYS_MAX
    ) {
      errors.push(
        `retention.artifactPreviewDays must be an integer between ${SETTINGS_BOUNDS.RETENTION_DAYS_MIN} and ${SETTINGS_BOUNDS.RETENTION_DAYS_MAX}`,
      );
    }
    if (typeof ret.redactSensitivePreviews !== 'boolean') {
      errors.push('retention.redactSensitivePreviews must be a boolean');
    }
    if (ret.allowRawEvidencePreviews !== undefined && typeof ret.allowRawEvidencePreviews !== 'boolean') {
      errors.push('retention.allowRawEvidencePreviews must be a boolean');
    }
  }

  // Runtime block
  if (!raw.runtime || typeof raw.runtime !== 'object') {
    errors.push('Missing or invalid runtime block');
  } else {
    const run = raw.runtime;
    for (const key of Object.keys(run)) {
      if (!['modelUnloadAfterSeconds', 'serviceStopAfterSeconds', 'stopMode'].includes(key)) {
        errors.push(`Unknown runtime field: ${key}`);
      }
    }
    if (
      typeof run.modelUnloadAfterSeconds !== 'number' ||
      !Number.isInteger(run.modelUnloadAfterSeconds) ||
      run.modelUnloadAfterSeconds < SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MIN ||
      run.modelUnloadAfterSeconds > SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MAX
    ) {
      errors.push(
        `runtime.modelUnloadAfterSeconds must be an integer between ${SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MIN} and ${SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MAX}`,
      );
    }
    if (
      typeof run.serviceStopAfterSeconds !== 'number' ||
      !Number.isInteger(run.serviceStopAfterSeconds) ||
      run.serviceStopAfterSeconds < SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MIN ||
      run.serviceStopAfterSeconds > SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MAX
    ) {
      errors.push(
        `runtime.serviceStopAfterSeconds must be an integer between ${SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MIN} and ${SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MAX}`,
      );
    }
    if (run.stopMode !== 'after-current-tasks' && run.stopMode !== 'force') {
      errors.push("runtime.stopMode must be 'after-current-tasks' or 'force'");
    }
  }

  // Accessibility block
  if (!raw.accessibility || typeof raw.accessibility !== 'object') {
    errors.push('Missing or invalid accessibility block');
  } else {
    const acc = raw.accessibility;
    for (const key of Object.keys(acc)) {
      if (!['theme', 'reducedMotion', 'fontScale', 'density'].includes(key)) {
        errors.push(`Unknown accessibility field: ${key}`);
      }
    }
    if (acc.theme !== 'dark' && acc.theme !== 'high-contrast') {
      errors.push("accessibility.theme must be 'dark' or 'high-contrast'");
    }
    if (typeof acc.reducedMotion !== 'boolean') {
      errors.push('accessibility.reducedMotion must be a boolean');
    }
    if (
      typeof acc.fontScale !== 'number' ||
      Number.isNaN(acc.fontScale) ||
      acc.fontScale < SETTINGS_BOUNDS.FONT_SCALE_MIN ||
      acc.fontScale > SETTINGS_BOUNDS.FONT_SCALE_MAX
    ) {
      errors.push(
        `accessibility.fontScale must be a number between ${SETTINGS_BOUNDS.FONT_SCALE_MIN} and ${SETTINGS_BOUNDS.FONT_SCALE_MAX}`,
      );
    }
    if (acc.density !== 'compact' && acc.density !== 'comfortable') {
      errors.push("accessibility.density must be 'compact' or 'comfortable'");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    settings: {
      schemaVersion: 1,
      projectId: String(raw.projectId).trim(),
      retention: {
        conversationDays: raw.retention.conversationDays,
        eventDisplayDays: raw.retention.eventDisplayDays,
        artifactPreviewDays: raw.retention.artifactPreviewDays,
        redactSensitivePreviews: Boolean(raw.retention.redactSensitivePreviews),
        allowRawEvidencePreviews: Boolean(raw.retention.allowRawEvidencePreviews ?? false),
      },
      runtime: {
        modelUnloadAfterSeconds: raw.runtime.modelUnloadAfterSeconds,
        serviceStopAfterSeconds: raw.runtime.serviceStopAfterSeconds,
        stopMode: raw.runtime.stopMode,
      },
      accessibility: {
        theme: raw.accessibility.theme,
        reducedMotion: Boolean(raw.accessibility.reducedMotion),
        fontScale: Number(raw.accessibility.fontScale.toFixed(2)),
        density: raw.accessibility.density,
      },
      updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString(),
    },
  };
}

/**
 * Normalizes and safely merges partial updates with existing settings.
 * Clamps numeric values that are slightly outside boundaries instead of crashing.
 */
export function normalizeBasicSettings(
  patch: Record<string, any>,
  current: BasicSettings,
): BasicSettings {
  const merged: BasicSettings = {
    schemaVersion: 1,
    projectId: current.projectId,
    retention: {
      conversationDays:
        typeof patch?.retention?.conversationDays === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.RETENTION_DAYS_MIN,
              Math.min(SETTINGS_BOUNDS.RETENTION_DAYS_MAX, Math.round(patch.retention.conversationDays)),
            )
          : current.retention.conversationDays,
      eventDisplayDays:
        typeof patch?.retention?.eventDisplayDays === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.RETENTION_DAYS_MIN,
              Math.min(SETTINGS_BOUNDS.RETENTION_DAYS_MAX, Math.round(patch.retention.eventDisplayDays)),
            )
          : current.retention.eventDisplayDays,
      artifactPreviewDays:
        typeof patch?.retention?.artifactPreviewDays === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.RETENTION_DAYS_MIN,
              Math.min(SETTINGS_BOUNDS.RETENTION_DAYS_MAX, Math.round(patch.retention.artifactPreviewDays)),
            )
          : current.retention.artifactPreviewDays,
      redactSensitivePreviews:
        typeof patch?.retention?.redactSensitivePreviews === 'boolean'
          ? patch.retention.redactSensitivePreviews
          : current.retention.redactSensitivePreviews,
      allowRawEvidencePreviews:
        typeof patch?.retention?.allowRawEvidencePreviews === 'boolean'
          ? patch.retention.allowRawEvidencePreviews
          : Boolean(current.retention.allowRawEvidencePreviews ?? false),
    },
    runtime: {
      modelUnloadAfterSeconds:
        typeof patch?.runtime?.modelUnloadAfterSeconds === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MIN,
              Math.min(SETTINGS_BOUNDS.MODEL_UNLOAD_SECONDS_MAX, Math.round(patch.runtime.modelUnloadAfterSeconds)),
            )
          : current.runtime.modelUnloadAfterSeconds,
      serviceStopAfterSeconds:
        typeof patch?.runtime?.serviceStopAfterSeconds === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MIN,
              Math.min(SETTINGS_BOUNDS.SERVICE_STOP_SECONDS_MAX, Math.round(patch.runtime.serviceStopAfterSeconds)),
            )
          : current.runtime.serviceStopAfterSeconds,
      stopMode:
        patch?.runtime?.stopMode === 'force' || patch?.runtime?.stopMode === 'after-current-tasks'
          ? patch.runtime.stopMode
          : current.runtime.stopMode,
    },
    accessibility: {
      theme:
        patch?.accessibility?.theme === 'high-contrast' || patch?.accessibility?.theme === 'dark'
          ? patch.accessibility.theme
          : current.accessibility.theme,
      reducedMotion:
        typeof patch?.accessibility?.reducedMotion === 'boolean'
          ? patch.accessibility.reducedMotion
          : current.accessibility.reducedMotion,
      fontScale:
        typeof patch?.accessibility?.fontScale === 'number'
          ? Math.max(
              SETTINGS_BOUNDS.FONT_SCALE_MIN,
              Math.min(SETTINGS_BOUNDS.FONT_SCALE_MAX, parseFloat(patch.accessibility.fontScale.toFixed(2))),
            )
          : current.accessibility.fontScale,
      density:
        patch?.accessibility?.density === 'compact' || patch?.accessibility?.density === 'comfortable'
          ? patch.accessibility.density
          : current.accessibility.density,
    },
    updatedAt: new Date().toISOString(),
  };

  return merged;
}
