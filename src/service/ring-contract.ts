/**
 * TASK RING-CONTRACT-01: Frozen Ring contract (type stubs).
 *
 * This file is the compile-time home of the contract the three dev lanes
 * build against in parallel. It introduces NO behavior: service, router, and
 * GUI code gain behavior in their own files; this module only declares the
 * shared shapes so lanes never touch each other's files.
 *
 * Lane map (each lane owns its files; all import types from here):
 *   - Dev A (threads + persistence): RingThreadService + router thread
 *     routes in `src/api/router.ts` (thread block only).
 *   - Dev B (streaming events): publish path in
 *     `src/service/ring-agent-service.ts` (record() fan-out only) — event
 *     union extension lives in `src/gui/src/api/ring-run-types.ts`.
 *   - Dev C (tools + roles + artifacts): `src/service/ring-tools/*` and the
 *     registry in `src/service/ring-tool-registry.ts`.
 *
 * Policy is NOT weakened here: consequential enforcement stays in the
 * registry (see `RingToolDefinition.consequential`), and
 * `src/backends/meta-api-policy.ts` is untouched.
 */

export type RingRole = 'operator' | 'maintenance' | 'safety' | 'manager';

export const RING_ROLES: readonly RingRole[] = ['operator', 'maintenance', 'safety', 'manager'];

export const DEFAULT_RING_ROLE: RingRole = 'operator';

/** Run lifecycle states (frozen; unchanged from RING-AGENT-LOOP-01). */
export type RingContractRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

/** Run execution mode (frozen; unchanged). */
export type RingContractRunMode = 'hosted' | 'evidence-only';

/**
 * Thread: a named conversation owning an ordered list of run ids.
 * Persisted as JSON under `.maos/ring-runs/threads/<threadId>.json`;
 * reopening rebuilds from that stored history (no in-memory state is
 * authoritative across restarts).
 */
export interface RingThread {
  threadId: string;
  title: string;
  role: RingRole;
  createdAt: string;
  runs: string[];
}

/** POST /api/v1/ring/threads request body. */
export interface RingThreadCreateRequest {
  title?: string;
  role?: RingRole;
  instruction?: string;
}

/** POST /api/v1/ring/threads/:id/messages request body (starts a run carrying prior conversation context). */
export interface RingThreadMessageRequest {
  instruction: string;
}

/** Existing POST /api/v1/ring/runs request shape (frozen; unchanged). */
export interface RingRunCreateContractRequest {
  instruction: string;
  agentId?: string;
  csvPath?: string;
  exportPath?: string;
  evidenceRoot?: string;
  analysisId?: string;
  documentPath?: string;
  threadId?: string;
  role?: RingRole;
}

/** Frozen streaming extension: the four new event types. */
export type RingStreamEventType = 'model.delta' | 'plan.updated' | 'artifact.created' | 'memory.saved' | 'skill.prefetch';

/** plan.updated: the agent's current todo list (ordered steps). */
export interface RingPlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** artifact.created payload: a file the run stored under its artifact dir. */
export interface RingArtifactDescriptor {
  path: string;
  kind: string;
  size: number;
  sha256: string;
}

/** memory.saved payload: a note the run stored for future turns. */
export interface RingMemoryRecord {
  noteId: string;
  summary: string;
}

/**
 * Tool definition: tools live in separate files (e.g.
 * `src/service/ring-tools/*.ts`) and register here. Consequential
 * enforcement lives in the REGISTRY (the `consequential` flag gates the
 * approval pause), never in the model. Results are truncated via the
 * existing `truncate()` pattern.
 */
export interface RingToolContext {
  projectRoot: string;
  evidenceRoot: string;
  runId: string;
  runContext: Record<string, unknown>;
}

export interface RingToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  consequential: boolean;
  roles?: RingRole[];
  execute: (ctx: RingToolContext, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/** Artifact storage layout (frozen). */
export const RING_ARTIFACT_DIR_PREFIX = '.maos/ring-runs/artifacts';

/** Thread storage layout (frozen). */
export const RING_THREAD_DIR = '.maos/ring-runs/threads';

/**
 * New streaming event types, for validators and the WS fan-out.
 *
 * TASK HYBRID-ROUTER-01: 'skill.prefetch' marks the deterministic
 * server-side bookkeeping prefetch in hosted mode (remember/recall/
 * update_plan executed by the server BEFORE the first model turn, same
 * registry-direct code as the evidence-only path). It is recorded as a
 * server event — never as a model tool call — so the transcript stays
 * honest about who did the bookkeeping.
 */
export const RING_STREAM_EVENT_TYPES: readonly RingStreamEventType[] = [
  'model.delta',
  'plan.updated',
  'artifact.created',
  'memory.saved',
  'skill.prefetch',
];

/**
 * Type guard for thread ids: `thread-<epochMs>-<8 hex>`.
 * Run ids (`ring-…`) never match.
 */
export function isRingThreadId(value: unknown): value is string {
  return typeof value === 'string' && /^thread-[0-9]+-[0-9a-f]{8}$/.test(value);
}

/** Type guard for role values; unknown roles fail closed. */
export function isRingRole(value: unknown): value is RingRole {
  return value === 'operator' || value === 'maintenance' || value === 'safety' || value === 'manager';
}
