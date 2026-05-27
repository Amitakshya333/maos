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

// ---- File Ownership Engine (P3.3) ----
// Evolved from simple file locks → semantic ownership model.
// Tracks reads, writes, ownership transfer, and conflict resolution.

export type AccessType = 'READ' | 'WRITE' | 'EXCLUSIVE';

export interface FileOwnership {
  /** File path (normalized) */
  path: string;
  /** Current owner agent ID */
  owner: string;
  /** Task that claimed ownership */
  taskId: string;
  /** When ownership was claimed */
  ownedSince: number;
  /** Last access time (read or write) */
  lastAccessed: number;
  /** Current access type */
  accessType: AccessType;
  /** Number of writes to this file by the owner */
  writeCount: number;
}

export interface OwnershipReport {
  path: string;
  owner: string;
  accessType: AccessType;
  taskId: string;
  ageMs: number;
  silenceMs: number;
  writeCount: number;
}

class FileOwnershipEngine {
  private ownerships = new Map<string, FileOwnership>();
  private readLog = new Map<string, Set<string>>(); // path → set of agent IDs that read it

  /** Idle timeout: ownership released if agent hasn't touched file in 60s */
  private idleTimeoutMs = 60_000;

  /** Stale timeout: force-release after 10 minutes regardless */
  private staleTimeoutMs = 10 * 60_000;

  /**
   * Claim ownership of a file for writing.
   *
   * Returns null if ownership granted.
   * Returns a ScopeViolation if conflict cannot be resolved.
   */
  claimWrite(filePath: string, agentId: string, taskId: string): ScopeViolation | null {
    const normalized = this.normalizePath(filePath);
    const existing = this.ownerships.get(normalized);
    const now = Date.now();

    // No owner → claim
    if (!existing) {
      this.ownerships.set(normalized, {
        path: normalized,
        owner: agentId,
        taskId,
        ownedSince: now,
        lastAccessed: now,
        accessType: 'WRITE',
        writeCount: 1,
      });
      return null;
    }

    // Same agent → re-acquire (update access time + count)
    if (existing.owner === agentId) {
      existing.lastAccessed = now;
      existing.writeCount++;
      return null;
    }

    // Stale ownership? (10 min without any access → auto-transfer)
    if (now - existing.lastAccessed > this.staleTimeoutMs) {
      this.ownerships.set(normalized, {
        path: normalized,
        owner: agentId,
        taskId,
        ownedSince: now,
        lastAccessed: now,
        accessType: 'WRITE',
        writeCount: 1,
      });
      return null;
    }

    // Idle ownership? (60s without access → transfer)
    if (now - existing.lastAccessed > this.idleTimeoutMs) {
      this.ownerships.set(normalized, {
        path: normalized,
        owner: agentId,
        taskId,
        ownedSince: now,
        lastAccessed: now,
        accessType: 'WRITE',
        writeCount: 1,
      });
      return null;
    }

    // Active conflict → WRITE_CONFLICT
    const silenceMs = now - existing.lastAccessed;
    return {
      type: 'FILE_LOCKED',
      agentId,
      filePath,
      detail: 'File "' + filePath + '" is owned by ' + existing.owner +
        ' (task: ' + existing.taskId + ', ' + existing.accessType +
        ', active ' + Math.round(silenceMs / 1000) + 's ago). ' +
        'Try again when ownership is released.',
    };
  }

  /**
   * Record that an agent read a file (no ownership claim, just tracking).
   */
  recordRead(filePath: string, agentId: string): void {
    const normalized = this.normalizePath(filePath);
    if (!this.readLog.has(normalized)) {
      this.readLog.set(normalized, new Set());
    }
    this.readLog.get(normalized)!.add(agentId);
  }

  /**
   * Release all ownerships held by an agent (on task complete/fail).
   */
  releaseAll(agentId: string): number {
    let released = 0;
    for (const [key, ownership] of this.ownerships) {
      if (ownership.owner === agentId) {
        this.ownerships.delete(key);
        released++;
      }
    }
    return released;
  }

  /**
   * Release ownership of a specific file.
   */
  release(filePath: string, agentId: string): boolean {
    const normalized = this.normalizePath(filePath);
    const existing = this.ownerships.get(normalized);
    if (existing && existing.owner === agentId) {
      this.ownerships.delete(normalized);
      return true;
    }
    return false;
  }

  /**
   * Get info about who owns a file.
   */
  getOwner(filePath: string): FileOwnership | undefined {
    return this.ownerships.get(this.normalizePath(filePath));
  }

  /**
   * Get all files owned by an agent.
   */
  getAgentFiles(agentId: string): string[] {
    const files: string[] = [];
    for (const [key, ownership] of this.ownerships) {
      if (ownership.owner === agentId) {
        files.push(key);
      }
    }
    return files;
  }

  /**
   * Get all active ownerships (for dashboard).
   */
  getAllOwnerships(): Map<string, FileOwnership> {
    return new Map(this.ownerships);
  }

  /**
   * Get a dashboard-friendly ownership report.
   */
  getReport(): OwnershipReport[] {
    const now = Date.now();
    const report: OwnershipReport[] = [];

    for (const [, ownership] of this.ownerships) {
      report.push({
        path: ownership.path,
        owner: ownership.owner,
        accessType: ownership.accessType,
        taskId: ownership.taskId,
        ageMs: now - ownership.ownedSince,
        silenceMs: now - ownership.lastAccessed,
        writeCount: ownership.writeCount,
      });
    }

    return report.sort((a, b) => a.silenceMs - b.silenceMs);
  }

  /**
   * Get all agents that have read a specific file.
   */
  getReaders(filePath: string): string[] {
    const normalized = this.normalizePath(filePath);
    const readers = this.readLog.get(normalized);
    return readers ? Array.from(readers) : [];
  }

  /**
   * Sweep stale ownerships. Called periodically by the health monitor.
   */
  sweepStale(): number {
    const now = Date.now();
    let swept = 0;
    for (const [key, ownership] of this.ownerships) {
      if (now - ownership.lastAccessed > this.staleTimeoutMs) {
        this.ownerships.delete(key);
        swept++;
      }
    }
    return swept;
  }

  private normalizePath(p: string): string {
    return path.normalize(p).replace(/\\/g, '/').toLowerCase();
  }
}

// ---- Singleton ----

let _registry: FileOwnershipEngine | null = null;

/**
 * Get the file ownership engine singleton.
 * Backward compatible: same function name as before.
 */
export function getFileLockRegistry(): FileOwnershipEngine {
  if (!_registry) {
    _registry = new FileOwnershipEngine();
  }
  return _registry;
}

// Explicit new name (aliased from old name for compat)
export { getFileLockRegistry as getFileOwnershipEngine };

// ---- Combined Guard Function ----

/**
 * Full scope + ownership check for a write_file call.
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
      detail: 'Cannot write to "' + filePath + '". Scope: [' + scope.join(', ') + ']',
    };
  }

  // 2. File ownership check (replaces simple lock)
  const engine = getFileLockRegistry();
  const conflict = engine.claimWrite(filePath, agentId, taskId);
  if (conflict) {
    return conflict;
  }

  return null;
}

