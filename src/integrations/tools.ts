import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { ToolDef } from '../backends/provider';
import { guardWriteFile, validateCommand, getFileLockRegistry, ScopeViolation, assertRealWritePathContained, isPathInScope as checkPathInScope } from '../core/scope-guard';
import { getMemoryStore, MemoryType } from '../core/context-memory';
import {
  OcrDocumentInput,
  OcrDocumentToolResult,
  OcrPageToolResult,
  OcrOptions,
  OcrDocumentResult,
  OcrError,
  OCR_BOUNDS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  validateOcrDocumentInput,
} from '../domain/ocr';
import {
  AnalyzeImageInput,
  AnalyzeImageResult,
  ImageObservation,
  VlmError,
  VLM_ERROR_CODES,
  VISION_BOUNDS,
  PINNED_VLM_CONFIG,
  validateAnalyzeImageInput,
} from '../domain/vision';
import {
  KbSearchInput,
  KbSearchResult,
  KbSearchAnswerResult,
  KbSearchNoAnswerResult,
  KbSearchCitation,
  KbSearchError,
  KbSearchErrorCode,
  KB_SEARCH_BOUNDS,
  validateKbSearchInput,
} from '../domain/kb-search';
import {
  DocxGenerationError,
  DocxGenerationErrorCode,
  GenerateDocxToolInput,
  GenerateDocxToolResult,
  XlsxGenerationError,
  XlsxGenerationErrorCode,
  GenerateXlsxToolInput,
  GenerateXlsxToolResult,
  PptxGenerationError,
  PptxGenerationErrorCode,
  GeneratePptxToolInput,
  GeneratePptxToolResult,
} from '../domain/office-artifact';
import type { ToolExecutionPlan, PreExecutionEvaluationOutcome } from '../domain/tool-plan';
import {
  ToolApprovalPlanner,
  ToolPreExecutionContext,
} from '../industrial/tool-approval-planner';
import {
  createServiceContainer,
  ServiceContainer,
  OcrService,
  VisionService,
  AuditService,
  DurableIdempotencyStore,
  KbSearchService,
  DocxGeneratorService,
  XlsxGeneratorService,
  PptxGeneratorService,
  SandboxRunnerService,
} from '../service';
import {
  AUTHORIZED_CODE_SANDBOX_AGENTS,
  CONTAINER_RUNNER_ERROR_CODES,
  ContainerRunnerError,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from '../domain/sandbox-run';

/**
 * MAOS Agent Tool Definitions
 *
 * These are the tools that every agent has access to.
 * The agent runner calls these when the model requests tool execution.
 */

// ─── Tool Definitions (sent to the model) ─────────────────────

export const AGENT_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'ocr_document',
      description:
        'Extract printed text with bounding boxes, confidence, and provenance from a project-local PDF document.',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for ocr_document input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          sourcePath: {
            type: 'string',
            description: 'Relative project path to the PDF document (e.g., "evidence/scan.pdf")',
          },
          sourceArtifactId: {
            type: 'string',
            description: 'Optional source artifact identifier if document was already ingested',
          },
          language: {
            type: 'string',
            description: 'OCR language code (default "en")',
          },
          pageRange: {
            type: 'object',
            properties: {
              start: { type: 'number', description: 'Starting page number (1-indexed, inclusive)' },
              end: { type: 'number', description: 'Ending page number (1-indexed, inclusive)' },
            },
            description: 'Optional bounded page range to extract',
          },
          confidenceMode: {
            type: 'string',
            enum: ['standard', 'strict'],
            description: 'Confidence evaluation mode ("standard" or "strict")',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
          expectedSourceHash: {
            type: 'string',
            description: 'Optional 64-character SHA-256 hex hash of the source PDF',
          },
        },
        required: ['schemaVersion', 'projectId', 'sourcePath', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description:
        'Analyze an image (PNG, JPEG, WEBP, BMP) using the pinned Vision-Language Model to extract structured visual observations (measurements, label readings, drawing observations).',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for analyze_image input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          sourcePath: {
            type: 'string',
            description:
              'Relative project path to the image file (e.g., "evidence/inspection.png"). Mutually exclusive with sourceArtifactId.',
          },
          sourceArtifactId: {
            type: 'string',
            description:
              'Artifact ID of the image in the Safe Artifact Store. Mutually exclusive with sourcePath.',
          },
          imageHash: {
            type: 'string',
            description: 'Optional expected 64-character SHA-256 hex hash of the source image',
          },
          prompt: {
            type: 'string',
            description:
              'Observation prompt or question for the Vision-Language Model (max 4096 chars)',
          },
          taskType: {
            type: 'string',
            enum: ['measurement', 'label-reading', 'drawing-observation', 'general-observation'],
            description: 'Industrial task type for vision analysis',
          },
          maxOutputTokens: {
            type: 'number',
            description: 'Maximum tokens for model output (1 to 2048)',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
          expectedModelId: {
            type: 'string',
            description: 'Optional expected model ID (defaults to pinned VLM)',
          },
          expectedModelRevision: {
            type: 'string',
            description: 'Optional expected model revision (defaults to pinned revision)',
          },
          allowCpuFallback: {
            type: 'boolean',
            description: 'Allow fallback to CPU if GPU memory budget is unavailable',
          },
        },
        required: [
          'schemaVersion',
          'projectId',
          'prompt',
          'taskType',
          'maxOutputTokens',
          'requestId',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description:
        'Search the project-local knowledge base vector index using semantic similarity. Returns deterministic, citation-preserving passages with provenance.',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for search_knowledge_base input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          query: {
            type: 'string',
            description: 'Natural language or keyword search query text (max 2048 characters)',
          },
          topK: {
            type: 'number',
            description: 'Maximum number of citations to return (1 to 50, default 5)',
          },
          minScore: {
            type: 'number',
            description: 'Minimum cosine similarity score threshold (0.0 to 1.0, default 0.0)',
          },
          filter: {
            type: 'object',
            properties: {
              sourcePaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter citations to specific relative source paths',
              },
              documentIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter citations to specific document IDs',
              },
              mimeTypes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter citations to specific MIME types (e.g., "application/pdf", "text/plain")',
              },
              pageNumbers: {
                type: 'array',
                items: { type: 'number' },
                description: 'Filter citations to specific page numbers',
              },
              sectionHeadings: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter citations to specific section headings',
              },
            },
            description: 'Optional metadata filters',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
        },
        required: ['schemaVersion', 'projectId', 'query', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_docx',
      description:
        'Generate an air-gapped, verifiable DOCX approval note from validated OfficeDocxInput.',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for generate_docx input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          input: {
            type: 'object',
            description: 'Validated OfficeDocxInput contract payload',
          },
          outputPath: {
            type: 'string',
            description: 'Relative project path for the generated .docx file (e.g., "artifacts/approval_note.docx")',
          },
          templatePath: {
            type: 'string',
            description: 'Optional relative project path to an approved offline DOCX/DOTX template',
          },
          allowOverwrite: {
            type: 'boolean',
            description: 'Whether to allow overwriting an existing output (requires valid approval)',
          },
          approvalId: {
            type: 'string',
            description: 'Approval ID authorizing document generation or overwrite',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
        },
        required: ['schemaVersion', 'projectId', 'input', 'outputPath', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_xlsx',
      description:
        'Generate an air-gapped, verifiable XLSX workbook deliverable from validated OfficeXlsxInput.',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for generate_xlsx input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          input: {
            type: 'object',
            description: 'Validated OfficeXlsxInput contract payload',
          },
          outputPath: {
            type: 'string',
            description: 'Relative project path for the generated .xlsx file (e.g., "artifacts/verification_workbook.xlsx")',
          },
          templatePath: {
            type: 'string',
            description: 'Optional relative project path to an approved offline XLSX/XLTX template',
          },
          allowOverwrite: {
            type: 'boolean',
            description: 'Whether to allow overwriting an existing output (requires valid approval)',
          },
          approvalId: {
            type: 'string',
            description: 'Approval ID authorizing document generation or overwrite',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
        },
        required: ['schemaVersion', 'projectId', 'input', 'outputPath', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_pptx',
      description:
        'Generate an air-gapped, verifiable PPTX presentation deliverable from validated OfficePptxInput.',
      parameters: {
        type: 'object',
        properties: {
          schemaVersion: {
            type: 'number',
            description: 'Schema version for generate_pptx input (must be 1)',
          },
          projectId: {
            type: 'string',
            description: 'Active project identifier',
          },
          input: {
            type: 'object',
            description: 'Validated OfficePptxInput contract payload',
          },
          outputPath: {
            type: 'string',
            description: 'Relative project path for the generated .pptx file (e.g., "artifacts/safety_deck.pptx")',
          },
          templatePath: {
            type: 'string',
            description: 'Optional relative project path to an approved offline PPTX/POTX template',
          },
          allowOverwrite: {
            type: 'boolean',
            description: 'Whether to allow overwriting an existing output (requires valid approval)',
          },
          approvalId: {
            type: 'string',
            description: 'Approval ID authorizing document generation or overwrite',
          },
          requestId: {
            type: 'string',
            description: 'Unique request ID for durable idempotency claim',
          },
        },
        required: ['schemaVersion', 'projectId', 'input', 'outputPath', 'requestId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ingest_document',
      description: 'Parse a project-local TXT, CSV, JSON, or text-based PDF into bounded structured evidence.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative project path to the document' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description:
        'Run a short Python script in a project-local temporary sandbox. Output is bounded and execution times out after 30 seconds.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Python source code to execute' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_code_sandbox',
      description:
        'Run Python source code strictly inside the isolated, pinned, offline sandbox container. Output is bounded and execution times out after 30 seconds.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Python source code to execute inside the sandbox container',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional command-line arguments to pass to the script',
          },
          files: {
            type: 'object',
            description: 'Optional map of relative filenames to file contents staged in the container workspace',
          },
          timeoutMs: {
            type: 'number',
            description: 'Execution timeout in milliseconds (max 30000)',
          },
          maxOutputBytes: {
            type: 'number',
            description: 'Maximum stdout/stderr bytes before truncation (max 50000)',
          },
          projectId: {
            type: 'string',
            description: 'Optional active project identifier',
          },
          requestId: {
            type: 'string',
            description: 'Optional unique request ID for durable idempotency claim',
          },
          approvalId: {
            type: 'string',
            description: 'Optional approval ID authorizing execution',
          },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_compliance',
      description: 'Deterministically evaluate measurements against configured warning and critical thresholds.',
      parameters: {
        type: 'object',
        properties: {
          measurements: { type: 'object', description: 'Map of metric names to numeric values' },
          thresholds: {
            type: 'object',
            description: 'Map to {warning, critical, unit}; bounds may be numbers or {min,max}',
          },
          thresholds_path: { type: 'string', description: 'Optional project-local JSON threshold file' },
        },
        required: ['measurements'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file in the project. Use this before modifying any file to understand existing code.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the project root (e.g., "src/api/auth.ts")',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from the project root',
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the contents of a directory. Returns file names, sizes, and whether each entry is a file or directory.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the directory from the project root (e.g., "src/components/")',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command and return stdout/stderr. Use for npm install, running tests, checking types, etc. Commands run from the project root.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute (e.g., "npm test", "npx tsc --noEmit")',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description:
        'Stage all changes and create a git commit with the given message. Use when you have completed a logical unit of work.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Descriptive commit message (e.g., "feat: add login page with glassmorphism design")',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Search the codebase for a pattern. Returns matching lines with file paths and line numbers. Use to understand existing patterns before writing new code.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search pattern (text or regex)',
          },
          file_pattern: {
            type: 'string',
            description: 'Optional glob pattern to filter files (e.g., "*.ts", "src/**/*.tsx")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description:
        'Signal that you have finished the task. Call this when all work is done and committed. Provide a summary of what you accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'A brief summary of what was accomplished (e.g., "Created login page with email/password form, glassmorphism styling, and responsive layout")',
          },
          files_changed: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of files that were created or modified',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_knowledge',
      description:
        'Share a discovery, decision, or warning with other agents on the team. Use this when you learn something that would help other agents work more efficiently (e.g., project structure, tech stack, important constraints, architectural decisions).',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['DISCOVERY', 'DECISION', 'WARNING', 'FILE_MAP'],
            description:
              'Type of knowledge: DISCOVERY (factual finding), DECISION (architectural choice), WARNING (pitfall/constraint), FILE_MAP (project structure)',
          },
          content: {
            type: 'string',
            description: 'The knowledge to share (be concise but specific)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Searchable tags (e.g., ["frontend", "react", "routing"])',
          },
          confidence: {
            type: 'number',
            description: 'How confident you are: 0.0 = guess, 0.5 = inference, 1.0 = verified fact. Default: 1.0',
          },
        },
        required: ['type', 'content', 'tags'],
      },
    },
  },
  // ── v0.3: Agent Negotiation Tools ──────────────────────────────
  {
    type: 'function',
    function: {
      name: 'request_from_team',
      description:
        'Request information or artifacts from other agents on the team. Use when you need data another agent has produced (e.g., API schema, database models, component interfaces). The response will appear in your next iteration.',
      parameters: {
        type: 'object',
        properties: {
          need: {
            type: 'string',
            description: 'What you need (e.g., "REST API routes", "database schema", "auth token format")',
          },
          context: {
            type: 'string',
            description: 'Why you need it and how you will use it',
          },
          urgency: {
            type: 'string',
            enum: ['blocking', 'nice_to_have'],
            description: 'How urgently you need this. blocking = cannot proceed without it.',
          },
        },
        required: ['need', 'context'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_team',
      description:
        'Respond to a request from another agent on the team. Use when you see a pending team request that you can answer.',
      parameters: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            description: 'The request ID to respond to',
          },
          response: {
            type: 'string',
            description: 'Your response — the information or artifact requested',
          },
        },
        required: ['requestId', 'response'],
      },
    },
  },
];

// ─── Tool Executors ───────────────────────────────────────────

/**
 * Scope enforcement: check if a file path is within allowed directories.
 * Supports patterns like "/", "src/", "src/api/" etc.
 * "/" means unrestricted access.
 *
 * NOTE: This is now a thin wrapper around scope-guard.ts.
 * Kept for backward compat but the real logic is in scope-guard.
 */
function isPathInScope(filePath: string, scope: string[], projectRoot: string): boolean {
  return checkPathInScope(filePath, scope, projectRoot);
}

const TOOL_OUTPUT_LIMIT = 200_000;
function jsonResult(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= TOOL_OUTPUT_LIMIT
    ? serialized
    : JSON.stringify({ ok: false, error: `Structured tool result exceeded ${TOOL_OUTPUT_LIMIT} characters` });
}
function projectFile(projectRoot: string, input: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, input || '');
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Path must remain inside the project root');
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(resolved);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
      throw new Error('Resolved path must remain inside the project root');
  }
  return resolved;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && records.length <= 1000; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value.length > 0)) records.push(row);
      row = [];
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell.trim());
    records.push(row);
  }
  return { headers: records[0] || [], rows: records.slice(1, 1001) };
}

function ingestDocument(projectRoot: string, args: Record<string, any>): unknown {
  const filePath = projectFile(projectRoot, args.path);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`File not found: ${args.path}`);
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath);
  if (raw.length > 2 * 1024 * 1024) throw new Error('Document exceeds the 2 MB ingestion limit');
  const contentLimit = 100_000;
  if (ext === '.txt' || ext === '.md' || ext === '.log')
    return {
      ok: true,
      format: ext.slice(1),
      path: args.path,
      content: raw.toString('utf8').substring(0, contentLimit),
      truncated: raw.length > contentLimit,
    };
  if (ext === '.csv') {
    const parsed = parseCsv(raw.toString('utf8'));
    return {
      ok: true,
      format: 'csv',
      path: args.path,
      headers: parsed.headers,
      rows: parsed.rows,
      rowCount: parsed.rows.length,
      truncated: raw.length > TOOL_OUTPUT_LIMIT,
    };
  }
  if (ext === '.json')
    return { ok: true, format: 'json', path: args.path, data: JSON.parse(raw.toString('utf8')), truncated: false };
  if (ext === '.pdf') {
    try {
      const content = execFileSync('pdftotext', ['-layout', filePath, '-'], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        ok: true,
        format: 'pdf',
        path: args.path,
        content: content.substring(0, contentLimit),
        truncated: content.length > contentLimit,
      };
    } catch {
      throw new Error(
        'Text PDF extraction unavailable. Install the local Poppler pdftotext utility or convert the PDF to TXT. Scanned PDFs require OCR and are not supported.',
      );
    }
  }
  throw new Error(`Unsupported document type '${ext || 'unknown'}'. Use TXT, CSV, JSON, or PDF.`);
}

function isIndustrialProfileEnvironment(projectRoot: string, profileMode?: string): boolean {
  if (profileMode) {
    const lower = profileMode.toLowerCase();
    if (lower.includes('industrial') || lower.includes('sovereign')) return true;
    if (lower.includes('cloud') || lower.includes('dev')) return false;
  }
  if (process.env.MAOS_PROFILE === 'industrial' || process.env.NODE_ENV === 'industrial') {
    return true;
  }
  try {
    const configPath = path.join(projectRoot, 'profiles', 'industrial', 'maos.config.json');
    if (fs.existsSync(configPath)) return true;
    const rootConfig = path.join(projectRoot, '.maos', 'maos.config.json');
    if (fs.existsSync(rootConfig)) {
      const parsed = JSON.parse(fs.readFileSync(rootConfig, 'utf8'));
      if (parsed.profile?.id === 'industrial' || parsed.profile?.mode === 'sovereign-local') {
        return true;
      }
    }
  } catch {}
  return true; // Fail-closed to industrial by default
}

function executePython(projectRoot: string, args: Record<string, any>): unknown {
  const isIndustrial = isIndustrialProfileEnvironment(projectRoot, args?.profileMode);

  if (
    isIndustrial ||
    args?.executorType === 'host' ||
    !args?.profileMode ||
    String(args?.profileMode).includes('tampered')
  ) {
    if (isIndustrial || !args?.profileMode || String(args?.profileMode).includes('tampered') || args?.executorType === 'host') {
      return {
        ok: false,
        error: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
        message:
          "Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.",
      };
    }
  }

  if (typeof args.script !== 'string' || !args.script.trim()) throw new Error('script is required');
  const sandboxRoot = path.join(projectRoot, '.maos', 'industrial-sandbox');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(sandboxRoot, 'run-'));
  const scriptPath = path.join(sandbox, `${randomUUID()}.py`);
  fs.writeFileSync(scriptPath, args.script, 'utf8');
  const outputLimit = 50_000;
  try {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const result = execFileSync(python, [scriptPath, ...(Array.isArray(args.args) ? args.args.map(String) : [])], {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: outputLimit * 2,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    return { ok: true, exitCode: 0, stdout: String(result).substring(0, outputLimit), stderr: '' };
  } catch (err: any) {
    return {
      ok: false,
      exitCode: typeof err.status === 'number' ? err.status : null,
      timedOut: err.code === 'ETIMEDOUT',
      stdout: String(err.stdout || '').substring(0, outputLimit),
      stderr: String(err.stderr || err.message || '').substring(0, outputLimit),
    };
  } finally {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

function checkCompliance(projectRoot: string, args: Record<string, any>): unknown {
  const measurements = args.measurements && typeof args.measurements === 'object' ? args.measurements : {};
  let thresholds: Record<string, any> = args.thresholds || {};
  let rulesetId: string | null = null;
  if (args.thresholds_path) {
    const p = projectFile(projectRoot, args.thresholds_path);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    rulesetId = raw.rulesetId || null;
    thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : raw;
  }
  if (thresholds.thresholds && typeof thresholds.thresholds === 'object') thresholds = thresholds.thresholds;
  const findings = Object.entries(measurements).map(([metric, value]) => {
    const rule = thresholds[metric];
    const numeric = Number(value);
    if (!rule || !Number.isFinite(numeric))
      return {
        ruleId: rulesetId ? `${rulesetId}/${metric}` : metric,
        metric,
        value: String(value),
        observedNumeric: numeric,
        unit: null,
        status: 'WARNING' as const,
        threshold: null,
        deviation: null,
        recommendation: 'Provide a numeric value and configured threshold.',
      };
    const critical = typeof rule.critical === 'number' ? rule.critical : rule.critical?.max;
    const warning = typeof rule.warning === 'number' ? rule.warning : rule.warning?.max;
    const minimumCritical = rule.critical?.min;
    const minimumWarning = rule.warning?.min;
    let status: 'PASS' | 'WARNING' | 'FAIL' = 'PASS';
    let limit: number | undefined;
    if (critical !== undefined && numeric >= critical) {
      status = 'FAIL';
      limit = critical;
    } else if (minimumCritical !== undefined && numeric <= minimumCritical) {
      status = 'FAIL';
      limit = minimumCritical;
    } else if (warning !== undefined && numeric >= warning) {
      status = 'WARNING';
      limit = warning;
    } else if (minimumWarning !== undefined && numeric <= minimumWarning) {
      status = 'WARNING';
      limit = minimumWarning;
    } else limit = critical ?? warning ?? minimumCritical ?? minimumWarning;
    const deviation = typeof limit === 'number' ? numeric - limit : null;
    // Use per-status recommendations from threshold config (recommendations.WARNING / recommendations.FAIL)
    const recommendations = rule.recommendations || {};
    const fallbackRec = rule.recommendation || (status === 'WARNING'
      ? 'Inspect trend and schedule maintenance.'
      : 'Stop or isolate equipment and investigate immediately.');
    return {
      ruleId: rulesetId ? `${rulesetId}/${metric}` : metric,
      metric,
      value: String(value),
      observedNumeric: numeric,
      unit: rule.unit || null,
      status,
      threshold: { warning: rule.warning ?? null, critical: rule.critical ?? null },
      deviation,
      recommendation: status === 'PASS' ? 'No action required.' : (recommendations[status] || fallbackRec),
    };
  });
  const status = findings.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : findings.some((f) => f.status === 'WARNING')
      ? 'WARNING'
      : 'PASS';
  return { ok: true, rulesetId, status, findings };
}

export const AUTHORIZED_OCR_AGENTS = [
  'ingest_agent',
  'analyst_agent',
  'auditor_agent',
  'inspector',
  'analyst',
  'architect',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
];

export const AUTHORIZED_ANALYZE_IMAGE_AGENTS = [
  'ingest_agent',
  'analyst_agent',
  'auditor_agent',
  'inspector',
  'analyst',
  'architect',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
  'admin',
];

export const AUTHORIZED_SEARCH_KB_AGENTS = [
  'retrieval_agent',
  'ingest_agent',
  'analyst_agent',
  'auditor_agent',
  'inspector',
  'analyst',
  'architect',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
  'admin',
];

export const AUTHORIZED_GENERATE_DOCX_AGENTS = [
  'report_agent',
  'doc_agent',
  'supervisor_agent',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
  'admin',
];

export const AUTHORIZED_GENERATE_XLSX_AGENTS = [
  'report_agent',
  'doc_agent',
  'supervisor_agent',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
  'admin',
];

export const AUTHORIZED_GENERATE_PPTX_AGENTS = [
  'report_agent',
  'doc_agent',
  'supervisor_agent',
  'lead-inspector',
  'auditor',
  'test-agent',
  'verification',
  'admin',
];

export function getToolsForAgent(
  allowedToolsOrAgentId?: string[] | string,
  agentIdOrAllowedTools?: string | string[],
  profileMode?: string,
): ToolDef[] {
  let effectiveAllowed: string[] | undefined;
  let effectiveAgentId: string | undefined;

  if (typeof allowedToolsOrAgentId === 'string') {
    effectiveAgentId = allowedToolsOrAgentId;
    if (Array.isArray(agentIdOrAllowedTools)) {
      effectiveAllowed = agentIdOrAllowedTools;
    }
  } else if (Array.isArray(allowedToolsOrAgentId)) {
    effectiveAllowed = allowedToolsOrAgentId;
    if (typeof agentIdOrAllowedTools === 'string') {
      effectiveAgentId = agentIdOrAllowedTools;
    }
  } else {
    if (typeof agentIdOrAllowedTools === 'string') {
      effectiveAgentId = agentIdOrAllowedTools;
    } else if (Array.isArray(agentIdOrAllowedTools)) {
      effectiveAllowed = agentIdOrAllowedTools;
    }
  }

  const isIndustrial =
    profileMode?.toLowerCase().includes('industrial') ||
    profileMode?.toLowerCase().includes('sovereign') ||
    process.env.MAOS_PROFILE === 'industrial';

  let baseTools = AGENT_TOOLS;
  if (isIndustrial) {
    baseTools = baseTools.filter((t) => t.function.name !== 'execute_python');
  }

  if (effectiveAllowed && effectiveAllowed.length > 0) {
    if (isIndustrial) {
      effectiveAllowed = effectiveAllowed.filter((toolName) => toolName !== 'execute_python');
    }
    return baseTools.filter((t) => effectiveAllowed!.includes(t.function.name));
  }
  const agentLower = (effectiveAgentId || '').toLowerCase();
  const isOcrAuthorized = AUTHORIZED_OCR_AGENTS.includes(agentLower);
  const isAnalyzeImageAuthorized = AUTHORIZED_ANALYZE_IMAGE_AGENTS.includes(agentLower);
  const isSearchKbAuthorized = AUTHORIZED_SEARCH_KB_AGENTS.includes(agentLower);
  const isGenerateDocxAuthorized = AUTHORIZED_GENERATE_DOCX_AGENTS.includes(agentLower);
  const isGenerateXlsxAuthorized = AUTHORIZED_GENERATE_XLSX_AGENTS.includes(agentLower);
  const isGeneratePptxAuthorized = AUTHORIZED_GENERATE_PPTX_AGENTS.includes(agentLower);
  const isCodeSandboxAuthorized = AUTHORIZED_CODE_SANDBOX_AGENTS.some((a) => a.toLowerCase() === agentLower);
  return baseTools.filter((t) => {
    if (t.function.name === 'ocr_document') {
      return Boolean(isOcrAuthorized);
    }
    if (t.function.name === 'analyze_image') {
      return Boolean(isAnalyzeImageAuthorized);
    }
    if (t.function.name === 'search_knowledge_base') {
      return Boolean(isSearchKbAuthorized);
    }
    if (t.function.name === 'generate_docx') {
      return Boolean(isGenerateDocxAuthorized);
    }
    if (t.function.name === 'generate_xlsx') {
      return Boolean(isGenerateXlsxAuthorized);
    }
    if (t.function.name === 'generate_pptx') {
      return Boolean(isGeneratePptxAuthorized);
    }
    if (t.function.name === 'execute_code_sandbox') {
      return Boolean(isCodeSandboxAuthorized);
    }
    return true;
  });
}

export interface OcrToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeOcrDocumentTool(
  input: unknown,
  context: OcrToolExecutionContext,
  services?: {
    ocr?: OcrService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): OcrDocumentToolResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('ocr_document')) ||
    AUTHORIZED_OCR_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('ocr_document')) {
    throw new OcrError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'ocr_document'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new OcrError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke ocr_document.`,
    );
  }

  // 2. Validate typed input
  const validatedInput = validateOcrDocumentInput(input);

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && !isPathInScope(validatedInput.sourcePath, context.scope, context.projectRoot)) {
    throw new OcrError(
      'TRAVERSAL_REJECTED',
      `File '${validatedInput.sourcePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = projectFile(context.projectRoot, validatedInput.sourcePath);
  } catch (err: any) {
    throw new OcrError('TRAVERSAL_REJECTED', err.message);
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new OcrError('NOT_FOUND', `PDF file not found: '${validatedInput.sourcePath}'`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new OcrError('NOT_FOUND', `Path is not a regular file: '${validatedInput.sourcePath}'`);
  }
  if (stat.size > OCR_BOUNDS.maxSourceBytes) {
    throw new OcrError(
      'BYTE_LIMIT_EXCEEDED',
      `PDF size (${stat.size} bytes) exceeds limit of ${OCR_BOUNDS.maxSourceBytes} bytes`,
    );
  }
  if (stat.size === 0) {
    throw new OcrError('MALFORMED_INPUT', 'PDF file is empty (0 bytes)');
  }

  // Validate MIME magic bytes (%PDF-)
  const fd = fs.openSync(resolvedPath, 'r');
  const headerBuf = Buffer.alloc(Math.min(1024, stat.size));
  try {
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!headerBuf.toString('latin1').includes('%PDF-')) {
    throw new OcrError('INVALID_IMAGE_FORMAT', 'File lacks valid %PDF- magic signature in header');
  }

  // 4. Durable Idempotency Claim
  const idempotencyStore = services?.idempotency || new DurableIdempotencyStore(context.projectRoot);
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(validatedInput))
    .digest('hex');

  const claimOutcome = idempotencyStore.claim({
    key: validatedInput.requestId,
    requestHash,
    operation: 'ocr_document',
    projectId: validatedInput.projectId,
    authContext: context.agentId,
  });

  if (claimOutcome.outcome === 'replay') {
    return { ...(claimOutcome.record.responsePayload as OcrDocumentToolResult), cached: true };
  }
  if (claimOutcome.outcome === 'conflict') {
    throw new OcrError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
  }
  if (claimOutcome.outcome === 'in_progress') {
    throw new OcrError('CONCURRENT_MUTATION', claimOutcome.message);
  }
  if (claimOutcome.outcome === 'auth_mismatch') {
    throw new OcrError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
  }

  // 5. Execute OCR
  const ocrService = services?.ocr || createServiceContainer(context.projectRoot).ocr;
  const ocrOpts: OcrOptions = {
    expectedSourceHash: validatedInput.expectedSourceHash,
    language: validatedInput.language,
    confidenceThresholds:
      validatedInput.confidenceMode === 'strict'
        ? { high: 0.9, medium: 0.7, low: 0.5 }
        : DEFAULT_CONFIDENCE_THRESHOLDS,
  };

  if (validatedInput.pageRange) {
    ocrOpts.targetPages = [];
    for (let p = validatedInput.pageRange.start; p <= validatedInput.pageRange.end; p++) {
      ocrOpts.targetPages.push(p);
    }
  }

  let ocrDocRes: OcrDocumentResult;
  try {
    ocrDocRes = ocrService.ocrDocumentSync(validatedInput.sourcePath, ocrOpts);
  } catch (err: any) {
    idempotencyStore.fail(validatedInput.requestId, err.message);
    throw err;
  }

  // 6. Emit tool-level immutable audit event on success
  const auditService = services?.audit || new AuditService(context.projectRoot);
  let auditRecord;
  try {
    auditRecord = auditService.recordAuditEvent({
      source: 'ocr_document',
      category: 'tool',
      data: {
        action: 'DOCUMENT_OCRED',
        requestId: validatedInput.requestId,
        projectId: validatedInput.projectId,
        sourcePath: validatedInput.sourcePath,
        sourceArtifactId: ocrDocRes.sourceArtifactId,
        sourceHash: ocrDocRes.sourceHash,
        totalPages: ocrDocRes.totalPages,
        averageConfidence: ocrDocRes.averageConfidence,
        pageResultsCount: ocrDocRes.pages.length,
        agentId: context.agentId || 'unknown',
      },
    });
  } catch (err: any) {
    idempotencyStore.fail(validatedInput.requestId, `Audit event emission failed: ${err.message}`);
    throw err;
  }

  // 7. Assemble tool result
  const pageResults: OcrPageToolResult[] = ocrDocRes.pages.map((p) => ({
    pageNumber: p.pageNumber,
    artifactId: p.artifactId || `art_ocr_${p.sourceHash.substring(0, 8)}_${p.pageNumber}`,
    artifactHash: p.artifactHash || p.sourceHash,
    confidence: p.confidence,
    warnings: p.warnings,
    blockCount: p.blocks.length,
  }));

  const toolResult: OcrDocumentToolResult = {
    schemaVersion: 1,
    sourceArtifactId: ocrDocRes.sourceArtifactId,
    sourceHash: ocrDocRes.sourceHash,
    totalPages: ocrDocRes.totalPages,
    text: ocrDocRes.text,
    averageConfidence: ocrDocRes.averageConfidence,
    warnings: ocrDocRes.warnings,
    pageResults,
    engine: 'maos-industrial-ocr',
    engineVersion: '1.0.0',
    auditEventId: auditRecord.hash,
  };

  // 8. Complete idempotency
  idempotencyStore.complete(validatedInput.requestId, 200, toolResult, toolResult.sourceArtifactId);

  return toolResult;
}

export async function executeOcrDocumentToolAsync(
  input: unknown,
  context: OcrToolExecutionContext,
  services?: {
    ocr?: OcrService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<OcrDocumentToolResult> {
  return executeOcrDocumentTool(input, context, services);
}

export interface AnalyzeImageToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeAnalyzeImageTool(
  input: unknown,
  context: AnalyzeImageToolExecutionContext,
  services?: {
    vision?: VisionService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): AnalyzeImageResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('analyze_image')) ||
    AUTHORIZED_ANALYZE_IMAGE_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('analyze_image')) {
    throw new VlmError(
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'analyze_image'. Allowed tools: ${context.allowedTools.join(', ')}`,
      VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL,
    );
  }

  if (!isAuthorized) {
    throw new VlmError(
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke analyze_image.`,
      VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL,
    );
  }

  // 2. Validate typed input
  const validatedInput = validateAnalyzeImageInput(input);

  // 3. Project-root and scope confinement
  if (
    validatedInput.sourcePath &&
    context.scope &&
    context.scope.length > 0 &&
    !isPathInScope(validatedInput.sourcePath, context.scope, context.projectRoot)
  ) {
    throw new VlmError(
      `File '${validatedInput.sourcePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      VLM_ERROR_CODES.TRAVERSAL_REJECTED,
    );
  }

  // 4. Durable Idempotency Claim
  const idempotencyStore = services?.idempotency || new DurableIdempotencyStore(context.projectRoot);
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(validatedInput))
    .digest('hex');

  const claimOutcome = idempotencyStore.claim({
    key: validatedInput.requestId,
    requestHash,
    operation: 'analyze_image',
    projectId: validatedInput.projectId,
    authContext: context.agentId,
  });

  if (claimOutcome.outcome === 'replay') {
    return { ...(claimOutcome.record.responsePayload as AnalyzeImageResult), cached: true };
  }
  if (claimOutcome.outcome === 'conflict') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  }
  if (claimOutcome.outcome === 'in_progress') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.CONCURRENT_MUTATION);
  }
  if (claimOutcome.outcome === 'auth_mismatch') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL);
  }

  // 5. Execute VLM Analysis
  const visionService = services?.vision || createServiceContainer(context.projectRoot).vision;
  let toolResult: AnalyzeImageResult;
  try {
    toolResult = visionService.analyzeImageSync(validatedInput, context.agentId);
  } catch (err: any) {
    idempotencyStore.fail(validatedInput.requestId, err.message);
    throw err;
  }

  // 6. Complete idempotency
  idempotencyStore.complete(
    validatedInput.requestId,
    200,
    toolResult,
    toolResult.artifactId || toolResult.sourceArtifactId,
  );

  return toolResult;
}

export async function executeAnalyzeImageToolAsync(
  input: unknown,
  context: AnalyzeImageToolExecutionContext,
  services?: {
    vision?: VisionService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<AnalyzeImageResult> {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('analyze_image')) ||
    AUTHORIZED_ANALYZE_IMAGE_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('analyze_image')) {
    throw new VlmError(
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'analyze_image'. Allowed tools: ${context.allowedTools.join(', ')}`,
      VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL,
    );
  }

  if (!isAuthorized) {
    throw new VlmError(
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke analyze_image.`,
      VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL,
    );
  }

  // 2. Validate typed input
  const validatedInput = validateAnalyzeImageInput(input);

  // 3. Project-root and scope confinement
  if (
    validatedInput.sourcePath &&
    context.scope &&
    context.scope.length > 0 &&
    !isPathInScope(validatedInput.sourcePath, context.scope, context.projectRoot)
  ) {
    throw new VlmError(
      `File '${validatedInput.sourcePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      VLM_ERROR_CODES.TRAVERSAL_REJECTED,
    );
  }

  // 4. Durable Idempotency Claim
  const idempotencyStore = services?.idempotency || new DurableIdempotencyStore(context.projectRoot);
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(validatedInput))
    .digest('hex');

  const claimOutcome = idempotencyStore.claim({
    key: validatedInput.requestId,
    requestHash,
    operation: 'analyze_image',
    projectId: validatedInput.projectId,
    authContext: context.agentId,
  });

  if (claimOutcome.outcome === 'replay') {
    return { ...(claimOutcome.record.responsePayload as AnalyzeImageResult), cached: true };
  }
  if (claimOutcome.outcome === 'conflict') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  }
  if (claimOutcome.outcome === 'in_progress') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.CONCURRENT_MUTATION);
  }
  if (claimOutcome.outcome === 'auth_mismatch') {
    throw new VlmError(claimOutcome.message, VLM_ERROR_CODES.UNAUTHORIZED_TOOL_CALL);
  }

  // 5. Execute VLM Analysis Async
  const visionService = services?.vision || createServiceContainer(context.projectRoot).vision;
  let toolResult: AnalyzeImageResult;
  try {
    toolResult = await visionService.analyzeImage(validatedInput, context.agentId);
  } catch (err: any) {
    idempotencyStore.fail(validatedInput.requestId, err.message);
    throw err;
  }

  // 6. Complete idempotency
  idempotencyStore.complete(
    validatedInput.requestId,
    200,
    toolResult,
    toolResult.artifactId || toolResult.sourceArtifactId,
  );

  return toolResult;
}

export interface SearchKnowledgeBaseToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export type SearchKnowledgeBaseToolResult = KbSearchResult & {
  cached?: boolean;
};

export function executeSearchKnowledgeBaseTool(
  input: unknown,
  context: SearchKnowledgeBaseToolExecutionContext,
  services?: {
    kbSearch?: KbSearchService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): SearchKnowledgeBaseToolResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('search_knowledge_base')) ||
    AUTHORIZED_SEARCH_KB_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('search_knowledge_base')) {
    throw new KbSearchError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'search_knowledge_base'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new KbSearchError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke search_knowledge_base.`,
    );
  }

  // 2. Validate typed input
  const validation = validateKbSearchInput(input);
  if (!validation.valid) {
    throw new KbSearchError(
      'INVALID_INPUT',
      `Invalid search_knowledge_base input: ${validation.errors.join('; ')}`,
    );
  }
  const validatedInput = input as KbSearchInput;

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && validatedInput.filter?.sourcePaths) {
    for (const sp of validatedInput.filter.sourcePaths) {
      if (!isPathInScope(sp, context.scope, context.projectRoot)) {
        throw new KbSearchError(
          'TRAVERSAL_REJECTED',
          `Filter path '${sp}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
        );
      }
    }
  }

  // 4. Durable Idempotency Claim
  const requestId = validatedInput.requestId;
  let idempotencyStore: DurableIdempotencyStore | undefined;
  if (requestId) {
    idempotencyStore = services?.idempotency || new DurableIdempotencyStore(context.projectRoot);
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(validatedInput))
      .digest('hex');

    const claimOutcome = idempotencyStore.claim({
      key: requestId,
      requestHash,
      operation: 'search_knowledge_base',
      projectId: validatedInput.projectId,
      authContext: context.agentId,
    });

    if (claimOutcome.outcome === 'replay') {
      return { ...(claimOutcome.record.responsePayload as KbSearchResult), cached: true };
    }
    if (claimOutcome.outcome === 'conflict') {
      throw new KbSearchError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'in_progress') {
      throw new KbSearchError('CONCURRENT_MUTATION', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'auth_mismatch') {
      throw new KbSearchError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
    }
  }

  // 5. Execute search
  const kbSearchService = services?.kbSearch || createServiceContainer(context.projectRoot).kbSearch;
  let toolResult: KbSearchResult;
  try {
    toolResult = kbSearchService.searchSync(validatedInput);
  } catch (err: any) {
    if (idempotencyStore && requestId) {
      idempotencyStore.fail(requestId, err.message);
    }
    throw err;
  }

  // 6. Complete idempotency
  if (idempotencyStore && requestId) {
    idempotencyStore.complete(
      requestId,
      200,
      toolResult,
    );
  }

  return toolResult;
}

export async function executeSearchKnowledgeBaseToolAsync(
  input: unknown,
  context: SearchKnowledgeBaseToolExecutionContext,
  services?: {
    kbSearch?: KbSearchService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<SearchKnowledgeBaseToolResult> {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('search_knowledge_base')) ||
    AUTHORIZED_SEARCH_KB_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('search_knowledge_base')) {
    throw new KbSearchError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'search_knowledge_base'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new KbSearchError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke search_knowledge_base.`,
    );
  }

  // 2. Validate typed input
  const validation = validateKbSearchInput(input);
  if (!validation.valid) {
    throw new KbSearchError(
      'INVALID_INPUT',
      `Invalid search_knowledge_base input: ${validation.errors.join('; ')}`,
    );
  }
  const validatedInput = input as KbSearchInput;

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && validatedInput.filter?.sourcePaths) {
    for (const sp of validatedInput.filter.sourcePaths) {
      if (!isPathInScope(sp, context.scope, context.projectRoot)) {
        throw new KbSearchError(
          'TRAVERSAL_REJECTED',
          `Filter path '${sp}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
        );
      }
    }
  }

  // 4. Durable Idempotency Claim
  const requestId = validatedInput.requestId;
  let idempotencyStore: DurableIdempotencyStore | undefined;
  if (requestId) {
    idempotencyStore = services?.idempotency || new DurableIdempotencyStore(context.projectRoot);
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(validatedInput))
      .digest('hex');

    const claimOutcome = idempotencyStore.claim({
      key: requestId,
      requestHash,
      operation: 'search_knowledge_base',
      projectId: validatedInput.projectId,
      authContext: context.agentId,
    });

    if (claimOutcome.outcome === 'replay') {
      return { ...(claimOutcome.record.responsePayload as KbSearchResult), cached: true };
    }
    if (claimOutcome.outcome === 'conflict') {
      throw new KbSearchError('IDEMPOTENCY_CONFLICT', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'in_progress') {
      throw new KbSearchError('CONCURRENT_MUTATION', claimOutcome.message);
    }
    if (claimOutcome.outcome === 'auth_mismatch') {
      throw new KbSearchError('UNAUTHORIZED_TOOL_CALL', claimOutcome.message);
    }
  }

  // 5. Execute search async
  const kbSearchService = services?.kbSearch || createServiceContainer(context.projectRoot).kbSearch;
  let toolResult: KbSearchResult;
  try {
    toolResult = await kbSearchService.search(validatedInput);
  } catch (err: any) {
    if (idempotencyStore && requestId) {
      idempotencyStore.fail(requestId, err.message);
    }
    throw err;
  }

  // 6. Complete idempotency
  if (idempotencyStore && requestId) {
    idempotencyStore.complete(
      requestId,
      200,
      toolResult,
    );
  }

  return toolResult;
}

export interface GenerateDocxToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeGenerateDocxTool(
  input: unknown,
  context: GenerateDocxToolExecutionContext,
  services?: {
    docxGenerator?: DocxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): GenerateDocxToolResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('generate_docx')) ||
    AUTHORIZED_GENERATE_DOCX_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('generate_docx')) {
    throw new DocxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'generate_docx'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new DocxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke generate_docx.`,
    );
  }

  // 2. Validate input is object
  if (!input || typeof input !== 'object') {
    throw new DocxGenerationError('INVALID_INPUT', 'generate_docx requires an object argument.');
  }
  const typedInput = input as GenerateDocxToolInput;

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && typedInput.outputPath) {
    if (!isPathInScope(typedInput.outputPath, context.scope, context.projectRoot)) {
      throw new DocxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${typedInput.outputPath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }
  if (context.scope && context.scope.length > 0 && typedInput.templatePath) {
    if (!isPathInScope(typedInput.templatePath, context.scope, context.projectRoot)) {
      throw new DocxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Template path '${typedInput.templatePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }

  // 4. Delegate to DocxGeneratorService
  const docxService = services?.docxGenerator || createServiceContainer(context.projectRoot).docxGenerator;
  return docxService.generateDocx({
    ...typedInput,
    callerIdentity: {
      agentId: context.agentId,
      taskId: context.taskId,
    },
  });
}

export async function executeGenerateDocxToolAsync(
  input: unknown,
  context: GenerateDocxToolExecutionContext,
  services?: {
    docxGenerator?: DocxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<GenerateDocxToolResult> {
  return Promise.resolve(executeGenerateDocxTool(input, context, services));
}

export interface GenerateXlsxToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeGenerateXlsxTool(
  input: unknown,
  context: GenerateXlsxToolExecutionContext,
  services?: {
    xlsxGenerator?: XlsxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): GenerateXlsxToolResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('generate_xlsx')) ||
    AUTHORIZED_GENERATE_XLSX_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('generate_xlsx')) {
    throw new XlsxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'generate_xlsx'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new XlsxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke generate_xlsx.`,
    );
  }

  // 2. Validate input is object
  if (!input || typeof input !== 'object') {
    throw new XlsxGenerationError('INVALID_INPUT', 'generate_xlsx requires an object argument.');
  }
  const typedInput = input as GenerateXlsxToolInput;

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && typedInput.outputPath) {
    if (!isPathInScope(typedInput.outputPath, context.scope, context.projectRoot)) {
      throw new XlsxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${typedInput.outputPath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }
  if (context.scope && context.scope.length > 0 && typedInput.templatePath) {
    if (!isPathInScope(typedInput.templatePath, context.scope, context.projectRoot)) {
      throw new XlsxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Template path '${typedInput.templatePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }

  // 4. Delegate to XlsxGeneratorService
  const xlsxService = services?.xlsxGenerator || createServiceContainer(context.projectRoot).xlsxGenerator;
  return xlsxService.generateXlsx({
    ...typedInput,
    callerIdentity: {
      agentId: context.agentId,
      taskId: context.taskId,
    },
  });
}

export async function executeGenerateXlsxToolAsync(
  input: unknown,
  context: GenerateXlsxToolExecutionContext,
  services?: {
    xlsxGenerator?: XlsxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<GenerateXlsxToolResult> {
  return Promise.resolve(executeGenerateXlsxTool(input, context, services));
}

export interface GeneratePptxToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeGeneratePptxTool(
  input: unknown,
  context: GeneratePptxToolExecutionContext,
  services?: {
    pptxGenerator?: PptxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): GeneratePptxToolResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('generate_pptx')) ||
    AUTHORIZED_GENERATE_PPTX_AGENTS.includes(agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('generate_pptx')) {
    throw new PptxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'generate_pptx'. Allowed tools: ${context.allowedTools.join(', ')}`,
    );
  }

  if (!isAuthorized) {
    throw new PptxGenerationError(
      'UNAUTHORIZED_TOOL_CALL',
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke generate_pptx.`,
    );
  }

  // 2. Validate input is object
  if (!input || typeof input !== 'object') {
    throw new PptxGenerationError('INVALID_INPUT', 'generate_pptx requires an object argument.');
  }
  const typedInput = input as GeneratePptxToolInput;

  // 3. Project-root and scope confinement
  if (context.scope && context.scope.length > 0 && typedInput.outputPath) {
    if (!isPathInScope(typedInput.outputPath, context.scope, context.projectRoot)) {
      throw new PptxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Output path '${typedInput.outputPath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }
  if (context.scope && context.scope.length > 0 && typedInput.templatePath) {
    if (!isPathInScope(typedInput.templatePath, context.scope, context.projectRoot)) {
      throw new PptxGenerationError(
        'PATH_TRAVERSAL_DETECTED',
        `Template path '${typedInput.templatePath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
      );
    }
  }

  // 4. Delegate to PptxGeneratorService
  const pptxService = services?.pptxGenerator || createServiceContainer(context.projectRoot).pptxGenerator;
  return pptxService.generatePptx({
    ...typedInput,
    callerIdentity: {
      agentId: context.agentId,
      taskId: context.taskId,
    },
  });
}

export async function executeGeneratePptxToolAsync(
  input: unknown,
  context: GeneratePptxToolExecutionContext,
  services?: {
    pptxGenerator?: PptxGeneratorService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<GeneratePptxToolResult> {
  return Promise.resolve(executeGeneratePptxTool(input, context, services));
}

export interface CodeSandboxToolExecutionContext {
  projectRoot: string;
  agentId?: string;
  taskId?: string;
  scope?: string[];
  allowedTools?: string[];
}

export function executeCodeSandboxTool(
  input: unknown,
  context: CodeSandboxToolExecutionContext,
  services?: {
    sandboxRunner?: SandboxRunnerService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): SandboxExecutionResult {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('execute_code_sandbox')) ||
    AUTHORIZED_CODE_SANDBOX_AGENTS.some((a) => a.toLowerCase() === agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('execute_code_sandbox')) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'execute_code_sandbox'. Allowed tools: ${context.allowedTools.join(', ')}`,
      { agentId: context.agentId, allowedTools: context.allowedTools },
    );
  }

  if (!isAuthorized) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke execute_code_sandbox.`,
      { agentId: context.agentId, authorizedAgents: AUTHORIZED_CODE_SANDBOX_AGENTS },
    );
  }

  // 2. Validate input object
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.INVALID_INPUT,
      'execute_code_sandbox requires an object argument.',
    );
  }
  const typedInput = input as Record<string, any>;

  // Reject host executor in execute_code_sandbox
  if (typedInput.executorType === 'host' || (typedInput.executorType && typedInput.executorType !== 'sandbox')) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL,
      "Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.",
      { executorType: typedInput.executorType, agentId: context.agentId },
    );
  }

  // 3. Project-root and scope confinement for staged files
  if (context.scope && context.scope.length > 0 && typedInput.files && typeof typedInput.files === 'object') {
    for (const relPath of Object.keys(typedInput.files)) {
      if (!isPathInScope(relPath, context.scope, context.projectRoot)) {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
          `Staged file path '${relPath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
          { filePath: relPath, scope: context.scope },
        );
      }
    }
  }

  // 4. Delegate to SandboxRunnerService synchronously
  const runner =
    services?.sandboxRunner ||
    createServiceContainer(context.projectRoot).sandboxRunner;

  return runner.executeSync(
    {
      ...typedInput,
      callerIdentity: {
        agentId: context.agentId,
        taskId: context.taskId,
      },
    },
    {
      idempotencyKey: typedInput.requestId,
    },
  );
}

export async function executeCodeSandboxToolAsync(
  input: unknown,
  context: CodeSandboxToolExecutionContext,
  services?: {
    sandboxRunner?: SandboxRunnerService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
  },
): Promise<SandboxExecutionResult> {
  // 1. Authorization check
  const agentLower = (context.agentId || '').toLowerCase();
  const isAuthorized =
    (context.allowedTools && context.allowedTools.includes('execute_code_sandbox')) ||
    AUTHORIZED_CODE_SANDBOX_AGENTS.some((a) => a.toLowerCase() === agentLower);

  if (context.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes('execute_code_sandbox')) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
      `Agent '${context.agentId || 'unknown'}' is not allowed to use tool 'execute_code_sandbox'. Allowed tools: ${context.allowedTools.join(', ')}`,
      { agentId: context.agentId, allowedTools: context.allowedTools },
    );
  }

  if (!isAuthorized) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.UNAUTHORIZED_AGENT,
      `Agent '${context.agentId || 'unknown'}' is not authorized to invoke execute_code_sandbox.`,
      { agentId: context.agentId, authorizedAgents: AUTHORIZED_CODE_SANDBOX_AGENTS },
    );
  }

  // 2. Validate input object
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContainerRunnerError(
      CONTAINER_RUNNER_ERROR_CODES.INVALID_INPUT,
      'execute_code_sandbox requires an object argument.',
    );
  }
  const typedInput = input as Record<string, any>;

  // 3. Project-root and scope confinement for staged files
  if (context.scope && context.scope.length > 0 && typedInput.files && typeof typedInput.files === 'object') {
    for (const relPath of Object.keys(typedInput.files)) {
      if (!isPathInScope(relPath, context.scope, context.projectRoot)) {
        throw new ContainerRunnerError(
          CONTAINER_RUNNER_ERROR_CODES.PROJECT_ESCAPE_DETECTED,
          `Staged file path '${relPath}' is outside agent's allowed scope [${context.scope.join(', ')}]`,
          { filePath: relPath, scope: context.scope },
        );
      }
    }
  }

  // 4. Delegate to SandboxRunnerService asynchronously
  const runner =
    services?.sandboxRunner ||
    createServiceContainer(context.projectRoot).sandboxRunner;

  return runner.execute(
    {
      ...typedInput,
      callerIdentity: {
        agentId: context.agentId,
        taskId: context.taskId,
      },
    },
    {
      idempotencyKey: typedInput.requestId,
    },
  );
}

/**
 * Execute a tool call and return the result as a string.
 */
export function executeTool(
  toolName: string,
  args: Record<string, any>,
  projectRoot: string,
  scope: string[],
  agentId?: string,
  taskId?: string,
  allowedTools?: string[],
  services?: {
    vision?: VisionService;
    audit?: AuditService;
    idempotency?: DurableIdempotencyStore;
    kbSearch?: KbSearchService;
    docxGenerator?: DocxGeneratorService;
    xlsxGenerator?: XlsxGeneratorService;
    pptxGenerator?: PptxGeneratorService;
    sandboxRunner?: SandboxRunnerService;
  },
): { result: string; isComplete: boolean } {
  // Authorization check FIRST
  if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    return {
      result: `🚫 TOOL_UNAUTHORIZED: Agent ${agentId} is not allowed to use tool '${toolName}'. Allowed tools: ${allowedTools.join(', ')}`,
      isComplete: false,
    };
  }

  try {
    switch (toolName) {
      case 'generate_docx': {
        try {
          const toolResult = executeGenerateDocxTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          }, services);
          return { result: jsonResult(toolResult), isComplete: false };
        } catch (err: any) {
          const code = err instanceof DocxGenerationError ? err.code : 'GENERATION_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }

      case 'generate_xlsx': {
        try {
          const toolResult = executeGenerateXlsxTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          }, services);
          return { result: jsonResult(toolResult), isComplete: false };
        } catch (err: any) {
          const code = err instanceof XlsxGenerationError ? err.code : 'GENERATION_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }

      case 'generate_pptx': {
        try {
          const toolResult = executeGeneratePptxTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          }, services);
          return { result: jsonResult(toolResult), isComplete: false };
        } catch (err: any) {
          const code = err instanceof PptxGenerationError ? err.code : 'GENERATION_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }

      case 'search_knowledge_base': {
        try {
          const toolResult = executeSearchKnowledgeBaseTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          }, services);
          return { result: jsonResult({ ok: true, ...toolResult }), isComplete: false };
        } catch (err: any) {
          const code = err instanceof KbSearchError ? err.code : 'SEARCH_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }
      case 'analyze_image': {
        try {
          const toolResult = executeAnalyzeImageTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          }, services);
          return { result: jsonResult({ ok: true, ...toolResult }), isComplete: false };
        } catch (err: any) {
          const code = err instanceof VlmError ? err.code : 'INFERENCE_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }
      case 'ocr_document': {
        try {
          const toolResult = executeOcrDocumentTool(args, {
            projectRoot,
            scope,
            agentId,
            taskId,
            allowedTools,
          });
          return { result: jsonResult({ ok: true, ...toolResult }), isComplete: false };
        } catch (err: any) {
          const code = err instanceof OcrError ? err.code : 'OCR_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }
      case 'ingest_document': {
        try {
          if (args.path && !isPathInScope(args.path, scope, projectRoot)) {
            return { result: jsonResult({ ok: false, error: `SCOPE_VIOLATION: File '${args.path}' is outside agent's allowed scope [${scope.join(', ')}]` }), isComplete: false };
          }
          return { result: jsonResult(ingestDocument(projectRoot, args)), isComplete: false };
        } catch (err: any) {
          return { result: jsonResult({ ok: false, error: err.message }), isComplete: false };
        }
      }

      case 'execute_code_sandbox': {
        try {
          const toolResult = executeCodeSandboxTool(
            args,
            {
              projectRoot,
              scope,
              agentId,
              taskId,
              allowedTools,
            },
            services,
          );
          return { result: jsonResult(toolResult), isComplete: false };
        } catch (err: any) {
          const code = err instanceof ContainerRunnerError ? err.code : 'CONTAINER_EXECUTION_FAILED';
          return {
            result: jsonResult({
              ok: false,
              error: code,
              message: err.message,
            }),
            isComplete: false,
          };
        }
      }

      case 'execute_python': {
        const isIndustrial = isIndustrialProfileEnvironment(projectRoot, args?.profileMode);
        if (isIndustrial) {
          return {
            result: jsonResult({
              ok: false,
              error: 'HOST_EXECUTOR_FORBIDDEN_IN_INDUSTRIAL',
              message:
                "Host executor ('execute_python') is strictly forbidden in Industrial mode. All code tasks must run inside the container sandbox.",
            }),
            isComplete: false,
          };
        }
        return { result: jsonResult(executePython(projectRoot, args)), isComplete: false };
      }

      case 'check_compliance': {
        try {
          return { result: jsonResult(checkCompliance(projectRoot, args)), isComplete: false };
        } catch (err: any) {
          return { result: jsonResult({ ok: false, error: err.message }), isComplete: false };
        }
      }

      case 'read_file': {
        try {
          const filePath = projectFile(projectRoot, args.path);
          if (!isPathInScope(args.path, scope, projectRoot)) {
            return { result: `🚫 SCOPE_VIOLATION: File '${args.path}' is outside agent's allowed scope [${scope.join(', ')}]`, isComplete: false };
          }
          if (!fs.existsSync(filePath)) {
            return { result: `Error: File not found: ${args.path}`, isComplete: false };
          }
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').length;
          return {
            result: `File: ${args.path} (${lines} lines)\n\n${content}`,
            isComplete: false,
          };
        } catch (err: any) {
          return { result: `🚫 PATH_VIOLATION: ${err.message}`, isComplete: false };
        }
      }

      case 'write_file': {
        // HARD SCOPE ENFORCEMENT + FILE LOCK
        const violation = guardWriteFile(args.path, agentId || 'unknown', taskId || 'unknown', scope, projectRoot);
        if (violation) {
          return {
            result: `🚫 ${violation.type}: ${violation.detail}`,
            isComplete: false,
          };
        }
        let filePath: string;
        try {
          // Re-check immediately before directory creation and write to reduce
          // check/use exposure after the initial scope/ownership validation.
          filePath = assertRealWritePathContained(args.path, projectRoot);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          filePath = assertRealWritePathContained(args.path, projectRoot);
          fs.writeFileSync(filePath, args.content, { encoding: 'utf-8', flag: 'w' });
        } catch (err: any) {
          return { result: `🚫 PATH_VIOLATION: ${err.message}`, isComplete: false };
        }
        const lines = args.content.split('\n').length;
        return {
          result: `Written: ${args.path} (${lines} lines)`,
          isComplete: false,
        };
      }

      case 'list_dir': {
        try {
          const dirPath = projectFile(projectRoot, args.path || '.');
          if (!isPathInScope(args.path || '.', scope, projectRoot)) {
            return { result: `🚫 SCOPE_VIOLATION: Directory '${args.path}' is outside agent's allowed scope [${scope.join(', ')}]`, isComplete: false };
          }
          if (!fs.existsSync(dirPath)) {
            return { result: `Error: Directory not found: ${args.path}`, isComplete: false };
          }
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const listing = entries.map((e) => {
            const isDir = e.isDirectory();
            const fullPath = path.join(dirPath, e.name);
            if (isDir) {
              return `📁 ${e.name}/`;
            } else {
              const stats = fs.statSync(fullPath);
              const sizeKB = (stats.size / 1024).toFixed(1);
              return `📄 ${e.name} (${sizeKB} KB)`;
            }
          });
          return {
            result: `Directory: ${args.path || '.'}\n\n${listing.join('\n')}`,
            isComplete: false,
          };
        } catch (err: any) {
          return { result: `🚫 PATH_VIOLATION: ${err.message}`, isComplete: false };
        }
      }

      case 'run_command': {
        // Defense in depth: block shell execution for industrial-scoped agents
        // even if allowedTools check was somehow bypassed
        if (scope.every(s => s.startsWith('demo/industrial') || s.startsWith('profiles/industrial'))) {
          return {
            result: `🚫 SHELL_BLOCKED: Shell execution is disabled for industrial-scoped agents. Use specific tools (ingest_document, check_compliance, execute_code_sandbox) instead.`,
            isComplete: false,
          };
        }
        // COMMAND SAFETY VALIDATION
        const cmdViolation = validateCommand(args.command, agentId || 'unknown', projectRoot);
        if (cmdViolation && cmdViolation.type === 'COMMAND_BLOCKED') {
          return {
            result: `🚫 COMMAND BLOCKED: ${cmdViolation.detail}\nThis command is not allowed for security reasons.`,
            isComplete: false,
          };
        }
        // Warnings are logged but allowed through
        try {
          const output = execSync(args.command, {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: 30_000, // 30s max
            maxBuffer: 1024 * 1024, // 1MB
          });
          return {
            result: `Command: ${args.command}\nExit: 0\n\n${output.substring(0, 5000)}`,
            isComplete: false,
          };
        } catch (cmdErr: any) {
          return {
            result: `Command: ${args.command}\nExit: ${cmdErr.status || 1}\n\nStdout:\n${(cmdErr.stdout || '').substring(0, 2500)}\n\nStderr:\n${(cmdErr.stderr || '').substring(0, 2500)}`,
            isComplete: false,
          };
        }
      }

      case 'git_commit': {
        // Defense in depth: block git operations for industrial-scoped agents
        if (scope.every(s => s.startsWith('demo/industrial') || s.startsWith('profiles/industrial'))) {
          return {
            result: `🚫 GIT_BLOCKED: Git operations are disabled for industrial-scoped agents.`,
            isComplete: false,
          };
        }
        try {
          // Hard-scope git to the project root — NEVER escape upward
          const gitEnv = {
            ...process.env,
            GIT_DIR: path.join(projectRoot, '.git'),
            GIT_WORK_TREE: projectRoot,
          };
          const gitOpts = { cwd: projectRoot, encoding: 'utf-8' as const, env: gitEnv, timeout: 30_000 };

          // Auto-init git repo if none exists (prevents walking up to parent .git)
          if (!fs.existsSync(path.join(projectRoot, '.git'))) {
            execFileSync('git', ['init'], gitOpts);
            execFileSync('git', ['checkout', '-b', 'main'], { ...gitOpts, stdio: ['pipe', 'pipe', 'pipe'] });
          }

          execFileSync('git', ['add', '-A'], gitOpts);
          execFileSync('git', ['commit', '-m', args.message], gitOpts);
          return {
            result: `Committed: "${args.message}"`,
            isComplete: false,
          };
        } catch (gitErr: any) {
          return {
            result: `Git error: ${gitErr.message}`,
            isComplete: false,
          };
        }
      }

      case 'search_code': {
        try {
          const gitDir = path.join(projectRoot, '.git');
          const hasGit = fs.existsSync(gitDir);

          let output: string;
          if (hasGit) {
            const gitEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: projectRoot };
            const grepArgs = args.file_pattern
              ? ['grep', '-n', '-I', args.query, '--', args.file_pattern]
              : ['grep', '-n', '-I', args.query];
            output = execFileSync('git', grepArgs, {
              cwd: projectRoot,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
              env: gitEnv,
            });
          } else {
            // Fallback: use findstr on Windows, grep on Unix
            const isWin = process.platform === 'win32';
            if (isWin) {
              output = execFileSync('findstr', ['/S', '/N', '/I', args.query, args.file_pattern || '*.*'], {
                cwd: projectRoot,
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024,
                timeout: 15000,
              });
            } else {
              output = execFileSync('grep', ['-rnI', args.query, args.file_pattern || '.'], {
                cwd: projectRoot,
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024,
                timeout: 15000,
              });
            }
          }
          const lines = output.split('\n').slice(0, 50); // Cap at 50 results
          return {
            result: `Search results for "${args.query}":\n\n${lines.join('\n')}`,
            isComplete: false,
          };
        } catch {
          return {
            result: `No results found for "${args.query}"`,
            isComplete: false,
          };
        }
      }

      case 'task_complete': {
        const files = args.files_changed || [];
        return {
          result: `Task completed!\nSummary: ${args.summary}\nFiles changed: ${files.join(', ') || 'none listed'}`,
          isComplete: true,
        };
      }

      case 'share_knowledge': {
        const memStore = getMemoryStore();
        if (!memStore) {
          return {
            result: 'Knowledge shared (memory store not active — will not persist).',
            isComplete: false,
          };
        }
        const entry = memStore.add({
          agentId: agentId || 'unknown',
          taskId: taskId || 'unknown',
          type: (args.type || 'DISCOVERY') as MemoryType,
          content: args.content || '',
          tags: Array.isArray(args.tags) ? args.tags : [],
          confidence: typeof args.confidence === 'number' ? args.confidence : 1.0,
        });
        return {
          result: `Knowledge shared with the team!\nType: ${entry.type}\nTags: ${entry.tags.join(', ')}\nOther agents will see this in their context.`,
          isComplete: false,
        };
      }

      case 'request_from_team': {
        const { getCoordinator } = require('../core/coordinator');
        const coord = getCoordinator();
        if (!coord) {
          return {
            result: 'Coordinator not active — request could not be routed.',
            isComplete: false,
          };
        }
        const requestId = coord.handleRequest(
          agentId || 'unknown',
          taskId || 'unknown',
          args.need || '',
          args.context || '',
          args.urgency || 'nice_to_have',
        );
        return {
          result: `Request sent to team! Request ID: ${requestId}\nYour request for "${args.need}" has been broadcast. If a matching answer exists in team memory, it will appear immediately. Otherwise, other agents will see your request and may respond.`,
          isComplete: false,
        };
      }

      case 'respond_to_team': {
        const { getCoordinator: getCoord } = require('../core/coordinator');
        const coord2 = getCoord();
        if (!coord2) {
          return {
            result: 'Coordinator not active — response could not be delivered.',
            isComplete: false,
          };
        }
        coord2.handleResponse(agentId || 'unknown', args.requestId || '', args.response || '');
        return {
          result: `Response delivered to the requesting agent!`,
          isComplete: false,
        };
      }

      default:
        return { result: `Unknown tool: ${toolName}`, isComplete: false };
    }
  } catch (err: any) {
    return { result: `Tool error [${toolName}]: ${err.message}`, isComplete: false };
  }
}

/**
 * Verifies that a tool invocation conforms to an explicit ToolExecutionPlan contract (F7-04).
 */
export function verifyToolExecutionContract(
  contract: ToolExecutionPlan,
  toolName: string,
  execContext: ToolPreExecutionContext,
): PreExecutionEvaluationOutcome {
  const planner = new ToolApprovalPlanner();
  return planner.evaluatePreExecution(contract, {
    ...execContext,
    requestedTool: toolName,
  });
}

