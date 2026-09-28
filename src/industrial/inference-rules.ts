/**
 * MAOS Industrial — Deterministic Inference Rules Engine (F7-02)
 *
 * Provides explicit, versioned, and immutable inference rules for request
 * classification, modality resolution, tool requirements, and agent assignment.
 *
 * Invariants:
 * 1. 100% deterministic rule matching (same input -> identical rule match).
 * 2. Attachment content is treated as data only (prompt injection defense).
 * 3. Ambiguous and unsupported requests fail closed or request clarification.
 * 4. Non-degradation requirements are strictly generated.
 */

import * as path from 'path';
import type {
  InferenceInput,
  InferenceRule,
  InferenceRuleMatch,
  EvidenceReference,
  TaskAttachment,
} from '../domain/inference';
import type { ExtendedTaskRequirements, TaskModality } from '../domain/schemas';

// ── Attachment Helpers ────────────────────────────────────────

const OCR_EXTENSIONS = new Set(['.pdf', '.tiff', '.tif']);
const OCR_MIMES = new Set(['application/pdf', 'image/tiff', 'image/x-tiff']);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.svg']);
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
  'image/gif',
  'image/svg+xml',
]);

const OFFICE_DOCX_EXTENSIONS = new Set(['.docx']);
const OFFICE_DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const OFFICE_XLSX_EXTENSIONS = new Set(['.xlsx']);
const OFFICE_XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const OFFICE_PPTX_EXTENSIONS = new Set(['.pptx']);
const OFFICE_PPTX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.py',
  '.rs',
  '.go',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.java',
  '.json',
  '.sql',
  '.sh',
  '.bash',
  '.ps1',
  '.html',
  '.css',
]);

function getExtension(name: string): string {
  const ext = path.extname(name || '').toLowerCase();
  return ext;
}

function hasAttachmentMatching(
  attachments: readonly TaskAttachment[] | undefined,
  predicate: (att: TaskAttachment) => boolean,
): { found: boolean; attachment?: TaskAttachment } {
  if (!attachments || attachments.length === 0) return { found: false };
  for (const att of attachments) {
    if (predicate(att)) return { found: true, attachment: att };
  }
  return { found: false };
}

function buildAttachmentEvidence(
  att: TaskAttachment,
  matchDetail: string,
): EvidenceReference {
  return {
    source: 'attachment',
    ref: att.name,
    matchDetail,
    hash: att.sourceHash,
  };
}

// ── Unsupported Patterns ──────────────────────────────────────

const UNSUPPORTED_REGEX =
  /\b(deploy to aws|deploy to cloud|launch ec2|push to gcp|azure deploy|cloud run deploy|live scrape|scrape website live|browse internet|fetch from external url|cryptocurrency|crypto mine|mine crypto|crypto mining|mine bitcoin|bitcoin|bypass safety|disable sandbox|ignore safety constraints|bypass offline check|disable air-gap)\b/i;

// ── Ambiguity Patterns ────────────────────────────────────────

const VAGUE_PHRASES = new Set([
  'fix',
  'fix this',
  'fix it',
  'check',
  'check this',
  'review',
  'review this',
  'do it',
  'run',
  'help',
  'process',
  'update',
  'analyze',
  'analyze this',
  'start',
  'work on it',
  'handle this',
  'please inspect',
]);

// ── Version 1 Rules Registry ─────────────────────────────────

export const INFERENCE_RULES_V1: readonly InferenceRule[] = [
  // ── 1. Unsupported Request Detector (Priority 1000) ─────────
  {
    ruleId: 'RULE_UNSUPPORTED_DETECT',
    name: 'Unsupported Capability & Safety Gate Violation Detector',
    version: 1,
    priority: 1000,
    category: 'UNSUPPORTED',
    targetIntent: 'unsupported_capability',
    requiredModalities: ['text'],
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const match = text.match(UNSUPPORTED_REGEX);
      if (match) {
        return {
          matched: true,
          confidence: 1.0,
          reasons: ['UNSUPPORTED_REQUEST_PATTERN_DETECTED', `Matched disallowed term: "${match[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Disallowed unsupported operation: "${match[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 2. Ambiguity Detector (Priority 900) ────────────────────
  {
    ruleId: 'RULE_AMBIGUOUS_DETECT',
    name: 'Ambiguous & Conflicting Intent Detector',
    version: 1,
    priority: 900,
    category: 'AMBIGUITY',
    targetIntent: 'ambiguous_request',
    requiredModalities: ['text'],
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim().toLowerCase() || '';
      const attachments = input.attachments || [];

      // Case A: Extremely short/vague phrase without attachments
      if (attachments.length === 0 && (VAGUE_PHRASES.has(text) || (text.length > 0 && text.length <= 4))) {
        return {
          matched: true,
          confidence: 0.25,
          reasons: ['AMBIGUOUS_INPUT_DETECTED', 'INSUFFICIENT_SPECIFICATION_VAGUE_TEXT'],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Vague unspecific prompt text: "${input.text?.trim()}"`,
            },
          ],
        };
      }

      // Case B: Conflicting deliverable intents with equal standing
      const wantsDocx = /\b(docx|word report)\b/i.test(text);
      const wantsXlsx = /\b(xlsx|spreadsheet|excel)\b/i.test(text);
      const wantsPptx = /\b(pptx|slides|powerpoint)\b/i.test(text);
      const deliverableCount = (wantsDocx ? 1 : 0) + (wantsXlsx ? 1 : 0) + (wantsPptx ? 1 : 0);

      if (deliverableCount >= 2 && /\b(create|generate|draft)\b/i.test(text) && !/\b(pipeline|multi|all|unified)\b/i.test(text)) {
        return {
          matched: true,
          confidence: 0.35,
          reasons: ['CONFLICTING_DELIVERABLE_INTENTS', 'MULTIPLE_TARGET_FORMATS_WITHOUT_PIPELINE'],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Prompt simultaneously requests multiple distinct office deliverables without workflow context: ${text}`,
            },
          ],
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 3. Document OCR with Text Directives (Priority 100) ──────
  {
    ruleId: 'RULE_OCR_DOCUMENT',
    name: 'Document OCR & Scanned Text Extraction',
    version: 1,
    priority: 100,
    category: 'OCR',
    targetIntent: 'document_ocr',
    requiredModalities: ['vision', 'text'],
    suggestedAgent: 'ocr-specialist',
    suggestedWorkflow: 'document-processing-pipeline',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['vision', 'text'],
      primaryModality: 'vision',
      tools: {
        requiredTools: ['ocr_extract', 'artifact_read'],
        optionalTools: ['pdf_raster'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const ocrKeywordMatch = text.match(/\b(ocr|extract text|tesseract|scanned pdf|scanned document|transcribe document|read scan)\b/i);
      const pdfAttachment = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return OCR_EXTENSIONS.has(ext) || (att.mimeType ? OCR_MIMES.has(att.mimeType) : false);
      });

      if (ocrKeywordMatch) {
        const evidence: EvidenceReference[] = [
          {
            source: 'prompt',
            ref: 'text',
            matchDetail: `Matched OCR directive keyword: "${ocrKeywordMatch[0]}"`,
          },
        ];
        if (pdfAttachment.found && pdfAttachment.attachment) {
          evidence.push(buildAttachmentEvidence(pdfAttachment.attachment, 'Attached PDF/scanned document'));
        }
        return {
          matched: true,
          confidence: pdfAttachment.found ? 0.98 : 0.90,
          reasons: ['OCR_DIRECTIVE_KEYWORD_MATCHED', pdfAttachment.found ? 'SCANNED_DOCUMENT_ATTACHED' : 'OCR_PROMPT_ONLY'],
          evidence,
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 4. Document OCR Attachment-Only (Priority 95) ───────────
  {
    ruleId: 'RULE_OCR_ATTACHMENT_ONLY',
    name: 'Document OCR for Passive PDF/TIFF Attachment',
    version: 1,
    priority: 95,
    category: 'OCR',
    targetIntent: 'document_ocr_attachment',
    requiredModalities: ['vision', 'text'],
    suggestedAgent: 'ocr-specialist',
    suggestedWorkflow: 'document-processing-pipeline',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['vision', 'text'],
      primaryModality: 'vision',
      tools: {
        requiredTools: ['ocr_extract', 'artifact_read'],
        optionalTools: ['pdf_raster'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      // Only matches if text is empty or passive/generic
      if (text.length > 0 && !VAGUE_PHRASES.has(text.toLowerCase()) && !/^(extract|process|read|scan)$/i.test(text)) {
        return { matched: false, confidence: 0, reasons: [], evidence: [] };
      }

      const match = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return OCR_EXTENSIONS.has(ext) || (att.mimeType ? OCR_MIMES.has(att.mimeType) : false);
      });

      if (match.found && match.attachment) {
        return {
          matched: true,
          confidence: 0.92,
          reasons: ['PASSIVE_OCR_ATTACHMENT_DETECTED', `File extension: ${getExtension(match.attachment.name)}`],
          evidence: [buildAttachmentEvidence(match.attachment, 'PDF/TIFF document attachment without conflicting prompt')],
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 5. Image & Diagram Inspection with Text (Priority 90) ────
  {
    ruleId: 'RULE_IMAGE_ANALYSIS',
    name: 'Visual Diagram & Image Analysis',
    version: 1,
    priority: 90,
    category: 'IMAGE_ANALYSIS',
    targetIntent: 'image_inspection',
    requiredModalities: ['vision'],
    suggestedAgent: 'vision-inspector',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['vision'],
      primaryModality: 'vision',
      tools: {
        requiredTools: ['vision_inspect', 'artifact_read'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const visualKeyword = text.match(/\b(image analysis|inspect diagram|cad drawing|visual inspection|analyze image|detect defect|raster inspect|visual regression)\b/i);
      const imgAttachment = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return IMAGE_EXTENSIONS.has(ext) || (att.mimeType ? IMAGE_MIMES.has(att.mimeType) : false);
      });

      if (visualKeyword) {
        const evidence: EvidenceReference[] = [
          {
            source: 'prompt',
            ref: 'text',
            matchDetail: `Matched visual analysis keyword: "${visualKeyword[0]}"`,
          },
        ];
        if (imgAttachment.found && imgAttachment.attachment) {
          evidence.push(buildAttachmentEvidence(imgAttachment.attachment, 'Attached raster/vector image'));
        }
        return {
          matched: true,
          confidence: imgAttachment.found ? 0.97 : 0.88,
          reasons: ['VISUAL_INSPECTION_DIRECTIVE_MATCHED', imgAttachment.found ? 'IMAGE_ATTACHED' : 'VISUAL_PROMPT_ONLY'],
          evidence,
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 6. Image Attachment-Only (Priority 85) ──────────────────
  {
    ruleId: 'RULE_IMAGE_ATTACHMENT_ONLY',
    name: 'Visual Inspection for Passive Image Attachment',
    version: 1,
    priority: 85,
    category: 'IMAGE_ANALYSIS',
    targetIntent: 'image_inspection_attachment',
    requiredModalities: ['vision'],
    suggestedAgent: 'vision-inspector',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['vision'],
      primaryModality: 'vision',
      tools: {
        requiredTools: ['vision_inspect', 'artifact_read'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      if (text.length > 0 && !VAGUE_PHRASES.has(text.toLowerCase()) && !/^(inspect|analyze|view)$/i.test(text)) {
        return { matched: false, confidence: 0, reasons: [], evidence: [] };
      }

      const match = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return IMAGE_EXTENSIONS.has(ext) || (att.mimeType ? IMAGE_MIMES.has(att.mimeType) : false);
      });

      if (match.found && match.attachment) {
        return {
          matched: true,
          confidence: 0.91,
          reasons: ['PASSIVE_IMAGE_ATTACHMENT_DETECTED', `File extension: ${getExtension(match.attachment.name)}`],
          evidence: [buildAttachmentEvidence(match.attachment, 'Image attachment without explicit prompt')],
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 7. Generate DOCX Deliverable (Priority 80) ───────────────
  {
    ruleId: 'RULE_GENERATE_DOCX',
    name: 'Generate DOCX Word Document Deliverable',
    version: 1,
    priority: 80,
    category: 'DELIVERABLE',
    targetIntent: 'generate_docx',
    requiredModalities: ['text'],
    suggestedAgent: 'office-docx-builder',
    suggestedWorkflow: 'office-deliverable-generation',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['generate_docx', 'artifact_write'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const docxMatch = text.match(/\b(generate docx|create word document|word report|draft docx|engineering spec docx|audit report docx|write docx)\b/i);
      if (docxMatch) {
        return {
          matched: true,
          confidence: 0.96,
          reasons: ['DOCX_GENERATION_DIRECTIVE_MATCHED', `Keyword: "${docxMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Direct request for DOCX deliverable generation: "${docxMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 8. Generate XLSX Deliverable (Priority 80) ───────────────
  {
    ruleId: 'RULE_GENERATE_XLSX',
    name: 'Generate XLSX Spreadsheet Deliverable',
    version: 1,
    priority: 80,
    category: 'DELIVERABLE',
    targetIntent: 'generate_xlsx',
    requiredModalities: ['text'],
    suggestedAgent: 'office-xlsx-builder',
    suggestedWorkflow: 'office-deliverable-generation',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['generate_xlsx', 'artifact_write'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const xlsxMatch = text.match(/\b(generate xlsx|create spreadsheet|excel calculation|export xlsx|workbook|create excel sheet|draft xlsx)\b/i);
      if (xlsxMatch) {
        return {
          matched: true,
          confidence: 0.96,
          reasons: ['XLSX_GENERATION_DIRECTIVE_MATCHED', `Keyword: "${xlsxMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Direct request for XLSX spreadsheet generation: "${xlsxMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 9. Generate PPTX Deliverable (Priority 80) ───────────────
  {
    ruleId: 'RULE_GENERATE_PPTX',
    name: 'Generate PPTX Presentation Deliverable',
    version: 1,
    priority: 80,
    category: 'DELIVERABLE',
    targetIntent: 'generate_pptx',
    requiredModalities: ['text'],
    suggestedAgent: 'office-pptx-builder',
    suggestedWorkflow: 'office-deliverable-generation',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['generate_pptx', 'artifact_write'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const pptxMatch = text.match(/\b(generate pptx|create presentation|powerpoint slides|slide deck|slideshow|pitch deck|draft pptx)\b/i);
      if (pptxMatch) {
        return {
          matched: true,
          confidence: 0.96,
          reasons: ['PPTX_GENERATION_DIRECTIVE_MATCHED', `Keyword: "${pptxMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Direct request for PPTX presentation generation: "${pptxMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 10. Office Attachment-Only (Priority 75) ─────────────────
  {
    ruleId: 'RULE_OFFICE_ATTACHMENT_ONLY',
    name: 'Office Package Inspection for Attached OOXML',
    version: 1,
    priority: 75,
    category: 'DELIVERABLE',
    targetIntent: 'inspect_office_deliverable',
    requiredModalities: ['text'],
    suggestedAgent: 'office-reviewer',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['artifact_read'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      if (text.length > 0 && !VAGUE_PHRASES.has(text.toLowerCase()) && !/^(inspect|review|verify)$/i.test(text)) {
        return { matched: false, confidence: 0, reasons: [], evidence: [] };
      }

      const match = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return (
          OFFICE_DOCX_EXTENSIONS.has(ext) ||
          OFFICE_XLSX_EXTENSIONS.has(ext) ||
          OFFICE_PPTX_EXTENSIONS.has(ext) ||
          (att.mimeType ? OFFICE_DOCX_MIMES.has(att.mimeType) || OFFICE_XLSX_MIMES.has(att.mimeType) || OFFICE_PPTX_MIMES.has(att.mimeType) : false)
        );
      });

      if (match.found && match.attachment) {
        return {
          matched: true,
          confidence: 0.90,
          reasons: ['OFFICE_PACKAGE_ATTACHMENT_DETECTED', `File: ${match.attachment.name}`],
          evidence: [buildAttachmentEvidence(match.attachment, 'Attached OOXML deliverable file for inspection')],
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 11. Knowledge Base Search (Priority 70) ──────────────────
  {
    ruleId: 'RULE_KB_SEARCH',
    name: 'Knowledge Base Retrieval & Query',
    version: 1,
    priority: 70,
    category: 'KB',
    targetIntent: 'kb_search',
    requiredModalities: ['text'],
    suggestedAgent: 'kb-researcher',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['kb_search'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const kbMatch = text.match(/\b(kb search|search knowledge base|find in corpus|query documentation|retrieve docs|lookup spec|search kb)\b/i);
      if (kbMatch) {
        return {
          matched: true,
          confidence: 0.94,
          reasons: ['KB_SEARCH_DIRECTIVE_MATCHED', `Keyword: "${kbMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Knowledge base lookup request: "${kbMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 12. Knowledge Base Ingestion (Priority 70) ────────────────
  {
    ruleId: 'RULE_KB_INGESTION',
    name: 'Knowledge Base Ingestion & Vector Indexing',
    version: 1,
    priority: 70,
    category: 'KB',
    targetIntent: 'kb_ingestion',
    requiredModalities: ['text'],
    suggestedAgent: 'kb-curator',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['kb_ingest', 'kb_embed'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const ingestMatch = text.match(/\b(ingest corpus|index directory|embed documentation|rebuild kb index|ingest folder|build vector index)\b/i);
      if (ingestMatch) {
        return {
          matched: true,
          confidence: 0.95,
          reasons: ['KB_INGESTION_DIRECTIVE_MATCHED', `Keyword: "${ingestMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Corpus ingestion request: "${ingestMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 13. Code Development (Priority 60) ───────────────────────
  {
    ruleId: 'RULE_CODE_DEVELOPMENT',
    name: 'Software Implementation & Refactoring',
    version: 1,
    priority: 60,
    category: 'CODE',
    targetIntent: 'code_development',
    requiredModalities: ['code', 'text'],
    suggestedAgent: 'coder',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['code', 'text'],
      primaryModality: 'code',
      tools: {
        requiredTools: ['file_write', 'file_read', 'bash'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const codeMatch = text.match(/\b(implement function|refactor|write typescript|write python|fix bug|create class|unit test|compile rust|build script|npm run|debug code)\b/i);
      if (codeMatch) {
        return {
          matched: true,
          confidence: 0.93,
          reasons: ['CODE_DEVELOPMENT_DIRECTIVE_MATCHED', `Keyword: "${codeMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Code engineering task: "${codeMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 14. Code Attachment-Only (Priority 55) ───────────────────
  {
    ruleId: 'RULE_CODE_ATTACHMENT_ONLY',
    name: 'Code Analysis for Source Code Attachment',
    version: 1,
    priority: 55,
    category: 'CODE',
    targetIntent: 'code_analysis_attachment',
    requiredModalities: ['code', 'text'],
    suggestedAgent: 'coder',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['code', 'text'],
      primaryModality: 'code',
      tools: {
        requiredTools: ['file_read'],
      },
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      if (text.length > 0 && !VAGUE_PHRASES.has(text.toLowerCase()) && !/^(inspect|review|test)$/i.test(text)) {
        return { matched: false, confidence: 0, reasons: [], evidence: [] };
      }

      const match = hasAttachmentMatching(input.attachments, att => {
        const ext = getExtension(att.name);
        return CODE_EXTENSIONS.has(ext);
      });

      if (match.found && match.attachment) {
        return {
          matched: true,
          confidence: 0.90,
          reasons: ['CODE_ATTACHMENT_DETECTED', `File: ${match.attachment.name}`],
          evidence: [buildAttachmentEvidence(match.attachment, 'Source code file attachment')],
        };
      }

      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 15. Code Review (Priority 50) ────────────────────────────
  {
    ruleId: 'RULE_CODE_REVIEW',
    name: 'Peer Code & PR Review',
    version: 1,
    priority: 50,
    category: 'REVIEW',
    targetIntent: 'code_review',
    requiredModalities: ['code', 'text'],
    suggestedAgent: 'reviewer',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['code', 'text'],
      primaryModality: 'code',
      allowDegradation: false,
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const reviewMatch = text.match(/\b(code review|review pr|audit diff|review pull request|review code quality|check code standards)\b/i);
      if (reviewMatch) {
        return {
          matched: true,
          confidence: 0.92,
          reasons: ['CODE_REVIEW_DIRECTIVE_MATCHED', `Keyword: "${reviewMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Code review request: "${reviewMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 16. Architecture & Planning (Priority 45) ────────────────
  {
    ruleId: 'RULE_ARCHITECTURE_PLANNING',
    name: 'System Architecture & Task Decomposition',
    version: 1,
    priority: 45,
    category: 'ARCHITECTURE',
    targetIntent: 'architecture_planning',
    requiredModalities: ['text'],
    suggestedAgent: 'architect',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const archMatch = text.match(/\b(architecture plan|system design|decompose tasks|implementation roadmap|workflow orchestrator|subsystem specification)\b/i);
      if (archMatch) {
        return {
          matched: true,
          confidence: 0.91,
          reasons: ['ARCHITECTURE_PLANNING_DIRECTIVE_MATCHED', `Keyword: "${archMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Architecture and planning request: "${archMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 17. Verification & Audit (Priority 40) ───────────────────
  {
    ruleId: 'RULE_VERIFICATION_AUDIT',
    name: 'Verification & Gate Compliance Audit',
    version: 1,
    priority: 40,
    category: 'AUDIT',
    targetIntent: 'verification_audit',
    requiredModalities: ['text'],
    suggestedAgent: 'verifier',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
      tools: {
        requiredTools: ['audit_verify', 'verifier_run'],
      },
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      const auditMatch = text.match(/\b(run verification|verify test results|compliance audit|audit trail verification|safety sign-off|verify gate)\b/i);
      if (auditMatch) {
        return {
          matched: true,
          confidence: 0.94,
          reasons: ['VERIFICATION_AUDIT_DIRECTIVE_MATCHED', `Keyword: "${auditMatch[0]}"`],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Verification and audit request: "${auditMatch[0]}"`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },

  // ── 18. General Text QA (Priority 10) ────────────────────────
  {
    ruleId: 'RULE_GENERAL_TEXT',
    name: 'General Text Explanation & Dialogue',
    version: 1,
    priority: 10,
    category: 'GENERAL',
    targetIntent: 'general_text_query',
    requiredModalities: ['text'],
    suggestedAgent: 'general-assistant',
    inferredRequirements: {
      schemaVersion: 1,
      modalities: ['text'],
      primaryModality: 'text',
    },
    matcher: (input: InferenceInput): InferenceRuleMatch => {
      const text = input.text?.trim() || '';
      // Require sufficient length to avoid capturing ambiguous single words
      if (text.length >= 10 && !VAGUE_PHRASES.has(text.toLowerCase())) {
        return {
          matched: true,
          confidence: 0.80,
          reasons: ['GENERAL_TEXT_QUERY_MATCHED', 'PROMPT_LENGTH_SUFFICIENT'],
          evidence: [
            {
              source: 'prompt',
              ref: 'text',
              matchDetail: `Text query with ${text.length} characters`,
            },
          ],
        };
      }
      return { matched: false, confidence: 0, reasons: [], evidence: [] };
    },
  },
];
