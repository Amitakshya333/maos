/**
 * TASK RING-CONTRACT-01: Frozen tool-registry interface.
 *
 * Tools live in separate files (e.g. `src/service/ring-tools/*.ts`) and
 * register here. Consequential enforcement lives in the REGISTRY, not the
 * model: `isConsequential()` is the single gate the agent loop consults
 * before pausing for human approval. Results are truncated via the existing
 * `truncate()` pattern (re-exported here for tool files).
 *
 * The existing 6 tools migrate onto this interface in the Dev C lane with
 * BEHAVIOR UNCHANGED (same tests green). This module ships the registry +
 * interface only; no tool is moved here.
 */

import type { RingToolContext, RingToolDefinition } from './ring-contract';

export type { RingToolContext, RingToolDefinition } from './ring-contract';

export function truncate(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

export class RingToolRegistry {
  private readonly tools = new Map<string, RingToolDefinition>();

  /** Register a tool definition. Duplicate names throw (fail closed). */
  register(def: RingToolDefinition): void {
    if (!def || typeof def.name !== 'string' || !def.name.trim()) {
      throw new Error('RING_TOOL_INVALID: tool definition requires a non-empty name.');
    }
    if (typeof def.execute !== 'function') {
      throw new Error(`RING_TOOL_INVALID: tool '${def.name}' requires an execute function.`);
    }
    if (this.tools.has(def.name)) {
      throw new Error(`RING_TOOL_DUPLICATE: tool '${def.name}' is already registered.`);
    }
    this.tools.set(def.name, def);
  }

  /** Look up a tool by name (undefined when unknown). */
  get(name: string): RingToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** All registered tool names, in registration order. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * THE consequential gate: the agent loop pauses for human approval iff
   * this returns true. The model never decides. Unknown tools fail closed
   * (treated as consequential so nothing executes without review).
   */
  isConsequential(name: string): boolean {
    const def = this.tools.get(name);
    if (!def) return true;
    return def.consequential === true;
  }

  /**
   * Role scoping: tools with no `roles` list are available to every role.
   * Tools listing `roles` are visible only to those roles. The default
   * role (`operator`) sees the full migrated set, so current tests keep
   * passing.
   */
  isVisibleTo(name: string, role: string): boolean {
    const def = this.tools.get(name);
    if (!def) return false;
    if (!def.roles || def.roles.length === 0) return true;
    return def.roles.includes(role as never);
  }

  /** Execute a tool with truncation-friendly error surfacing. */
  async execute(name: string, ctx: RingToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const def = this.tools.get(name);
    if (!def) return { ok: false, toolName: name, error: `Unknown tool: ${name}` };
    try {
      const result = await def.execute(ctx, args || {});
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
      return { ok: false, toolName: name, error: `Tool '${name}' returned a non-object result.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, toolName: name, error: truncate(message, 800) };
    }
  }
}
