# Findings → fixes mapping (COMPLETION-FIX-14)

Scope: no new paths (same 9 as FIX-12). Only 5 files changed; agent-runner,
read-only suite, and the state helper/tests are byte-identical to FIX-12.

## 1. Panel callbacks bound to the exact {file, key} pair

`selectFile`/`selectSample` return the per-selection identity; the panel now
stores the exact pair in `selectionRef` at selection time, and every async
callback (analyze-selected-CSV, ask-about-CSV) closes over that pair. A stale
pair is rejected by the coordinator before any upload/request, result, error,
review, storage, or navigation is attributed to the newly selected source.
The coordinator also requires `sourceKind === 'file'` for ask/analysis, so a
sample identity can never be used for a file operation. Reselecting the same
file mints a new identity, invalidating older pairs.

## 2. downloadArtifactContent brought in line with request()

Both methods now share `createAbortScope`/`callerAbortError`: a pre-aborted
caller signal throws the caller reason (or AbortError) before `fetch` starts;
a mid-flight caller abort rejects with the caller reason — Error, string, or
undefined — while only the client's own deadline maps to `TimeoutError`; the
forwarding listener is always removed and the timer always cleared on every
exit (success, HTTP/network error, caller abort, timeout). The existing
no-signal client-timeout contract remains intact (ui1-02-api-clients: 33/33,
including the explicit TimeoutError cases).

## Tests (all new/changed suites run; per-file counts below)

- `telemetry-review-coordinator.test.ts` (24): stale-panel-callback refusal
  for analysis (pair stays valid afterward), ask-requires-file-source,
  identical-metadata collision + reselect-mints-new-identity, encode-cancel
  resolve/reject, abort resolve/reject, timeout truthfulness,
  old-abort-after-new-op, dispose/remount, sample atomicity, retained
  FIX-06/08/10/12 lifetime coverage.
- `rest-client-abort.test.ts` (9): pre-aborted no-fetch (both methods),
  listener attach/detach, mid-flight caller abort with Error reason, string
  reason (download), undefined reason (download), deadline TimeoutError
  (both methods), download success with cleanup.
- `telemetry-review-state.test.ts` (5), `read-only-completion.test.ts` (11,
  unchanged behavior).
- Focused new-suite total: 49 passed. Full targeted run: 123 passed across
  9 files in one invocation, exit 0 (49 new + 74 retained contract/boundary/
  budget/telemetry; each test counted once, no overlap or double counting).
  Existing client contract suite: ui1-02-api-clients 33 passed (timeout
  contract intact). ui1-19 in this worktree: 25/26 (canary rust/test.txt is
  an untracked file present only in the main checkout — environmental, kept
  separate); industrial-repl 2/2 passed.
