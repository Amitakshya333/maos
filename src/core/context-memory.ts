/**
 * MAOS Context Memory — Inter-Agent Knowledge Transfer
 *
 * A shared, append-only knowledge store that lets agents share
 * discoveries, decisions, and warnings with each other.
 *
 * How it works:
 *   1. Agent A calls the `share_knowledge` tool during execution.
 *   2. The memory entry is persisted to .maos/memory/session.jsonl
 *   3. Agent B starts its task → system prompt includes recent memories.
 *   4. Agent B skips exploration that A already did → saves 2-5 iterations.
 *
 * Memory types:
 *   DISCOVERY  — factual finding ("project uses Vite + React")
 *   DECISION   — architectural choice ("use single tasks table")
 *   WARNING    — pitfall or constraint ("don't modify package.json")
 *   FILE_MAP   — discovered file structure or dependencies
 *
 * Lifecycle:
 *   - Session-scoped (cleared on new `maos start`)
 *   - Entries can have optional TTL (stale after N seconds)
 *   - Capped at 20 most recent entries in prompt injection
 *   - Stored in .maos/memory/session.jsonl (append-only JSONL)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getMemoryDir } from '../utils/paths';

// ---- Types ----

export type MemoryType = 'DISCOVERY' | 'DECISION' | 'WARNING' | 'FILE_MAP';

export interface MemoryEntry {
  /** Unique ID */
  id: string;
  /** Which agent wrote this */
  agentId: string;
  /** Which task produced this */
  taskId: string;
  /** Type of knowledge */
  type: MemoryType;
  /** The knowledge content */
  content: string;
  /** Searchable tags */
  tags: string[];
  /** When it was written */
  timestamp: number;
  /** Optional TTL in ms (after which entry is considered stale) */
  ttlMs?: number;
  /** Confidence score: 0.0 = guess, 1.0 = verified */
  confidence: number;
}

// ---- Constants ----

/** Max entries injected into agent prompts */
const MAX_PROMPT_ENTRIES = 20;

/** Max entries stored before pruning */
const MAX_STORED_ENTRIES = 200;

/** Default TTL: 30 minutes */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

// ---- Memory Store ----

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private filePath: string;
  private sessionId: string;

  constructor(projectRoot: string) {
    const memDir = getMemoryDir(projectRoot);
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }
    this.filePath = path.join(memDir, 'session.jsonl');
    this.sessionId = Date.now().toString(36);
    this.load();
  }

  // ---- Public API ----

  /**
   * Add a memory entry from an agent.
   */
  add(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `mem_${this.sessionId}_${this.entries.length}`,
      timestamp: Date.now(),
    };

    this.entries.push(fullEntry);
    this.persist(fullEntry);

    // Prune if over limit
    if (this.entries.length > MAX_STORED_ENTRIES) {
      this.entries = this.entries.slice(-MAX_STORED_ENTRIES);
    }

    return fullEntry;
  }

  /**
   * Get all live (non-expired) entries.
   */
  getLive(): MemoryEntry[] {
    const now = Date.now();
    return this.entries.filter(e => {
      if (e.ttlMs && (now - e.timestamp > e.ttlMs)) return false;
      return true;
    });
  }

  /**
   * Get entries for prompt injection.
   * Returns the N most recent live entries, formatted for system prompt.
   */
  getForPrompt(excludeAgentId?: string): string {
    const live = this.getLive();
    if (live.length === 0) return '';

    // Optionally exclude the agent's own entries (avoid echo)
    const filtered = excludeAgentId
      ? live.filter(e => e.agentId !== excludeAgentId)
      : live;

    if (filtered.length === 0) return '';

    // Take most recent N
    const recent = filtered.slice(-MAX_PROMPT_ENTRIES);

    const lines = recent.map(e => {
      const age = this.formatAge(Date.now() - e.timestamp);
      const tagStr = e.tags.length > 0 ? ` | tags: ${e.tags.join(', ')}` : '';
      const confStr = e.confidence < 1.0 ? ` | confidence: ${e.confidence}` : '';
      return `[${e.agentId} | ${age} ago | ${e.type}${confStr}${tagStr}]\n  ${e.content}`;
    });

    return `\n## Shared Team Memory (from other agents)\n${lines.join('\n\n')}\n`;
  }

  /**
   * Search memories by tag.
   */
  searchByTag(tag: string): MemoryEntry[] {
    const lower = tag.toLowerCase();
    return this.getLive().filter(e =>
      e.tags.some(t => t.toLowerCase().includes(lower))
    );
  }

  /**
   * Search memories by content substring.
   */
  searchByContent(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.getLive().filter(e =>
      e.content.toLowerCase().includes(lower)
    );
  }

  /**
   * Get all entries (including expired).
   */
  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  /**
   * Get memory stats.
   */
  getStats(): {
    total: number;
    live: number;
    expired: number;
    byType: Record<string, number>;
    byAgent: Record<string, number>;
  } {
    const live = this.getLive();
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};

    for (const e of this.entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byAgent[e.agentId] = (byAgent[e.agentId] || 0) + 1;
    }

    return {
      total: this.entries.length,
      live: live.length,
      expired: this.entries.length - live.length,
      byType,
      byAgent,
    };
  }

  /**
   * Clear all memories (new session).
   */
  clear(): void {
    this.entries = [];
    try {
      if (fs.existsSync(this.filePath)) {
        // Archive old session
        const archivePath = this.filePath.replace('.jsonl', `.${Date.now()}.jsonl`);
        fs.renameSync(this.filePath, archivePath);
      }
    } catch { /* non-fatal */ }
    this.sessionId = Date.now().toString(36);
  }

  /**
   * Get entry count.
   */
  get size(): number {
    return this.entries.length;
  }

  // ---- Persistence ----

  private persist(entry: MemoryEntry): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* non-fatal */ }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;

      const lines = fs.readFileSync(this.filePath, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          this.entries.push(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    } catch { /* non-fatal — start fresh */ }
  }

  // ---- Helpers ----

  private formatAge(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  }
}

// ---- Singleton ----

let _store: MemoryStore | null = null;

/**
 * Get the memory store singleton (or null if not initialized).
 */
export function getMemoryStore(): MemoryStore | null {
  return _store;
}

/**
 * Create/initialize the memory store.
 * Called by the orchestrator on startup.
 */
export function createMemoryStore(projectRoot: string): MemoryStore {
  _store = new MemoryStore(projectRoot);
  return _store;
}

/**
 * Clear the memory store (new session).
 */
export function clearMemoryStore(): void {
  _store?.clear();
}
