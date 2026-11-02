# TASK RING-IMPL-01 — run log

- Base commit: `5cf1afe28fa514d91a62e871885a8406f40316f3` (main at task start; verified `git rev-parse HEAD`).
- Worktree: `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-ring-impl-01` (detached HEAD at base).
- `C:\maos` sources never edited. No commits, pushes, or tags. Index touched only
  transiently (`git add -N` to emit the patch, then `git reset -q`); verified empty after.
- Deliverable: `candidate.patch` (37,664 bytes)
  SHA-256: `5EAC51EEA337BE7B9A38967D454EF0448C316EC331260F9BD1C463970A7E384C`
- Patch self-containment: `git apply --check` in a second pristine worktree at base → exit 0
  (verify worktree removed afterwards).

## 1. ChatView behaviour relied on (rename-in-place record)

ChatView.tsx at base (5cf1afe) is a sovereign-local surface; the following behaviour is
relied on and unchanged by this patch (only additive Ring state + two copy mappings):

- Conversations load via `apiAdapter.getConversations()` with first-conversation
  auto-select; active conversation fetched via `getConversation(activeConvId)`.
- `loadModels()` polls `getActiveModelIdentity()` + `getModels()` every 5 s; the model
  selector + confirm/downgrade flows (`switchModel`, `chat-switch-error-banner`,
  `chat-confirm-prompt-banner`) are untouched.
- Send path: `addMessage(user)` → `chatCompletion(conversationId, history)` →
  `addMessage(assistant, isModelGenerated, verifiedAgainstData:false)`; the
  `MODEL_SERVER_UNAVAILABLE` branch text is untouched.
- Promotion (`promoteToTask` modal + `Link Task` banner), mode toggle
  (`evidence`/`brainstorm` + downgrade modal), pin toggle, attachment tray (50 MB
  project-root confinement copy), and the `unverified-prose-badge` are untouched.
- Empty-state title `Sovereign Local Chat Ready` is intentionally unchanged.

Ring additions to the view: `ringResult` state (null until first ask), state banner
(hosted/evidence-only, rendered only when a result exists), `RingAskPanel` mount above
the unchanged workspace, badge text via `ringBadgeText()` (local text preserved as the
fallback), assistant attribution via `ringRoleLabel()`.

## 2. Files changed

- `src/gui/src/components/ActivityBar.tsx`: O-1 `chat` first in `INDUSTRIAL_DEMO_VIEWS`;
  O-2 label `Chat & Sessions` → `Ring`.
- `src/gui/src/views/ChatView.tsx`: rename-in-place (aria-label `Ring View`, title
  `Ring & Interactive Exploration`); badge/banner/panel wiring; `RING` attribution.
- `src/gui/src/api/ring-types.ts` (NEW): exact RING-SVC-01 contract + fail-closed
  `validateRingAskResult` (never invents identity).
- `src/gui/src/components/RingAskPanel.tsx` (NEW): ask panel, result card, banners,
  verify card, `ringBadgeText`/`ringRoleLabel` helpers.
- `src/gui/src/api/rest-client.ts`: `ringAsk()` → POST `/api/v1/ring/ask` (120 s).
- `src/gui/src/api/adapter.ts`: `ringAsk()` wrapper.
- `src/gui/src/api/index.ts`: re-export `ring-types`.
- `.env.example`: O-6 commented `# BASETEN_API_KEY=` placeholder (+ one comment line).
- `tests/gui/ring-impl-01.test.ts` (NEW): 16 tests.

## 3. Verbatim copy (as implemented)

- Hosted badge: `HOSTED · meta-models/muse-spark-open-1026 via Baseten`
  (+ `· reported <id>` only from server echo).
- Evidence-only badge: `EVIDENCE-ONLY · no model configured`.
- Hosted banner: `Meta model reasoning via Baseten. Company evidence stays in MAOS.`
- Telemetry boundary: `raw telemetry never leaves MAOS; only the summary is sent`.
- Evidence-only banner contains both `no model wrote this answer` and `no model ran`.
- Verify fallback: `No export verified yet.`
- Refusal reuses `CompletionRefusalDemo` via a Ring-owned `TelemetryReviewCoordinator`
  (`prepareReview` → real gate; refusal text rendered verbatim in `role="alert"`).

## 4. Commands + exit codes (worktree)

| # | Command | Exit |
|---|---|---|
| 1 | `npx tsc -p tsconfig.gui.json --noEmit` (initial) | 2 (ring-types `Record→RingAskResult` cast; fixed with `as unknown as`) |
| 2 | `npx tsc -p tsconfig.gui.json --noEmit` (after fix) | 0 |
| 3 | `npx vitest run tests/gui/ring-impl-01.test.ts tests/gui/ui1-25-truthful-readiness.test.ts tests/gui/telemetry-review-state.test.ts tests/gui/telemetry-review-coordinator.test.ts tests/gui/rest-client-abort.test.ts tests/gui/telemetry-refusal-demo.test.ts` (initial) | 1 (one assertion expected raw quotes; static markup HTML-escapes to `&quot;`; fixed test) |
| 4 | same vitest command (after fix) | 0 — 6 files, 68 tests passed (ring-impl-01: 16) |
| 5 | `npx prettier --check` on 8 touched files | 1 — but untouched base files (`Header.tsx`, `TelemetryReviewPanel.tsx`) fail identically, so only the 3 NEW files were formatted (`--write`, exit 0); existing files left byte-stable outside the task diff |
| 6 | `npx tsc -p tsconfig.gui.json --noEmit` (after format) | 0 |
| 7 | same vitest command (after format) | 0 — 6 files, 68 tests passed |
| 8 | `git apply --check` of candidate.patch in pristine base worktree | 0 |

Test env: `node_modules` junction → `C:\clean\core-b2-02\node_modules` (donor package
version 0.3.0, devDependencies identical to worktree; verified absent before, ReparsePoint
+ target after, removed after the runs; `Test-Path` False confirmed).

## 5. Exclusions verification (step 7)

- `git diff --name-only | Select-String chat-inference` → 0 matches; `ChatInferenceService`
  untouched; sovereign `chatCompletion` route/client path unchanged.
- Client sends only `{ question, analysisId? }` to `/api/v1/ring/ask`; no telemetry payload
  exists anywhere on the Ring client path.
- No approval creation/decision code added; served-model suffix renders only from server echo.
- No credential persistence added (`.env.example` comment only; key stays env-only).
- App header brand (`MAOS // MONOCHROME MISSION CONTROL`) untouched.

## 6. Notes / dependencies

- The GUI consumes `POST /api/v1/ring/ask` per the contract; the route/service itself is
  TASK RING-SVC-01 (Antigravity). Until it lands, asks surface the transport error
  verbatim with `No model ran` semantics (no silent fallback, no invented result).
- `RingVerifyCard` renders transcript lines only from provided real output; with no
  export evidence it shows `No export verified yet.` ChatView currently passes no
  transcript (no GUI-accessible export-verify route exists per O-5), so the fallback
  shows until RING-SVC-01 or a later task supplies real transcript data.
