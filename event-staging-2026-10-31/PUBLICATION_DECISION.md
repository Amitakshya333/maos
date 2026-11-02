# Publication decision (owner) — status 2026-10-31

Date: 2026-10-31. No publication has been performed from staging.

## Status

- **D1 EXECUTED (TAG-05, 2026-10-31):** tag `event-core-2cfdf9b` created on
  `https://github.com/Amitakshya333/maos.git` (tag object
  `ee569a1b67507c37cf6e968895405a6bd36d0181`, peels to `2cfdf9b`); verified
  remotely (`ls-remote` tag + `^{}` lines; anonymous API 200 on pinned base
  `f9525055`); `main` untouched at `256befbb`. Only that single ref was
  pushed. Current obtainability: `UPSTREAM.md`.
- **D5 EXECUTED 2026-11-01:** staged content pushed to `maos-ind_` as its
  first commit. Decided by the product manager under owner delegation, after a
  clean pre-push secret scan. No further tags will be
  created from staging.
- The Problem/Decision sections below are the preserved pre-execution
  record; "two patches" there now reads three (0003 added, OVERLAY-04).

## Problem (pre-execution record)

Judges could not obtain the pinned Core base `f9525055`, either overlay
result, the committed reference `2cfdf9b`, or the Rust source at those
revisions: the public `maos.git` HEAD was `256befbb` (Sep 29) and the
9-commit range `256befbb..2cfdf9b` was entirely unpushed (evidence:
`PUBLIC_ACCESS_CHECK.md`). The event repo `maos-ind_` is public, empty, and
fresh-dated (created Oct 29) — the correct shell, currently holding nothing.

## Decision (choose exactly one Core-publication route — Route A taken)

- **Route A (taken): publish the Core range to `maos.git` as a labelled
  ref.** Tag `event-core-2cfdf9b` resolving to `2cfdf9b`, so all 9 SHAs
  (`e47ee5c f9525055 239a0042 189e786 27dd171 d526bfe bb871cb f201cfe 2cfdf9b`)
  are anonymously fetchable; exact URL + ref recorded in the event README.
  Publishing makes post-tip commits available as *dependency source*; it
  does not promote them to approved event work (event approval stays:
  three patches + map, with overlay-3 scope per `CONTRIBUTION_MAP.md`).
- **Route B (not taken): advance public `main` to `2cfdf9b`.** Weaker
  labelling; main was deliberately left at `256befbb`.
- **Rejected: re-pin the base to public `256befbb`.** Would fold the pre-event
  Sep 28–29 changes into the "event" overlay and misattribute prior work.
  Do not do this.
- **Forbidden: import Core history or old code into `maos-ind_`.** The event
  repo's first commit must be patches + fixtures + docs only (this staging
  content after review), with the Core range referenced as a labelled pinned
  public dependency. Never substitute the private collaboration repo.

## Owner decision list

| ID | Decision | State |
|---|---|---|
| D1 | Approve Route A (or B) and execute the push; return exact URL + ref | DONE (TAG-05; see Status) |
| D2 | Per-commit event approval for overlay-3 scope (0003 chain built + verified; approval vs further review) | DECIDED 2026-11-01: include 0003, labelled reproduction-verified and not independently reviewed. FIX-06/08/10/12 stay excluded. (Product manager, under owner delegation.) |
| D3 | Confirm FIX-06/FIX-08/FIX-10/FIX-12 stay excluded pending independent review + integration | OPEN — Owner + Delta |
| D4 | Confirm hosted Meta terms / data handling / billing gate before any live-key step (README B3) | OPEN, not required for submission (no hosted calls in scope) |
| D5 | Approve first-commit publication of reviewed staging content to empty `maos-ind_` | EXECUTED 2026-11-01 (product manager, under owner delegation) |
| D6 | Accept the unresolved-notices plan (clean-room materialization) or commission full texts first | DECIDED 2026-11-01: option (a), publish with the JS notice gap stated in THIRD_PARTY_NOTICES/JS-CLOSURE-RUN-2026-10-31.md (60 root + 15 desktop texts unresolved; 10 MPL-2.0 lightningcss binaries). No legal clearance claimed. |
