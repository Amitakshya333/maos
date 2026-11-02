/**
 * TASK RING-DEV-B-01 (Day 2a): thread sidebar + role picker for the Ring
 * workspace.
 *
 * Consumes ONLY frozen shapes:
 * - `RingRole` / `RING_ROLES` / `DEFAULT_RING_ROLE` from the contract
 *   (`src/service/ring-contract.ts` value universe mirrored locally — the
 *   GUI cannot import server sources, so the four literals are repeated here
 *   with a comment pointing at the source of truth).
 * - Thread wire shape validated by `validateRingThreadState`
 *   (`threadId/title/role/createdAt/runs`).
 *
 * Honesty rules:
 * - Thread routes are Dev A's lane. When the service answers (200) the
 *   sidebar lists threads and posts messages into the active thread
 *   (`POST /threads/:id/messages`, which starts a run carrying prior
 *   conversation context). When the service 404s (Dev A not yet merged),
 *   the sidebar says so verbatim and the workspace keeps starting
 *   unscoped runs — nothing is fabricated, no fake thread ids.
 * - Role affects prompt+tools server-side (Dev C keys off `thread.role`).
 *   Picking a role creates (or re-tags locally) the active thread with that
 *   role; when the thread service is unavailable the picker still records
 *   the request and labels it `requested (thread service unavailable)` so
 *   the user never believes the role applied when it did not.
 */
import React from 'react';
import { validateRingThreadState } from '../api/ring-run-types';

/**
 * Source of truth: `src/service/ring-contract.ts` (`RING_ROLES`,
 * `DEFAULT_RING_ROLE`). Repeated here because the GUI bundle cannot import
 * server sources; keep the two lists identical.
 */
export const RING_ROLES: readonly string[] = ['operator', 'maintenance', 'safety', 'manager'];
export const DEFAULT_RING_ROLE = 'operator';

/**
 * TASK RING-DEV-B-01 (Day 1a): Expand handoff key shared by the overlay
 * (`RingOverlay`) and the full view (`RingWorkspace`). The value is a
 * thread id (preferred — same thread ids in both views) or a run id
 * fallback. Lives here so neither view imports the other. Same
 * localStorage partition in Electron (shared session partition), so the
 * key survives the overlay→main-window hop.
 */
export const RING_EXPAND_KEY = 'maos:ring:expand-thread';

export interface RingThreadSummary {
  threadId: string;
  title: string;
  role: string;
  createdAt: string;
  runs: string[];
}

export interface RingThreadClient {
  createThread: (input: { title?: string; role?: string }) => Promise<{ threadId: string }>;
  getThread: (threadId: string) => Promise<RingThreadSummary>;
  postMessage: (threadId: string, instruction: string) => Promise<{ runId: string }>;
}

export function toThreadSummary(value: unknown): RingThreadSummary {
  const v = validateRingThreadState(value);
  return { threadId: v.threadId, title: v.title, role: v.role, createdAt: v.createdAt, runs: [...v.runs] };
}

export const RingRolePicker: React.FC<{
  role: string;
  threadAvailable: boolean;
  onPick: (role: string) => void;
}> = ({ role, threadAvailable, onPick }) => (
  <span role="group" aria-label="Ring role" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
    <label htmlFor="ring-role-select" style={{ color: 'var(--text-dim, #888888)' }}>Role</label>
    <select
      id="ring-role-select"
      aria-label="Ring role"
      aria-describedby={threadAvailable ? undefined : 'ring-role-unscoped-note'}
      data-testid="ring-role-picker"
      value={role}
      onChange={(event) => onPick(event.target.value)}
      style={{
        padding: '4px 8px',
        borderRadius: '4px',
        border: '1px solid var(--border-color, #444444)',
        backgroundColor: 'var(--bg-primary, #121212)',
        color: 'inherit',
        fontSize: '12px',
      }}
    >
      {RING_ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
    {!threadAvailable && (
      <span
        id="ring-role-unscoped-note"
        data-testid="ring-role-unscoped-note"
        style={{ fontSize: '11px', color: 'var(--status-amber, #eab308)' }}
        title="The thread service is not available, so the role cannot be attached to a thread yet. Runs start unscoped."
      >
        requested — thread service unavailable
      </span>
    )}
  </span>
);

export const RingThreadSidebar: React.FC<{
  threads: readonly RingThreadSummary[];
  activeThreadId: string | null;
  available: boolean;
  loading: boolean;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}> = ({ threads, activeThreadId, available, loading, onSelect, onNew }) => (
  <nav
    aria-label="Ring threads"
    data-testid="ring-thread-sidebar"
    style={{
      width: '200px',
      flexShrink: 0,
      backgroundColor: 'var(--bg-secondary, #1a1a1a)',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #333333)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border-color, #333333)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <span style={{ fontWeight: 600, fontSize: '13px' }}>Threads</span>
      <button
        type="button"
        data-testid="ring-new-thread"
        onClick={onNew}
        disabled={!available}
        title={available ? 'Start a new thread' : 'Thread service unavailable'}
        style={{ padding: '2px 8px', fontSize: '12px' }}
        className="btn-secondary"
      >
        + New
      </button>
    </div>
    <div style={{ overflowY: 'auto', padding: '6px', flex: 1 }}>
      {!available && (
        <div data-testid="ring-threads-unavailable" style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--text-dim, #888888)' }}>
          Thread history is unavailable (thread service not reached). Runs below are this session only.
        </div>
      )}
      {available && loading && (
        <div style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--text-dim, #888888)' }}>Loading…</div>
      )}
      {available &&
        threads.map((thread) => {
          const selected = thread.threadId === activeThreadId;
          return (
            <button
              key={thread.threadId}
              type="button"
              data-testid={'ring-thread-' + thread.threadId}
              aria-pressed={selected}
              onClick={() => onSelect(thread.threadId)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: '4px',
                cursor: 'pointer',
                marginBottom: '4px',
                backgroundColor: selected ? 'var(--accent-dim, rgba(59, 130, 246, 0.2))' : 'transparent',
                border: selected ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent',
                color: 'inherit',
              }}
            >
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {thread.title || thread.threadId}
              </span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-dim, #888888)' }}>
                {thread.role} · {thread.runs.length} run{thread.runs.length === 1 ? '' : 's'}
              </span>
            </button>
          );
        })}
    </div>
  </nav>
);
