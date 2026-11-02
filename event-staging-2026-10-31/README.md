# MAOS Industrial — event submission (local deterministic T-07 scope)

**Status: published to `maos-ind_` on 2026-11-01.** Scope is the local,
deterministic T-07 demo. The clean-room run from the pinned Core tag passed
(`runtime-acceptance.json` PASS; engineering verdict FAIL is the expected
result for the synthetic input). The submitted demo makes no hosted-model call.
The GUI/Electron launch and the `rust/test.txt` canary fixture are not verified
in this submission; see the gates below.

This directory stages a patch-overlay event submission: pinned Core dependency
+ three event patches reconstructing the accepted tip + synthetic fixtures +
notices + provenance plan. It contains no Core source, no Git history, no
engine binary, no credentials, and no model runtimes.

Target event repo (public, empty, created 2026-10-29T12:40:37Z, verified
2026-10-31): `https://github.com/Amitakshya333/maos-ind_.git`
Published there as the first commit on 2026-11-01.
**Line endings matter.** `scripts/apply-event-patches.ps1` hashes the patch files byte-for-byte, so a checkout that converts LF to CRLF will fail the script closed. The event repo ships a `.gitattributes` pinning LF for `*.patch`, `*.ps1`, `*.csv`, and the notice texts. If you override that (or copy the patches out of the repo), the apply script refuses to run. No further tags will
be created from staging.

## Gates

| # | Gate | State |
|---|---|---|
| B1 | Core dependency publicly obtainable | **CLEARED 2026-10-31 (TAG-05):** tag `event-core-2cfdf9b` verified remotely (`ls-remote` tag + `^{}` peel to `2cfdf9b`; anonymous API 200 on pinned base `f9525055`). Fetch commands in §2 are exact but themselves unexecuted in staging (local-only task, no network fetches). |
| B2 | Clean-room build and deterministic T-07 run | **CLEARED for local deterministic T-07 scope (2026-10-31).** Packet `review-packets/b2-cleanroom-retry-2026-10-31` (22 step transcripts): tag fetch; patches 0001–0003 reconstruct tree `53305f48…`; backend build and GUI typecheck exit 0; Rust engine 1.95.0 built offline and healthy; T-07 run exit 0 (RMS 2.637 mm/s, verdict FAIL); audit chain valid (9 records); DOCX and audit export hashed. Not verified: GUI/Electron launch, `rust/test.txt` canary (separated by owner decision), hosted inference. |
| B3 | Hosted Meta clearance | **OPEN, not required for this submission.** The submitted demo makes no hosted-model call. Any live Meta step stays disabled until B3 clears (terms, data handling, billing gate, owner authorization). |
| B4 | Apply script covers 0001–0003 | **CLEARED 2026-10-31 (APPLY-SCRIPT-05); HARDENED 2026-10-31 (APPLY-SCRIPT-06, Delta findings):** ambient `GIT_INDEX_FILE` fails closed, real index path explicitly verified, staged-only differences fail closed and are never classified idempotent. 10 raw transcripts in `evidence/apply-script-06/` (positive, idempotent, wrong-base, dirty, partial-prefix, staged-index, hash-mismatch, `GIT_INDEX_FILE`/`GIT_DIR`/`GIT_WORK_TREE` env-guards), all PASS with independent tree confirmation. APPLY-SCRIPT-07 fixed the normal-clone relative-index comparison bug (RUNLOG-evidenced, pre-fix signature reproduced) + durable self-test; 13 fresh transcripts in `evidence/apply-script-07/` (10 clone + 3 worktree) + self-test run, all PASS; prior evidence preserved. |

## 0. Dependency revision (pinned)

- Base: `f9525055c56a7f7771dd2fa029c147c2960a98a3`
- Chain: `0001` → `239a0042` → `0002` → `189e786` → `0003` → `2cfdf9b`
  (event tip = tag target `2cfdf9b81f56eada7df2041625da18e44531151e`).
- Dependency tag: `refs/tags/event-core-2cfdf9b` on
  `https://github.com/Amitakshya333/maos.git`.
- Pending corrections FIX-06, FIX-08, FIX-10, FIX-12 are **not** in this
  chain and stay excluded until independently reviewed and integrated.
- Do not fetch the private collaboration repo or any other ref.

## 1. Prerequisites `[UNEXECUTED — versions quoted from committed docs]`

From committed `docs/INSTALLATION.md`, `demo/industrial/RUNBOOK.md`,
`package.json`, `rust/rust-toolchain.toml` at `2cfdf9b`:

- Windows x64, Windows PowerShell 5.1+.
- Node.js 22.12+ and npm 9+ (bootstrap/Electron tooling; app `engines` minimum
  is Node 20; keep a Node 20+ `node.exe` on `PATH` or set
  `MAOS_NODE_EXECUTABLE`).
- Rust toolchain 1.95.0 via committed `rust/rust-toolchain.toml`
  (`channel = "1.95.0"` — the build pin; distinct from the Cargo
  `rust-version = "1.95.0"` MSRV declaration and the one-off "built with
  1.95.0" rehearsal record; see `DISCREPANCIES.md` D1).
- Python ≥3.10 only for OCR/embedding/data-script workflows (not invoked by
  the T-07 judged flow; minimums resolved in `DISCREPANCIES.md` D2 —
  preflight enforces presence-only with a 3.9 display default, ≥3.10 is an
  unenforced workflow requirement).
- Short ASCII install path (e.g. `C:\MAOS`); the installer refuses projected
  paths ≥240 chars.
- Network to the npm registry (+ Electron binary host) for `npm ci`.
  No model-provider account is needed for the local demo; a personal key is
  needed only for the optional hosted step in §6.

```powershell
node --version   # expect >= 22.12 per committed INSTALLATION.md
npm --version    # expect >= 9
cargo --version  # expect 1.95.0 via rust-toolchain.toml
```

## 2. Fetch the pinned Core dependency `[UNEXECUTED in staging]`

```powershell
git clone --no-checkout https://github.com/Amitakshya333/maos.git C:\MAOS\core
git -C C:\MAOS\core fetch origin refs/tags/event-core-2cfdf9b
git -C C:\MAOS\core checkout f9525055c56a7f7771dd2fa029c147c2960a98a3
git -C C:\MAOS\core rev-parse HEAD   # must print the base SHA above
git -C C:\MAOS\core status --porcelain  # must print nothing (clean)
```

Use a disposable checkout you can delete. Do not reuse a checkout containing
unrelated credentials.

## 3. Apply the event patches `[UNEXECUTED in staging; chain verified locally — see PATCH_MANIFEST.md]`

```powershell
.\scripts\apply-event-patches.ps1 -CorePath C:\MAOS\core
```

The script verifies patch hashes against the manifest, refuses a wrong base
or dirty checkout, detects partial application, runs `git apply --check`
before each patch, verifies the tree after every overlay against the
committed trees, and creates no commit. It never resets, checks out, or
overwrites user files. Rerunning on a fully patched tree succeeds
idempotently after re-verifying the result.

Patched result equals event tip `2cfdf9b` (tree `53305f48…c9cb`); the script
verifies this itself and the clean room confirms independently per
`VERIFICATION_PLAN.md` step 2.

## 4. Install and build `[UNEXECUTED]`

```powershell
npm ci                 # root graph, from the patched lockfile
npm ci --prefix desktop  # Electron shell tools (electron 45.0.0)
npm run build:backend
npm run typecheck:gui
```

`npm ci` runs dependency lifecycle scripts as your user with network access.
Use a disposable least-privilege profile without unrelated secrets.

## 5. Engine setup `[UNEXECUTED]`

The engine is source-built from the pinned Rust workspace; no binary ships
with this staging directory or the npm package.

```powershell
cargo build --release --locked --manifest-path C:\MAOS\core\rust\Cargo.toml
# Binary: C:\MAOS\core\rust\target\release\maos-engine.exe
# CANARY NOTE (ENGINE-RESOLUTION-01, unresolved test-asset prerequisite):
# rust/test.txt is absent from the pinned Git tree (ignored per .gitignore,
# out-of-band fixture). Do NOT fabricate or silently copy it. Only if the
# owner supplies it out-of-band, run the hash check below; absence is
# neither a runtime failure nor product-failure evidence.
Get-FileHash -Algorithm SHA256 C:\MAOS\core\rust\test.txt
# Expected canary (when fixture supplied): 1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435
'{"version":"1.0","operation":"health"}' | & C:\MAOS\core\rust\target\release\maos-engine.exe
# Expect engine maos-industrial-engine, version 0.1.0, protocol 1.0, status ok
```

Copy the self-built binary into the demo project as the runbook describes;
never substitute an unknown binary. The rehearsal checksum `b62c128a…cc605`
(package-run-5) is identity evidence for that build only, not a release
signature.

## 6. Private key entry (only for the optional hosted step)

- The local T-07 demo (§7) makes **no hosted-model call** and needs **no key**.
- If a future judged step opts into hosted Meta inference (currently
  **disabled**, blocked on B3): set the key as a process environment variable
  whose name matches the provider entry's `apiKeyEnv` (documented example:
  `MODEL_API_KEY`), and enable the exact fragment from the committed operator
  guide (`baseURL https://api.meta.ai/v1`, model `muse-spark-1.3`,
  `metaApiEnabled: true`). The Meta key is read only from that named
  variable — never from project config or the credential store.
- Never commit keys. Committed `.env.example` carries only the
  `FREEMODEL_API_KEY=your-key-here` placeholder shape; placeholder-looking
  values are rejected by the credential module.

```powershell
$env:MODEL_API_KEY = '<paste-your-own-key-here>'  # process scope only
```

## 7. Synthetic demo `[UNEXECUTED]`

Headless judged run (explicit synthetic auto-approval, not a human review):

```powershell
maos-industrial run --auto-approve --yes --json
```

Interactive gate behavior:

```powershell
maos industrial run --auto-approve   # expect exit 4 CONFIRMATION_REQUIRED
maos industrial run                  # expect exit 10 GATE_REJECTED at human gate
```

Staging fixtures (`fixtures/synthetic-pilot.csv`,
`fixtures/synthetic-thresholds.json`, ruleset `SYNTHETIC-PILOT-V1`) are the
minimal synthetic inputs for patch-level rehearsal. The full T-07 judged flow
uses the Core tree's bundled `demo/industrial/` inputs (500-row turbine log,
thresholds, maintenance report, inspection scan).

## 8. Expected outputs (quoted from the committed runbook, `[UNEXECUTED]`)

- Pipeline: `PREFLIGHT → POLICY → SERVICES → DAG → VERIFY → AUDIT EXPORT`.
- Thresholds: vibration warn 4.5 / critical 7.1 mm/s; temp warn 85 / critical
  95 °C. Computed RMS `2.63711 mm/s`; peak 8.3 mm/s, 97.2 °C → verdict `FAIL`
  (engineering result; a `FAIL` verdict can still be a successfully completed
  run).
- Deliverable: `artifacts/generated/turbine_safety_approval_note.docx` (+ hash
  in run manifest). Audit export:
  `artifacts/generated/judged-run-audit-export.json`.
- Verify: `maos-industrial verify audit --run-id <run-id> --json`.
- Record for provenance: source revs, lockfile/runtime versions, engine
  build identity + binary hash, command outputs/exit codes, sanitized
  evidence. Keep engineering verdict distinct from execution status.

## Notices (summary; detail in LICENSES_AND_NOTICES.md)

- Rust vendor texts complete for the vendored tree (61/61 files, 31 crates;
  byte-identical to committed blobs) — scope-limited, see index.
- JS texts partial: 183 texts for 182 root packages; 70 root + 15 desktop
  entries unresolved (tables in `THIRD_PARTY_NOTICES/`).
- No license-compatibility review performed; no completeness claimed.

## Map of this staging directory

- `UPSTREAM.md` — pinned dependency + tag verification.
- `PATCH_MANIFEST.md` — patch order, hashes, chain verification record.
- `CONTRIBUTION_MAP.md` — prior work vs event surface, overlay-3 boundary,
  FIX exclusions.
- `LICENSES_AND_NOTICES.md` + `THIRD_PARTY_NOTICES/` — materialized notices
  and explicit unresolved inventory (no completeness claim).
- `DISCREPANCIES.md` — Rust 1.95 / Python wording resolutions.
- `PUBLIC_ACCESS_CHECK.md` — pre-tag obtainability evidence (2026-10-31).
- `PUBLICATION_DECISION.md` — decision record (D1 executed via TAG-05).
- `VERIFICATION_PLAN.md` — minimum clean-room command sequence (unexecuted).
- `STAGING_NOTES.md` — per-task change log.
