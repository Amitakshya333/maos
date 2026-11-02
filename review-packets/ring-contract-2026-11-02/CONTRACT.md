# TASK RING-CONTRACT-01 — Frozen Ring Agent Contract

- Base commit: `a573e2a722a2db31dbb453ab43c9f36d0e0d6c30` (main HEAD, "Add the Ring agent loop and workspace")
- Owner: PM. Lanes A/B/C start in parallel from this freeze; no lane touches another lane's files.
- Policy: `src/backends/meta-api-policy.ts` is NOT weakened by this contract. Arming rules, endpoint/model pinning, and credential env are unchanged.

## 1. Threads

`RingThread { threadId, title, role, createdAt, runs: runId[] }`

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/v1/ring/threads` | `{ title?, role? }` | `{ threadId }` (201) |
| `GET /api/v1/ring/threads/:id` | — | thread state (404 `NOT_FOUND` when missing) |
| `POST /api/v1/ring/threads/:id/messages` | `{ instruction }` | starts a run carrying prior conversation context; returns `{ runId }` (201) |

- Existing `/ring/runs` (`POST`, `GET /:id`, `POST /:id/cancel`, `POST /:id/approvals/:approvalId`) stays working **unchanged**.
- Threads persist under `.maos/ring-runs/threads/<threadId>.json`; reopening rebuilds from stored history (no in-memory loss on restart). Dev A ships a restart-reload test.
- Validation: `validateRingThreadState` (GUI side, fail-closed); unknown roles rejected.

## 2. Streaming events

Single event union extending the existing `RingRunEvent` — four additive types; the existing nine are untouched:

- `model.delta` — `{ delta: string }` token text.
- `plan.updated` — `{ plan: [{ step, status: pending|in_progress|done }] }` todo list.
- `artifact.created` — `{ artifact: { path, kind, size, sha256 } }`.
- `memory.saved` — `{ memory: { noteId, summary } }`.

**Transport decision: existing WebSocket channel (`/api/v1/events`); NO new SSE endpoint.**

Proof it exists: `src/api/server.ts` upgrades `GET /api/v1/events` (RFC 6455 loopback-only + origin allowlist), `src/api/event-broker.ts` broadcasts persisted `SequencedEvent`s with `projectId`/`runId` scoping, sequence + replay, and `src/gui/src/api/event-client.ts` (`BrowserEventClient`) already subscribes with `runId`. `RingWorkspace.tsx` documents the gap honestly: the channel is project-scoped plumbing and Ring never publishes to it yet, so polling is the current live path.

Frozen transport: Dev B persists each mapped wire event via `EventService.recordEvent` as `SequencedEvent { eventType: 'ring.run.<type>', runId, projectId, correlationId, payload: <wire event> }` — `server.ts` auto-broadcasts it to `runId`-scoped WS subscribers. `GET /api/v1/ring/runs/:id` stays the documented snapshot fallback and the polling path (`getRingRun` / new `getRingRunEvents` alias) keeps working either way. The `onStreamEvent` hook added to `RingAgentService` is the Dev B fan-out point; listener exceptions never break a run and the JSONL transcript is untouched.

## 3. Tool registry

```ts
interface RingToolDefinition {
  name: string; description: string; parameters: object;
  consequential: boolean; roles?: Role[];
  execute(ctx, args): result;
}
```

- Tools live in separate files (`src/service/ring-tools/*.ts`); this packet ships the six stubs with frozen names/descriptions/parameters/flags.
- The existing 6 tools (`analyze_telemetry`, `read_company_document`, `search_knowledge`, `draft_safety_note`, `verify_export`, `request_approval`) migrate onto the interface in Dev C with **BEHAVIOR UNCHANGED** (same tests green — the migration moves method bodies verbatim, keeps `summarizeArgs`/`truncate` shapes, keeps JSONL field names).
- **Consequential enforcement lives in the REGISTRY** (`registry.isConsequential()` is the single approval gate; unknown tools fail closed as consequential) — not the model. Current consequential set: `draft_safety_note`, `request_approval`.
- Results truncated via the existing `truncate()` pattern.

## 4. Roles

`'operator' | 'maintenance' | 'safety' | 'manager'`. Default `operator` exists so current tests don't break. Role affects the system prompt (Dev C, keyed off `thread.role` stored at thread creation) and the tool set (registry `roles?` visibility; unlisted = visible to all).

## 5. Artifacts

Stored under `.maos/ring-runs/artifacts/<runId>/`. Served by `GET /api/v1/ring/runs/:runId/artifacts/:filename` with path checks reusing the `isWithin`/`isStrictlyWithin` patterns (never serve outside the run dir). Descriptor `{ path, kind, size, sha256 }` rides `artifact.created` events.

## 6. What the dev lanes own (no shared files)

- **Dev A** — `src/service/ring-thread-service.ts` (replace NOT_IMPLEMENTED bodies), thread routes in `src/api/router.ts` (thread block only), `RingWorkspace` thread UI.
- **Dev B** — `record()` fan-out in `src/service/ring-agent-service.ts` (hook exists), WS publish via `EventService.recordEvent`, streaming event emitters, GUI live-path switch. Owns NO router thread block, NO tool files.
- **Dev C** — `src/service/ring-tools/*.ts` (move bodies verbatim), registry wiring + `isConsequential` swap-in, role prompts, `src/service/ring-artifacts.ts` + artifact download route. Owns NOTHING in the service loop except the two-line gate call.

Shared frozen types: `src/service/ring-contract.ts`, `src/service/ring-tool-registry.ts`, validators in `src/gui/src/api/ring-run-types.ts`. Any change to these three files requires a PM contract amendment — lanes do not edit them unilaterally.

## 7. Evidence

- New contract test `tests/industrial/ring-contract.test.ts` (5 tests): thread shape + restart-reload, event union validation, registry gate, streaming hook.
- Tools-temp OCR/vision preflight: see `PREFLIGHT.md` in this packet (read-only; no installs; no live calls).
