# Upstream sync — 2026-11-01 (post-publication state)

This file records the public-repo state after the event submission was
published, so the event repo does not contradict the public Core repo.

## Core repo (https://github.com/Amitakshya333/maos.git)
- refs/heads/main: advanced to `f54dd7e6db33b0683ff2f2583516bca5dc3f6ce3` on 2026-11-01.
  - `d324129` Reconcile GUI selection binding and REST cancellation (FIX-16 + muted engine-status tone)
  - `f54dd7e` Remove unused simple-git dependency
- refs/tags/event-core-2cfdf9b: `ee569a1b67507c37cf6e968895405a6bd36d0181` (unchanged). Peels to `2cfdf9b`.
- The 9-commit pinned range ending at `2cfdf9b` is unchanged and anonymously fetchable.

## Event submission (unchanged)
The submission still pins the Core base `f9525055c56a7f7771dd2fa029c147c2960a98a3` and applies
0001 → 0002 → 0003 to reconstruct tree `53305f48e6a7fb039bcf72fa38ab102bcccb9cb8` (the tree of
`2cfdf9b`). Reviewers follow README.md §2–§3 and UPSTREAM.md. The advance of public
`main` does not change the judged build.

## Review record (Task R, 2026-11-01) — 4 minor findings

Full review: `review-packets/core-review-d324129-f54dd7e-2026-11-01/REVIEW.md`. Verdict: no blockers, no majors.
- **F1a (attribution):** `d324129` reformats its 12 files with the repo prettier config. 8 of 9 FIX-16 files differ byte-wise from the reviewed packet solely by formatting (proven: `prettier(FIX-16 bytes) == committed bytes`, committed prettier-clean). Content is equivalent; no unreviewed logic. Future audits should normalize with prettier before comparing.
- **F1b (traceability):** the `d324129` message names only the selection-binding work but also bundles the engine-indicator change (`Header.tsx`, `layout.css`, `ui1-25` test; 3 of 12 files). That bundle is the reviewed engine-indicator candidate.
- **F3 (scope):** `f54dd7e` removes 17 lockfile entries, not only `simple-git` and `@simple-git/argv-parser`. The 12 extra are orphan pruning (`detect-libc` plus 11 `lightningcss-<platform>` entries with zero dependents). Verified behavior-neutral; no version changes in retained entries.
- **F4 (open):** `npm-cache-manifest.json` was not regenerated, so `validateNpmStore` keeps reporting the store as invalid. This is pre-existing and test-pinned (`tests/f2-04-offline-stores.test.ts` expects invalid). Regeneration is an open item, not a demo blocker.

## Order note
`UPSTREAM.md` describes the pre-advance state (main was `256befbb`). This file is the
later record. Where they disagree, this file wins.
