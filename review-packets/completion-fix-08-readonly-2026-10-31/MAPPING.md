# Findings → fixes mapping (COMPLETION-FIX-08)

Scope note: the agent-runner classification/reminder is byte-identical to the
accepted FIX-06 implementation (frozen; Finding 4's narrowed wording
"requires no repository/project deliverable changes" is already present there,
verified by packet grep). All FIX-08 changes are GUI lifecycle only.

## Invariant (enforced in TelemetryReviewCoordinator)

Every async operation captures {source key, sequence, per-operation id} and
checks all three before EVERY state or external side effect. Only the current
operation may update results, errors, phase, busy flags, storage, or
navigation. Stale operations do nothing. Cancellation supplements guards.

## 1. Sample selection atomicity

`runSampleAnalysis` binds the sample, clears the previous file/input
(`clearFileInput`), invalidates priors, and analyzes in one entrypoint. The
panel's sample button only calls it — no separate `selectSample` call to
forget. Covered by the sample-action-while-preparation-pending test.

## 2. Preparation overlap

`prepareReview` checks lifetime AND request id before reviewRun, errors,
storage writes, navigation, and busy cleanup. Same-source A/B covered:
stale success ignored, stale rejection ignored, only the latest applies,
storage/navigation fire once.

## 3. Analysis cleanup

`runFileAnalysis` runs carry a per-operation id checked in result, error, and
`finally` paths alongside the lifetime. Stale result, stale error, and stale
`finally` cannot clear or set B's busy/error state.

## 4. File encoding and cancellation

Ownership starts before encoding: the panel passes a deferred reader and the
coordinator encodes inside the guarded operation; encoder failures and
timeouts apply error/busy patches only when current, so no unguarded panel
error update exists. An aborted-but-resolved upload transitions the CURRENT
operation out of uploading/requesting to `cancelled`; a stale abort is a
no-op and can never cancel or reset a newer operation.

## Tests (no new framework; panel entrypoints only)

`tests/gui/telemetry-review-coordinator.test.ts` (12 tests) drives the exact
delegated entrypoints with deferred promises/barriers: sample-vs-pending-prepare,
same-source A/B stale success + stale rejection, analysis A/B stale result/
error/finally, encode-failure-after-source-change, abort-then-resolve,
old-abort-after-new-start, stale reconnect/analysis, file→sample refusal,
sample→file binding. `tests/gui/telemetry-review-state.test.ts` unchanged.
New client suites: 27/27; full targeted set: 101/101 across 8 files in one run.
