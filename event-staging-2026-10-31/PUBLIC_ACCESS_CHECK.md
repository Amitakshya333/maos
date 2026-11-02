# Public-access check (read-only, 2026-10-31)

> Status: PRE-TAG evidence — SUPERSEDED for obtainability by TAG-05 (tag
> `event-core-2cfdf9b` published and verified; pinned base `f9525055` now
> HTTP 200). Preserved as the audit trail of the pre-publication state.
> Current status: `UPSTREAM.md`.

Method: anonymous `git ls-remote` + anonymous GitHub REST/raw reads. No
credentials, no writes, no fetches of private state. A bogus-SHA control
establishes the meaning of HTTP 422 (SHA absent from the public repo).

| # | Check | Method | Result |
|---|---|---|---|
| 1 | Core repo readable | `git ls-remote https://github.com/Amitakshya333/maos.git HEAD` | OK: `256befbb…668b HEAD` |
| 2 | Public refs | `git ls-remote <maos.git>` (full) | `main` = `256befbb`; PR heads `pull/1,3,4,5` only — none match any event SHA |
| 3 | Public-HEAD commit | `GET /repos/Amitakshya333/maos/commits/256befbb…` | 200, message matches local history |
| 4 | Bogus-SHA control | `GET …/commits/0000…0000` | 422 → 422 means "SHA not in public repo" |
| 5 | Patch base | `GET …/commits/f9525055…98a3` | **422 — not public** |
| 6 | Overlay 1 tip | `GET …/commits/239a0042…f1f` | **422 — not public** |
| 7 | Overlay 2 tip | `GET …/commits/189e786…215` | **422 — not public** |
| 8 | Committed ref | `GET …/commits/2cfdf9b…151e` | **422 — not public** |
| 9 | Base parent | `GET …/commits/e47ee5c…90e6` | **422 — not public** |
| 10 | Rust manifest at public HEAD | `raw.githubusercontent…/256befbb…/rust/Cargo.toml` | 200: MIT, `rust-version 1.95.0` |
| 11 | License at public HEAD | `raw.githubusercontent…/256befbb…/LICENSE` | 200: MIT, © 2025 Amitakshya Sutar, 1073 bytes — matches staged `LICENSE` |
| 12 | Event repo | `GET /repos/Amitakshya333/maos-ind_` + full `ls-remote` | Public, empty (size 0, zero refs), `created_at 2026-10-29T12:40:37Z`, default branch `main` — suitable shell |
| 13 | Stale package.json URL | `GET /repos/Amitakshya333/MAOS-industrial-` | **404 — repository does not exist** |

Conclusion: the Core dependency range `256befbb..2cfdf9b` (9 commits) is
entirely unpushed, so judges cannot obtain the pinned base, the overlay
results, the committed reference, or the Rust source at those revisions.
Rust source/license are obtainable only at the stale public HEAD `256befbb`.
Required action: `PUBLICATION_DECISION.md`.
