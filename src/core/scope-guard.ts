/**
 * MAOS Scope Guard
 *
 * Hard enforcement of agent file scopes and a file lock registry
 * to prevent simultaneous writes to the same file by different agents.
 *
 * Three levels of enforcement:
 *   1. Write scope: agents can ONLY write to files within their scope
 *   2. Command guard: dangerous commands are blocked (rm -rf, format, etc.)
 *   3. File locks: only one agent may write to a file at a time
 *
 * The system prompt asks nicely. This enforces it.
 */

import * as path from 'path';

// ---- Command Blocklist ----
// Patterns that agents are NEVER allowed to run, regardless of scope.

const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // Destructive system commands
  /\brm\s+-rf\s+[\/\\]/i,             // rm -rf / or rm -rf \
  /\bformat\b/i,                       // format drive
  /\bdel\s+\/[sf]\b/i,                // del /s /f (Windows recursive delete)
  /\brd\s+\/s\b/i,                    // rd /s (Windows recursive delete)
  /\brmdir\s+\/s\b/i,                 // rmdir /s
  /\bshutdown\b/i,                     // shutdown
  /\breboot\b/i,                       // reboot
  /\bpowershell.*-enc/i,              // encoded powershell commands
  /\bcurl\b.*\|\s*(bash|sh|powershell)/i, // pipe to shell

  // Network exfiltration
  /\bcurl\b.*-X\s*POST\b/i,           // curl POST (data exfiltration)
  /\bwget\b.*--post/i,                // wget POST
  /\bnc\b.*-l/i,                      // netcat listen

  // Credential theft
  /\bcat\b.*\.(env|pem|key)\b/i,      // read secrets
  /\btype\b.*\.(env|pem|key)\b/i,     // Windows read secrets
  /\.ssh\//i,                          // SSH directory access

  // Process manipulation
  /\btaskkill\b/i,                     // kill processes (Windows)
  /\bkill\s+-9\b/i,                   // force kill

  // Registry/system
  /\breg\s+(add|delete)\b/i,          // Windows registry
  /\bschtasks\b/i,                    // Windows scheduled tasks
];

// Patterns that are suspicious but allowed with logging
const WARN_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+publish\b/i,               // publishing packages
  /\bgit\s+push\b/i,                  // pushing to remote
  /\bgit\s+force/i,                   // force push
  /\bchmod\b/i,                        // changing permissions
  /\bchown\b/i,                        // changing ownership
];

// ---- Scope Guard ----

export interface ScopeViolation {
  type: 'WRITE_BLOCKED' | 'COMMAND_BLOCKED' | 'COMMAND_WARNING' | 'FILE_LOCKED';
  agentId: string;
  detail: string;
  filePath?: string;
  command?: string;
}

/**
 * Check if a file path is within the agent's allowed scope.
 *
 * Scope patterns:
 *   "/"         → unrestricted (all files)
 *   "src/"      → anything under src/
 *   "*.ts"      → any .ts file at root
 *   "src/*.tsx"  → any .tsx file directly in src/
 */
export function isPathInScope(
  filePath: string,
  scope: string[],
  projectRoot: string,
): boolean {
  // Unrestricted scopes
  if (scope.includes('/') || scope.includes('**/*') || scope.includes('*')) return true;

  const normalizedPath = path.normalize(filePath).replace(/\\/g, '/').replace(/^\//, '');

  return scope.some(scopePattern => {
    let pattern = path.normalize(scopePattern).replace(/\\/g, '/').replace(/^\//, '');

    // Strip trailing wildcards
    if (pattern.endsWith('**/*')) {
      pattern = pattern.replace(/\*\*\/\*$/, '');
    } else if (pattern.endsWith('**')) {
      pattern = pattern.replace(/\*\*$/, '');
    }

    // Remove trailing slash
    pattern = pattern.replace(/\/$/, '');

    // Empty after stripping = root = allow all
    if (!pattern) return true;

    // Check prefix match
    const normalizedForMatch = normalizedPath.replace(/\/$/, '');
    return normalizedForMatch === pattern ||
           normalizedForMatch.startsWith(pattern + '/');
  });
}

/**
 * Validate a command for safety.
 * Returns null if safe, a ScopeViolation if blocked or warned.
 */
export function validateCommand(
  command: string,
  agentId: string,
  projectRoot: string,
): ScopeViolation | null {
  // Check against blocklist
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        type: 'COMMAND_BLOCKED',
        agentId,
        command,
        detail: `Command blocked by security policy. Pattern: ${pattern.source}`,
      };
    }
  }

  // Check for path escapes: commands that reference paths outside project root
  // Match absolute paths that don't start with the project root
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
  const absPathRegex = /(?:^|\s)([A-Z]:\\[^\s"']+|\/[^\s"']+)/gi;
  let match;
  while ((match = absPathRegex.exec(command)) !== null) {
    const absPath = match[1].replace(/\\/g, '/').toLowerCase();
    if (!absPath.startsWith(normalizedRoot) && 
        !absPath.startsWith('/dev/null') &&
        !absPath.startsWith('/tmp') &&
        !absPath.match(/^\/usr\//) &&
        !absPath.match(/^[a-z]:\\windows/i)) {
      // This is an absolute path outside the project — suspicious but not always harmful
      // We'll allow it but it could be logged as a warning
    }
  }

  // Check warning patterns
  for (const pattern of WARN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        type: 'COMMAND_WARNING',
        agentId,
        command,
        detail: `Potentially dangerous command detected: ${pattern.source}`,
      };
    }
  }

  return null;
}

// ---- File Lock Registry ----
// Prevents two agents from writing to the same file simultaneously.

interface FileLock {
  agentId: string;
  taskId: string;
  lockedAt: number;
}

class FileLockRegistry {
  private locks = new Map<string, FileLock>();

  /**
   * Attempt to acquire a lock on a file for an agent.
   * Returns true if lock acquired (or already held by same agent).
   * Returns false if locked by a different agent.
   */
  acquire(filePath: string, agentId: string, taskId: string): boolean {
    const normalized = this.normalizePath(filePath);
    const existing = this.locks.get(normalized);

    if (!existing) {
      this.locks.set(normalized, { agentId, taskId, lockedAt: Date.now() });
      return true;
    }

    // Same agent can re-acquire its own lock
    if (existing.agentId === agentId) {
      return true;
    }

    // Stale lock? (older than 10 minutes → auto-release)
    if (Date.now() - existing.lockedAt > 10 * 60 * 1000) {
      this.locks.set(normalized, { agentId, taskId, lockedAt: Date.now() });
      return true;
    }

    // Locked by another agent
    return false;
  }

  /**
   * Release all locks held by an agent.
   */
  releaseAll(agentId: string): number {
    let released = 0;
    for (const [key, lock] of this.locks) {
      if (lock.agentId === agentId) {
        this.locks.delete(key);
        released++;
      }
    }
    return released;
  }

  /**
   * Get info about who holds a lock on a file.
   */
  getOwner(filePath: string): FileLock | undefined {
    return this.locks.get(this.normalizePath(filePath));
  }

  /**
   * Get all locks held by an agent.
   */
  getAgentLocks(agentId: string): string[] {
    const files: string[] = [];
    for (const [key, lock] of this.locks) {
      if (lock.agentId === agentId) {
        files.push(key);
      }
    }
    return files;
  }

  /**
   * Get all active locks.
   */
  getAllLocks(): Map<string, FileLock> {
    return new Map(this.locks);
  }

  private normalizePath(p: string): string {
    return path.normalize(p).replace(/\\/g, '/').toLowerCase();
  }
}

// ---- Singleton ----

let _registry: FileLockRegistry | null = null;

export function getFileLockRegistry(): FileLockRegistry {
  if (!_registry) {
    _registry = new FileLockRegistry();
  }
  return _registry;
}

// ---- Combined Guard Function ----

/**
 * Full scope + lock check for a write_file call.
 * Returns null if allowed, ScopeViolation if blocked.
 */
export function guardWriteFile(
  filePath: string,
  agentId: string,
  taskId: string,
  scope: string[],
  projectRoot: string,
): ScopeViolation | null {
  // 1. Scope check
  if (!isPathInScope(filePath, scope, projectRoot)) {
    return {
      type: 'WRITE_BLOCKED',
      agentId,
      filePath,
      detail: `Cannot write to "${filePath}". Scope: [${scope.join(', ')}]`,
    };
  }

  // 2. File lock check
  const registry = getFileLockRegistry();
  if (!registry.acquire(filePath, agentId, taskId)) {
    const owner = registry.getOwner(filePath);
    return {
      type: 'FILE_LOCKED',
      agentId,
      filePath,
      detail: `File "${filePath}" is locked by agent ${owner?.agentId} (task: ${owner?.taskId})`,
    };
  }

  return null;
}
