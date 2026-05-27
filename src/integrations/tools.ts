import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
      name: 'read_file',
      description: 'Read the contents of a file in the project. Use this before modifying any file to understand existing code.',
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
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.',
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
      description: 'List the contents of a directory. Returns file names, sizes, and whether each entry is a file or directory.',
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
      description: 'Run a shell command and return stdout/stderr. Use for npm install, running tests, checking types, etc. Commands run from the project root.',
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
      description: 'Stage all changes and create a git commit with the given message. Use when you have completed a logical unit of work.',
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
      description: 'Search the codebase for a pattern. Returns matching lines with file paths and line numbers. Use to understand existing patterns before writing new code.',
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
      description: 'Signal that you have finished the task. Call this when all work is done and committed. Provide a summary of what you accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A brief summary of what was accomplished (e.g., "Created login page with email/password form, glassmorphism styling, and responsive layout")',
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
      description: 'Share a discovery, decision, or warning with other agents on the team. Use this when you learn something that would help other agents work more efficiently (e.g., project structure, tech stack, important constraints, architectural decisions).',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['DISCOVERY', 'DECISION', 'WARNING', 'FILE_MAP'],
            description: 'Type of knowledge: DISCOVERY (factual finding), DECISION (architectural choice), WARNING (pitfall/constraint), FILE_MAP (project structure)',
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
        const violation = guardWriteFile(
          args.path,
          agentId || 'unknown',
          taskId || 'unknown',
          scope,
          projectRoot,
        );
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
        const listing = entries.map(e => {
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
            execSync('git init', gitOpts);
            execSync('git checkout -b main', { ...gitOpts, stdio: ['pipe', 'pipe', 'pipe'] });
          }

          execSync('git add -A', gitOpts);
          execSync(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, gitOpts);
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
            const grepCmd = args.file_pattern
              ? `git grep -n -I "${args.query}" -- "${args.file_pattern}"`
              : `git grep -n -I "${args.query}"`;
            output = execSync(grepCmd, {
              cwd: projectRoot,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
              env: gitEnv,
            });
          } else {
            // Fallback: use findstr on Windows, grep on Unix
            const isWin = process.platform === 'win32';
            const cmd = isWin
              ? `findstr /S /N /I "${args.query}" ${args.file_pattern || '*.*'}`
              : `grep -rnI "${args.query}" ${args.file_pattern || '.'}`;
            output = execSync(cmd, {
              cwd: projectRoot,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
              timeout: 15000,
            });
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

      default:
        return { result: `Unknown tool: ${toolName}`, isComplete: false };
    }
  } catch (err: any) {
    return { result: `Tool error [${toolName}]: ${err.message}`, isComplete: false };
  }
}
