# Clean-room local B2 plan — minimum T-07 deterministic run (UNEXECUTED)

Status: plan only (2026-10-31). Nothing here has been run. Written so the
owner can authorize one bounded execution. All commands, versions, and
expectations are quoted from staged docs and the committed tree at `2cfdf9b`
(RUNBOOK, INSTALLATION.md, OPERATOR_GUIDE, package manifests, toolchain
pin); nothing is guessed.

## Scope: IN

Headless CLI judged run on the local deterministic T-07 path: local code +
bundled synthetic fixtures, no hosted-model call, no key. Steps: fetch →
patches → install → build → engine → preflight-gated judged run → verify →
provenance bundle.

## Scope: OUT (separate concerns, not this run)

- Hosted inference (B3/step 7): needs D4 clearance + judge's own key. Never
  part of B2.
- Agent contract mock suites (e.g. staged
  `tests/industrial/analysis-agent-auth-http.test.ts`, which constructs a
  `mock` provider over loopback): mock-transport checks belong to step-4
  suite scope, not to this deterministic run. Kept distinct in records.
- Desktop/Electron shell install (`npm ci --prefix desktop`, Electron 45
  binary): NOT required for the headless command — statically verified
  2026-10-31. Dependency direction is one-way shell→app
  (`desktop/main.cjs` spawns the Node service); no file under `src/`
  imports `desktop/` or `electron` (all `desktop` hits are prose), and
  nothing under `src/industrial` or `src/cli` references `dist/gui`,
  `electron`, or `desktop/main|preload`. The `maos-industrial` bin runs
  `dist/industrial/entrypoint.js` → `require('../cli/index')` in-process,
  built by `build:backend` (`tsc` only). Desktop serves RUNBOOK Option B
  (Cockpit) only; Electron + its network/binary requirements are out of
  this minimum plan.
- Full vitest suite, notice export (D6 lane), any publication.

## Prerequisites (disposable machine/profile, no unrelated secrets)

- Windows x64, PowerShell 5.1+, git; short ASCII paths (`C:\clean\core`).
- Node.js 20+ and npm 9+ (per app `engines`; the 22.12+ floor came only
  from the Electron install tooling, which is out of scope — keep a
  `node.exe` on `PATH` or set `MAOS_NODE_EXECUTABLE`).
- Rust toolchain 1.95.0 via committed `rust/rust-toolchain.toml`
  (`channel = "1.95.0"` — the build pin; distinct from the Cargo
  `rust-version = "1.95.0"` MSRV declaration and the one-off "built with
  1.95.0" rehearsal record; see `DISCREPANCIES.md` D1).
- A Python interpreter present (preflight requires presence; detected
  version is displayed, never compared — D2; T-07 invokes no Python).
- Network allows ONLY: `github.com` (clone/fetch tag), npm registry.
  No model-provider endpoints, no Electron binary host.

## Network downloads (all pinned; record hashes)

| # | Artifact | Source | Pin / check |
|---|---|---|---|
| 1 | Core source + tag | `maos.git`, `refs/tags/event-core-2cfdf9b` | `checkout f9525055…`; patches → tree `53305f48…` |
| 2 | 249 root npm tarballs | npm registry | root lockfile; integrity fields recorded |
| 3 | Rust 1.95.0 toolchain (if absent) | rustup | `rust-toolchain.toml` channel |
| 4 | Rust crates | none expected | vendored `rust/vendor/` + `--locked`; fail on any fresh resolution |

## Lifecycle scripts / executed code (untrusted-by-default, unaudited)

- Root `prepare`: `node scripts/prepare-hooks.js` (hook install).
- Root-graph dependency `preinstall`/`install`/`postinstall` per the locked
  graph (per committed INSTALLATION.md; no per-script audit performed).
- `cargo build` compiles the vendored crates (source-built, MIT/Apache/
  UNLICENSE/Unicode/Boost texts staged; no binary substitution).

## Commands (in order; stop on first deviation)

From anywhere, then from `C:\clean\core` unless noted:

1. `git clone --no-checkout https://github.com/Amitakshya333/maos.git C:\clean\core`
2. `git -C C:\clean\core fetch origin refs/tags/event-core-2cfdf9b`
3. `git -C C:\clean\core checkout f9525055…98a3`; `rev-parse HEAD` = base; `status` clean.
4. (from staging) `.\scripts\apply-event-patches.ps1 -CorePath C:\clean\core` → success line; independently confirm tree `53305f48…`.
5. `npm ci` (root graph only) → exit 0; record npm/node versions.
6. `npm run build:backend`; `npm run typecheck:gui` → exit 0.
7. Canary test-asset check — UNRESOLVED PREREQUISITE (ENGINE-RESOLUTION-01):
   `rust/test.txt` is absent from the pinned Git tree (verified absent at
   base and tip) and is ignored per `.gitignore:59` — an out-of-band test
   fixture, not tree content. Do NOT fabricate or silently copy it into
   the checkout. Only if the owner supplies it out-of-band:
   `Get-FileHash rust/test.txt` must equal `13922455…733435`. If absent,
   record `CANARY-FIXTURE-ABSENT` and continue: absence is neither a
   runtime-requirement failure (the step 9 engine health check is the
   runtime gate) nor evidence of product failure.
8. `cargo build --release --locked --manifest-path rust/Cargo.toml` → `rust\target\release\maos-engine.exe`; record SHA-256 + size.
9. Engine health: `'{"version":"1.0","operation":"health"}' | & <binary>` → `maos-industrial-engine/0.1.0/protocol 1.0/status ok`. Stage into demo project per README §5 (checksum-compare copy).
10. `maos-industrial run --auto-approve --yes --json` → exit 0; RMS `2.63711`, verdict `FAIL`, run ID in JSON.
11. Gate probes: `maos industrial run --auto-approve` → exit 4; `maos industrial run` → exit 10.
12. `maos-industrial verify audit --run-id <run-id> --json` → chain + manifest/report/export hashes pass.

## Expected artifacts (demo project root)

- `artifacts/generated/turbine_safety_approval_note.docx` (+ hash in run manifest).
- `artifacts/generated/judged-run-audit-export.json` (sealed).
- Run manifest / receipt with selected-source hash, replay-verified findings,
  model explanation labelled UNVERIFIED (local path: no hosted model used).
- Provenance bundle: source revs, lock/runtime versions, engine build
  identity + binary hash, every command output/exit code, sanitized demo
  evidence. Engineering verdict (`FAIL`) stays distinct from execution
  status.

## Authorization bounds requested

- Enumerated commands only; enumerated network endpoints only (github +
  npm registry + rustup-if-absent); $0 spend (no hosted calls, no
  billing surface); synthetic fixtures only; no secrets in scope (none
  entered, none stored); disposable profile/machine, deleted or re-imaged
  after. Stop conditions: any hash/exit/output deviation, any unexpected
  network destination, any lifecycle-script failure, any fresh crate
  resolution, any prompt for credentials. B2 green = steps above all pass
  with full records; until then no run claim.
