# License and notices inventory (staging, 2026-10-31 — PARTIAL, see Unresolved)

Only material marked Materialized was copied from accessible local sources.
Nothing here is fetched, invented, or complete unless its evidence says so.

## Materialized

- **Core source license.** `LICENSE` (MIT, © 2025 Amitakshya Sutar),
  content-identical to the public-HEAD `LICENSE` (1073 bytes, 2026-10-31).
- **Rust engine declared license.** Workspace + engine crate declare MIT;
  toolchain pinned by committed `rust/rust-toolchain.toml` (`1.95.0` +
  rustfmt/clippy + `x86_64-pc-windows-msvc`). The "does not pin" sentence in
  committed `docs/INSTALLATION.md` is factually wrong — the pin file exists
  at `2cfdf9b` and already existed when that doc was written (`27dd171`).
  See `DISCREPANCIES.md` D1.
- **Vendored Rust dependency texts — COMPLETE for the vendored tree.**
  `THIRD_PARTY_NOTICES/rust-vendor/` holds all 61 license/UNLICENSE files
  for all 31 vendored crates (MIT/Apache-2.0/UNLICENSE/Unicode/Boost),
  byte-identical to committed blobs (count 61/61; two `hash-object`
  spot-checks match). Evidence: `rust-vendor/INDEX.md`.
- **JS root license texts — PARTIAL.** `THIRD_PARTY_NOTICES/js-root/` holds
  183 texts for 182 version-matched packages (byte-copies from the
  pre-existing local install; zero version mismatches; hash spot-check
  passes). Full SPDX-id inventory stays in `js-root-lock-inventory.md`
  (249 rows).
- **JS desktop license inventory (ids only).**
  `js-desktop-lock-inventory.md` (15 rows; no local install to copy from).

## Unresolved

1. JS root: 70 entries in `js-root-unresolved.md` (60 not installed locally —
   skipped optional/platform packages; 10 version-matched but shipping no
   LICENSE file). Needs clean-room `npm ci` + tarball-text export.
2. JS desktop: all 15 entries in `js-desktop-unresolved.md` (no local
   `desktop/node_modules`). Needs clean-room `npm ci --prefix desktop` +
   text export.
3. License-compatibility review: none performed (does any dep require more
   than preservation, e.g. notice display or source offer?). A preliminary
   screen from staged material only is in
   `THIRD_PARTY_NOTICES/COMPATIBILITY-SCREEN.md` (not a clearance; MPL-2.0
   texts incomplete).
4. Build-time-only confirmation: committed builds use `--locked` + vendoring,
   so no fresh crates are expected; clean-room must confirm zero additional
   resolutions (Rust) and record the actual resolved set (JS).
5. No engine binary is shipped: no binary redistribution rights asserted or
   needed. Any future binary shipment reopens provenance/signing/approval.
6. `npm ci` lifecycle scripts remain untrusted-by-default (see README §4);
   no script audit performed.

Installation runs dependency lifecycle scripts as the invoking user with
possible network access. Lockfiles pin versions, not trust. Use a disposable
least-privilege environment without unrelated secrets.
