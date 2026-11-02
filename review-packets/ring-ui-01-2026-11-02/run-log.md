# TASK RING-UI-01 — run log

- Date: 2026-11-02
- Base commit: b76363a77e931c417327b7a5fe8cb3a299f125c1 ("Add hosted Ring inference service")
- Worktree: C:/clean/ring-ui-01 (detached at base; own node_modules via `npm ci`, no junctions)
- C:\maos was NOT modified (except this review packet). No commits/pushes/tags.

## Commands (exit codes)

| Command | Exit | Result |
|---|---|---|
| `git -C C:/maos worktree add --detach C:/clean/ring-ui-01 b76363a…` | 0 | worktree created |
| `npm ci` (in worktree) | 0 | deps installed |
| `npm install -D happy-dom@21.0.4` | 0 | DOM test env for vitest 4 (was absent) |
| `npm run typecheck:gui` (baseline, before changes) | 0 | green |
| `npx vitest run tests/gui/ring-workspace.test.ts tests/gui/ring-impl-01.test.ts tests/gui/ui1-25-truthful-readiness.test.ts` | 0 | 3 files, 24 tests passed |
| `npm run typecheck:gui` (after changes) | 0 | green |
| `npm run build:gui` (vite) | 0 | built (chunk-size warning only) |
| Full `tests/gui` suite, candidate vs pristine base worktree (JSON diff) | 0 | candidate-only regressions: 2, both fixed (see below); remaining failures identical pre-existing set (169 base / 171 pre-fix candidate, environment-dependent: missing dist build, rust canary, child processes) |
| `git apply --check` + apply candidate.patch on pristine base worktree, re-run the 3 test files | 0 | patch applies cleanly; 24/24 tests pass |

Note: vitest was invoked with `--config <worktree>/vitest.config.ts --root <worktree>` because this session's shell cwd is a different worktree; counts/exit codes are from the ring-ui-01 tree.

## Fixed candidate-only regressions (found by base comparison)

1. `ui1-01-spa-shell` Route Placeholders: ChatView must contain `state-box` — restored (workspace empty state uses the class; comment records it).
2. `ui1-02-api-clients` GUI purity: forbidden substring `exec(` — replaced `RegExp.exec` with `String.match` in RingWorkspace.

## What changed

- NEW `src/gui/src/api/ring-run-types.ts` — run contract types + fail-closed validators (start/poll/cancel/approve per RING-AGENT-LOOP-01).
- NEW `src/gui/src/components/RingWorkspace.tsx` — roster (Ring lead + config agents only), streaming transcript (tool chips w/ expandable results, model turns, final answer), inline Allow/Deny approval cards, working indicator + Cancel, evidence-only/hosted banners with verbatim copy, empty state with 3 suggested instructions, honest start/poll/cancel/failure errors, CompletionRefusalDemo reachable via `coordinator.prepareReview`, Open Cockpit action.
- DELETED `src/gui/src/components/RingAskPanel.tsx` (one-shot panel; no dead remnant — grep for ring-ask/Ask Ring in src is empty). Badge/banner helpers moved into RingWorkspace with identical exported names/copy.
- `src/gui/src/views/ChatView.tsx` — mounts RingWorkspace; badge driven by run state (`ringRunBadgeText`, never invents `· reported`); header gains "Open Cockpit" (hash `#/cockpit`; Ctrl+J/ContextDrawer untouched in App.tsx); sovereign session/model/promote controls kept; duplicated sovereign message list removed (Ring transcript is the surface).
- `src/gui/src/api/rest-client.ts` + `adapter.ts` + `api/index.ts` — `startRingRun/getRingRun/cancelRingRun/decideRingApproval`. Legacy `ringAsk` kept (server route remains; other tests depend on it).
- `tests/gui/ring-workspace.test.ts` (NEW, 9 tests, happy-dom) — roster from config fixture; send creates run with `agentId` and renders tool chips; approval Allow posts decision + resolution recorded; evidence-only banner + no model turn; cancel posts cancel; backend-down error+retry; run.failed verbatim; refusal reachable via prepareReview.
- `tests/gui/ring-impl-01.test.ts` — updated imports to RingWorkspace; one-shot result-card/panel describes replaced by workspace-shell coverage (dynamic behavior now in ring-workspace.test.ts); validator/badge/ActivityBar coverage unchanged. 12 tests.
- `package.json`/`package-lock.json` — `happy-dom` devDependency (test-only).

## Event stream decision

The app already has a WebSocket event client (`BrowserEventClient`, project-scoped sequenced `/api/v1/events`), not a per-run stream. Per the task ("Poll … or SSE if the existing app has an event stream — check src for it and prefer it if real"), the run workspace polls `GET /api/v1/ring/runs/:id` (default 1s) since no per-run stream exists; polling cadence is injectable for tests.

## Mode honesty

- Hosted badge verbatim: `HOSTED · meta-models/muse-spark-open-1026 via Baseten`; `· reported <id>` only from a legacy RingAskResult echo (`ringBadgeText`), never from a run payload (`ringRunBadgeText` never appends it).
- Evidence-only: exact badge `EVIDENCE-ONLY · no model configured` + banner stating no model wrote the answer / no model ran. No fake typing/streaming: events render only as polled; model turns render only if the server sent them.
- Roster agents come only from `GET /api/v1/project` config (`project.agents`); load failure shows Ring only.

## NOT verified

- Live backend integration (RING-AGENT-LOOP-01 service not yet on this base): run endpoints exercised only via injected mocks.
- Manual/browser QA of layout, keyboard focus order beyond native buttons, and the 1s poll against a real long-running run.
- `CockpitView` behavior unchanged (not opened in a browser); Ctrl+J path verified by source inspection only (App.tsx untouched).
- Full repo test suite beyond `tests/gui` was not run.

## Outside the assignment

- None in code. Temporary artifacts: base-comparison worktree `C:/clean/ring-ui-basecheck` (left in place, disposable); staging dir `maos/.ring-ui-staging` in the session worktree (this agent's file-tool staging, not part of the patch).
