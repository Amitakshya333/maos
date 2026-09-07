import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { ToolDef } from '../backends/provider';
import { guardWriteFile, validateCommand, getFileLockRegistry, ScopeViolation } from '../core/scope-guard';
import { getMemoryStore, MemoryType } from '../core/context-memory';

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
  const { isPathInScope: check } = require('../core/scope-guard');
  return check(filePath, scope, projectRoot);
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

function executePython(projectRoot: string, args: Record<string, any>): unknown {
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
  if (args.thresholds_path) {
    const p = projectFile(projectRoot, args.thresholds_path);
    thresholds = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  if (thresholds.thresholds && typeof thresholds.thresholds === 'object') thresholds = thresholds.thresholds;
  const findings = Object.entries(measurements).map(([metric, value]) => {
    const rule = thresholds[metric];
    const numeric = Number(value);
    if (!rule || !Number.isFinite(numeric))
      return {
        metric,
        value,
        status: 'WARNING',
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
    return {
      metric,
      value: numeric,
      unit: rule.unit || null,
      status,
      threshold: { warning: rule.warning ?? null, critical: rule.critical ?? null },
      deviation,
      recommendation:
        status === 'PASS'
          ? 'No action required.'
          : status === 'WARNING'
            ? rule.recommendation || 'Inspect trend and schedule maintenance.'
            : rule.recommendation || 'Stop or isolate equipment and investigate immediately.',
    };
  });
  const status = findings.some((f) => f.status === 'FAIL')
    ? 'FAIL'
    : findings.some((f) => f.status === 'WARNING')
      ? 'WARNING'
      : 'PASS';
  return { ok: true, status, findings };
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
): { result: string; isComplete: boolean } {
  try {
    switch (toolName) {
      case 'ingest_document': {
        try {
          return { result: jsonResult(ingestDocument(projectRoot, args)), isComplete: false };
        } catch (err: any) {
          return { result: jsonResult({ ok: false, error: err.message }), isComplete: false };
        }
      }

      case 'execute_python': {
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
        const filePath = path.resolve(projectRoot, args.path);
        if (!fs.existsSync(filePath)) {
          return { result: `Error: File not found: ${args.path}`, isComplete: false };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').length;
        return {
          result: `File: ${args.path} (${lines} lines)\n\n${content}`,
          isComplete: false,
        };
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
        const filePath = path.resolve(projectRoot, args.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, args.content, 'utf-8');
        const lines = args.content.split('\n').length;
        return {
          result: `Written: ${args.path} (${lines} lines)`,
          isComplete: false,
        };
      }

      case 'list_dir': {
        const dirPath = path.resolve(projectRoot, args.path || '.');
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
      }

      case 'run_command': {
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
