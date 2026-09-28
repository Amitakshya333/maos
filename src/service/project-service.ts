import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath, isMaosInitialized } from '../utils/paths';
import type { Project, ProfileConfig, AgentEntry, ProviderEntry } from '../domain/schemas';
import {
  BasicSettings,
  getDefaultBasicSettings,
  validateBasicSettings,
  normalizeBasicSettings,
} from '../domain/settings';
import { BasicSettingsStore } from './project-service/settings-store';
import { TaskService } from './task-service';
import { AuditService } from './audit-service';
import { ArtifactService } from './artifact-service';
import { ModelService } from './model-service';
import { readServiceIdentity, ServiceInstanceIdentity } from './project-service/instance-identity';
import { getOrGenerateProjectId } from './project-service/recent-projects';
import { getDefaultEnginePath, verifyExecutable } from '../industrial/rust-engine-bridge';

export interface ProjectServiceDeps {
  taskService?: TaskService;
  auditService?: AuditService;
  artifactService?: ArtifactService;
  modelService?: ModelService;
}

export interface StopServiceOptions {
  mode: 'after-current-tasks' | 'force';
  confirm?: boolean;
  reason?: string;
}

const SENSITIVE_SETTING_KEY = /(?:token|password|secret|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?token)/i;

function sanitizeLegacySettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLegacySettings);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_SETTING_KEY.test(key)) continue;
    result[key] = sanitizeLegacySettings(child);
  }
  return result;
}

export interface StopServiceResult {
  status: 'stopped' | 'stopping_after_tasks';
  mode: 'after-current-tasks' | 'force';
  interruptedTasksCount?: number;
  activeTasksCount?: number;
  cleanedTempArtifacts?: number;
  unloadedModels?: number;
  timestamp: string;
}

export class ProjectService {
  private readonly settingsStore: BasicSettingsStore;

  constructor(
    private readonly projectRoot: string,
    private deps: ProjectServiceDeps = {},
  ) {
    this.settingsStore = new BasicSettingsStore(projectRoot);
  }

  setDependencies(deps: ProjectServiceDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  getSettingsStore(): BasicSettingsStore {
    return this.settingsStore;
  }

  /**
   * Check whether MAOS has been initialized in the project root.
   */
  isInitialized(): boolean {
    return isMaosInitialized(this.projectRoot);
  }

  /**
   * Load and return the project configuration as a typed Project.
   * Throws if config file does not exist or is malformed.
   */
  loadConfig(): Project {
    const configPath = getConfigPath(this.projectRoot);
    if (!fs.existsSync(configPath)) {
      throw new Error(`MAOS config not found at ${configPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      schemaVersion: 1,
      projectName: raw.projectName ?? '',
      profile: raw.profile
        ? {
            id: raw.profile.id ?? '',
            displayName: raw.profile.displayName ?? '',
            mode: raw.profile.mode ?? 'cloud',
            zeroCloud: raw.profile.zeroCloud ?? false,
            evidenceRoot: raw.profile.evidenceRoot ?? '',
          }
        : undefined,
      routingMode: raw.routingMode ?? 'auto',
      providers: raw.providers ?? {},
      agents: raw.agents ?? [],
      routing: raw.routing ?? {
        strategy: 'capability_score',
        costWeight: 0.2,
        capabilityWeight: 0.8,
        maxParallelAgents: 4,
        fallbackProvider: '',
      },
    };
  }

  /**
   * Return provider configurations.
   */
  getProviders(): Record<string, ProviderEntry> {
    return this.loadConfig().providers;
  }

  /**
   * Return agent configurations.
   */
  getAgents(): AgentEntry[] {
    return this.loadConfig().agents;
  }

  /**
   * Return profile configuration, or undefined if none.
   */
  getProfile(): ProfileConfig | undefined {
    return this.loadConfig().profile;
  }

  /**
   * Check if the project is using the industrial profile.
   */
  isIndustrialProfile(): boolean {
    const profile = this.getProfile();
    return profile?.id === 'industrial' || profile?.mode === 'sovereign-local';
  }

  /**
   * Get project settings from .maos/settings/basic-settings.json, merged with
   * legacy .maos/settings.json and project configuration.
   */
  getSettings(projectId?: string): Record<string, unknown> & BasicSettings {
    const resolvedProjectId = projectId || getOrGenerateProjectId(this.projectRoot);
    const basic = this.settingsStore.loadSettings(resolvedProjectId);

    let legacy: Record<string, unknown> = {};
    const legacyPath = path.join(this.projectRoot, '.maos', 'settings.json');
    if (fs.existsSync(legacyPath)) {
      try {
        legacy = sanitizeLegacySettings(JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))) as Record<string, unknown>;
      } catch {}
    }

    let config: Project | undefined;
    try {
      config = this.loadConfig();
    } catch {}

    const projectName =
      (legacy.projectName as string) ||
      config?.projectName ||
      path.basename(this.projectRoot);

    return {
      // Legacy compatibility fields
      projectName,
      routingMode: (legacy.routingMode as string) || config?.routingMode || 'auto',
      routing: legacy.routing || config?.routing || {
        strategy: 'capability_score',
        costWeight: 0.2,
        capabilityWeight: 0.8,
        maxParallelAgents: 4,
        fallbackProvider: '',
      },
      zeroCloud: legacy.zeroCloud ?? config?.profile?.zeroCloud ?? false,
      retentionDays: (legacy.retentionDays as number) ?? basic.retention.conversationDays,
      redactSecrets: (legacy.redactSecrets as boolean) ?? basic.retention.redactSensitivePreviews,
      logLevel: (legacy.logLevel as string) || 'info',
      ...legacy,
      // Authoritative basic settings
      schemaVersion: 1,
      projectId: resolvedProjectId,
      retention: basic.retention,
      runtime: basic.runtime,
      accessibility: basic.accessibility,
      updatedAt: basic.updatedAt,
    };
  }

  /**
   * Update project settings atomically with rigorous bounds validation.
   */
  updateSettings(patch: Record<string, unknown>, projectId?: string): Record<string, unknown> & BasicSettings {
    const resolvedProjectId = projectId || getOrGenerateProjectId(this.projectRoot);
    const current = this.getSettings(resolvedProjectId);

    if (patch.schemaVersion !== undefined && patch.schemaVersion !== 1) {
      throw new Error('INVALID_BASIC_SETTINGS: schemaVersion must be 1');
    }

    // Merge nested and flat patches safely
    const currentBasic = this.settingsStore.loadSettings(resolvedProjectId);
    const candidatePatch: Record<string, unknown> = {
      retention: { ...currentBasic.retention },
      runtime: { ...currentBasic.runtime },
      accessibility: { ...currentBasic.accessibility },
    };

    if (patch.retention && typeof patch.retention === 'object' && !Array.isArray(patch.retention)) {
      candidatePatch.retention = {
        ...(candidatePatch.retention as object),
        ...(patch.retention as object),
      };
    }
    if (patch.runtime && typeof patch.runtime === 'object' && !Array.isArray(patch.runtime)) {
      candidatePatch.runtime = {
        ...(candidatePatch.runtime as object),
        ...(patch.runtime as object),
      };
    }
    if (patch.accessibility && typeof patch.accessibility === 'object' && !Array.isArray(patch.accessibility)) {
      candidatePatch.accessibility = {
        ...(candidatePatch.accessibility as object),
        ...(patch.accessibility as object),
      };
    }

    // Flat compatibility mappings
    const retObj = candidatePatch.retention as Record<string, unknown>;
    const runObj = candidatePatch.runtime as Record<string, unknown>;
    const accObj = candidatePatch.accessibility as Record<string, unknown>;

    if (patch.conversationDays !== undefined) retObj.conversationDays = patch.conversationDays;
    if (patch.eventDisplayDays !== undefined) retObj.eventDisplayDays = patch.eventDisplayDays;
    if (patch.artifactPreviewDays !== undefined) retObj.artifactPreviewDays = patch.artifactPreviewDays;
    if (patch.redactSensitivePreviews !== undefined) retObj.redactSensitivePreviews = patch.redactSensitivePreviews;
    if (patch.redactSecrets !== undefined) retObj.redactSensitivePreviews = patch.redactSecrets;
    if (patch.allowRawEvidencePreviews !== undefined) retObj.allowRawEvidencePreviews = patch.allowRawEvidencePreviews;

    if (patch.modelUnloadAfterSeconds !== undefined) runObj.modelUnloadAfterSeconds = patch.modelUnloadAfterSeconds;
    if (patch.serviceStopAfterSeconds !== undefined) runObj.serviceStopAfterSeconds = patch.serviceStopAfterSeconds;
    if (patch.stopMode !== undefined) runObj.stopMode = patch.stopMode;

    if (patch.theme !== undefined) accObj.theme = patch.theme;
    if (patch.reducedMotion !== undefined) accObj.reducedMotion = patch.reducedMotion;
    if (patch.fontScale !== undefined) accObj.fontScale = patch.fontScale;
    if (patch.density !== undefined) accObj.density = patch.density;

    const validation = validateBasicSettings(
      {
        schemaVersion: 1,
        projectId: resolvedProjectId,
        retention: retObj,
        runtime: runObj,
        accessibility: accObj,
      },
      resolvedProjectId,
    );

    if (!validation.valid || !validation.settings) {
      throw new Error(`INVALID_BASIC_SETTINGS: ${validation.errors?.join('; ') || 'Validation failed'}`);
    }

    // Save basic settings atomically
    this.settingsStore.saveSettings(validation.settings);

    // Save legacy custom properties to .maos/settings.json
    const maosDir = path.join(this.projectRoot, '.maos');
    if (!fs.existsSync(maosDir)) {
      fs.mkdirSync(maosDir, { recursive: true });
    }
    const legacyPath = path.join(maosDir, 'settings.json');
    let legacyObj: Record<string, unknown> = {};
    if (fs.existsSync(legacyPath)) {
      try {
        legacyObj = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      } catch {}
    }

    const updatedLegacy = sanitizeLegacySettings({
      ...legacyObj,
      ...patch,
      retentionDays: validation.settings.retention.conversationDays,
      redactSecrets: validation.settings.retention.redactSensitivePreviews,
    }) as Record<string, unknown>;

    fs.writeFileSync(legacyPath, JSON.stringify(updatedLegacy, null, 2), 'utf-8');

    return this.getSettings(resolvedProjectId);
  }

  /**
   * Reset settings to canonical defaults for this project.
   */
  resetSettings(projectId?: string): Record<string, unknown> & BasicSettings {
    const resolvedProjectId = projectId || getOrGenerateProjectId(this.projectRoot);
    this.settingsStore.resetSettings(resolvedProjectId);
    return this.getSettings(resolvedProjectId);
  }

  /**
   * Safely stop or force-stop the project service.
   * Force stop requires explicit confirmation to prevent accidental disruption.
   */
  stopService(options: StopServiceOptions): StopServiceResult {
    if (options.mode === 'force') {
      if (options.confirm !== true) {
        throw new Error('CONFIRMATION_REQUIRED: Force stop requires explicit user confirmation.');
      }

      // 1. Mark active tasks as INTERRUPTED (prevents phantom success)
      const taskService = this.deps.taskService || new TaskService(this.projectRoot);
      const interruptedTasks = taskService.interruptActiveTasks(
        options.reason || 'Service force-stopped with user confirmation',
      );

      // 2. Clean up unfinalized partial artifacts (.tmp_*)
      const artifactService = this.deps.artifactService || new ArtifactService(this.projectRoot);
      const cleanedTempArtifacts = artifactService.cleanupOrphanTempFiles(0);

      // 3. Unload model leases
      const modelService = this.deps.modelService || new ModelService(this.projectRoot);
      const unloadedModels = modelService.releaseAllLeases();

      // 4. Record tamper-evident audit event before reporting success. A force
      // stop without durable provenance is not a trustworthy completed stop.
      try {
        const auditService = this.deps.auditService || new AuditService(this.projectRoot);
        auditService.recordAuditEvent({
          category: 'interruption',
          source: 'project-service',
          data: {
            event: 'SERVICE_FORCE_STOPPED',
            reason: options.reason || 'Service force-stopped with user confirmation',
            interruptedTasksCount: interruptedTasks.length,
            cleanedTempArtifacts,
            unloadedModels,
          },
        });
      } catch (err: any) {
        throw new Error(`AUDIT_PERSISTENCE_FAILED: Force-stop was not acknowledged because the interruption audit could not be persisted: ${err?.message || String(err)}`);
      }

      return {
        status: 'stopped',
        mode: 'force',
        interruptedTasksCount: interruptedTasks.length,
        cleanedTempArtifacts,
        unloadedModels,
        timestamp: new Date().toISOString(),
      };
    }

    if (options.mode === 'after-current-tasks') {
      const taskService = this.deps.taskService || new TaskService(this.projectRoot);
      const activeTasks = taskService.listTasks({ status: 'active' });

      return {
        status: activeTasks.length > 0 ? 'stopping_after_tasks' : 'stopped',
        mode: 'after-current-tasks',
        activeTasksCount: activeTasks.length,
        timestamp: new Date().toISOString(),
      };
    }

    throw new Error('INVALID_STOP_MODE: Mode must be "after-current-tasks" or "force".');
  }

  /**
   * Get sovereignty and security status.
   */
  getSovereigntyStatus(): Record<string, unknown> {
    let config: Project;
    try {
      config = this.loadConfig();
    } catch {
      return {
        zeroCloud: false,
        profileMode: 'cloud',
        allLocalProviders: false,
        loopbackEnforced: true,
        networkIsolation: 'unverified',
      };
    }

    const providers = Object.values(config.providers);
    const allLocal =
      providers.length > 0 &&
      providers.every((p) => {
        const url = p.baseURL || '';
        return url.includes('127.0.0.1') || url.includes('localhost') || url.includes('::1');
      });

    return {
      zeroCloud: config.profile?.zeroCloud ?? allLocal,
      profileMode: config.profile?.mode ?? (allLocal ? 'sovereign-local' : 'cloud'),
      allLocalProviders: allLocal,
      loopbackEnforced: true,
      evidenceRoot: config.profile?.evidenceRoot || 'artifacts/verification',
      status: allLocal ? 'SOVEREIGN_LOCAL' : 'REMOTE_OR_MIXED',
    };
  }

  /**
   * Local Endpoint & Sovereignty Visibility.
   * Strictly avoids exposing session tokens, token hashes, API keys, or raw secrets.
   */
  getSovereigntyVisibility(identity?: ServiceInstanceIdentity): {
    loopbackEndpoint: string;
    instanceIdRedacted: string;
    modelInfo: { residentModels: string[]; totalConfigured: number };
    rustEngineHealth: boolean;
    sovereigntyStatus: Record<string, unknown>;
    projectRoot: string;
    canonicalPath: string;
  } {
    const activeIdentity = identity || readServiceIdentity(this.projectRoot);
    const loopbackHost = activeIdentity?.host || '127.0.0.1';
    const loopbackPort = activeIdentity?.servicePort || 0;
    const loopbackEndpoint = loopbackPort ? `http://${loopbackHost}:${loopbackPort}` : `http://${loopbackHost}`;

    const instanceIdRaw = activeIdentity?.serviceInstanceId || 'unknown';
    const instanceIdRedacted =
      instanceIdRaw.length > 8 ? `${instanceIdRaw.substring(0, 8)}...` : instanceIdRaw;

    const modelService = this.deps.modelService || new ModelService(this.projectRoot);
    const models = modelService.listModels();
    const residency = modelService.getModelResidencyStatus();

    const enginePath = getDefaultEnginePath(this.projectRoot);
    let rustEngineHealth = false;
    if (fs.existsSync(enginePath)) {
      try {
        const manifest = verifyExecutable(enginePath);
        rustEngineHealth = Boolean(manifest.executableHash);
      } catch {}
    }

    const sovereigntyStatus = this.getSovereigntyStatus();

    return {
      loopbackEndpoint,
      instanceIdRedacted,
      modelInfo: {
        residentModels: residency.residentModels,
        totalConfigured: models.length,
      },
      rustEngineHealth,
      sovereigntyStatus,
      projectRoot: this.projectRoot,
      canonicalPath: path.resolve(this.projectRoot),
    };
  }
}
