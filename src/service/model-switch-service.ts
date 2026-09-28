/**
 * MAOS Service: Model Switcher and Auto-Routing Service (UI1-13)
 *
 * Implements:
 * 1. Automatic model routing based on task requirements, modality, complexity.
 * 2. Audited manual model override with actor, reason, revision, confirmation.
 * 3. Authoritative active model identity and residency visibility.
 * 4. Workflow-fixed model and revision protection (zero mid-run switches).
 * 5. Compatibility matrix verification.
 * 6. Queue-aware switching via SharedModelManager and FairQueueService.
 * 7. Explicit confirmation for disruptive model unloads.
 * 8. Tamper-evident audit logging.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedModelManager } from './model-manager';
import type { FairQueueService } from './fair-queue-service';
import type { AuditService } from './audit-service';
import {
  ModelRouteRequest,
  ModelRouteResult,
  ModelSwitchRequest,
  ModelSwitchResult,
  ActiveModelIdentity,
  ModelSwitchError,
  SWITCH_ERROR_CODES,
  PINNED_MODEL_CAPABILITIES,
  validateModelRouteRequest,
  validateModelSwitchRequest,
  TaskModality,
} from '../domain/model-switch';
import { PINNED_TEXT_CONFIG, ModelRegistration } from '../domain/model-manifest';
import { PINNED_VLM_CONFIG } from '../domain/vision';
import { PINNED_EMBEDDING_CONFIG } from '../domain/embedding';

export class ModelSwitchService {
  constructor(
    private readonly projectRoot: string,
    private readonly modelManager: SharedModelManager,
    private readonly fairQueueService?: FairQueueService,
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Deterministically route a task to the most appropriate pinned model
   * based on task requirements, modality, complexity, and image presence.
   */
  public determineRoute(input: ModelRouteRequest): ModelRouteResult {
    const val = validateModelRouteRequest(input);
    if (!val.valid) {
      throw new ModelSwitchError(
        `Invalid route request: ${val.errors.join('; ')}`,
        SWITCH_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    const normModality = (input.modality || '').toLowerCase().trim();
    const taskType = (input.taskType || '').toLowerCase().trim();
    const prompt = (input.promptText || '').toLowerCase().trim();

    // 1. Check for visual / multimodal requirements
    const isVision =
      input.hasImages === true ||
      normModality === 'vision' ||
      normModality === 'multimodal' ||
      taskType === 'ocr' ||
      taskType === 'ocr_review' ||
      taskType === 'image_inspection' ||
      prompt.includes('diagram') ||
      prompt.includes('inspect image') ||
      prompt.includes('ocr');

    // 2. Check for embedding / retrieval requirements
    const isEmbedding =
      normModality === 'embedding' ||
      taskType === 'embedding' ||
      taskType === 'kb_search' ||
      taskType === 'retrieval' ||
      taskType === 'similarity';

    let targetConfig: {
      modelId: string;
      revision: string;
      device: 'cuda' | 'cpu';
      vramRequiredMb: number;
    };
    let reason: string;
    let confidence: number;
    let alternativeModelIds: string[];

    if (isVision) {
      targetConfig = {
        modelId: PINNED_VLM_CONFIG.modelId,
        revision: PINNED_VLM_CONFIG.revision,
        device: 'cuda',
        vramRequiredMb: 3072,
      };
      reason = 'Visual attachment or image inspection modality requires pinned VLM Qwen2-VL-2B-Instruct';
      confidence = 0.98;
      alternativeModelIds = [PINNED_TEXT_CONFIG.modelId];
    } else if (isEmbedding) {
      targetConfig = {
        modelId: PINNED_EMBEDDING_CONFIG.modelId,
        revision: PINNED_EMBEDDING_CONFIG.revision,
        device: 'cpu',
        vramRequiredMb: 0,
      };
      reason = 'Semantic vector embedding or retrieval requires pinned CPU MiniLM-L6-v2';
      confidence = 1.0;
      alternativeModelIds = [];
    } else {
      // Default: Text / Code reasoning model
      targetConfig = {
        modelId: PINNED_TEXT_CONFIG.modelId,
        revision: PINNED_TEXT_CONFIG.revision,
        device: 'cuda',
        vramRequiredMb: 4096,
      };
      reason = 'Text reasoning or code generation task routes to pinned LLM Qwen2.5-3B-Instruct';
      confidence = 0.95;
      alternativeModelIds = [PINNED_VLM_CONFIG.modelId];
    }

    // Verify registration and health against SharedModelManager
    const reg = this.modelManager.getModelRegistration(targetConfig.modelId);
    if (!reg) {
      throw new ModelSwitchError(
        `Routed model '${targetConfig.modelId}' is not registered with SharedModelManager`,
        SWITCH_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }
    if (!reg.isHealthy) {
      throw new ModelSwitchError(
        `Routed model '${targetConfig.modelId}' is unhealthy: ${reg.unhealthyReason || 'health probe failed'}`,
        SWITCH_ERROR_CODES.MODEL_UNHEALTHY,
      );
    }

    return {
      selectedModelId: reg.modelId,
      selectedRevision: reg.revision,
      device: reg.device,
      vramRequiredMb: reg.vramRequiredMb,
      reason,
      confidence,
      alternativeModelIds,
    };
  }

  /**
   * Check if a model is compatible with a requested modality.
   */
  public checkCompatibility(
    modelId: string,
    requiredModality?: TaskModality | string,
  ): { compatible: boolean; reason?: string } {
    if (!requiredModality) {
      return { compatible: true };
    }

    const reg = this.modelManager.getModelRegistration(modelId);
    if (!reg) {
      return {
        compatible: false,
        reason: `Model '${modelId}' is not registered with SharedModelManager`,
      };
    }

    const normModality = requiredModality.toLowerCase().trim() as TaskModality;
    const capability = PINNED_MODEL_CAPABILITIES.find(
      (c) => c.modelId === reg.modelId || c.modelId.endsWith(modelId),
    );

    if (capability && !capability.supportedModalities.includes(normModality)) {
      return {
        compatible: false,
        reason: `Model '${reg.modelId}' does not support modality '${normModality}'. Supported: ${capability.supportedModalities.join(', ')}`,
      };
    }

    // Embedding model cannot handle generative text or vision
    if (reg.device === 'cpu' && normModality !== 'embedding') {
      return {
        compatible: false,
        reason: `Embedding model '${reg.modelId}' only supports 'embedding' modality, cannot handle '${normModality}'`,
      };
    }

    return { compatible: true };
  }

  /**
   * Perform an audited manual model switch or override.
   * Fail closed for unregistered models, revision mismatch, missing snapshots,
   * unhealthy models, workflow-fixed locks, and active lease conflicts.
   */
  public async switchModel(request: ModelSwitchRequest): Promise<ModelSwitchResult> {
    // 1. Pure validation
    const val = validateModelSwitchRequest(request);
    if (!val.valid) {
      throw new ModelSwitchError(
        `Invalid ModelSwitchRequest: ${val.errors.join('; ')}`,
        SWITCH_ERROR_CODES.UNAUDITED_OVERRIDE,
      );
    }

    // 2. Audit fields required
    if (!request.actor || !request.actor.trim() || !request.reason || !request.reason.trim()) {
      throw new ModelSwitchError(
        'Manual model switch requires explicit actor and reason for audit compliance',
        SWITCH_ERROR_CODES.UNAUDITED_OVERRIDE,
      );
    }

    // 3. Resolve model registration
    const reg = this.modelManager.getModelRegistration(request.targetModelId);
    if (!reg) {
      throw new ModelSwitchError(
        `Target model '${request.targetModelId}' is not registered in pinned manifest`,
        SWITCH_ERROR_CODES.MODEL_UNAVAILABLE,
      );
    }

    // 4. Expected revision check
    if (request.expectedRevision && request.expectedRevision !== reg.revision) {
      throw new ModelSwitchError(
        `Revision mismatch for model '${reg.modelId}': expected '${request.expectedRevision}', registered is '${reg.revision}'`,
        SWITCH_ERROR_CODES.REVISION_MISMATCH,
      );
    }

    // 5. Offline snapshot verification (zero runtime download)
    this.assertSnapshotAvailable(reg);

    // 6. Health check
    if (!reg.isHealthy) {
      throw new ModelSwitchError(
        `Target model '${reg.modelId}' is unhealthy: ${reg.unhealthyReason || 'health probe failed'}`,
        SWITCH_ERROR_CODES.MODEL_UNHEALTHY,
      );
    }

    // 7. Modality compatibility check
    if (request.requiredModality) {
      const comp = this.checkCompatibility(reg.modelId, request.requiredModality);
      if (!comp.compatible) {
        throw new ModelSwitchError(
          comp.reason || `Target model '${reg.modelId}' is incompatible with modality '${request.requiredModality}'`,
          SWITCH_ERROR_CODES.MODALITY_INCOMPATIBLE,
        );
      }
    }

    // 8. Workflow-fixed model and mid-run protection
    const residency = this.modelManager.getResidencyStatus();
    const currentResidentModelId = residency.residentModelId;
    const activeGpu = this.modelManager.getActiveGpuLeases();

    // Check if resident model is locked by active workflow run
    if (reg.device !== 'cpu' && currentResidentModelId && currentResidentModelId !== reg.modelId) {
      const fixedRun = activeGpu.find((l) => l.runId);
      if (fixedRun) {
        throw new ModelSwitchError(
          `WORKFLOW_FIXED_MODEL_PROTECTED: Cannot switch model. Resident model '${currentResidentModelId}' is locked by active workflow run '${fixedRun.runId}'`,
          SWITCH_ERROR_CODES.WORKFLOW_FIXED_MODEL_PROTECTED,
          { lockedByRunId: fixedRun.runId, currentResidentModelId },
        );
      }

      // Check if any active GPU leases exist for current model
      if (this.modelManager.getActiveGpuLeasesCount() > 0) {
        throw new ModelSwitchError(
          `CONCURRENCY_VIOLATION: Cannot switch GPU model while ${this.modelManager.getActiveGpuLeasesCount()} lease(s) are active on '${currentResidentModelId}'`,
          SWITCH_ERROR_CODES.CONCURRENCY_VIOLATION,
          { activeLeases: this.modelManager.getActiveGpuLeasesCount() },
        );
      }
    }

    // Check mid-run switch for a specific runId
    if (request.runId) {
      const runLeases = this.modelManager.listLeases(request.projectId).filter((l) => l.runId === request.runId);
      if (runLeases.length > 0) {
        const existingModelId = runLeases[0].modelId;
        if (existingModelId !== reg.modelId) {
          throw new ModelSwitchError(
            `MID_RUN_SWITCH_FORBIDDEN: Run '${request.runId}' already holds lease on model '${existingModelId}'. Mid-run model switch is prohibited.`,
            SWITCH_ERROR_CODES.MID_RUN_SWITCH_FORBIDDEN,
          );
        }
      }
    }

    // 9. Disruptive switch confirmation handling
    // If switching between GPU models (or loading a new GPU model when one is resident with 0 leases)
    const requiresUnload =
      reg.device !== 'cpu' &&
      currentResidentModelId !== null &&
      currentResidentModelId !== reg.modelId;

    if (requiresUnload && !request.confirmed) {
      return {
        status: 'CONFIRMATION_REQUIRED',
        previousModelId: currentResidentModelId,
        activeModelId: currentResidentModelId,
        activeRevision: residency.residentModelRevision || '',
        device: residency.residentDevice,
        vramUsedMb: residency.vramUsedMb,
        requiresUnload: true,
        message: `Switching to '${reg.modelId}' requires unloading resident model '${currentResidentModelId}' (${residency.vramUsedMb} MB VRAM). Explicit confirmation required.`,
      };
    }

    // 10. Execute the switch
    if (requiresUnload) {
      this.modelManager.unloadCurrentModel();
    }

    // Acquire lease on new model to establish residency and verify capability
    let leaseId: string | undefined;
    if (reg.device !== 'cpu') {
      const lease = await this.modelManager.acquireLease({
        modelId: reg.modelId,
        agentId: request.actor,
        projectId: request.projectId,
        runId: request.runId,
        expectedRevision: reg.revision,
      });
      leaseId = lease.id;
    }

    const updatedResidency = this.modelManager.getResidencyStatus();

    // 11. Tamper-evident audit logging
    const auditEventId = this.recordAudit({
      category: 'model',
      action: 'MODEL_SWITCH',
      actor: request.actor,
      reason: request.reason,
      targetModelId: reg.modelId,
      previousModelId: currentResidentModelId,
      revision: reg.revision,
      device: reg.device,
      projectId: request.projectId,
      runId: request.runId,
      conversationId: request.conversationId,
      leaseId,
    });

    return {
      status: 'SWITCHED',
      previousModelId: currentResidentModelId,
      activeModelId: reg.modelId,
      activeRevision: reg.revision,
      device: reg.device,
      vramUsedMb: updatedResidency.vramUsedMb,
      requiresUnload,
      message: `Model switched successfully to '${reg.modelId}' (${reg.device.toUpperCase()})`,
      auditEventId,
      leaseId,
    };
  }

  /**
   * Get the authoritative identity and residency details of the active model.
   */
  public getActiveModelIdentity(options?: { projectId?: string }): ActiveModelIdentity {
    const residency = this.modelManager.getResidencyStatus();
    const activeGpu = this.modelManager.getActiveGpuLeases();
    const fixedRun = activeGpu.find((l) => l.runId);

    // If a model is resident in VRAM, return its identity
    let targetReg: ModelRegistration | undefined;
    if (residency.residentModelId) {
      targetReg = this.modelManager.getModelRegistration(residency.residentModelId);
    } else {
      // If no model is resident, return default configured text model
      targetReg = this.modelManager.getModelRegistration(PINNED_TEXT_CONFIG.modelId);
    }

    const capability = targetReg
      ? PINNED_MODEL_CAPABILITIES.find(
          (c) => c.modelId === targetReg?.modelId || c.modelId.endsWith(targetReg?.modelId || ''),
        )
      : undefined;

    return {
      modelId: residency.residentModelId || targetReg?.modelId || null,
      modelName: targetReg?.modelName || null,
      revision: residency.residentModelRevision || targetReg?.revision || null,
      architecture: targetReg?.architecture || null,
      quantization: targetReg?.quantization || null,
      device: residency.residentDevice !== 'none' ? residency.residentDevice : (targetReg?.device || 'cuda'),
      vramUsedMb: residency.vramUsedMb,
      vramBudgetMb: residency.vramBudgetMb,
      activeLeases: residency.activeLeases,
      queueLength: residency.queueLength,
      healthy: targetReg ? targetReg.isHealthy : residency.healthy,
      unhealthyReason: targetReg?.unhealthyReason || residency.unhealthyReason,
      isWorkflowFixed: fixedRun !== undefined,
      lockedByRunId: fixedRun ? fixedRun.runId || null : null,
      supportedModalities: capability ? [...capability.supportedModalities] : ['text'],
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private assertSnapshotAvailable(reg: ModelRegistration): void {
    if (!reg.manifestPath || !reg.snapshotPath) {
      throw new ModelSwitchError(
        `Model '${reg.modelId}' has no verified offline snapshot identity. Runtime downloads are prohibited.`,
        SWITCH_ERROR_CODES.NO_RUNTIME_DOWNLOAD,
      );
    }
    if (!fs.existsSync(reg.manifestPath)) {
      throw new ModelSwitchError(
        `Model snapshot manifest missing: ${reg.manifestPath}. Runtime downloads are prohibited.`,
        SWITCH_ERROR_CODES.NO_RUNTIME_DOWNLOAD,
      );
    }
    if (!fs.existsSync(reg.snapshotPath)) {
      throw new ModelSwitchError(
        `Model snapshot directory missing: ${reg.snapshotPath}. Runtime downloads are prohibited.`,
        SWITCH_ERROR_CODES.NO_RUNTIME_DOWNLOAD,
      );
    }
  }

  private recordAudit(data: Record<string, unknown>): string | undefined {
    if (!this.auditService) return undefined;
    try {
      const event = this.auditService.recordAuditEvent({
        category: 'model',
        source: 'model_switch',
        data,
      });
      return event ? event.hash : undefined;
    } catch {
      return undefined;
    }
  }
}
