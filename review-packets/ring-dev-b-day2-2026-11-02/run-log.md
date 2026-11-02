# TASK DEV-B-02 — run log (2026-11-02)

Base: `ba451de` (`Document frozen Ring contract and preflight`).
Scratch: `C:/clean/ring-b-day2` (detached worktree at `ba451de`, own `npm ci` — 242 packages, 8s).
Packet: `C:/maos/review-packets/ring-dev-b-day2-2026-11-02/` (ONLY `C:/maos` writes).
No commits to main, no pushes. `BASETEN_API_KEY` unset throughout; all tests evidence-only/mocks.

## Baseline (before changes)

- `npx vitest run ring-devb-surface + ring-workspace + ring-impl-01 + ui1-25`: 4 files, 54 passed.
- `npx tsc -p tsconfig.gui.json --noEmit`: exit 0.

## Changes (GUI/shell + additive glue only; frozen contracts untouched)

1. `src/gui/src/components/RingWorkspace.tsx` — `handleSelectThread` now loads the selected
   thread's runs through the same `getRun` poll path into the transcript (thread history per
   thread, not the previously active view); unreachable runs keep a `null` state. New threads
   already start with the picked role + empty view (`handleNewThread` unchanged behavior).
2. `src/gui/src/api/adapter.ts` — `storeRingCsvEvidence` glue fix: resolves
   `receipt.source.relativePath` (the EVIDENCE CSV `analyze_telemetry` reads), NOT the analysis
   receipt JSON (`receiptPath`). No router change — the telemetry route stays the only
   evidence-root write route (server lane owns validation; writes never escape the evidence root).
3. `src/gui/src/components/RingAttachments.tsx` — honest per-kind local-only labels: screenshots
   `inspect_image pending (Dev C)`; PDF `no evidence-root write route for PDF yet`; CSV
   `evidence store unreachable`. Same-file `attachmentInstructionSuffix` unchanged
   (`csvPath:`/`documentPath:` only for stored paths).
4. `src/gui/src/components/RingOverlay.tsx` — screenshot button arms only one held capture at a
   time (disabled while a chip is held; discard before re-taking). Still explicit + visible,
   never automatic; in-memory only, labelled `inspect_image` pending.
5. `src/gui/src/components/RingThreads.tsx` — role picker keeps the frozen four-role vocab and
   reuses the `RoleOnboardingModal` pattern pieces that fit a header control (group label +
   `describedby` note); never mislabels Ring roles as workspace presets. Same thread ids
   overlay<->full; Expand handoff key unchanged.
6. Artifact open/download — no code change needed: card calls `downloadArtifact(runId, filename)`
   through the adapter (session bearer header, never a token in a URL; filename is a single path
   segment). Verified by the real-loopback test below + this-machine check (item 5) that the
   click path downloads the real file.

Voice: CUT per scope — no local transcription engine exists; nothing was built. Recorded here only.

## Tests added (all evidence-only; `BASETEN_API_KEY` unset)

`tests/gui/ring-devb-surface.test.ts` (+6):
- thread sidebar history: Expand handoff for `thread-a` loads `run-a1` via `getRun` (`seen`
  contains `run-a1`), transcript shows `A history line`; role picker options are exactly
  `[operator, maintenance, safety, manager]`.
- `storeRingCsvEvidence` resolves the evidence CSV path (`e/x-v.csv`, not `r/x.json`).
- `storeRingCsvEvidence` rejects loudly with `no evidence path` when the receipt has none.
- PDF local-only chip names the missing write route.
- Overlay screenshot button disables while one capture is held (single-capture guard).
- Artifact card passes `(runId, filename-suffix)` — filename only, never the raw path.
- Real-loopback download: `RingArtifactService.saveArtifact` -> `resolveArtifactPath` returns the
  bytes; `GET /api/v1/ring/runs/run-day2/artifacts/safety-note.md` on a live loopback
  `RestApiServer` (temp project, evidence-only) returns `T-07 review`; traversal
  (`..%2Fsecret.txt`) returns 400/404.

`tests/gui/ring-workspace.test.ts` (+1):
- Sidebar select swaps the transcript to that thread's history; a new thread is created with the
  picked role input.

## Verification (exit codes)

- `npx vitest run ring-devb-surface + ring-workspace + ring-impl-01 + ui1-25 + ring-contract + ring-agent`: **6 files, 74 passed, exit 0**
- `npx tsc -p tsconfig.gui.json --noEmit`: **exit 0**
- `npx tsc -p tsconfig.json --noEmit` (full): **exit 0**
- `npm run build`: **exit 0** (vite 1.04s; chunk-size warning only, pre-existing)
- `BASETEN_API_KEY`: unset (verified `echo` before each run block)

## Machine-test table (THIS machine)

| Check | Result |
|---|---|
| Overlay hotkey default `CommandOrControl+Shift+Space` (+ `MAOS_RING_HOTKEY` override) | VERIFIED (node harness, this machine) |
| Overlay route `#/ring-overlay`; toggle create/show/hide/focus via injected `BrowserWindow` (private-IPC preload, no token in URL) | VERIFIED (node harness, this machine) |
| Real loopback artifact download (save -> resolve -> GET bytes; traversal 400/404) | VERIFIED (vitest, this machine, evidence-only temp project) |
| Screen capture success/failure contract (base64 + `displays: 1`; loud reason on denial) | VERIFIED via `capturePrimaryDisplay` unit path (desktop test, this machine) |
| Display enumeration | 1 display reported (Generic PnP Monitor; Win32 `ScreenWidth/Height` blank in this headless session — recorded honestly) |
| Translucency by eye | NOT VERIFIED — no composited-desktop eyeball check run (flag `transparent: true` set at construction; visual judgement requires the running Electron window) |
| 2+ monitors | NOT VERIFIED — absent on this machine (1 display) |
| Physical hotkey from another app (global shortcut while another app focused) | NOT VERIFIED — Electron is not installed in this scratch (`electron` binary absent; registration result covered by unit path only, `registerRingHotkey` loud-error branch) |
| Voice transcription | CUT per scope — not built, not tested |
| PDF/image evidence-root copy | NOT DONE — no server write route exists for those kinds (Dev A lane owns server validation); UI flow labels them local-only honestly instead of fabricating a store |

## T-07 / RingWorkspace regression check

`ring-impl-01`, `ring-workspace`, `ring-contract`, `ring-agent` suites all pass unchanged above
(74 total). Electron security posture untouched: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true` on both windows; preload exposes IPC only
(`initialize`/`expandRing`/`captureRingScreen`); session token travels the bearer header, never a URL.

## Anything outside assignment

- None. No router/service/tool/contract edits; no desktop behavior changes; no server write-route
  additions; no auto-capture path; no commits; no pushes.

## Patch applicability

- `git apply --check` against the dirty scratch fails spuriously (changes already present there).
- Verified on a pristine `ba451de` checkout (`C:/clean/ring-day2-verify`, removed after): `git apply --check` **exit 0**, stat matches the 7 files above.
