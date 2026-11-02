# Staging notes (EVENT-REPO-PREP-02, 2026-10-31)

## What this directory is

A new local draft of the missing delivery documents, layered on a byte-identical
copy of the assessment scaffold
(`maos-ind-event-prep-2026-10-29`, preserved untouched — only read/copied).
Reference: committed `2cfdf9b81f56eada7df2041625da18e44531151e` via the
sanitized snapshot (`f850a70c…`, verified) and `C:\maos` history. No full
application source was copied here; no FIX-06/FIX-08 content was exported as
approved event work.

## Files carried forward unchanged (hashes re-verified in staging)

- `patches/0001-industrial-agent-workflow.patch` — SHA-256 `40777ee7…03dd6` ✓
- `patches/0002-meta-provider-and-bounded-agent.patch` — SHA-256 `eb68e07b…4d0ec` ✓
- `scripts/apply-event-patches.ps1`, `fixtures/*`, `LICENSE`

## Files replaced or added in staging

| File | Change |
|---|---|
| `README.md` | Replaced scaffold outline with the full judge path (prereqs → fetch → patches → install → engine → key → demo → expected outputs), every command marked `[UNEXECUTED]`/`[BLOCKED]`. |
| `UPSTREAM.md` | Added 2026-10-31 public-access results (Core HEAD, absent SHAs, empty event repo, stale third URL). |
| `PATCH_MANIFEST.md` | Kept patch rows; added staging re-verification note + tip status (no 0003 patch; post-tip excluded). |
| `CONTRIBUTION_MAP.md` | Extended through `2cfdf9b`: 9-commit table, new-file structural evidence, substantiation beyond timestamps, exclusion register. |
| `LICENSES_AND_NOTICES.md` | Replaced draft with materialized inventory + explicit unresolved list. No completeness claim. |
| `THIRD_PARTY_NOTICES/` | New: 11 vendored Rust license texts (byte-faithful `git show` export from `2cfdf9b`), JS lock inventories (249 root + 15 desktop rows), Rust crate inventory (32), vendor index. |
| `PUBLIC_ACCESS_CHECK.md` | New: read-only obtainability evidence table. |
| `PUBLICATION_DECISION.md` | New: precise publication decision + owner decision list. |
| `VERIFICATION_PLAN.md` | Replaced with the minimum clean-room command sequence (all unexecuted). |
| `STAGING_NOTES.md` | This file. |

## What was NOT done (constraints)

No installs, builds, tests, hosted inference, commits, pushes, or publication.
No clean-room run — nothing here is tested. OpenCode's candidate and Delta's
snapshot were not modified. The full sanitized snapshot was used as a read
reference only, never as submission content.

## EVENT-NOTICES-03 entry (2026-10-31)

- Rust vendor notices completed from local git objects: 50 further texts
  exported (61/61 files, 31 crates), two blob-hash spot-checks match.
- JS root: 183 texts for 182 version-matched packages byte-copied from the
  pre-existing local install (hash spot-check passes); 70 entries remain
  without verifiable local text (`js-root-unresolved.md`).
- JS desktop: all 15 entries unresolved, no local install exists
  (`js-desktop-unresolved.md`). No fetches performed.
- Discrepancies D1 (toolchain pin) and D2 (Python minimums) resolved from
  authoritative tree/code sources in new `DISCREPANCIES.md`; README §1 and
  `VERIFICATION_PLAN.md` pointers updated. Committed Core docs untouched.

## EVENT-OVERLAY-04 entry (2026-10-31, local-only)

- Added `patches/0003-install-workflows-pilot-baseten.patch` (exact
  `git diff 189e786..2cfdf9b`; 34 files +3266/−419; SHA-256
  `99fbf264…e4abe4`; path set equals history with zero differences).
  0001/0002 bytes preserved.
- Verified the 3-patch chain in isolated worktree
  `C:\maos\.worktrees\overlay-verify-04`: all `--check`/`apply` exit 0;
  intermediate and final `write-tree` SHAs equal the committed trees
  (`c0f45cc2…`, `e3f1ec51…`, `53305f48…`); final `diff 2cfdf9b` empty.
- Rewrote README (gates incl. cleared B1 via TAG-05, tag fetch, 0003
  commands), UPSTREAM (tag verification), PATCH_MANIFEST (0003 row + chain
  record), CONTRIBUTION_MAP (overlay-3 boundary, FIX-06/08/10/12 exclusion);
  tightened DISCREPANCIES D1 (three Rust 1.95 facts); minimal
  VERIFICATION_PLAN step-2 consistency edit. Apply script left at 0001–0002
  (gate B4, workaround documented). No installs/builds/fetches/commits/
  pushes/tags; scaffold and staging history otherwise preserved.

## APPLY-SCRIPT-05 entry (2026-10-31, local-only)

- Rewrote `scripts/apply-event-patches.ps1` for 0001–0003: manifest hash pins,
  base/dirty gates, exact tree-comparison state detection (fully-applied /
  partial-prefix / foreign), per-overlay `--check` + apply + tree verify via
  throwaway index, no commit/reset. Two defects found and fixed during
  verification (stderr-capture termination; chained-patch state probing).
- Case record, all in disposable worktrees under `C:\maos\.worktrees\`:
  positive run exit 0 with independent `write-tree` match to `2cfdf9b` tree
  `53305f48…` (worktree `apply-pos-05` preserved); idempotent rerun exit 0;
  wrong-base, dirty, partial (`0001 applied; 0002 and 0003 pending`), and
  hash-mismatch negatives all fail closed with targets untouched.
- Removed README §3 manual-workaround wording; cleared gate B4; updated
  PATCH_MANIFEST script note and VERIFICATION_PLAN step 2. No installs,
  builds, hosted requests, commits, or publication.

## APPLY-SCRIPT-06 entry (2026-10-31, local-only, Delta findings)

- Hardened `scripts/apply-event-patches.ps1`: (1) ambient `GIT_INDEX_FILE`
  fails closed at startup and re-checked at each verification, with the
  real index path explicitly resolved via `--git-path index` and compared;
  (2) staged-only index differences (`diff --cached --quiet HEAD`) fail
  closed and are never classified as idempotent application.
- Evidence matrix: 8 child-process transcripts in
  `evidence/apply-script-06/` (commands, raw stdout/stderr, process exit
  codes, before/after HEAD/status/index-state): positive exit 0 +
  independent `write-tree` match to tip tree `53305f48…`; idempotent exit 0;
  wrong-base/dirty/partial-prefix/staged-index/hash-mismatch/env-guard all
  exit 1 with precise messages and targets untouched. All OBSERVED: PASS.
- B4 docs updated only after green. No installs, fetches, builds, hosted
  calls, commits, pushes, publication, or `.maos` inspection. Whether
  `evidence/` ships to the event repo is an owner D5 decision.

## EVENT-DOCS-05 entry (2026-10-31, local-only)

- Reconciled B2 (local-only steps 1–6+9, no key) vs B3 (hosted step 7, D4
  clearance + judge key) vs D6 (step 8 notices) in VERIFICATION_PLAN;
  replaced `<D1-URL>`/`<D1-ref>` with the documented URL/tag; made the
  working directory explicit per step; marked the mock-transport invocation
  UNRESOLVED pending Delta's source trace (no guessing; step 6 blocked).
- Updated PUBLICATION_DECISION (D1 DONE via TAG-05 with tag evidence;
  Route A taken; three-patch approval scope; D2/D3/D4/D6 open) while
  keeping D5 explicitly PENDING; added a supersede note to
  PUBLIC_ACCESS_CHECK (pre-tag trail; current status in UPSTREAM).
- Extended the apply-script env guard to `GIT_DIR`/`GIT_WORK_TREE`
  (fail-closed at startup + every verification) and re-ran the full
  evidence matrix: 10 transcripts, all PASS, independent tree match.
  Script SHA-256 `8CB2F803…93044`. No installs, fetches, builds, hosted
  calls, commits, pushes, publication, or `.maos` inspection.

## Reconciliation entry (2026-10-31, local-only)

- Compatibility screen: Rust section reconciled to an explicit 31-crate-ID
  table (24 MIT/Apache-2.0 incl. chrono/typenum pointers, 3 MIT/UNLICENSE,
  2 MIT, 1 Apache-2.0/Boost, 1 Apache-2.0/MIT/Unicode-V3) — corrects the
  earlier "22" group miscount. JS unresolved reconciled: 70 root (60
  not-installed + 10 no-license-file) + 15 desktop, zero cross-graph name
  overlaps, 85 unique name@version; counts are per graph+version.
- Verification wording: step 6 rewritten from "mock-first" to the
  source-confirmed local deterministic path (runbook: local code +
  bundled fixtures, no hosted call); the loopback mock transport check
  stays a separate, distinct item (contract tests under step 4, e.g. the
  staged analysis-agent-auth-http mock provider). Exit criteria updated.
- Notice closure and legal clearance left explicitly unresolved. No
  network, installs, builds, hosted calls, or publication.

## APPLY-SCRIPT-07 entry (2026-10-31, local-only, RUNLOG bug)

- Fixed the demonstrated index-path comparison bug: `--git-path index`
  returns relative `.git/index` in normal clones; the script now requests
  `--path-format=absolute` (fallback: plain output) and normalizes any
  still-relative result against the target checkout before comparing.
  All env/staged/hash/tree guards preserved. Script SHA-256
  `2B8674AA…256A7`.
- Observed the authentic pre-fix failure first (exit 1, 93 status lines —
  identical RUNLOG signature; transcript `00-prefailure.txt`), then fixed.
- Added durable `scripts/test-apply-script.ps1` (6 checks incl. normal-clone
  positive+tree, staged/env/wrongbase refusals, worktree regression;
  refuses retained paths); self-test green (attempt-1 harness stderr bug
  preserved transparently, fixed in test).
- Evidence `evidence/apply-script-07/` (prior set preserved): 13 matrix
  transcripts (10 normal-clone + 3 linked-worktree) + self-test runs, all
  PASS, independent tree match. `C:\clean\core` never touched, reused, or
  reset. No installs, builds, hosted calls, commits, or publication.

## B2-CANARY-CLARIFICATION entry (2026-10-31, local-only)

- Per ENGINE-RESOLUTION-01, verified read-only: `rust/test.txt` absent
  from the pinned base tree AND the tip tree, ignored via
  `.gitignore:59` (out-of-band fixture); `.gitattributes` carries only a
  checkout rule for it. Nothing fabricated or copied.
- Flagged the canary steps in CLEANROOM-B2-PLAN (step 7),
  VERIFICATION_PLAN (step 4), and README §5 as an UNRESOLVED test-asset
  prerequisite: owner must supply the fixture out-of-band or waive;
  absence is recorded (`CANARY-FIXTURE-ABSENT`), never a runtime failure
  or product-failure evidence. Original plan text and all failure
  evidence preserved; canary decision kept separate from the apply-script
  correction.
- Apply-script normal-clone correction stands: script hash re-verified
  `2B8674AA…256A7`; -07 evidence intact; `C:\clean\core` untouched. The
  tree-verification proof is unaffected (absent file is consistently
  absent on both sides). No application changes or publication.

## TASK N entry (2026-11-01, docs-only Ring narrative)

- Wrote RING_NARRATIVE.md (pitch, problem, Ring/Cockpit split, Muse Spark
  Open fit, 7-step demo arc, not-claimed list, 30-second opening) and
  RING_USER_TEST_SCRIPT.md (Electron steps, exact question, pass/fail
  boxes, refusal + verifier steps, evidence-only fallback, defect
  template). Baseten endpoint/model/key pins grounded in code + contract
  test; SOP doc, RMS/verdict/DOCX/audit, gates, tamper negatives all
  cited. PM-directed/UNVERIFIED: Ring/Cockpit naming, question text,
  on-screen renderings, GUI refusal text, evidence-only announcement
  wording, hand-tamper procedure (derived, B2-unexecuted). No builds,
  tests, installs, commits, or pushes.

## TASK M entry (2026-11-01, document-only)

- Wrote SMOKE_QA_2026-11-03.md (timed 5-min script: speaker track, actions,
  expected results, Electron→CLI fallback, 5 honest wordings, go/no-go)
  from DEMO_SCRIPT, USER_TESTING, B2 packet, and Electron rehearsal
  evidence; and SUBMISSION_INVENTORY_DRAFT.md (repos, pins, hashes,
  evidence map incl. Tasks A–E/G/R, artifacts, limitations,
  must-not-claim list). Task D located (46 canary ENOENT failures now
  grounded); grey dot + RESULT: CRITICAL grounded to rehearsal (fix-
  augmented snapshot scope noted). No hosted calls; live remote state
  marked unverified. No builds, tests, installs, commits, or pushes.

## JS-closure run entry (2026-10-31, read-only + report)

- Inspected existing `node_modules` in `C:\clean\core-b2-02` only (no
  install/fetch) against the 85 unresolved entries; wrote
  `THIRD_PARTY_NOTICES/JS-CLOSURE-RUN-2026-10-31.md`. Result: root 0
  newly LICENSED / 10 PRESENT-NO-LICENSE / 60 MISSING; desktop 0/0/15
  (`desktop/node_modules` absent). Gap confirmed exact and unchanged; no
  legal clearance claimed. Only this entry and the new report file were
  written.

## LOCAL-VALIDATION-PLAN entry (2026-10-31, plan only, unexecuted)

- Wrote `CLEANROOM-B2-PLAN.md`: minimum T-07 deterministic run (fetch →
  patches → install → build → engine → judged run → verify → provenance),
  with prerequisites, pinned network downloads, lifecycle-script inventory,
  ordered commands, expected artifacts, and authorization bounds ($0 spend,
  synthetic data only, stop conditions). Hosted inference (B3), agent
  contract mock suites, full vitest, cockpit, notice export, and
  publication explicitly out of scope. Nothing executed, installed, or
  published; B2 stays unverified.

## B2-plan desktop review (2026-10-31, static only)

- Verified the desktop/Electron install is NOT required for the headless
  T-07 command: one-way shell→app dependency, zero `src/` imports of
  `desktop/`/`electron`/`dist/gui`, CLI entrypoint runs in-process,
  `build:backend` excludes desktop. Removed `npm ci --prefix desktop`,
  the Electron binary download + host, and the 22.12 Node floor (now
  engines >=20) from CLEANROOM-B2-PLAN.md. No execution, install, fetch,
  or publication. Note: VERIFICATION_PLAN step 3 still lists the desktop
  install for the full (non-minimum) path — left for owner direction.

## License-screen entry (2026-10-31, local-only)

- Wrote preliminary `THIRD_PARTY_NOTICES/COMPATIBILITY-SCREEN.md` from
  staged texts/inventories only. Rust: 31/31 permissive (preliminary
  pass, vendored scope). JS: bulk permissive; MPL-2.0 ×11 lightningcss
  flagged (1 text staged, 10 missing) plus 60+15 other gaps — unresolved.
  No completeness or clearance claimed; no formal review performed.
