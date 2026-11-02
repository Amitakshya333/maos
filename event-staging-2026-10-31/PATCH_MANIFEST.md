# Patch manifest

Status: staging draft (2026-10-31), not approved for submission, not
clean-room installed. Chain reconstruction verified locally (see below);
no install, build, or demo run has been executed.

| Order | Patch | Base → result | Paths | SHA-256 |
|---|---|---|---:|---|
| 1 | `0001-industrial-agent-workflow.patch` | `f9525055…98a3` → `239a0042…f1f` | 100 | `40777ee7ea4edbf534377bbe3012ead6b2588b6b070681f1686003c699c03dd6` |
| 2 | `0002-meta-provider-and-bounded-agent.patch` | `239a0042…f1f` → `189e786…215` | 27 | `eb68e07bce21e9ac9d5245274bc5fcea787c0a2ae6ec7810e756f933b764d0ec` |
| 3 | `0003-install-workflows-pilot-baseten.patch` | `189e786…215` → `2cfdf9b…151e` | 34 | `99fbf264719871d0b25f4075fdfaba8d881963b0ac5af0749095d06613e4abe4` |

- `0003` = exact `git diff 189e786..2cfdf9b` (4833 lines; 34 files
  +3266/−419; path set equals history with zero differences). Label covers
  its five committed commits: install hardening (`27dd171`), bootstrap
  stderr (`d526bfe`), bounded workflows (`bb871cb`), pilot-cancellation fix
  (`f201cfe`), Baseten budget (`2cfdf9b`). Pending corrections FIX-06, FIX-08,
  FIX-10, FIX-12 are **not** in this chain — they stay excluded until
  independently reviewed and integrated (see `CONTRIBUTION_MAP.md`).
- `scripts/apply-event-patches.ps1` covers 0001–0003 (rewritten 2026-10-31,
  APPLY-SCRIPT-05; scaffold original preserved at the assessment path):
  hash-pinned patch files, base/clean/partial/result gates, per-overlay
  tree verification via throwaway index, no commit, no reset. Verified:
  positive run tree-exact, wrong-base/dirty/partial/hash negatives all fail
  closed with targets untouched, idempotent rerun succeeds. See
  STAGING_NOTES for the case record. APPLY-SCRIPT-06 hardening: ambient
  `GIT_INDEX_FILE` fails closed at startup and at every verification, the
  real index path is explicitly resolved and compared, and staged-only
  index differences fail closed instead of reading as idempotent.
  EVENT-DOCS-05 extends the env guard to `GIT_DIR`/`GIT_WORK_TREE` with the
  same fail-closed evidence pattern. Raw evidence:
  `evidence/apply-script-06/` (10 transcripts, all PASS). APPLY-SCRIPT-07
  fixes relative `--git-path index` handling (`--path-format=absolute` +
  normalization against the checkout) and adds durable
  `scripts/test-apply-script.ps1`; fresh evidence in
  `evidence/apply-script-07/` (13 transcripts + self-test, all PASS).

## Chain verification record (local, 2026-10-31)

Isolated worktree at base `f9525055`, patches applied in order with
`git apply --check` then `git apply` (all exit 0, no whitespace flags):

| After | `git write-tree` | Expected `<rev>^{tree}` | Match |
|---|---|---|---|
| 0001 | `c0f45cc2bded63233079f5d1973ced9025f76f9b` | `239a0042^{tree}` | exact |
| 0001–0002 | `e3f1ec51b4a264c0ce67d21dab0842c7b30a7940` | `189e786^{tree}` | exact |
| 0001–0003 | `53305f48e6a7fb039bcf72fa38ab102bcccb9cb8` | `2cfdf9b^{tree}` | exact |

Final `git diff 2cfdf9b --shortstat` empty: every reconstructed blob equals
the committed tip. Tree-SHA equality is blob-level proof. Verify worktree
preserved at `C:\maos\.worktrees\overlay-verify-04`.
