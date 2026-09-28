/**
 * MAOS Industrial — Deterministic Inference Service (F7-02)
 *
 * Implements deterministic classification, modality resolution, evidence
 * tracking, prompt-injection defense, and unambiguous clarification protocols.
 *
 * Core Guarantees:
 * 1. 100% Deterministic: Identical inputs yield identical InferenceResult and inputHash.
 * 2. Prompt Injection Neutralization: Attachment bodies are treated as data only;
 *    instructions inside attachments cannot hijack inference or override rules.
 * 3. Fail Closed / Clarification: Ambiguous or unsupported requests return
 *    structured clarification prompts or fail closed rather than guessing broadly.
 * 4. Non-Degradation: Enforces F7-01 non-degradation requirements.
 * 5. Privacy-Safe Audit: Logs inference decisions without raw sensitive prose.
 */

import * as crypto from 'crypto';
import type { AuditService } from './audit-service';
import type {
  InferenceInput,
  InferenceResult,
  InferenceRule,
  InferenceRuleMatch,
} from '../domain/inference';
import { validateInferenceInput, validateInferenceResult } from '../domain/validators';
import { INFERENCE_RULES_V1 } from '../industrial/inference-rules';

export interface InferenceServiceOptions {
  readonly auditService?: AuditService;
  readonly rules?: readonly InferenceRule[];
}

/**
 * Computes a deterministic SHA-256 hash over normalized input fields.
 */
export function computeCanonicalInputHash(input: InferenceInput): string {
  const normalizedText = input.text ? input.text.trim() : '';
  const normalizedAttachments = (input.attachments || [])
    .map((att) => ({
      name: att.name,
      mimeType: att.mimeType || '',
      sourcePath: att.sourcePath || '',
      sourceHash: att.sourceHash || '',
      sizeBytes: att.sizeBytes || 0,
      pageCount: att.pageCount || 0,
      artifactId: att.artifactId || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const canonicalObj = {
    text: normalizedText,
    attachments: normalizedAttachments,
  };

  return crypto.createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');
}

/**
 * Generates an explicit, actionable clarification prompt for ambiguous requests.
 */
function generateClarificationPrompt(input: InferenceInput, match?: InferenceRuleMatch): string {
  if (match?.reasons.includes('CONFLICTING_DELIVERABLE_INTENTS')) {
    return (
      'The request specifies multiple conflicting deliverable formats without an explicit workflow. ' +
      'Please clarify which deliverable you wish to generate:\n' +
      '1. DOCX (Word Document)\n' +
      '2. XLSX (Excel Spreadsheet)\n' +
      '3. PPTX (PowerPoint Presentation)\n' +
      'Or specify if you require the complete multi-deliverable pipeline.'
    );
  }

  if (match?.reasons.includes('INSUFFICIENT_SPECIFICATION_VAGUE_TEXT')) {
    const trimmed = input.text?.trim() || '';
    return (
      `The request is too brief or ambiguous ("${trimmed}"). Please specify the intended action:\n` +
      '1. Generate an office deliverable (DOCX, XLSX, or PPTX)\n' +
      '2. Extract text from a document via OCR\n' +
      '3. Inspect an image or diagram\n' +
      '4. Search or ingest the Knowledge Base\n' +
      '5. Implement or review source code'
    );
  }

  return (
    'The request could not be mapped to an unambiguous capability. ' +
    'Please provide additional context or specify the desired task modality and output format.'
  );
}

export class InferenceService {
  private readonly rules: readonly InferenceRule[];
  private readonly auditService?: AuditService;

  constructor(options: InferenceServiceOptions = {}) {
    this.auditService = options.auditService;
    // Sort rules descending by priority
    const baseRules = options.rules ?? INFERENCE_RULES_V1;
    this.rules = [...baseRules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Retrieves the configured inference rules in evaluation priority order.
   */
  public getRules(): readonly InferenceRule[] {
    return this.rules;
  }

  /**
   * Deterministically infers intent, requirements, modalities, and routing parameters.
   */
  public infer(input: InferenceInput): InferenceResult {
    // 1. Validate input
    const inputValidation = validateInferenceInput(input);
    if (!inputValidation.valid) {
      throw new Error(`Invalid InferenceInput: ${inputValidation.errors.join('; ')}`);
    }

    // 2. Canonical input hash
    const inputHash = computeCanonicalInputHash(input);

    // 3. Sequential priority rule evaluation
    for (const rule of this.rules) {
      const match = rule.matcher(input);
      if (match.matched) {
        let result: InferenceResult;

        if (rule.category === 'UNSUPPORTED') {
          result = {
            schemaVersion: 1,
            status: 'UNSUPPORTED',
            inferredIntent: rule.targetIntent,
            confidence: match.confidence,
            matchedRuleId: rule.ruleId,
            matchedRuleVersion: rule.version,
            reasoningCodes: match.reasons,
            supportingEvidence: match.evidence,
            requirements: null,
            selectedModality: null,
            selectedAgent: null,
            selectedWorkflow: null,
            clarificationPrompt: null,
            inputHash,
            deterministic: true,
          };
        } else if (rule.category === 'AMBIGUITY') {
          result = {
            schemaVersion: 1,
            status: 'CLARIFICATION_REQUIRED',
            inferredIntent: rule.targetIntent,
            confidence: match.confidence,
            matchedRuleId: rule.ruleId,
            matchedRuleVersion: rule.version,
            reasoningCodes: match.reasons,
            supportingEvidence: match.evidence,
            requirements: null,
            selectedModality: null,
            selectedAgent: null,
            selectedWorkflow: null,
            clarificationPrompt: generateClarificationPrompt(input, match),
            inputHash,
            deterministic: true,
          };
        } else {
          // Normal matched rule
          result = {
            schemaVersion: 1,
            status: 'MATCHED',
            inferredIntent: rule.targetIntent,
            confidence: match.confidence,
            matchedRuleId: rule.ruleId,
            matchedRuleVersion: rule.version,
            reasoningCodes: match.reasons,
            supportingEvidence: match.evidence,
            requirements: rule.inferredRequirements,
            selectedModality:
              rule.inferredRequirements.primaryModality ||
              rule.requiredModalities[0] ||
              'text',
            selectedAgent: rule.suggestedAgent ?? null,
            selectedWorkflow: rule.suggestedWorkflow ?? null,
            clarificationPrompt: null,
            inputHash,
            deterministic: true,
          };
        }

        // Validate result schema
        const resultValidation = validateInferenceResult(result);
        if (!resultValidation.valid) {
          throw new Error(`Constructed invalid InferenceResult: ${resultValidation.errors.join('; ')}`);
        }

        // Record audit event
        this.recordAudit(result, inputHash);

        return result;
      }
    }

    // 4. Fail-closed fallback when no rules match
    const fallbackResult: InferenceResult = {
      schemaVersion: 1,
      status: 'AMBIGUOUS',
      inferredIntent: 'unknown_intent',
      confidence: 0.0,
      matchedRuleId: null,
      matchedRuleVersion: null,
      reasoningCodes: ['NO_MATCHING_RULE_FOUND'],
      supportingEvidence: [],
      requirements: null,
      selectedModality: null,
      selectedAgent: null,
      selectedWorkflow: null,
      clarificationPrompt: generateClarificationPrompt(input),
      inputHash,
      deterministic: true,
    };

    const fallbackValidation = validateInferenceResult(fallbackResult);
    if (!fallbackValidation.valid) {
      throw new Error(`Constructed invalid fallback InferenceResult: ${fallbackValidation.errors.join('; ')}`);
    }

    this.recordAudit(fallbackResult, inputHash);

    return fallbackResult;
  }

  private recordAudit(result: InferenceResult, inputHash: string): void {
    if (!this.auditService) return;
    this.auditService.recordAuditEvent({
      category: 'stage',
      source: 'inference-service',
      data: {
        event: 'INFERENCE_EXECUTED',
        status: result.status,
        inferredIntent: result.inferredIntent,
        matchedRuleId: result.matchedRuleId,
        matchedRuleVersion: result.matchedRuleVersion,
        confidence: result.confidence,
        selectedModality: result.selectedModality,
        selectedAgent: result.selectedAgent,
        selectedWorkflow: result.selectedWorkflow,
        evidenceCount: result.supportingEvidence.length,
        inputHash,
      },
    });
  }
}
