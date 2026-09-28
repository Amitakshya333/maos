/**
 * MAOS Industrial — Deterministic Typed Workflow Planner (F7-03)
 *
 * Transforms a validated InferenceResult and TaskRequirements into a versioned,
 * deterministic, typed WorkflowPlan.
 *
 * Core Safety Rules:
 * 1. Zero LLM Guessing: Plans are built from deterministic typed recipes only.
 * 2. No Implicit Tool Escalation: Only declared tools in task requirements are permitted.
 * 3. Forbidden Tool Rejection: Any forbidden tool in plan steps fails closed.
 * 4. Pinned Model Revision: Revision mismatches fail closed.
 * 5. Non-Degradation: Non-text modalities cannot downgrade to text-only agents.
 * 6. Mandatory Approval Gates: Office deliverables and safety-critical steps
 *    require explicit approval steps before finalization.
 * 7. Acyclic DAG: Dependencies must form a strictly acyclic directed graph.
 * 8. 100% Determinism: Canonical hashing produces identical planHash for identical inputs.
 * 9. Content Neutrality: Document/OCR/VLM prose is treated strictly as data.
 */

import * as crypto from 'crypto';
import type {
  InferenceResult,
  EvidenceReference,
} from '../domain/inference';
import type {
  ExtendedTaskRequirements,
  TaskModality,
  TaskModelRequirement,
} from '../domain/schemas';
import type {
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowStepType,
  WorkflowPlanProvenance,
  WorkflowPlanningOutcome,
  WorkflowPlanningErrorCode,
} from '../domain/workflow-plan';
import { computeCanonicalPlanHash } from '../domain/workflow-plan';
import { validateWorkflowPlan } from '../domain/validators';
import type { AgentProfile, TaskRequirements } from '../core/router';

export interface WorkflowPlanningInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly inference: InferenceResult;
  readonly taskRequirements: TaskRequirements;
  readonly availableAgents: readonly AgentProfile[];
  readonly context?: Record<string, unknown>;
}

export const SYSTEM_PLATFORM_TOOLS = new Set<string>([
  'artifact_read',
  'artifact_write',
  'approval_request',
]);

// ── Recipe Step Definitions ───────────────────────────────────

interface RecipeStepTemplate {
  readonly stepType: WorkflowStepType;
  readonly title: string;
  readonly requiredModality: TaskModality;
  readonly requiredTools: readonly string[];
  readonly dependencyIndices: readonly number[]; // indices of preceding steps this step depends on
  readonly inputs: {
    readonly artifactTypes?: readonly string[];
    readonly sourceIds?: readonly string[];
    readonly parameters?: Record<string, unknown>;
  };
  readonly outputs: {
    readonly expectedArtifactTypes: readonly string[];
    readonly outputSchemaId?: string;
  };
  readonly requiresApproval: boolean;
  readonly approvalReason?: string;
}

export class WorkflowPlanner {
  /**
   * Generates a deterministic, typed WorkflowPlan from validated inference.
   */
  public plan(input: WorkflowPlanningInput): WorkflowPlanningOutcome {
    // ── 1. Inference Status Gate ──────────────────────────────
    if (input.inference.status !== 'MATCHED') {
      const reason =
        input.inference.status === 'CLARIFICATION_REQUIRED'
          ? 'Cannot plan workflow: request is ambiguous or requires clarification.'
          : `Cannot plan workflow for ${input.inference.status} request.`;

      return {
        success: false,
        code: 'INFERENCE_NOT_MATCHED',
        reason,
        clarificationPrompt:
          input.inference.clarificationPrompt ??
          'Please clarify the desired action and required deliverables.',
      };
    }

    // ── 2. Evidence Freshness & Quarantine Gate ───────────────
    for (const ev of input.inference.supportingEvidence) {
      const combined = `${ev.source} ${ev.ref} ${ev.matchDetail}`.toLowerCase();
      if (
        combined.includes('quarantine') ||
        combined.includes('malware') ||
        combined.includes('infected') ||
        combined.includes('untrusted')
      ) {
        return {
          success: false,
          code: 'QUARANTINED_EVIDENCE',
          reason: `Evidence "${ev.ref}" is quarantined and cannot be used in execution planning.`,
          details: { evidence: ev },
        };
      }
      if (
        combined.includes('stale') ||
        combined.includes('expired') ||
        combined.includes('tampered')
      ) {
        return {
          success: false,
          code: 'STALE_EVIDENCE',
          reason: `Evidence "${ev.ref}" is stale or expired. Re-index or refresh required.`,
          details: { evidence: ev },
        };
      }
    }

    // ── 3. Cross-Project Isolation Gate ───────────────────────
    if (
      input.context?.projectId &&
      typeof input.context.projectId === 'string' &&
      input.context.projectId !== input.projectId
    ) {
      return {
        success: false,
        code: 'CROSS_PROJECT_VIOLATION',
        reason: `Cross-project access violation: plan belongs to "${input.projectId}" but context requested "${input.context.projectId}".`,
      };
    }

    // ── 4. Resolve Merged Requirements ────────────────────────
    const taskReqs =
      input.taskRequirements.extended ||
      ((input.taskRequirements as any)?.tools ? (input.taskRequirements as any) : undefined);
    const infReqs = input.inference.requirements;

    const modalities: TaskModality[] = infReqs?.modalities
      ? [...infReqs.modalities]
      : taskReqs?.modalities
      ? [...taskReqs.modalities]
      : ['text'];

    const primaryModality: TaskModality =
      infReqs?.primaryModality ||
      taskReqs?.primaryModality ||
      modalities[0] ||
      'text';

    const requiredTools = new Set<string>(
      taskReqs?.tools?.requiredTools !== undefined
        ? taskReqs.tools.requiredTools
        : infReqs?.tools?.requiredTools || [],
    );

    if (input.taskRequirements.capabilities?.includes('execute_python')) {
      requiredTools.add('execute_python');
    }

    const optionalTools = new Set<string>(
      taskReqs?.tools?.optionalTools !== undefined
        ? taskReqs.tools.optionalTools
        : infReqs?.tools?.optionalTools || [],
    );

    const forbiddenTools = new Set<string>([
      ...(infReqs?.tools?.forbiddenTools || []),
      ...(taskReqs?.tools?.forbiddenTools || []),
    ]);

    const allowDegradation =
      taskReqs?.allowDegradation === true && infReqs?.allowDegradation === true;

    // Reject host executor in industrial task requirements
    if (requiredTools.has('execute_python') || optionalTools.has('execute_python')) {
      return {
        success: false,
        code: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' as any,
        reason: "Industrial task requirements must not authorize host execution ('execute_python'). All code tasks must run inside the container sandbox.",
        details: { forbiddenTool: 'execute_python' },
      };
    }

    const mergedRequirements: ExtendedTaskRequirements = {
      schemaVersion: 1,
      modalities,
      primaryModality,
      model: infReqs?.model || taskReqs?.model,
      tools: {
        requiredTools: Array.from(requiredTools),
        optionalTools: Array.from(optionalTools),
        forbiddenTools: Array.from(forbiddenTools),
      },
      input: infReqs?.input || taskReqs?.input,
      output: infReqs?.output || taskReqs?.output,
      allowDegradation,
    };

    // ── 5. Non-Degradation Modality Check ─────────────────────
    if (!allowDegradation) {
      for (const reqMod of modalities) {
        if (reqMod !== 'text') {
          const hasAgentWithModality = input.availableAgents.some(
            (a) => a.enabled && (a.modalities?.includes(reqMod) || false),
          );
          if (!hasAgentWithModality) {
            return {
              success: false,
              code: 'MODALITY_UNAVAILABLE',
              reason: `No eligible agent supports required modality "${reqMod}". Non-degradation enforced.`,
              details: { requiredModality: reqMod },
            };
          }
        }
      }
    }

    // ── 6. Select Recipe Templates ────────────────────────────
    const recipeTemplates = this.getRecipeTemplates(
      input.inference.inferredIntent,
      input.inference.selectedWorkflow,
      mergedRequirements,
    );

    // ── 7. Build Typed Steps & Verify Invariants ──────────────
    const steps: WorkflowPlanStep[] = [];
    const planId = `plan_${input.taskId}_${input.runId}`;
    const generatedStepIds: string[] = [];

    // Precompute step IDs
    for (let i = 0; i < recipeTemplates.length; i++) {
      const t = recipeTemplates[i];
      const stepSeq = (i + 1).toString().padStart(2, '0');
      const stepId = `${planId}_step_${stepSeq}_${t.stepType.toLowerCase()}`;
      generatedStepIds.push(stepId);
    }

    for (let i = 0; i < recipeTemplates.length; i++) {
      const template = recipeTemplates[i];
      const stepId = generatedStepIds[i];

      // A. Check forbidden tools and host executor prohibition
      for (const tool of template.requiredTools) {
        if (tool === 'execute_python') {
          return {
            success: false,
            code: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL' as any,
            reason: `Industrial task plan must not authorize host execution ('execute_python'). All code tasks must run inside the container sandbox.`,
            details: { stepType: template.stepType, forbiddenTool: tool },
          };
        }
        if (forbiddenTools.has(tool)) {
          return {
            success: false,
            code: 'FORBIDDEN_TOOL_VIOLATION',
            reason: `Step "${template.stepType}" requires forbidden tool "${tool}".`,
            details: { stepType: template.stepType, forbiddenTool: tool },
          };
        }
      }

      // B. Check tool escalation (if declared tools specified)
      if (requiredTools.size > 0 || optionalTools.size > 0) {
        for (const tool of template.requiredTools) {
          if (!SYSTEM_PLATFORM_TOOLS.has(tool)) {
            if (!requiredTools.has(tool) && !optionalTools.has(tool)) {
              return {
                success: false,
                code: 'TOOL_ESCALATION_VIOLATION',
                reason: `Step "${template.stepType}" attempts to escalate privilege with undeclared tool "${tool}".`,
                details: { stepType: template.stepType, undeclaredTool: tool },
              };
            }
          }
        }
      }

      // C. Resolve Eligible Agent for this Step
      const agentResolution = this.resolveAgentForStep(
        template,
        mergedRequirements,
        input.availableAgents,
        input.inference.selectedAgent,
      );

      if (!agentResolution.success) {
        return {
          success: false,
          code: agentResolution.code,
          reason: agentResolution.reason,
          details: agentResolution.details,
        };
      }

      // D. Resolve Dependencies
      const dependencies = template.dependencyIndices.map(
        (idx) => generatedStepIds[idx],
      );

      const step: WorkflowPlanStep = {
        stepId,
        stepType: template.stepType,
        title: template.title,
        assignedAgentId: agentResolution.agentId,
        requiredTools: template.requiredTools,
        requiredModel: mergedRequirements.model,
        dependencies,
        inputs: template.inputs,
        outputs: template.outputs,
        requiresApproval: template.requiresApproval,
        approvalReason: template.approvalReason,
        status: 'READY',
      };

      steps.push(step);
    }

    // ── 8. Enforce Approval Gates ─────────────────────────────
    const isDeliverablePlan = steps.some(
      (s) =>
        s.stepType === 'GENERATE_DOCX' ||
        s.stepType === 'GENERATE_XLSX' ||
        s.stepType === 'GENERATE_PPTX',
    );

    if (isDeliverablePlan) {
      const hasApproval = steps.some((s) => s.stepType === 'REQUEST_APPROVAL');
      if (!hasApproval) {
        return {
          success: false,
          code: 'MISSING_APPROVAL_GATE',
          reason:
            'Office deliverable workflows must include an explicit REQUEST_APPROVAL gate before artifact finalization.',
        };
      }

      // Ensure approval step is positioned BEFORE finalization
      const approvalIdx = steps.findIndex((s) => s.stepType === 'REQUEST_APPROVAL');
      const finalizeIdx = steps.findIndex((s) => s.stepType === 'FINALIZE_ARTIFACT');
      if (finalizeIdx !== -1 && approvalIdx > finalizeIdx) {
        return {
          success: false,
          code: 'MISSING_APPROVAL_GATE',
          reason:
            'Approval step REQUEST_APPROVAL must precede FINALIZE_ARTIFACT in dependency order.',
        };
      }
    }

    // ── 9. Acyclic DAG Validation ─────────────────────────────
    const hasCycle = this.detectCycles(steps);
    if (hasCycle) {
      return {
        success: false,
        code: 'CYCLIC_DEPENDENCY',
        reason: 'Cyclic dependency detected in generated workflow plan.',
      };
    }

    // ── 10. Assemble Provenance & Compute Canonical Hash ──────
    const sourceArtifactIds: string[] = [];
    const sourceHashes: string[] = [];
    for (const ev of input.inference.supportingEvidence) {
      if (ev.source === 'attachment') {
        sourceArtifactIds.push(ev.ref);
      }
      if (ev.hash) {
        sourceHashes.push(ev.hash);
      }
    }

    const provenance: WorkflowPlanProvenance = {
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      inferenceInputHash: input.inference.inputHash,
      sourceArtifactIds,
      sourceHashes,
      evidenceReferences: input.inference.supportingEvidence,
      createdAt:
        (input.context?.createdAt as string) || new Date().toISOString(),
    };

    const draftPlan: Omit<WorkflowPlan, 'planHash'> = {
      schemaVersion: 1,
      planId,
      title: `Workflow Plan: ${input.inference.inferredIntent}`,
      intent: input.inference.inferredIntent,
      status: 'READY',
      provenance,
      requirements: mergedRequirements,
      steps,
      deterministic: true,
    };

    const planHash = computeCanonicalPlanHash(draftPlan);

    const completePlan: WorkflowPlan = {
      ...draftPlan,
      planHash,
    };

    // Validate plan against domain validator
    const planVal = validateWorkflowPlan(completePlan);
    if (!planVal.valid) {
      return {
        success: false,
        code: 'INVALID_PLAN_SCHEMA',
        reason: `Constructed invalid WorkflowPlan: ${planVal.errors.join('; ')}`,
      };
    }

    return {
      success: true,
      plan: completePlan,
    };
  }

  // ── Helper: Recipe Selection ────────────────────────────────

  private getRecipeTemplates(
    intent: string,
    workflow: string | null | undefined,
    reqs: ExtendedTaskRequirements,
  ): readonly RecipeStepTemplate[] {
    // Multimodal Conflict Review Recipe
    if (
      workflow === 'multimodal-conflict-review' ||
      (reqs.modalities.includes('vision') && reqs.modalities.includes('text') && intent === 'review_conflict')
    ) {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest attached source documents and image evidence',
          requiredModality: 'text',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['pdf', 'image'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'RASTERIZE_DOCUMENT',
          title: 'Rasterize PDF pages to high-resolution images',
          requiredModality: 'vision',
          requiredTools: ['pdf_raster', 'artifact_read', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['raster_image'] },
          requiresApproval: false,
        },
        {
          stepType: 'RUN_OCR',
          title: 'Extract structured text and numerical measurements via OCR',
          requiredModality: 'vision',
          requiredTools: ['ocr_extract', 'artifact_read', 'artifact_write'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['raster_image'] },
          outputs: { expectedArtifactTypes: ['ocr_extraction'] },
          requiresApproval: false,
        },
        {
          stepType: 'ANALYZE_IMAGE',
          title: 'Perform visual inspection for physical defects and markings',
          requiredModality: 'vision',
          requiredTools: ['vision_inspect', 'artifact_read', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['visual_observation'] },
          requiresApproval: false,
        },
        {
          stepType: 'REVIEW_CONFLICT',
          title: 'Cross-evaluate OCR findings and visual observations for discrepancy',
          requiredModality: 'text',
          requiredTools: ['conflict_compare', 'artifact_read', 'artifact_write'],
          dependencyIndices: [2, 3],
          inputs: { artifactTypes: ['ocr_extraction', 'visual_observation'] },
          outputs: { expectedArtifactTypes: ['conflict_report'] },
          requiresApproval: false,
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize unified inspection and conflict report',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [4],
          inputs: { artifactTypes: ['conflict_report'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // Document OCR Recipe
    if (intent === 'document_ocr' || intent === 'document_ocr_attachment') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest attached document evidence',
          requiredModality: 'text',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['pdf', 'tiff'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'RASTERIZE_DOCUMENT',
          title: 'Rasterize document pages for OCR extraction',
          requiredModality: 'vision',
          requiredTools: ['pdf_raster', 'artifact_read', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['raster_image'] },
          requiresApproval: false,
        },
        {
          stepType: 'RUN_OCR',
          title: 'Extract textual and tabular data via OCR engine',
          requiredModality: 'vision',
          requiredTools: ['ocr_extract', 'artifact_read', 'artifact_write'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['raster_image'] },
          outputs: { expectedArtifactTypes: ['ocr_extraction'] },
          requiresApproval: false,
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize structured OCR extraction output',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [2],
          inputs: { artifactTypes: ['ocr_extraction'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // Image Inspection Recipe
    if (intent === 'image_inspection' || intent === 'image_inspection_attachment') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest visual image evidence',
          requiredModality: 'vision',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['image'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'ANALYZE_IMAGE',
          title: 'Perform visual diagram and defect inspection',
          requiredModality: 'vision',
          requiredTools: ['vision_inspect', 'artifact_read', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['visual_finding'] },
          requiresApproval: false,
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize image inspection findings artifact',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['visual_finding'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // DOCX Deliverable Recipe
    if (intent === 'generate_docx') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest source data and measurements for Word report',
          requiredModality: 'text',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['data'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'GENERATE_DOCX',
          title: 'Generate formatted DOCX report package with visual layout bounds',
          requiredModality: 'text',
          requiredTools: ['generate_docx', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['docx'] },
          requiresApproval: false,
        },
        {
          stepType: 'REQUEST_APPROVAL',
          title: 'Request professional engineering sign-off for DOCX deliverable',
          requiredModality: 'text',
          requiredTools: ['approval_request'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['docx'] },
          outputs: { expectedArtifactTypes: ['approval_record'] },
          requiresApproval: true,
          approvalReason: 'Mandatory engineer sign-off required for DOCX deliverable release.',
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize approved DOCX deliverable package',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [2],
          inputs: { artifactTypes: ['docx', 'approval_record'] },
          outputs: { expectedArtifactTypes: ['final_docx'] },
          requiresApproval: false,
        },
      ];
    }

    // XLSX Deliverable Recipe
    if (intent === 'generate_xlsx') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest numerical metrics and calculation data',
          requiredModality: 'text',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['data'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'GENERATE_XLSX',
          title: 'Generate verified XLSX calculation workbook with formulas',
          requiredModality: 'text',
          requiredTools: ['generate_xlsx', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['xlsx'] },
          requiresApproval: false,
        },
        {
          stepType: 'REQUEST_APPROVAL',
          title: 'Request reviewer sign-off for calculation spreadsheet',
          requiredModality: 'text',
          requiredTools: ['approval_request'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['xlsx'] },
          outputs: { expectedArtifactTypes: ['approval_record'] },
          requiresApproval: true,
          approvalReason: 'Mandatory engineer sign-off required for XLSX calculation sheet release.',
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize approved XLSX spreadsheet package',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [2],
          inputs: { artifactTypes: ['xlsx', 'approval_record'] },
          outputs: { expectedArtifactTypes: ['final_xlsx'] },
          requiresApproval: false,
        },
      ];
    }

    // PPTX Deliverable Recipe
    if (intent === 'generate_pptx') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Ingest presentation summary points and milestones',
          requiredModality: 'text',
          requiredTools: ['artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['data'] },
          outputs: { expectedArtifactTypes: ['evidence'] },
          requiresApproval: false,
        },
        {
          stepType: 'GENERATE_PPTX',
          title: 'Generate 16:9 widescreen PPTX presentation deck',
          requiredModality: 'text',
          requiredTools: ['generate_pptx', 'artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['evidence'] },
          outputs: { expectedArtifactTypes: ['pptx'] },
          requiresApproval: false,
        },
        {
          stepType: 'REQUEST_APPROVAL',
          title: 'Request stakeholder sign-off for PPTX presentation deck',
          requiredModality: 'text',
          requiredTools: ['approval_request'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['pptx'] },
          outputs: { expectedArtifactTypes: ['approval_record'] },
          requiresApproval: true,
          approvalReason: 'Mandatory sign-off required for PPTX executive slide release.',
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize approved PPTX presentation deck package',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [2],
          inputs: { artifactTypes: ['pptx', 'approval_record'] },
          outputs: { expectedArtifactTypes: ['final_pptx'] },
          requiresApproval: false,
        },
      ];
    }

    // Knowledge Base Search Recipe
    if (intent === 'kb_search') {
      return [
        {
          stepType: 'SEARCH_KNOWLEDGE_BASE',
          title: 'Query local vector index for relevant corpus documents',
          requiredModality: 'text',
          requiredTools: ['kb_search'],
          dependencyIndices: [],
          inputs: { parameters: { topK: 5 } },
          outputs: { expectedArtifactTypes: ['search_results'] },
          requiresApproval: false,
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Synthesize citations and findings into knowledge response',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['search_results'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // Knowledge Base Ingestion Recipe
    if (intent === 'kb_ingestion') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Scan and chunk directory documents according to corpus policy',
          requiredModality: 'text',
          requiredTools: ['kb_ingest', 'artifact_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['documents'] },
          outputs: { expectedArtifactTypes: ['chunks'] },
          requiresApproval: false,
        },
        {
          stepType: 'SEARCH_KNOWLEDGE_BASE',
          title: 'Compute offline embeddings and rebuild vector index',
          requiredModality: 'text',
          requiredTools: ['kb_embed'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['chunks'] },
          outputs: { expectedArtifactTypes: ['vector_index'] },
          requiresApproval: false,
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Save updated knowledge base manifest and index',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['vector_index'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // Code Development Recipe
    if (intent === 'code_development' || intent === 'code_analysis_attachment') {
      return [
        {
          stepType: 'INGEST_EVIDENCE',
          title: 'Read source code files and review context',
          requiredModality: 'code',
          requiredTools: ['file_read'],
          dependencyIndices: [],
          inputs: { artifactTypes: ['source_code'] },
          outputs: { expectedArtifactTypes: ['source_context'] },
          requiresApproval: false,
        },
        {
          stepType: 'REVIEW_CONFLICT',
          title: 'Implement code modifications and unit tests',
          requiredModality: 'code',
          requiredTools: ['file_write', 'file_read', 'bash'],
          dependencyIndices: [0],
          inputs: { artifactTypes: ['source_context'] },
          outputs: { expectedArtifactTypes: ['code_patch'] },
          requiresApproval: false,
        },
        {
          stepType: 'REQUEST_APPROVAL',
          title: 'Request approval for code changes prior to finalization',
          requiredModality: 'text',
          requiredTools: ['approval_request'],
          dependencyIndices: [1],
          inputs: { artifactTypes: ['code_patch'] },
          outputs: { expectedArtifactTypes: ['approval_record'] },
          requiresApproval: true,
          approvalReason: 'Code modification sign-off required.',
        },
        {
          stepType: 'FINALIZE_ARTIFACT',
          title: 'Finalize code patch and execution record',
          requiredModality: 'text',
          requiredTools: ['artifact_write'],
          dependencyIndices: [2],
          inputs: { artifactTypes: ['code_patch', 'approval_record'] },
          outputs: { expectedArtifactTypes: ['report'] },
          requiresApproval: false,
        },
      ];
    }

    // Default Fallback Recipe (Text Query)
    return [
      {
        stepType: 'INGEST_EVIDENCE',
        title: 'Review input text query and context',
        requiredModality: 'text',
        requiredTools: ['artifact_read'],
        dependencyIndices: [],
        inputs: {},
        outputs: { expectedArtifactTypes: ['evidence'] },
        requiresApproval: false,
      },
      {
        stepType: 'FINALIZE_ARTIFACT',
        title: 'Finalize structured text response',
        requiredModality: 'text',
        requiredTools: ['artifact_write'],
        dependencyIndices: [0],
        inputs: { artifactTypes: ['evidence'] },
        outputs: { expectedArtifactTypes: ['report'] },
        requiresApproval: false,
      },
    ];
  }

  // ── Helper: Agent Resolution ────────────────────────────────

  private resolveAgentForStep(
    step: RecipeStepTemplate,
    reqs: ExtendedTaskRequirements,
    availableAgents: readonly AgentProfile[],
    targetedAgentId?: string | null,
  ):
    | { readonly success: true; readonly agentId: string }
    | {
        readonly success: false;
        readonly code: WorkflowPlanningErrorCode;
        readonly reason: string;
        readonly details?: Record<string, unknown>;
      } {
    // 1. If explicit target agent requested for whole task, check it first
    if (targetedAgentId && targetedAgentId !== 'AUTO') {
      const target = availableAgents.find((a) => a.id === targetedAgentId && a.enabled);
      if (target) {
        const evalRes = this.evaluateAgentForStep(target, step, reqs);
        if (evalRes.eligible) {
          return { success: true, agentId: target.id };
        }
        if (evalRes.hardFailureCode) {
          return {
            success: false,
            code: evalRes.hardFailureCode,
            reason: evalRes.reason || `Targeted agent "${target.id}" failed hard requirement check.`,
            details: { stepType: step.stepType, agentId: target.id },
          };
        }
      }
    }

    // 2. Filter candidates matching modality, tools, and model revision
    const candidates: Array<{ agent: AgentProfile; score: number }> = [];

    for (const agent of availableAgents) {
      if (!agent.enabled) continue;

      const evalRes = this.evaluateAgentForStep(agent, step, reqs);
      if (evalRes.eligible) {
        candidates.push({ agent, score: evalRes.score });
      }
    }

    if (candidates.length === 0) {
      // Find specific reason why no agent qualified
      for (const agent of availableAgents) {
        if (!agent.enabled) continue;
        const evalRes = this.evaluateAgentForStep(agent, step, reqs);
        if (evalRes.hardFailureCode) {
          return {
            success: false,
            code: evalRes.hardFailureCode,
            reason: evalRes.reason || `Agent "${agent.id}" failed hard requirement check.`,
            details: { stepType: step.stepType, agentId: agent.id },
          };
        }
      }

      return {
        success: false,
        code: 'NO_ELIGIBLE_AGENT',
        reason: `No eligible agent found for step "${step.stepType}". Required modality: ${step.requiredModality}, required tools: [${step.requiredTools.join(', ')}]`,
        details: { stepType: step.stepType },
      };
    }

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);
    return { success: true, agentId: candidates[0].agent.id };
  }

  private evaluateAgentForStep(
    agent: AgentProfile,
    step: RecipeStepTemplate,
    reqs: ExtendedTaskRequirements,
  ): {
    eligible: boolean;
    score: number;
    hardFailureCode?: WorkflowPlanningErrorCode;
    reason?: string;
  } {
    // Modality check
    const agentModalities = agent.modalities || ['text'];
    if (!agentModalities.includes(step.requiredModality)) {
      return {
        eligible: false,
        score: 0,
      };
    }

    // Required tools check
    const agentTools = new Set<string>([
      ...(agent.allowedTools || []),
      ...(agent.capabilities || []),
    ]);

    for (const tool of step.requiredTools) {
      if (!agentTools.has(tool) && !SYSTEM_PLATFORM_TOOLS.has(tool)) {
        return {
          eligible: false,
          score: 0,
        };
      }
    }

    // Pinned Model Revision Check
    if (reqs.model?.requiredRevision) {
      const agentRevision =
        (agent as any).modelRevision ||
        (agent as any).revision ||
        (agent.runtimeStats as any)?.modelRevision;
      if (agentRevision && agentRevision !== reqs.model.requiredRevision) {
        return {
          eligible: false,
          score: 0,
          hardFailureCode: 'MODEL_REVISION_MISMATCH',
          reason: `Agent "${agent.id}" has model revision "${agentRevision}", but task requires pinned revision "${reqs.model.requiredRevision}".`,
        };
      }
    }

    let score = 10;
    if (agent.idle) score += 5;
    if (agent.modalities?.includes(step.requiredModality)) score += 10;
    if (agent.capabilities?.includes(step.stepType.toLowerCase())) score += 5;

    return { eligible: true, score };
  }

  // ── Helper: DAG Cycle Detection ─────────────────────────────

  private detectCycles(steps: readonly WorkflowPlanStep[]): boolean {
    const inDegree = new Map<string, number>();
    const graph = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.stepId, 0);
      graph.set(step.stepId, []);
    }

    for (const step of steps) {
      for (const dep of step.dependencies) {
        if (graph.has(dep)) {
          graph.get(dep)!.push(step.stepId);
          inDegree.set(step.stepId, (inDegree.get(step.stepId) || 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    let visitedCount = 0;
    while (queue.length > 0) {
      const curr = queue.shift()!;
      visitedCount++;
      for (const next of graph.get(curr) || []) {
        const newDeg = inDegree.get(next)! - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return visitedCount < steps.length;
  }
}
