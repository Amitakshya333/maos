# Rust vendor license exports — COMPLETE for the vendored tree

Exported 2026-10-31 by byte-faithful `git show 2cfdf9b:rust/vendor/<path>`
(no re-encoding, no fetches). Vendor tree `2cfdf9b:rust/vendor`:
`603b628f9e9fd5fec0944b4fac944b7bf8555498`.

Completeness evidence: `git ls-tree` lists 61 license/UNLICENSE files under
`rust/vendor/` at `2cfdf9b`; this directory holds exactly those 61 files
(naming: `<crate>__<LICENSE-FILE>`). Fidelity spot-checks via
`git hash-object` vs committed blob SHA both match exactly:
`unicode-ident/LICENSE-UNICODE` → `11f2842a…c28c3b6`,
`typenum/LICENSE` → `364b7731…0ce9d4f`.

Covered crates (31): autocfg, block-buffer, cfg-if, chrono, cpufeatures,
crypto-common, csv, csv-core, diff, digest, generic-array, hex, itoa, libc,
memchr, num-traits, pretty_assertions (dev-only), proc-macro2, quote, ryu,
serde, serde_core, serde_derive, serde_json, sha2, syn, typenum,
unicode-ident, version_check, yansi, zmij. License families present:
MIT, Apache-2.0, UNLICENSE, Unicode, Boost.

Scope limit: this covers the vendored crates only. Toolchain (rustc/cargo
1.95.0) and registry-fresh non-vendored crates, if any are resolved at build
time, are outside this directory — the committed build uses
`--locked` + vendoring, so no additional crates are expected; confirming that
is a clean-room step (see `LICENSES_AND_NOTICES.md` Unresolved).
