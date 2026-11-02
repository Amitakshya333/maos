# Findings → fixes mapping (COMPLETION-FIX-06)

## 1. Review-preparation lifetime

`openAgentReview` now delegates to `TelemetryReviewCoordinator.prepareReview`,
which captures the source identity and a per-request generation id before
awaiting, then applies `reviewRun`, the `localStorage` write, and Approvals
navigation only if both are still current. `reviewBusy` is set at start and
cleared in a guarded `finally`: a stale finish never clears a newer request's
busy state. The same coordinator owns the guards for analysis, ask, and
reconnect flows. Cancellation (AbortController) is retained and supplements —
never replaces — the guards. The 80%-budget reminder is untouched.

## 2. Sample vs file identity

One unambiguous active source: selecting the bundled sample clears the
previously uploaded file (`selectedFile` → null plus file-input reset), so no
stale file remains available as though it were the sample; the agent button
stays disabled until a file is explicitly reselected. `askAboutCsv` additionally
refuses when the active source is not that exact file, so no request for a
detached file can run under a sample identity. File → sample → ask and
sample → file transitions are covered by tests 3–4 below.

## 3. Behavioral tests (no new framework; node vitest, existing GUI approach)

`tests/gui/telemetry-review-coordinator.test.ts` drives the exact coordinator
implementation the panel delegates every side effect to (fake adapters with
deferred promises, recorded applies/storage/navigation):
- Prepare A → select B → resolve A: no stale `reviewRun`, storage write,
  navigation, or error.
- Prepare A → select B → start B → finish A: B's busy survives; only B's finish
  clears it; B's run/storage/navigation apply.
- File A → sample → ask: zero adapter calls, no phase transitions.
- Sample → new file B: upload bound to B's name, result applied, phase completed.
- Stale reconnect and stale analysis results ignored.
`tests/gui/telemetry-review-state.test.ts` (helper contract) and the FIX-04
suites are retained. Total: 94 tests across 8 files in one run (no overlap).

## 4. Wording

Reminder narrowed to "requires no repository/project deliverable changes
required" — telemetry receipts and audit persistence are legitimate side
effects and were never project mutations. Empty `files_changed`, structured
`task_complete`, evidence binding, and budgets unchanged.
