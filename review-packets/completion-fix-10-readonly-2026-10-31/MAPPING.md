# Findings → fixes mapping (COMPLETION-FIX-10)

Scope: GUI lifecycle only. The agent-runner classification/reminder is
byte-identical since FIX-06 (frozen; Finding 4's narrowed wording
"requires no repository/project deliverable changes" was already present and
is preserved verbatim). No panel redesign, no budget/acceptance changes.

Invariant (enforced in `TelemetryReviewCoordinator`): every async operation
captures {source key, sequence, per-op id} and checks all three before EVERY
state or external side effect. Only the current operation applies; stale
operations no-op. Cancellation supplements guards, never replaces them.

## 1. Cancel during encoding (blocker)

Ownership starts before file reading: `askAboutCsv` captures identity, then
awaits the deferred encoder inside the guarded operation. Encoder resolving
after abort/cancel: no telemetry call; the current operation transitions to
`cancelled`, stale ones stay silent. Encoder rejecting after abort: current
stays `cancelled`, never `failed`. `runFileAnalysis` applies the same guards
(no signal exists on that path; source-change staleness covers it).
REST client (`rest-client.ts request`): a pre-aborted caller signal throws the
caller's abort reason before `fetch` starts; the forwarding listener is always
removed in `finally` (mid-flight abort mapping to TimeoutError preserved).

## 2. Real in-flight analysis A/B

Tests hold A's provider request pending, start B, then resolve/reject A:
stale resolve, stale error, and stale `finally` change nothing on B
(result, error, phase, busy). B's own outcome applies normally.

## 3. Same-source preparation ordering

A then B (same source): resolving B first applies review/storage/navigation;
a later A resolve is ignored (no second write, no overwrite). Separately,
a stale A rejection applies no error; B afterward applies normally.

## 4. Unmount lifecycle

New `dispose()` bumps the sequence (no permanent flag → remount-safe). The
panel effect cleanup aborts the in-flight controller and disposes. Late
prepare/reconnect resolves after unmount apply nothing — no detached updates,
storage writes, or navigation. Completed work is untouched by a later dispose;
a remounted panel reconnects normally.

## 5. Panel sample-button wiring

The sample button calls only `runSampleAnalysis`, which atomically binds the
sample, clears file/input (via the `clearFileInput` patch), invalidates
priors, and analyzes. The patch→setter mapping lives in the exported
`applyReviewPatch` interpreter (telemetryReviewState.ts) used by the panel —
not a simulation: sample-action tests assert the coordinator's emitted patch
stream including `clearFileInput`, and applier tests assert the real mapping
(setSelectedFile(null), input-key bump, phase/busy/result fields).

## Tests (deferred promises/barriers; no new framework)

`telemetry-review-coordinator.test.ts` (entrypoints the panel uses):
prepare-select-resolve, busy survival, same-source A/B success+rejection
ordering, sample-during-prepare, file→sample refusal, sample→file binding,
in-flight A/B resolve/error/finally isolation, encode-cancel resolve/reject,
abort-resolve/abort-reject, old-abort/cancel-after-new-op, dispose pending
prepare+reconnect, dispose-after-complete + remount, atomic sample action,
stale reconnect/analysis. `telemetry-review-state.test.ts`: helper contract +
applier mapping. `rest-client-abort.test.ts`: pre-aborted no-fetch + cleanup,
listener detach on settle, mid-flight abort mapping.
New/changed suites: 40/40. Full targeted set: 114/114 across 9 files in one
run (11 classification/service + 5 state + 21 coordinator + 3 REST +
32 Meta/Baseten contract + boundary suites + runner budget + telemetry).
