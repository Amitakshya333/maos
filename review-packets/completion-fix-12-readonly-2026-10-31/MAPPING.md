# Findings → fixes mapping (COMPLETION-FIX-12)

Scope: no new paths (same 9 as FIX-10). The agent-runner classification/reminder
is byte-identical since FIX-06 (frozen). All changes are GUI lifecycle + tests.

## 1. Unique per-selection identity (blocker)

`selectFile`/`selectSample` now return a unique key (`file#<uid>:…` /
`sample#<uid>`) from a per-coordinator monotonic counter. `runFileAnalysis`
and `askAboutCsv` take that key and refuse anything that does not equal the
current binding — two distinct File objects with identical metadata therefore
receive distinct identities, and a stale callback (including a reselect of
the same file, which mints a new identity) can trigger no request, state, or
navigation. Metadata-only and object-identity matching are gone.

## 2. Abort vs timeout (REST client + coordinator truthfulness)

`BrowserRestClient.request` and `downloadArtifactContent` now share one
hardened path: a pre-aborted caller signal throws the caller reason (or an
`AbortError` DOMException) before `fetch` starts; a mid-flight caller abort
rejects with the caller reason; only the client's own deadline maps to
`TimeoutError`; the forwarding listener is always removed and the timer
always cleared on every exit. The coordinator already keys its
cancelled-vs-failed display off the caller's signal (verified by tests),
so an abort stays `cancelled` while a genuine timeout still reads `Timed out`.

## Tests (all new/changed suites run; per-file counts below)

- `telemetry-review-coordinator.test.ts` (22): identical-metadata
  collision + reselect-new-identity, encode-cancel resolve/reject,
  abort-during-upload resolve/reject, provider-timeout truthfulness,
  old-abort-after-new-op (resolve + reject), dispose + remount, sample
  atomicity, plus the retained FIX-06/08 lifetime suite.
- `telemetry-review-state.test.ts` (5), `rest-client-abort.test.ts` (4:
  pre-aborted caller (no fetch, AbortError), listener attach/detach,
  mid-flight caller abort (AbortError, not TimeoutError), actual deadline
  (TimeoutError)),
  `read-only-completion.test.ts` (11, unchanged behavior).
- Focused new-suite total: 43 passed. Full targeted run: 116 passed
  across 9 files in one invocation with explicit exit 0
  (42 new/changed + 74 retained contract/boundary/budget/telemetry;
  each test counted once, no overlap or double counting).
