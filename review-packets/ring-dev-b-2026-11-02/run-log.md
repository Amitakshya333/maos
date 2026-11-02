# TASK DEV-B-01 — Ring surface (desktop + UI): run log

Lane: Dev B (surface). Worktree: `C:/clean/ring-dev-b-surface`, branch `ring/dev-b-surface`.
Base commit: `8b39caf36cacdb461504bd54ce66e7f8b9707855` ("Freeze Ring contracts...").

## Base-state verification

- `git -C C:/clean/ring-dev-b-surface log --oneline -1` → `8b39caf` — already at the
  contract commit; no merge needed (assignment text said `d98d40f`, stale).
- `BASETEN_API_KEY` unset (verified empty). No live/hosted calls, evidence-only throughout.
- `npm ci` in the worktree (own `node_modules`): `added 242 packages`, exit 0.
- Frozen contracts read, NOT changed: streaming union + validators in
  `src/gui/src/api/ring-run-types.ts`, thread shapes in `src/service/ring-contract.ts`,
  artifact path, role type `operator|maintenance|safety|manager`.
- Pre-existing work in the worktree (tracked modifications + untracked lane files)
  was adopted and completed, not rewritten.

## What was built (all in-lane, additive, fail-closed)

Day 1 — overlay shell + streaming display:
- Electron second window: frameless, `transparent: true`, `alwaysOnTop`,
  `skipTaskbar`, dedicated `#/ring-overlay` route rendering only the compact
  `RingOverlay` (no app shell). Same bundle, same session partition as the main
  window; preload-IPC + loopback auth only; never token-in-URL.
- Global hotkey `CommandOrControl+Shift+Space` (configurable via
  `MAOS_RING_HOTKEY`; NOT Ctrl+Space / Alt+Space — see code comment).
  Registration failure shows a dialog + console error and records
  `overlayState.hotkeyError` — never silent.
- Tray icon (Show / Expand / Quit), `will-quit` unregisters the hotkey.
- Animated `RingMark` with states idle/thinking/using-tool/
  waiting-for-approval/done/error (SVG pulse only while active; static otherwise).
- Overlay consumes the contract transport: live text (`model.delta`,
  concatenated verbatim, "live" marker only while polling), live plan
  checklist, tool chips, artifact cards (open/download via adapter, run id +
  filename — never a raw path), memory notes, inline Allow/Deny approval card,
  exact `EVIDENCE-ONLY` / `HOSTED` badge copy.

Day 1 fix found while wiring: the main-process `maos:initialize` handler checked
every sender against the main window's `mainFrame`, so the overlay (own frame)
could NEVER complete the session handshake. Fixed: each sender is checked against
its own main frame; loopback-origin check unchanged.

Expand (same thread ids): overlay posts into an overlay thread when the thread
client is reachable (falls back to unscoped runs with an honest note) and hands
off thread-id-first (run-id fallback) via `maos:ring:expand-thread` localStorage +
`maos:expand-ring` IPC. The full `RingWorkspace` adopts the handoff on mount/focus
(thread summary + run history, or run append + poll), then consumes the key.
The overlay never navigates itself away (old `#/chat` hop removed).

Day 2 — threads/roles/attachments/screenshot:
- Thread sidebar (history + New button) + role picker (frozen four roles) in the
  full view. Thread routes are Dev A's lane: first 404/connection failure flips
  `threadsAvailable` off and the workspace keeps starting unscoped runs with an
  honest note. Nothing fabricated, no fake thread ids.
- `RoleOnboardingModal.tsx` was deliberately NOT reused: it manages workspace
  layout presets (`developer/inspector_analyst/...`), a different domain from Ring
  agent roles (`operator/maintenance/...`). Reuse would misrepresent what "role"
  means. Documented here instead of forcing it.
- Drag-drop/paste PDF/image/CSV into Ring: files are read locally, CSVs are
  copied into the evidence root via the existing telemetry-upload route and
  referenced as `csvPath:`; PDF/image have NO server write route (telemetry
  route is CSV-only by server validation), so they stay local-only and the chip
  says exactly that (`documentPath:` is referenced only for stored paths —
  hence only CSV today; nothing invented).
- "What am I looking at?" — explicit trigger only, visible indicator, never
  automatic: browser builds use the OS screen picker (`getDisplayMedia`);
  Electron uses one-shot main-process `desktopCapturer` capture of the primary
  display via private IPC `maos:capture-ring-screen`. The PNG is held in memory
  only (thumbnail chip), labelled `local only — inspect_image pending (Dev C)`
  since `inspect_image` is Dev C's lane.
- Voice (push-to-talk): CUT on Day 2 per the cut order — no local transcription
  engine exists in the repo; shipping cloud transcription would violate
  non-negotiables 2/3. No voice code was added.

## Validation

- Regression gate (all green):
  `npx vitest run tests/gui/ring-workspace.test.ts tests/gui/ring-impl-01.test.ts
  tests/gui/ui1-25-truthful-readiness.test.ts tests/gui/ring-devb-surface.test.ts`
  → 4 files, **52 tests passed** (exit 0). `ring-workspace.test.ts` untouched.
- `npm run typecheck:gui` → exit 0. `npm run build` → `✓ built in ~1s`, exit 0.
- Wider `tests/gui/` run: 144 failures across 19 unrelated suites
  (role-presets, fair-queue, approvals, cockpit, one-project, ...). Proven
  pre-existing: stashed ALL lane changes (`git stash -u`) and re-ran 3 sample
  suites → identical 22 failed / 71 passed with and without the lane. Cause is
  environmental (e.g. missing `rust/test.txt` canary fixture in this checkout),
  untouched by this lane.
- Electron machine smoke (`desktop/ring-smoke.cjs`, this machine, real
  Electron 45): **13/13 checks passed**, exit 0 —
  1 display enumerated (1536×864 @1.25, primary), hotkey default correct and
  *registered*, overlay window created with bounds 400×640, frameless/
  translucent/always-on-top flags set at construction, `#/ring-overlay` route
  renders overlay + idle mark, show/hide toggle works, window focusable,
  capturePage non-empty (500×800).
- HONESTLY NOT verified: visual translucency judged by eye (no human looked at
  the composited desktop); multi-monitor placement beyond one display (only 1
  display on this machine); end-to-end hotkey press from another app (smoke
  covers registration + toggle path, not a physical keypress).

## Deliverable

- `candidate.patch` — unified diff vs base `8b39caf` (tracked + lane files),
  verified with `git apply --check` against a pristine `8b39caf` checkout.
- SHA-256 in `candidate.sha256`.

## Outside the assignment

None — no contract files touched, no `C:/maos` edits outside this packet dir,
no commits, no pushes, no tags, no live calls.
