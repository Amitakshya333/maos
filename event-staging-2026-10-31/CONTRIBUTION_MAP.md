# Contribution map through committed 2cfdf9b (staging, 2026-10-31)

Kickoff reference: Oct 26, 2026, 12:24 PM ET (16:24 UTC / 21:54 IST).
Recorded commit timestamps are **supporting context only**, never sole proof
of event creation (see Substantiation). Inclusion in the patch chain proves
reconstruction, not authorship or event eligibility.

## Commit register: public HEAD → event tip

Public `maos.git` HEAD was `256befbb` (2026-09-29); tag
`event-core-2cfdf9b` (published + verified 2026-10-31) now makes the full
range judge-fetchable.

| # | SHA | Recorded date (IST) | Subject | Stat | Class |
|---|---|---|---|---|---|
| 0 | `256befbb` | 2026-09-29 14:38 | fix(ci): stabilize embedding restore and Rust vendor checksums | public HEAD | Prior work (public) |
| 1 | `e47ee5c` | 2026-09-29 18:03 | fix(audit): publish append locks atomically | 3 files +134/−82 | Prior work (patch-base parent) |
| 2 | `f9525055` | 2026-09-29 18:17 | fix(ci): preserve canary bytes on Windows | 1 file +2 | Prior work = patch base |
| 3 | `239a0042` | 2026-10-28 15:41 | Add audited Industrial agent workflows | 100 files +9875/−1142 | **Event overlay 1** (`0001`) |
| 4 | `189e786` | 2026-10-29 00:25 | Enforce Meta provider and Industrial agent limits | 27 files +2168/−101 | **Event overlay 2** (`0002`) |
| 5 | `27dd171` | 2026-10-29 14:36 | Harden installation and project Git discovery | 17 files +890/−325 | **Event overlay 3** (`0003`) |
| 6 | `d526bfe` | 2026-10-29 15:38 | Handle npm stderr in bootstrap installer | 2 files +53/−11 | **Event overlay 3** (`0003`) |
| 7 | `bb871cb` | 2026-10-29 21:34 | Add bounded Industrial agent and provider workflows | 18 files +1889/−93 | **Event overlay 3** (`0003`) |
| 8 | `f201cfe` | 2026-10-29 23:45 | Fix pilot cancellation callback lifetime | 4 files +425/−41 | **Event overlay 3** (`0003`) |
| 9 | `2cfdf9b` | 2026-10-30 18:43 | Set Baseten reasoning output budget | 4 files +72/−12 | **Event overlay 3** (`0003`, event tip) |

Overlay 3 total (`189e786..2cfdf9b`): 34 files, +3266/−419.

## Baseline already present at `f9525055` (prior work, not event claims)

Provider/runtime and orchestration layers, plan/CLI, service and GUI
foundations, deterministic Industrial telemetry/rules/report capability, Rust
engine source + `rust/vendor/` + `rust/rust-toolchain.toml` (added Sep 28–29),
and MIT licensing. The Rust toolchain pin and vendored dependency texts are
pre-event prior work that the event build reuses as a labelled dependency.

## Overlay 3 attribution boundary

`0003` carries the five committed post-`189e786` commits verbatim (new files:
`docs/INSTALLATION.md`, install-bundle scripts,
`Start-BasetenSyntheticPilot.ps1`, `Windows-ProcessTree.ps1`,
`prepare-hooks.js`, `project-git-context.ts`, 4 tests incl. 2 Baseten).
Chain inclusion reconstructs the owner-accepted tip exactly (tree-SHA proof
in `PATCH_MANIFEST.md`); it does not by itself establish that any line was
first authored during the event. Per-commit event-approval status follows
owner/Delta review; judges must treat overlay 3 as "committed range under
review", with overlays 1–2 as the substantiated event surface below.

## Structural event-origin evidence (beyond timestamps)

1. **Patch↔history identity (verified by inspection, 2026-10-31).** All three
   staged patch files' SHA-256 are recorded in the manifest; their `diff
   --git` path sets equal `git diff --name-only` of the declared base→result
   ranges with **zero differences**; file counts and +/− line stats match
   history exactly. The full chain was additionally applied in an isolated
   worktree: each intermediate and final `write-tree` equals the corresponding
   committed tree SHA (see `PATCH_MANIFEST.md`).
2. **New-file creation inside the overlay ranges** (files that did not exist
   at the range base — structural additions, not timestamp claims):
   - Overlay 1 (22): `desktop/` shell (`main.cjs`, `preload.cjs`,
     `package.json`, `package-lock.json`, `README.md`),
     `src/domain/industrial-analysis-agent.ts`,
     `src/industrial/{analysis-agent-service,entrypoint,judged-run-lock}.ts`,
     `src/gui/src/native.d.ts`, 11 tests/rehearsals.
   - Overlay 2 (8): `docs/MAOS_INDUSTRIAL_OPERATOR_GUIDE.md`,
     `src/backends/meta-api-policy.ts`, `src/industrial/industrial-repl.ts`,
     5 contract/boundary/budget tests.
   - Overlay 3 (11): as listed in the attribution boundary above.
3. **Kickoff ordering as supporting context.** Overlay commits record Oct 28–30
   IST, after the Oct 26 12:24 PM ET kickoff; the base records Sep 29. Ordering
   is consistent with event authorship but proves nothing per line.
4. **Explicit limits.** Git establishes tree differences, not first-authorship
   time per line, not the author of previously uncommitted material, and not
   eligibility. Overlays modify pre-existing Core files (API routing,
   provider construction, runner/orchestration, CLI/REPL, services, GUI);
   within edited hunks, prior vs event lines are not separated. The owner must
   substantiate authorship/timing and file any required existing-code
   disclosure.

## Exclusion register

- Pending corrections **FIX-06, FIX-08, FIX-10, FIX-12**: **excluded** — not
  part of this patch chain in any form. They remain excluded until
  independently reviewed and integrated through the owner/Delta lane; a future
  overlay would carry them under a new labelled patch, never silently.
- Full application source snapshot: **never submission content** (reference
  only). Pre-existing code/history stays out of the event repo; the Core
  range is a labelled pinned public dependency via tag `event-core-2cfdf9b`.
