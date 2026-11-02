# Pinned Core base + public-access result

## Pins

- Base: `f9525055c56a7f7771dd2fa029c147c2960a98a3`
- Overlay 1 result: `239a0042b08a3960d3c89f890f01ab194ff82f1f`
- Overlay 2 result: `189e786ff0431b02b95ca618bb4791a5ad7b0215`
- Overlay 3 result = event tip = tag target:
  `2cfdf9b81f56eada7df2041625da18e44531151e`
- Dependency tag (published + verified 2026-10-31, TAG-05):
  `refs/tags/event-core-2cfdf9b` on
  `https://github.com/Amitakshya333/maos.git`
  (tag object `ee569a1b67507c37cf6e968895405a6bd36d0181`, peels to the tip;
  `main` untouched at `256befbb`).

## Public-access result

- `maos.git` public; tag verified remotely via `ls-remote` (tag + `^{}` peel
  lines) and independent anonymous API read: pinned base `f9525055` returns
  HTTP 200 (previously 422). All range SHAs are now judge-fetchable through
  the tag. No re-fetch was performed in staging (local-only task); evidence
  is the TAG-05 verification record of 2026-10-31.
- Rust source + MIT license at the pinned/tip revisions are obtainable
  through the same tag (same verification covers the tree).
- `https://github.com/Amitakshya333/maos-ind_.git` remains the correct
  publication shell for event content (public, empty, created Oct 29).
  Nothing staged has been pushed there.
- `https://github.com/Amitakshya333/MAOS-industrial-.git` (package.json
  `repository.url`) still 404 — stale metadata, do not use.

Fetch commands: README §2. Chain: `PATCH_MANIFEST.md`.

## Later state (2026-11-01) — see UPSTREAM-SYNC-2026-11-01.md

This file describes the pre-advance state (public main was `256befbb`).
UPSTREAM-SYNC-2026-11-01.md is the later record; where they disagree, that file wins.
