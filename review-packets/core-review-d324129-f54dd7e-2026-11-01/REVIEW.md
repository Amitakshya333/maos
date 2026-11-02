# Independent review: d324129 + f54dd7e (TASK R, review only — no code changes)

- Date: 2026-11-01. Reviewer work area: `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-core-review-r`
  (local clone of `C:\maos`; tags fetched from the local origin; no pushes, no edits to any checkout).
- Commits reviewed (linear, same author, both 2026-11-01):
  - `d324129d6fffa84593d8cb2320acd323dbce608d` "Reconcile GUI selection binding and REST cancellation" (parent `2cfdf9b`)
  - `f54dd7e6db33b0683ff2f2583516bca5dc3f6ce3` "Remove unused simple-git dependency" (parent `d324129`)
- Reference packets used: `review-packets/completion-fix-16-readonly-2026-10-31/` (source-hashes.json),
  `review-packets/engine-indicator-candidate-2026-10-31/` (candidate.patch, Task G),
  `review-packets/simple-git-removal-candidate-2026-11-01/` (candidate.patch + run-log).
  NOTE: the task brief cited the engine-indicator packet as the reference for the
  coordinator/selection-binding files; that packet contains no such hashes (it has no
  source manifest at all — only the 3-file engine patch + logs). Verification below
  uses the FIX-16 packet for the 9 completion paths and the engine-indicator candidate
  for its 3 paths. Recorded as minor process finding F2.

## Verdict: no blockers, no majors. 4 minor findings (F1–F4). Details below.

## Checklist

### (a) No path outside the intended set changed — PASS (with minor note F1b)
- `d324129 --stat`: exactly 12 files = FIX-16's 9 completion paths
  (`src/core/agent-runner.ts`, `src/gui/src/api/rest-client.ts`,
  `src/gui/src/components/TelemetryReviewPanel.tsx`,
  `telemetryReviewCoordinator.ts` + `telemetryReviewState.ts` (new),
  `tests/gui/{rest-client-abort,telemetry-review-coordinator,telemetry-review-state}.test.ts`,
  `tests/industrial/read-only-completion.test.ts`)
  plus the engine-indicator 3 (`Header.tsx`, `layout.css`, `ui1-25…test.ts`).
- `f54dd7e --stat`: exactly `package.json` + `package-lock.json`.
- Note: d324129 bundles two workstreams but its message names only one (F1b).

### (b) Committed content matches the reviewed candidates — PASS modulo prettier (minor F1a)
Per-file blob comparison of the d324129 tree against the packet references:
- Byte-identical (3): `TelemetryReviewPanel.tsx` (= FIX-16 `35302e85…`),
  `Header.tsx` + `layout.css` (= engine-indicator Task G `642e378…`/`b2e1f47…`).
- Equivalent modulo whole-file prettier reformat (9): for each of the other 8
  FIX-16 files and `ui1-25…test.ts`, `prettier(<reviewed bytes>)` with the repo
  config reproduces the committed bytes exactly, and the committed bytes are
  prettier-clean. Includes pre-existing-code regions (e.g. agent-runner
  `retryOnTransient` call sites), which is why d324129's line counts exceed the
  packets' (e.g. agent-runner 90 vs 30, rest-client 342 vs 67). No semantic
  delta in any of the 9 (spot-verified hunks are all reflows; the one paren
  insertion, `?? 3` → `(?? 3)`, is semantics-preserving).
- Consequence: hash continuity with the reviewed packets is broken (8/9 FIX-16
  blobs differ), so future audits must repeat this normalization step. Minor (F1a).

### (c) Strengthened ui1-25 present; mutation behavior as reported — PASS
- Present in d324129 with the Task G content (modulo the prettier regex wrap):
  `engineBadge` extractor (`tests/gui/ui1-25-truthful-readiness.test.ts:15-21`),
  element-scoped assertions (`:43-46`), positive control (`:51-68`).
- Repeated in my own worktree at d324129 (junction to clean-room deps, removed after):
  committed suite 3/3 exit 0 (`validation/ui1-25-committed.log`); with the
  `Header.tsx:15` muted line removed → exit 1 with
  `expected '<span class="status-dot amber"></span…>' to contain 'status-dot muted'`,
  1 failed / 2 passed (`validation/ui1-25-mutation.log`). Matches the reported
  behavior exactly. Worktree restored byte-identical (hash-verified) afterward.

### (d) Lockfile change — PASS with minor findings F3, F4
- f54dd7e is byte-identical to the reviewed simple-git candidate: applying
  `simple-git-removal-candidate-2026-11-01/candidate.patch` to clean 2cfdf9b
  yields the same `package.json`/`package-lock.json` blobs (`76dfc045…`/`7f0de626…`).
- `package.json` diff: removes only the `simple-git` line. No other change.
- Lockfile JSON diff (old vs new `packages` map): 17 entries removed, 0 added,
  0 version changes in retained entries, meta (`name`/`version`/`lockfileVersion`) unchanged.
  Beyond simple-git + argv-parser, also removed: `@kwsites/file-exists`,
  `@kwsites/promise-deferred`, `@simple-git/args-pathspec` (all simple-git
  subtree — expected), plus `detect-libc` and 11 `lightningcss-<platform>`
  entries. Verified programmatically that **zero** remaining entries reference
  any removed package (including as optional/peer deps), and that the main
  `lightningcss` entry was already absent pre-change (pre-existing staleness).
  So the 12 extra removals are orphan prunings — behavior-neutral — but they
  contradict the "removes only simple-git and @simple-git/argv-parser"
  characterization, and the candidate run-log never mentions them (F3).
- Retained-entry field changes are exactly: root `dependencies` minus simple-git,
  root `bin` gains `maos-industrial` (matches pre-existing `package.json` bin at
  2cfdf9b — benign stale-lock sync), `debug`/`ms` flipped to `"dev": true`
  (verified correct: zero non-dev dependents remain).
- `npm-cache-manifest.json` untouched → `validateNpmStore`
  (`src/industrial/offline-stores.ts:198-199`) still reports invalid (lockfile
  hash/count mismatch). Pre-existing test-pinned state (`tests/f2-04-offline-stores.test.ts:69-78`
  expects invalid), so no test breakage; the candidate run-log already flags
  manifest regeneration as open (F4, minor).

### (e) No new host/credential/env surface — PASS
Token scan (`http(s)://`, `baseURL`, `fetch(`, `apiKey`/`API_KEY`, `Authorization`,
`process.env`, `password`, `secret`, `credential`) over net-new added lines of both
diffs: hits are only (i) a prettier-moved pre-existing `this.fetch(...)` line in
`rest-client.ts` (file proven == prettier(FIX-16), so nothing new), (ii) test-local
loopback URLs (`127.0.0.1`), synthetic key fixtures (`*-not-real`), and env
save/restore patterns from the reviewed FIX-16 suite, (iii) lockfile added lines
(4: dep re-list, bin sync, 2 dev flags — no hosts/credentials).

### (f) Nothing under .maos/demo/docs/review-packets committed — PASS
Both `--stat` path sets contain only `src/**`, `tests/**`, `package.json`,
`package-lock.json`.

## Findings

- **[Minor F1a] d324129 breaks hash continuity with reviewed packets via whole-file prettier reformat.**
  8/9 completion files differ byte-wise from FIX-16 solely by formatting (proven:
  `prettier(FIX-16 bytes) == committed bytes`, committed prettier-clean), including
  untouched baseline regions. Content verified equivalent — no unreviewed logic —
  but future audits cannot rely on packet blob IDs. Evidence: blob table above + prettier round-trip script output (this review's working notes).
- **[Minor F1b] d324129 message omits the bundled engine-indicator change.**
  "Reconcile GUI selection binding and REST cancellation" does not mention
  `Header.tsx`, `layout.css`, or `ui1-25…test.ts` (3/12 files). Traceability only.
- **[Minor F2] Review reference mis-specification (process).** The brief cited the
  engine-indicator packet for coordinator/selection-binding hashes; that packet has
  no manifest and no such files. Verified against the FIX-16 packet instead (see (b)).
- **[Minor F3] f54dd7e removal scope exceeds its characterization.** 17 entries
  removed, not "only simple-git and @simple-git/argv-parser"; the 12 extra
  (detect-libc + 11 lightningcss platform orphans) are never mentioned in the
  candidate run-log. Verified benign: zero remaining dependents, zero version
  churn, commit faithful to its candidate. Characterization + candidate-analysis
  gap only.
- **[Minor F4] `npm-cache-manifest.json` left stale by f54dd7e.** `validateNpmStore`
  keeps reporting invalid (lockfile hash/count mismatch). Pre-existing,
  test-pinned (`f2-04…:69-78`), no breakage; regeneration already an open item
  in the candidate run-log.

## Not verified
- Test/build/typecheck execution on the committed tree (review-only scope; no
  suite runs except the ui1-25 committed + mutation runs above). The simple-git
  candidate's retained `npm ci` / build / typecheck exits 0 were read, not re-run.
- Runtime behavior of the committed code beyond the ui1-25 mutation check.
- The 12 orphan-removal entries' absence from any out-of-tree consumer (e.g.
  external tooling reading the lockfile); in-tree impact verified nil.
