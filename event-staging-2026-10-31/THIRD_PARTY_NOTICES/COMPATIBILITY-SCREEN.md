# Preliminary license-compatibility screen (2026-10-31)

Scope: ONLY texts and inventories already in this staging directory (listed
below). No network, no new fetches, no legal review. This is a screening
aid, not a clearance: the notice set is INCOMPLETE and no compatibility
conclusion below is final. Anything marked UNRESOLVED needs owner action.

Sources: `rust-vendor/` (61 texts, 31 crates) + `INDEX.md`;
`rust-cargo-lock-inventory.md` (32 pkgs); `js-root-lock-inventory.md`
(249 rows) + `js-root/` (183 texts) + `js-root-COVERAGE.md` +
`js-root-unresolved.md` (70); `js-desktop-lock-inventory.md` (15 rows) +
`js-desktop-unresolved.md` (15). Core distribution license: MIT (`LICENSE`).

## Rust — preliminary PASS (vendored tree only)

All 31 vendored crate IDs resolve to permissive terms from their staged
texts (crate → staged files → terms):

| # | Crate | Staged files | Terms |
|---|---|---|---|
| 1 | autocfg | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 2 | block-buffer | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 3 | cfg-if | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 4 | chrono | LICENSE.txt (dual pointer, verified) | MIT / Apache-2.0 |
| 5 | cpufeatures | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 6 | crypto-common | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 7 | csv | LICENSE-MIT, UNLICENSE | MIT / UNLICENSE |
| 8 | csv-core | LICENSE-MIT, UNLICENSE | MIT / UNLICENSE |
| 9 | diff | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 10 | digest | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 11 | generic-array | LICENSE (MIT text, verified) | MIT |
| 12 | hex | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 13 | itoa | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 14 | libc | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 15 | memchr | LICENSE-MIT, UNLICENSE | MIT / UNLICENSE |
| 16 | num-traits | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 17 | pretty_assertions | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 (dev-only) |
| 18 | proc-macro2 | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 19 | quote | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 20 | ryu | LICENSE-APACHE, LICENSE-BOOST | Apache-2.0 / Boost |
| 21 | serde | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 22 | serde_core | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 23 | serde_derive | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 24 | serde_json | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 25 | sha2 | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 26 | syn | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 27 | typenum | LICENSE ("MIT OR Apache-2.0", verified) + both full texts | MIT / Apache-2.0 |
| 28 | unicode-ident | LICENSE-APACHE, LICENSE-MIT, LICENSE-UNICODE (V3 notice, verified) | Apache-2.0 / MIT / Unicode-V3 |
| 29 | version_check | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 30 | yansi | LICENSE-APACHE, LICENSE-MIT | MIT / Apache-2.0 |
| 31 | zmij | LICENSE-MIT | MIT |

Summary: 24 dual MIT/Apache-2.0, 3 MIT/UNLICENSE, 2 MIT, 1 Apache-2.0/Boost,
1 Apache-2.0/MIT/Unicode-V3. No GPL/AGPL/LGPL/MPL/EPL/CDDL-family text
appears in the staged vendor set.
Obligations if shipped: preserve the staged copyright/license notices;
Apache-2.0 §4 change-marking is not triggered (vendored unmodified — no
modification evidence in the locked tree); no `NOTICE` files observed in
the staged set. Scope limit (from `rust-vendor/INDEX.md`): toolchain
(rustc/cargo) and any non-vendored resolutions are outside this screen —
UNRESOLVED, confirm zero additional resolutions in clean room.

## JavaScript — CONDITIONAL (bulk permissive; MPL texts incomplete)

Lockfile-declared id tally (264 rows, both inventories): MIT 222, ISC 13,
MPL-2.0 11, Apache-2.0 10, BSD-3-Clause 3, BSD-2-Clause 1, 0BSD 1,
(MIT OR CC0-1.0) 1, CC-BY-4.0 1, Unlicense 1. No GPL/AGPL/LGPL/EPL/CDDL ids.

- Permissive bulk (MIT/ISC/Apache-2.0/BSD/0BSD/Unlicense/MIT-or-CC0):
  preliminary OK **where texts are staged** (183 texts incl. dotenv
  BSD-2-Clause, tslib 0BSD, fast-sha256 Unlicense, type-fest, diff,
  ieee754, source-map-js — all `js-root/<pkg>__LICENSE*`). Ids are
  lockfile-declared; text↔id content was filename-mapped with spot reads
  only — full text↔id audit UNRESOLVED.
- CC-BY-4.0 × 1 (`caniuse-lite@1.0.30001810`, data tables; text staged at
  `js-root/caniuse-lite__LICENSE`): preliminary OK with attribution
  preserved.
- **MPL-2.0 × 11 (`lightningcss-<platform>@1.33.0`, weak copyleft,
  file-level): UNRESOLVED.** Only the win32-x64 text is staged
  (`js-root/lightningcss-win32-x64-msvc__LICENSE`, verified MPL-2.0 full
  text); the other 10 platform binaries sit in `js-root-unresolved.md`
  (`not-installed-locally`). MPL permits larger-work combination with an
  MIT app in principle (separate files stay under MPL with notices
  retained; no MPL file here is modified), but without the 10 texts,
  notice preservation cannot be shown. These ride the dev-toolchain chain
  (via `@vitejs/plugin-react`, build-time CSS); whether any copy lands in
  a distributed artifact is UNRESOLVED — confirm from the clean-room
  build outputs, and export the texts (or document platform-scoped
  rationale) before claiming coverage.
- Desktop 15 (MIT/ISC/Apache-2.0 ids incl. electron, playwright-core):
  texts wholly missing (`js-desktop-unresolved.md`) — UNRESOLVED, needs
  clean-room `npm ci --prefix desktop` + text export.

## Unresolved JS counts (reconciled, no overlaps)

- Root: 70 rows = 60 `not-installed-locally` + 10
  `no-license-file-installed` (all MIT-id); all 70 package names unique.
- Desktop: 15 rows, all unique names.
- Cross-graph name overlaps: **0**. Combined unique name@version: **85**
  (70 + 15). Counts are per graph+version: e.g. `@types/node` is resolved
  at root (`25.9.1`, text staged) and unresolved at desktop (`24.19.2`).
- Of the 60 root not-installed entries, 10 are the MPL-2.0 lightningcss
  platform binaries above; the rest are skipped optional/platform
  packages (full list in `js-root-unresolved.md`).

## Unresolved list (owner actions)

1. 10 MPL-2.0 platform texts + shipped-artifact analysis (blocks any
   copyleft clearance).
2. Remaining missing texts: 85 unique name@version (70 root + 15 desktop,
   zero overlaps) — clean-room export (notice closure stays UNRESOLVED).
3. Full text↔id content audit for the 183 staged JS texts (only
   filename-mapped + spot-read here).
4. Formal compatibility review / legal clearance — UNRESOLVED (this
   screen is not legal advice).
5. Toolchain + installer-downloaded artifacts (rustc/cargo, node/npm,
   Electron binary, Python wheels) — out of staged scope entirely.
6. Apache-2.0 `NOTICE`-file check at clean-room time (none observed in
   staged texts, but confirm against the resolved set).
