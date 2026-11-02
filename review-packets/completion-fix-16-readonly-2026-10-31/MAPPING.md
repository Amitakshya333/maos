# Findings → fixes mapping (COMPLETION-FIX-16)

Scope: same 9-path allowlist; 7 files changed vs FIX-14. Agent-runner and
the read-only suite are byte-identical to FIX-14. Work happened in the
isolated worktree `maos-fix16-candidate`, seeded from the FIX-14 complete
patch (blob-verified identical before edits); the FIX-14 candidate and
packet were not modified.

## 1. Coordinator race: validate before allocating the operation ID

`askAboutCsv` incremented `askOpId` before rejecting a stale key/source,
which burned the current operation's identity and silently invalidated a
valid in-flight ask. Validation (key current + active source is a file) now
runs first; only then is the operation ID allocated and captured.
Regression: deferred test — valid B ask pending on its upload, stale A ask
rejected, B still completes normally. Mutation-verified: restoring the
buggy order makes this test fail.

## 2. Panel callback wiring

The panel's {file, key} pair now lives in the tested `SelectionBinding`
(telemetryReviewState.ts): callbacks close over the exact pair object
returned by `bind()`, and staleness is object-identity, not metadata. A
retained stale callback therefore cannot pair its file with B's key.
Tests cover identical-metadata pairs, reselect-mints-new-pair, and clear.

## 3. REST abort reasons: accurate documentation + intended behavior

Documentation now states the actual contract: an Error abort reason
propagates verbatim; a non-Error reason (string, undefined, …) is
normalized to an AbortError DOMException. Caller cancellation is never a
TimeoutError; only the client's own deadline is. Tests pin the intended
behavior for custom string reasons on both `request()` and
`downloadArtifactContent()` (pre-aborted and mid-flight): rejection is an
AbortError, the string is not surfaced verbatim, fetch is not started for
pre-aborted signals, and listeners/timers are cleaned up on every exit.
The existing no-signal timeout contract remains intact
(ui1-02-api-clients: 33/33).

## Tests (all new/changed suites run; per-file counts below)

- `telemetry-review-coordinator.test.ts` (25): deferred stale-ask race,
  stale-panel-callback refusal, ask-requires-file-source, identical-metadata
  collision, encode/abort races, dispose/remount, sample atomicity, retained
  lifetime coverage.
- `telemetry-review-state.test.ts` (8): helper contract, applier mapping,
  SelectionBinding identity semantics.
- `rest-client-abort.test.ts` (12): both methods — pre-aborted no-fetch
  (Error + string reasons), listener attach/detach, mid-flight caller abort
  (Error + string + undefined), deadline TimeoutError, download success
  with cleanup.
- `read-only-completion.test.ts` (11, unchanged behavior).
- Focused new-suite total: 56 passed. Full targeted run: 130 passed across
  9 files in one invocation, exit 0 (56 new + 74 retained contract/boundary/
  budget/telemetry; each test counted once, no overlap or double counting).
  Existing client contract suite: ui1-02-api-clients 33 passed (timeout
  contract intact). ui1-19 in the fresh worktree: 23/26 (engine/canary
  fixtures are untracked build artifacts absent from a fresh checkout —
  environmental, kept separate); industrial-repl 1/2 (5 s timing-sensitive
  wait in this environment, kept separate).
