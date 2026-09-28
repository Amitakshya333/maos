/**
 * MAOS Memory Service
 *
 * Wraps agent knowledge sharing and search.
 * Extracted from: cli/index.ts (memory command), core/context-memory.ts.
 */

import { MemoryStore } from '../core/context-memory';
import type { MemoryEntry, MemoryStats, MemoryType } from '../domain/schemas';

/**
 * Convert a core memory entry to a domain MemoryEntry.
 */
function toMemoryEntry(raw: any): MemoryEntry {
  return {
    id: raw.id ?? '',
    agentId: raw.agentId ?? '',
    type: (raw.type ?? 'DISCOVERY') as MemoryType,
    content: raw.content ?? '',
    tags: raw.tags ?? [],
    confidence: raw.confidence ?? 1,
    timestamp: raw.timestamp ?? 0,
    ttlMs: raw.ttlMs ?? 0,
  };
}

export class MemoryService {
  private store: MemoryStore;

  constructor(projectRoot: string) {
    this.store = new MemoryStore(projectRoot);
  }

  /**
   * Get all live (non-expired) memory entries.
   */
  getLive(): MemoryEntry[] {
    return this.store.getLive().map(toMemoryEntry);
  }

  /**
   * Search memories by content substring.
   */
  search(query: string): MemoryEntry[] {
    return this.store.searchByContent(query).map(toMemoryEntry);
  }

  /**
   * Search memories by tag.
   */
  searchByTag(tag: string): MemoryEntry[] {
    return this.store.searchByTag(tag).map(toMemoryEntry);
  }

  /**
   * Get memory statistics.
   */
  getStats(): MemoryStats {
    const s = this.store.getStats();
    return {
      total: s.total,
      live: s.live,
      expired: s.expired,
      byType: s.byType,
      byAgent: s.byAgent,
    };
  }

  /**
   * Clear all memories (archives current session).
   */
  clear(): void {
    this.store.clear();
  }
}
