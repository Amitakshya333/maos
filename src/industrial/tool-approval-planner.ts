/**
 * MAOS Industrial — Tool and Approval Planner (F7-04)
 *
 * Implements deterministic execution contract generation and pre-execution
 * fail-closed security enforcement:
 * 1. Derives tamper-evident ToolExecutionPlan contracts from WorkflowPlan steps.
 * 2. Models 5 explicit approval categories:
 *    - NO_APPROVAL_REQUIRED
 *    - HUMAN_REVIEW_REQUIRED
 *    - EXPLICIT_APPROVAL_REQUIRED
 *    - SAFETY_CRITICAL_APPROVAL_REQUIRED
 *    - FINAL_ARTIFACT_APPROVAL_REQUIRED
 * 3. Enforces pre-execution verification gates:
 *    - Authorized agent validation
 *    - Allowed & forbidden tools enforcement
 *    - Missing, rejected, tampered, or stale approvals
 *    - Mandatory human review sign-off
 *    - Quarantined, modified, or missing artifacts
 *    - Cross-project artifact boundary isolation
 *    - Model revision pinning
 *    - Non-degradation modality checks
 *    - Upstream DAG dependency completion
 *    - Durable idempotency claims and conflict detection
 *    - Output schema conformance
 *    - Prompt-injection elevation neutralization
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { WorkflowPlan, WorkflowPlanStep, WorkflowStepStatus } from '../domain/workflow-plan';
import type { TaskRequirements, AgentProfile } from '../core/router';
import type { Approval } from '../domain/schemas';
import type {
  ToolExecutionPlan,
  ApprovalCategory,
  HumanReviewGate,
  ApprovalGate,
  ResourceBounds,
  AuditRequirement,
  PreExecutionEvaluationOutcome,
  ToolExecutionErrorCode,
} from '../domain/tool-plan';
import { computeCanonicalContractHash } from '../domain/tool-plan';
import { validateToolExecutionPlan } from '../domain/validators';
import { DurableIdempotencyStore } from '../core/idempotency-store';
import { SYSTEM_PLATFORM_TOOLS } from './workflow-planner';

export interface ToolContractCreationOptions {
  readonly timeoutMs?: number;
  readonly resourceBounds?: ResourceBounds;
  readonly requiredReviewerRole?: string;
  readonly safetyCritical?: boolean;
}

export interface ToolPreExecutionContext {
  readonly projectRoot: string;
  readonly executingAgent: AgentProfile;
  readonly requestedTool: string;
  readonly inputArgs: Record<string, unknown>;
  readonly taskAllowedTools?: readonly string[];
  readonly taskForbiddenTools?: readonly string[];
  readonly approvalRecord?: Approval | null;
  readonly humanReviewSignOff?: {
    readonly reviewerId: string;
    readonly reviewerRole: string;
    readonly signedAt: string;
    readonly verdict: 'APPROVED' | 'REJECTED';
    readonly notes?: string;
  } | null;
  readonly diskArtifacts?: ReadonlyArray<{
    readonly artifactId: string;
    readonly relativePath: string;
    readonly expectedHash?: string;
    readonly isQuarantined?: boolean;
    readonly projectId?: string;
  }>;
  readonly completedStepIds?: readonly string[];
  readonly dependencyStatuses?: Record<string, WorkflowStepStatus>;
  readonly idempotencyStore?: DurableIdempotencyStore;
  readonly promptProse?: string;
  readonly untrustedInputs?: Record<string, string>;
}

export class ToolApprovalPlanner {
  /**
   * Creates a deterministic, tamper-evident ToolExecutionPlan for a workflow step.
   */
  public createExecutionContract(
    step: WorkflowPlanStep,
    plan: WorkflowPlan,
    options: ToolContractCreationOptions = {},
  ): ToolExecutionPlan {
    const contractId = `contract_${plan.planId}_${step.stepId}`;

    // 1. Determine the principal allowed tool
    const allowedTool = this.resolvePrincipalTool(step);

    // Reject host executor in industrial mode
    if (allowedTool === 'execute_python' || step.requiredTools.includes('execute_python')) {
      throw new Error(
        `HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL: Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.`,
      );
    }

    // 2. Derive approval category and human-review requirements deterministically
    const { approvalRequirement, humanReviewRequirement, humanReviewGate, approvalGate } =
      this.deriveApprovalRequirements(step, plan, allowedTool, options);

    // 3. Collect input artifact IDs and source hashes
    const inputArtifactIds = step.inputs.artifactTypes ? [...step.inputs.artifactTypes] : [];
    const sourceHashes = plan.provenance.sourceHashes ? [...plan.provenance.sourceHashes] : [];

    // 4. Generate deterministic idempotency key
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(
        `${plan.provenance.projectId}:${plan.provenance.taskId}:${step.stepId}:${allowedTool}:${sourceHashes.join(',')}`,
      )
      .digest('hex');

    // 5. Establish resource bounds and timeouts
    const timeoutMs = options.timeoutMs ?? 30_000;
    const resourceBounds: ResourceBounds = {
      maxMemoryMb: options.resourceBounds?.maxMemoryMb ?? 2048,
      maxFileSizeBytes: options.resourceBounds?.maxFileSizeBytes ?? 50 * 1024 * 1024,
      maxExecutionTimeMs: options.resourceBounds?.maxExecutionTimeMs ?? timeoutMs,
    };

    // 6. Define audit requirement
    const auditRequirement: AuditRequirement = {
      eventType: 'TOOL_EXECUTION',
      requiredFields: ['contractId', 'toolName', 'agentId', 'idempotencyKey', 'status'],
    };

    // 7. Expected output type
    const expectedOutputType =
      step.outputs.expectedArtifactTypes && step.outputs.expectedArtifactTypes.length > 0
        ? step.outputs.expectedArtifactTypes[0]
        : 'report';

    // 8. Required modalities and model revision from plan requirements
    const requiredModalities = plan.requirements.modalities || ['text'];
    const requiredModel = plan.requirements.model?.modelFamily;
    const requiredRevision = plan.requirements.model?.requiredRevision;

    const draftContract: Omit<ToolExecutionPlan, 'contractHash'> = {
      schemaVersion: 1,
      contractId,
      workflowPlanId: plan.planId,
      stepId: step.stepId,
      stepType: step.stepType,
      projectId: plan.provenance.projectId,
      taskId: plan.provenance.taskId,
      runId: plan.provenance.runId,
      authorizedAgent: step.assignedAgentId,
      allowedTool,
      requiredModel,
      requiredRevision,
      requiredModalities,
      inputArtifactIds,
      sourceHashes,
      approvalRequirement,
      humanReviewRequirement,
      humanReviewGate,
      approvalGate,
      expectedOutputType,
      idempotencyKey,
      timeoutMs,
      resourceBounds,
      auditRequirement,
    };

    const contractHash = computeCanonicalContractHash(draftContract);

    const completeContract: ToolExecutionPlan = {
      ...draftContract,
      contractHash,
    };

    // Validate contract before returning
    const validation = validateToolExecutionPlan(completeContract);
    if (!validation.valid) {
      throw new Error(`Constructed invalid ToolExecutionPlan: ${validation.errors.join('; ')}`);
    }

    return completeContract;
  }

  /**
   * Pre-execution enforcement gate: verifies all security, tool, agent, model,
   * artifact, and approval constraints before tool execution is allowed to proceed.
   */
  public evaluatePreExecution(
    contract: ToolExecutionPlan,
    context: ToolPreExecutionContext,
  ): PreExecutionEvaluationOutcome {
    // ── 1. Prompt Injection Defense Gate (Multi-Surface) ────────
    const proseToCheck: string[] = [];
    if (context.promptProse) proseToCheck.push(context.promptProse);
    if (context.untrustedInputs) {
      for (const val of Object.values(context.untrustedInputs)) {
        if (typeof val === 'string') proseToCheck.push(val);
      }
    }
    for (const val of Object.values(context.inputArgs || {})) {
      if (typeof val === 'string') proseToCheck.push(val);
    }

    const APPROVAL_BYPASS_PATTERNS = [
      'ignore approval',
      'skip approval',
      'bypass approval',
      'override approval',
      'skip human review',
      'bypass human review',
      'bypass human approval',
      'skip human approval',
      'without approval',
      'no approval required',
      'auto approve',
      'force approve',
      'approval not needed',
    ];

    const TOOL_ESCALATION_PATTERNS = [
      'run bash instead',
      'elevate tool',
      'format disk',
      'grant all tools',
      'execute bash',
      'system override',
      'escalate privileges',
      'run shell',
      'execute command',
    ];

    for (const prose of proseToCheck) {
      const lower = prose.toLowerCase();
      if (contract.approvalRequirement !== 'NO_APPROVAL_REQUIRED') {
        for (const pattern of APPROVAL_BYPASS_PATTERNS) {
          if (lower.includes(pattern)) {
            return {
              success: false,
              code: 'PROMPT_INJECTION_REJECTED',
              reason: `Adversarial instruction attempting to bypass mandatory approval gate was detected and blocked: "${pattern}".`,
              details: { contractId: contract.contractId, pattern },
            };
          }
        }
      }

      if (contract.allowedTool !== 'bash') {
        for (const pattern of TOOL_ESCALATION_PATTERNS) {
          if (lower.includes(pattern)) {
            return {
              success: false,
              code: 'PROMPT_INJECTION_REJECTED',
              reason: `Adversarial instruction attempting unauthorized tool privilege escalation was detected and blocked: "${pattern}".`,
              details: { contractId: contract.contractId, pattern },
            };
          }
        }
      }

      const HOST_EXECUTOR_PATTERNS = [
        'run on host',
        'execute on host',
        'host executor',
        'use host python',
        'run host python',
        'executortype: host',
        'executor: host',
        'execute_python',
        'bypass container',
        'escape sandbox',
      ];
      for (const pattern of HOST_EXECUTOR_PATTERNS) {
        if (lower.includes(pattern)) {
          return {
            success: false,
            code: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
            reason: `Prompt/tool escalation attempting to select a host executor was detected and blocked: "${pattern}".`,
            details: { contractId: contract.contractId, pattern },
          };
        }
      }
    }

    // ── 1b. Path Traversal Defense Gate ─────────────────────────
    if (context.diskArtifacts) {
      for (const art of context.diskArtifacts) {
        if (art.relativePath && (art.relativePath.includes('..') || art.relativePath.includes('\0'))) {
          return {
            success: false,
            code: 'PATH_TRAVERSAL_DETECTED',
            reason: `Prohibited path traversal sequence detected in artifact relativePath: "${art.relativePath}".`,
            details: { artifactId: art.artifactId, path: art.relativePath },
          };
        }
      }
    }

    for (const [key, val] of Object.entries(context.inputArgs || {})) {
      if (typeof val === 'string' && (key.toLowerCase().includes('path') || key.toLowerCase().includes('file'))) {
        if (val.includes('..') || val.includes('\0')) {
          return {
            success: false,
            code: 'PATH_TRAVERSAL_DETECTED',
            reason: `Prohibited path traversal sequence detected in input argument "${key}": "${val}".`,
            details: { argument: key, value: val },
          };
        }
      }
    }

    // ── 2. Authorized Agent Check ───────────────────────────────
    if (context.executingAgent.id !== contract.authorizedAgent) {
      return {
        success: false,
        code: 'UNAUTHORIZED_AGENT',
        reason: `Agent "${context.executingAgent.id}" is not authorized for contract "${contract.contractId}". Expected "${contract.authorizedAgent}".`,
        details: {
          executingAgent: context.executingAgent.id,
          authorizedAgent: contract.authorizedAgent,
        },
      };
    }

    // ── 2b. Industrial Host Executor Prohibition Gate ───────────
    if (context.requestedTool === 'execute_python') {
      return {
        success: false,
        code: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
        reason: "Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.",
        details: { requestedTool: 'execute_python' },
      };
    }

    // ── 3. Allowed Tool Check ───────────────────────────────────
    if (context.requestedTool !== contract.allowedTool) {
      return {
        success: false,
        code: 'TOOL_NOT_ALLOWED',
        reason: `Requested tool "${context.requestedTool}" does not match contract allowed tool "${contract.allowedTool}".`,
        details: {
          requestedTool: context.requestedTool,
          contractAllowedTool: contract.allowedTool,
        },
      };
    }

    if (context.taskAllowedTools && context.taskAllowedTools.length > 0) {
      if (
        !context.taskAllowedTools.includes(context.requestedTool) &&
        !SYSTEM_PLATFORM_TOOLS.has(context.requestedTool)
      ) {
        return {
          success: false,
          code: 'TOOL_NOT_ALLOWED',
          reason: `Tool "${context.requestedTool}" is outside task allowed tools set: [${context.taskAllowedTools.join(', ')}].`,
          details: {
            requestedTool: context.requestedTool,
            taskAllowedTools: context.taskAllowedTools,
          },
        };
      }
    }

    // ── 4. Forbidden Tool Check ─────────────────────────────────
    if (context.taskForbiddenTools && context.taskForbiddenTools.includes(context.requestedTool)) {
      return {
        success: false,
        code: 'FORBIDDEN_TOOL',
        reason: `Tool "${context.requestedTool}" is strictly forbidden by task requirements.`,
        details: { forbiddenTool: context.requestedTool },
      };
    }

    // ── 5. Human Review Gate Check ──────────────────────────────
    if (contract.humanReviewRequirement) {
      if (!context.humanReviewSignOff) {
        return {
          success: false,
          code: 'HUMAN_REVIEW_REQUIRED',
          reason: `Step "${contract.stepId}" requires verified human review before tool execution.`,
          details: { contractId: contract.contractId, gate: contract.humanReviewGate },
        };
      }

      if (context.humanReviewSignOff.verdict !== 'APPROVED') {
        return {
          success: false,
          code: 'HUMAN_REVIEW_REQUIRED',
          reason: `Human review sign-off rejected: "${context.humanReviewSignOff.notes || 'Reviewer did not approve'}"`,
          details: {
            reviewerId: context.humanReviewSignOff.reviewerId,
            verdict: context.humanReviewSignOff.verdict,
          },
        };
      }
    }

    // ── 6. Approval Gate Check ──────────────────────────────────
    if (
      contract.approvalRequirement === 'EXPLICIT_APPROVAL_REQUIRED' ||
      contract.approvalRequirement === 'SAFETY_CRITICAL_APPROVAL_REQUIRED' ||
      contract.approvalRequirement === 'FINAL_ARTIFACT_APPROVAL_REQUIRED'
    ) {
      if (!context.approvalRecord) {
        return {
          success: false,
          code:
            contract.approvalRequirement === 'SAFETY_CRITICAL_APPROVAL_REQUIRED'
              ? 'SAFETY_CRITICAL_APPROVAL_REQUIRED'
              : 'MISSING_APPROVAL',
          reason: `Contract "${contract.contractId}" requires explicit approval, but no approval record was provided.`,
          details: { approvalRequirement: contract.approvalRequirement },
        };
      }

      if (context.approvalRecord.status !== 'approved') {
        return {
          success: false,
          code: 'APPROVAL_NOT_GRANTED',
          reason: `Approval for contract "${contract.contractId}" is in status "${context.approvalRecord.status}", expected "approved".`,
          details: { status: context.approvalRecord.status },
        };
      }

      // Check approval payload hash
      if (contract.approvalGate?.payloadHash) {
        const approvalHash =
          (context.approvalRecord as any).payloadHash ||
          context.approvalRecord.conditions?.find((c) => c.startsWith('payloadHash:'))?.split(':')[1];

        if (approvalHash && approvalHash !== contract.approvalGate.payloadHash) {
          return {
            success: false,
            code: 'INVALID_APPROVAL_HASH',
            reason: `Approval payload hash mismatch. Expected "${contract.approvalGate.payloadHash}", found "${approvalHash}".`,
            details: { expected: contract.approvalGate.payloadHash, actual: approvalHash },
          };
        }
      }

      // Stale approval check
      if (
        (context.approvalRecord as any).stale === true ||
        (context.approvalRecord as any).isStale === true
      ) {
        return {
          success: false,
          code: 'STALE_APPROVAL',
          reason: `Approval record "${context.approvalRecord.id}" is stale or expired. Re-approval required.`,
          details: { approvalId: context.approvalRecord.id },
        };
      }
    }

    // ── 7. Artifact Integrity & Quarantine Checks ───────────────
    if (context.diskArtifacts && context.diskArtifacts.length > 0) {
      for (const artifact of context.diskArtifacts) {
        // Cross-project violation
        if (artifact.projectId && artifact.projectId !== contract.projectId) {
          return {
            success: false,
            code: 'CROSS_PROJECT_ARTIFACT_VIOLATION',
            reason: `Artifact "${artifact.artifactId}" belongs to project "${artifact.projectId}", not active project "${contract.projectId}".`,
            details: {
              artifactId: artifact.artifactId,
              artifactProject: artifact.projectId,
              activeProject: contract.projectId,
            },
          };
        }

        // Quarantine check
        const lowerName = (artifact.relativePath || artifact.artifactId).toLowerCase();
        if (
          artifact.isQuarantined === true ||
          lowerName.includes('quarantine') ||
          lowerName.includes('malware') ||
          lowerName.includes('infected')
        ) {
          return {
            success: false,
            code: 'QUARANTINED_ARTIFACT',
            reason: `Artifact "${artifact.artifactId}" is quarantined and cannot be used in execution.`,
            details: { artifactId: artifact.artifactId },
          };
        }

        // Missing artifact check
        const fullPath = path.isAbsolute(artifact.relativePath)
          ? artifact.relativePath
          : path.join(context.projectRoot, artifact.relativePath);

        if (!fs.existsSync(fullPath)) {
          return {
            success: false,
            code: 'MISSING_ARTIFACT',
            reason: `Required input artifact "${artifact.artifactId}" is missing from disk: "${artifact.relativePath}".`,
            details: { artifactId: artifact.artifactId, path: artifact.relativePath },
          };
        }

        // Source hash mismatch check
        if (artifact.expectedHash) {
          try {
            const buf = fs.readFileSync(fullPath);
            const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
            if (actualHash !== artifact.expectedHash) {
              return {
                success: false,
                code: 'SOURCE_HASH_MISMATCH',
                reason: `Source hash mismatch for artifact "${artifact.artifactId}". Disk content has been modified.`,
                details: {
                  artifactId: artifact.artifactId,
                  expected: artifact.expectedHash,
                  actual: actualHash,
                },
              };
            }
          } catch (err: any) {
            return {
              success: false,
              code: 'MISSING_ARTIFACT',
              reason: `Failed to read artifact "${artifact.artifactId}": ${err.message}`,
              details: { artifactId: artifact.artifactId },
            };
          }
        }
      }
    }

    // ── 8. Model Revision Pinning Check ─────────────────────────
    if (contract.requiredRevision) {
      const agentRevision =
        (context.executingAgent as any).modelRevision ||
        (context.executingAgent as any).revision ||
        (context.executingAgent.runtimeStats as any)?.modelRevision;

      if (agentRevision && agentRevision !== contract.requiredRevision) {
        return {
          success: false,
          code: 'MODEL_REVISION_MISMATCH',
          reason: `Executing agent "${context.executingAgent.id}" model revision "${agentRevision}" does not match required pinned revision "${contract.requiredRevision}".`,
          details: {
            agentId: context.executingAgent.id,
            actualRevision: agentRevision,
            requiredRevision: contract.requiredRevision,
          },
        };
      }
    }

    // ── 9. Modality & Non-Degradation Check ─────────────────────
    const agentModalities = context.executingAgent.modalities || ['text'];
    for (const mod of contract.requiredModalities) {
      if (!agentModalities.includes(mod)) {
        return {
          success: false,
          code: 'MODALITY_DEGRADATION_REJECTED',
          reason: `Executing agent "${context.executingAgent.id}" does not support required modality "${mod}". Degradation rejected.`,
          details: {
            agentId: context.executingAgent.id,
            requiredModality: mod,
            agentModalities,
          },
        };
      }
    }

    // ── 10. Dependency Ordering Check ───────────────────────────
    if (context.dependencyStatuses) {
      for (const [depId, status] of Object.entries(context.dependencyStatuses)) {
        if (status !== 'COMPLETED') {
          return {
            success: false,
            code: 'DEPENDENCY_UNSATISFIED',
            reason: `Prerequisite dependency step "${depId}" is in status "${status}", expected "COMPLETED".`,
            details: { dependencyStepId: depId, dependencyStatus: status },
          };
        }
      }
    }

    // ── 11. Durable Idempotency Claim & Replay Check ─────────────
    if (context.idempotencyStore) {
      const claimOutcome = context.idempotencyStore.claim({
        key: contract.idempotencyKey,
        requestHash: contract.contractHash,
        operation: contract.allowedTool,
        projectId: contract.projectId,
        authContext: contract.authorizedAgent,
      });

      if (claimOutcome.outcome === 'conflict') {
        return {
          success: false,
          code: 'IDEMPOTENCY_CONFLICT',
          reason: claimOutcome.message || 'Conflicting mutation attempted on existing idempotency key.',
          details: { idempotencyKey: contract.idempotencyKey },
        };
      }

      if (claimOutcome.outcome === 'replay') {
        const replayStr =
          typeof claimOutcome.record.responsePayload === 'string'
            ? claimOutcome.record.responsePayload
            : JSON.stringify(claimOutcome.record.responsePayload ?? '');
        return {
          success: true,
          code: 'IDEMPOTENCY_REPLAY',
          replayResult: replayStr,
          contract,
          reason: 'Request previously completed. Replaying cached execution result.',
          details: { idempotencyKey: contract.idempotencyKey },
        };
      }
    }

    // ── 12. Output Type Conformance Check ───────────────────────
    if (
      context.inputArgs.expectedOutputType &&
      typeof context.inputArgs.expectedOutputType === 'string'
    ) {
      if (context.inputArgs.expectedOutputType !== contract.expectedOutputType) {
        return {
          success: false,
          code: 'OUTPUT_TYPE_MISMATCH',
          reason: `Declared output type "${context.inputArgs.expectedOutputType}" does not match contract expected output type "${contract.expectedOutputType}".`,
          details: {
            declared: context.inputArgs.expectedOutputType,
            expected: contract.expectedOutputType,
          },
        };
      }
    }

    // All pre-execution invariants passed!
    return {
      success: true,
      contract,
    };
  }

  // ── Private Helpers ──────────────────────────────────────────

  private resolvePrincipalTool(step: WorkflowPlanStep): string {
    const primaryDomainTools = [
      'generate_docx',
      'generate_xlsx',
      'generate_pptx',
      'ocr_extract',
      'vision_inspect',
      'conflict_compare',
      'kb_search',
      'kb_ingest',
      'pdf_raster',
      'execute_code_sandbox',
      'bash',
      'approval_request',
      'artifact_write',
      'artifact_read',
    ];

    for (const tool of primaryDomainTools) {
      if (step.requiredTools.includes(tool)) {
        return tool;
      }
    }

    return step.requiredTools[0] || 'artifact_read';
  }

  private deriveApprovalRequirements(
    step: WorkflowPlanStep,
    plan: WorkflowPlan,
    allowedTool: string,
    options: ToolContractCreationOptions,
  ): {
    approvalRequirement: ApprovalCategory;
    humanReviewRequirement: boolean;
    humanReviewGate?: HumanReviewGate;
    approvalGate?: ApprovalGate;
  } {
    // 1. Safety critical explicitly tagged or tool
    if (
      options.safetyCritical === true ||
      allowedTool === 'bash' ||
      allowedTool === 'execute_python' ||
      allowedTool === 'format_disk' ||
      allowedTool === 'system_config'
    ) {
      const gateId = `gate_safety_${plan.provenance.taskId}_${step.stepId}`;
      return {
        approvalRequirement: 'SAFETY_CRITICAL_APPROVAL_REQUIRED',
        humanReviewRequirement: true,
        humanReviewGate: {
          reason: `Safety-critical action "${allowedTool}" requires human sign-off before invocation.`,
          requiredReviewerRole: 'safety-officer',
          criteria: ['verify_sandbox_isolation', 'confirm_parameters', 'confirm_authorization'],
        },
        approvalGate: {
          gateId,
          requiredStatus: 'approved',
        },
      };
    }

    // 2. Multimodal conflict review or discrepancy check
    if (step.stepType === 'REVIEW_CONFLICT') {
      return {
        approvalRequirement: 'HUMAN_REVIEW_REQUIRED',
        humanReviewRequirement: true,
        humanReviewGate: {
          reason: 'Discrepancy detected between multimodal evidence sources. Human judgment required.',
          requiredReviewerRole: options.requiredReviewerRole || 'lead-inspector',
          criteria: ['review_ocr_readings', 'inspect_cad_markings', 'validate_cross_check'],
        },
      };
    }

    // 3. Office deliverable generation
    if (
      step.stepType === 'GENERATE_DOCX' ||
      step.stepType === 'GENERATE_XLSX' ||
      step.stepType === 'GENERATE_PPTX'
    ) {
      const gateId = `gate_deliverable_${plan.provenance.taskId}_${step.stepId}`;
      return {
        approvalRequirement: 'FINAL_ARTIFACT_APPROVAL_REQUIRED',
        humanReviewRequirement: true,
        humanReviewGate: {
          reason: `Release of professional ${step.stepType.replace('GENERATE_', '')} deliverable requires engineer review.`,
          requiredReviewerRole: options.requiredReviewerRole || 'lead-engineer',
          criteria: ['layout_bounds_check', 'measurements_verified', 'branding_compliance'],
        },
        approvalGate: {
          gateId,
          requiredStatus: 'approved',
        },
      };
    }

    // 4. Explicit approval step
    if (step.stepType === 'REQUEST_APPROVAL' || step.requiresApproval) {
      const gateId = `gate_approval_${plan.provenance.taskId}_${step.stepId}`;
      return {
        approvalRequirement: 'EXPLICIT_APPROVAL_REQUIRED',
        humanReviewRequirement: true,
        humanReviewGate: {
          reason: step.approvalReason || `Approval required for step "${step.stepId}".`,
          requiredReviewerRole: options.requiredReviewerRole || 'supervisor',
          criteria: ['verify_intermediate_outputs', 'check_compliance'],
        },
        approvalGate: {
          gateId,
          requiredStatus: 'approved',
        },
      };
    }

    // 5. Finalize artifact when deliverable is produced
    if (
      step.stepType === 'FINALIZE_ARTIFACT' &&
      plan.steps.some(
        (s) =>
          s.stepType === 'GENERATE_DOCX' ||
          s.stepType === 'GENERATE_XLSX' ||
          s.stepType === 'GENERATE_PPTX',
      )
    ) {
      const gateId = `gate_final_${plan.provenance.taskId}_${step.stepId}`;
      return {
        approvalRequirement: 'FINAL_ARTIFACT_APPROVAL_REQUIRED',
        humanReviewRequirement: true,
        humanReviewGate: {
          reason: 'Finalization of release package requires human sign-off.',
          requiredReviewerRole: options.requiredReviewerRole || 'lead-engineer',
          criteria: ['package_integrity', 'zero_external_links', 'valid_signatures'],
        },
        approvalGate: {
          gateId,
          requiredStatus: 'approved',
        },
      };
    }

    // Default: read-only, non-destructive, or standard pipeline operations
    return {
      approvalRequirement: 'NO_APPROVAL_REQUIRED',
      humanReviewRequirement: false,
    };
  }
}
