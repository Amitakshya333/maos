# TASK RING-ADAPTER-01 — Run Log

- Date: 2026-11-02. Deadline Nov 4; last blocking integration step before the real-agent demo (Ring service + Ring UI).
- Authoritative review: `C:\maos\review-packets\ring-integration-review-2026-11-02\REVIEW.md` (§1 contract table C1–C17, §4 adapter).
- Base commit: b76363a77e931c417327b7a5fe8cb3a299f125c1 ("Add hosted Ring inference service").
- Worktree: `C:\clean\ring-adapter-01` (detached at base; `npm ci` exit 0, own node_modules).
- `C:\maos` was NOT modified except writing this review packet. No commits/pushes/tags.
- Inputs (both verified SHA-256 before use): service patch `b683629e…56e516` (RING-AGENT-LOOP-01), UI patch `6f88a18e…b91e` (RING-UI-01).

## What was already in the scratch

The scratch worktree already contained both candidate patches applied in order (service, then UI) plus a partial prior-session adapter draft (unvalidated, draft wire test failing). This session audited the draft, fixed three defects (run.started mode projection, A5 undefined-id pairing, unusable wire-test mock), completed the evidence-only leg, and ran the full required validation.

## Commands (exit codes)

| Command | Exit | Result |
|---|---|---|
| `git -C C:/maos worktree add --detach C:/clean/ring-adapter-01 b76363a…` | 0 | (pre-existing; verified `git rev-parse HEAD` = base) |
| `npm ci` (in scratch) | 0 | (pre-existing; 242 packages; `node_modules/.bin/vitest` present) |
| `npm run build:backend` | 0 | clean (before and after adapter fixes) |
| `npm run typecheck:gui` | 0 | clean (before and after adapter fixes) |
| `vitest run tests/industrial/ring-wire-contract.test.ts` (draft) | 1 | 1 failed: mock never reached `awaiting_approval` (expected `completed` to be `awaiting_approval`) — draft mock defect, not a product defect |
| `vitest run ring-wire-contract` (rewritten) | 1→0 | first run: evidence-only passed, hosted leg exposed empty-`text` edge (tool-only turn with null content); mock corrected to real prose; rerun 2/2 passed |
| `vitest run ring-agent + ring-workspace + ring-impl-01` | 1 | 27/28: `ring-agent (a)` failed — `summary` no longer embeds `2.637` (intentional A2 change: verdict line + structured `overallRms`; mock updated, intent preserved) |
| `vitest run ring-agent + ring-workspace + ring-impl-01` (after mock update) | 0 | 28 passed (7+9+12) |
| `vitest run ring-inference + ui1-02-api-clients + ring-wire-contract` | 0 | 41 passed (6+33+2) |
| `git diff b76363a --stat` (patch content check) | 0 | 16 files; sovereign-chat files empty diff |

Total: 69 tests passed (7 ring-agent + 9 ring-workspace + 12 ring-impl-01 + 6 ring-inference + 33 ui1-02-api-clients + 2 ring-wire-contract), build + typecheck clean.

## Adapter items done (all in scratch; server snapshot boundary; UI validator untouched/fail-closed)

- A1 (`src/service/ring-agent-service.ts` `snapshot()` + `toWireEvent()`): snapshot emits `events` = mapped transcript (keeps `transcript` for compat). The `mode.evidence-only` entry is filtered from the wire (mode already on snapshot top-level + folded into the `run.started` wire event as live `run.mode`, not the stale stored placeholder). JSONL on disk untouched: object `argsSummary` + `mode.evidence-only` marker still written by `record()`.
- A2 (mapper): `toolName`→`tool`; `contentSummary`→`text` (only when non-empty; tool-only turns with null content emit no `text` so the UI invents nothing); `tool.result summary`→ short `resultSummary` line + structured `verdict` / `overallRms` (from `overallVibrationRms`) / `sources` (`[source]`) carried on the internal entry via `toolResultProjections` (keyed by `toolCallId`, never re-parsed from JSON); `run.failed error`→`message`; `approval.pending summary`→`action`; `toolCallId` passed through.
- A3 (mapper `formatArgsSummary()`): wire `argsSummary` is a compact `k=v` string rendering of `summarizeArgs()` (undefined/null keys omitted, never invents values); the object form stays in JSONL only.
- A4: covered by A2 (`summary`→`action`); the UI's event-scan finds the pending card with a non-empty action. Snapshot `pendingApproval` stays as harmless extra.
- A5 (`src/gui/src/api/ring-run-types.ts` + `RingWorkspace.tsx`): added `toolCallId?: string` + validator pass-through; chips pair call/result by `toolCallId` only — both sides must carry the same non-empty id (id-less events never pair by accident). Workspace mocks updated with `call-telemetry-1` ids (assertion intent preserved).
- A6 (PM decision: accepted-and-ignored for this release): router `POST /api/v1/ring/runs` accepts optional `agentId` with an explicit accepted-and-ignored comment; forwards it to `startRun` as context metadata only. Service records `agentId: <requested or 'ring-lead'>` + `requestedAgentId` on the `run.started` entry (JSONL/transcript only; Ring lead always executes). UI roster presence only ever marks the Ring lead working/waiting — never claims a selected non-lead agent is working.
- A7 (`RingWorkspace.tsx`): no hardcoded `mode:'hosted'` optimistic state — `TranscriptRun.state` is `RingRunState | null`, holds `null` (no badge/banner) until the first GET resolves; all readers are null-safe (`activeState`, `run.state?.…`).

## Files changed (vs base b76363a; `=` from input patches, `+` adapter-new, `~` adapter-touched)

- `src/service/ring-agent-service.ts` — NEW (= service patch) ~ adapter mapper/snapshot/A6 (~135 lines added)
- `src/service/index.ts` — modified (= service patch, mount ringAgent)
- `src/api/router.ts` — modified (= service patch routes) ~ A6 agentId accept (comment + type + forward)
- `tests/industrial/ring-agent.test.ts` — NEW (= service patch) ~ A2 mock update (verdict line + `overallRms` assertion; intent preserved)
- `src/gui/src/api/ring-run-types.ts` — NEW (= UI patch) ~ A5 `toolCallId` + pass-through
- `src/gui/src/components/RingWorkspace.tsx` — NEW (= UI patch) ~ A5 pairing + A6 presence + A7 null-state
- `src/gui/src/components/RingAskPanel.tsx` — DELETED (= UI patch)
- `src/gui/src/views/ChatView.tsx` — modified (= UI patch; mounts RingWorkspace)
- `src/gui/src/api/rest-client.ts`, `adapter.ts`, `index.ts` — modified (= UI patch run client)
- `tests/gui/ring-workspace.test.ts` — NEW (= UI patch) ~ A5 mock ids (intent preserved)
- `tests/gui/ring-impl-01.test.ts` — modified (= UI patch)
- `package.json` / `package-lock.json` — modified (= UI patch, happy-dom devDependency)
- `tests/industrial/ring-wire-contract.test.ts` — NEW (+) adapter regression test (2 tests: hosted with tool call + approval; evidence-only with zero model turns)

Untouched (verified empty diff): `src/service/chat-inference-service.ts`, `src/backends/factory.ts`.

## Acceptance check

- Validator accepts real snapshots in both modes (wire-contract test runs REAL `RingAgentService` → REAL `validateRingRunState`, both modes, exit 0).
- Tool chips pair by `toolCallId` (mapper passes through; UI pairs strictly; tested).
- Approval card shows a non-empty action (`Vibration Alert…` asserted on the real wire event).
- Evidence-only emits zero `model.turn` events (asserted on the real snapshot + validator).
- Sovereign chat untouched (empty diff on `chat-inference-service.ts`/`factory.ts`).

## NOT verified

- Live Baseten network behaviour; real long-run polling cadence; Electron/browser rendering (happy-dom + source only).
- `CompletionRefusalDemo` via real wire (`latestAnalysisId` regexes `resultSummary` for `telemetry-…`, which the short verdict line no longer carries — reachable in tests only via injected `prepareReview`, same as before the adapter).
- Full repo test suite beyond the six required files + build/typecheck.
- `CockpitView` behaviour (App.tsx untouched; Ctrl+J path per source inspection only).

## Outside the assignment

- None in product code. Scratch-only helpers in `/c/tmp/` (`wirebody.ts`, `wiretest.cjs`, `fixtail.cjs`, `fixmock.cjs`, `fixagent.cjs`, `runone.cjs`, `runtwo.cjs`) and prior-session `maos/.adapter-tmp/` + `C:\clean\ring-adapter-01` worktree are disposable and NOT part of the patch.
