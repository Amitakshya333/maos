# Installation reliability delta handoff — 2026-10-29

Status: local implementation and installation smoke passed; independent review pending. This is not a new approved release candidate. Evidence updated at 2026-10-29T02:58:50.160+05:30.

## Baseline and packet identity

- Repository: `C:\maos`, branch `main`, base/HEAD `189e786ff0431b02b95ca618bb4791a5ad7b0215`.
- Index is empty. No source was staged or committed.
- Source delta: 15 files. The manifest records raw-byte and LF-normalized SHA-256 per path.
- Patch SHA-256: `f2edd4658fcdba9716050d2a377ed941498300177656f3ff91a77e45fdd4b3e5`.
- Source-manifest SHA-256: `771081758b5747aeabd21f040ac98d75ecaea7c18db794883acefa9570955e75`.
- Reconstruction from the declared base passed `git apply --check` and `git apply` (both exit 0). Patch/manifest scope matched all 15 paths; all 15 files matched after LF normalization; 2 also matched raw bytes. The other raw-byte differences are CRLF/LF conversion, with no normalized content differences. See `patch-reconstruction-release.json`.

## Changes

- `desktop/package.json` now treats Electron `45.0.0` as a production dependency; the desktop lockfile pins the graph. Playwright `1.64.1` remains development-only.
- The npm tarball does not carry the root package lock, so the Windows bootstrap supplies the exact root lockfile beside the tarball and executes `npm ci` in both the app and desktop directories. The ordinary `npm install maosorch` route remains semver-based and is not the reproducible route.
- Electron 45 does not automatically download its runtime during `npm ci`. The installer now explicitly runs the lockfile-pinned package's `electron/install.js`, which uses Electron's bundled checksum data by default, then requires `electron.exe` to exist. It does not disable TLS checks or use unpinned `npx`.
- The application package's own `bin` commands do not get self-package `.bin` shims from in-place `npm ci`. The guide now documents direct Node entrypoints for the installed CLI and Industrial CLI.
- `prepare-hooks.js` skips Husky setup outside a Git checkout so production `npm ci --omit=dev` works without development-only Husky.
- `maos doctor` now returns structured readiness and a nonzero `exitCode` for required setup failures. `maos doctor` propagates that exit code. Missing configuration, malformed configuration, missing credentials, and a required missing/incompatible Industrial engine fail closed; optional capability absence remains a warning. Doctor no longer performs connectivity inference.
- Tests cover doctor readiness and package/runtime assets. No inference transport was used.

Exact source paths:

```text
README.md
package.json
desktop/package.json
desktop/package-lock.json
desktop/README.md
src/cli/doctor.ts
src/cli/index.ts
src/cli/repl.ts
tests/cli/meta-provider-entrypoints.test.ts
tests/industrial/package-runtime-assets.test.ts
docs/INSTALLATION.md
scripts/Install-MaosIndustrial.ps1
scripts/New-MaosIndustrialInstallBundle.ps1
scripts/prepare-hooks.js
tests/cli/doctor.test.ts
```

## Supported installation experience

The supported path for this candidate is the Windows x64 lockfile bootstrap bundle, not a portable installer:

1. Start with Node.js `>=22.12.0`, npm `>=9` (lockfile v3), Windows PowerShell `5.1+`, and Windows `tar.exe` on `PATH`.
2. Expand the local ZIP and run `Install-MaosIndustrial.ps1` against an empty destination.
3. The script verifies package/lock/script hashes, extracts the tarball, runs locked `npm ci --omit=dev` for the app and desktop, explicitly downloads the pinned Electron runtime using the package helper, and checks the installed executable.
4. Invoke the CLI with `node.exe app\dist\cli\index.js ...`, Industrial CLI with `node.exe app\dist\industrial\entrypoint.js ...`, and Electron with `app\desktop\node_modules\electron\dist\electron.exe app\desktop\main.cjs`.

The application metadata itself requires Node `>=20`; Node `>=22.12` is the installer floor because the pinned Electron npm package requires it. The installed desktop service also needs Node on `PATH` or `MAOS_NODE_EXECUTABLE`. Only Node 24.11.0/npm 11.6.1/PowerShell 7.6.9 were exercised; the declared lower floors were not tested as a compatibility matrix.

Network is needed for the npm registry and the configured Electron binary host. Electron's package-provided checksum list is used unless the supported mirror/checksum environment settings are overridden. The installer does not bundle Node/npm or Python.

The package contains backend output, GUI files, Electron main/preload resources, Industrial CLI/REPL entrypoints, demo fixtures, profile, Python scripts, and the desktop lockfile. It contains no `node_modules`, `.maos`, review packet, `.env`/credential-pattern file, Rust engine binary, or Electron executable. The ZIP manifest ties the package to base commit `189e786ff0431b02b95ca618bb4791a5ad7b0215` plus the patch SHA above.

## Package and installed runtime evidence

Final local artifacts (not published):

- npm tarball: `candidate-locked-bootstrap-release-2026-10-29/maosorch-0.3.0.tgz`; 1,222,398 bytes; 495 files; 5,568,811 unpacked bytes; SHA-256 `8f57f15bbbd96da493cf35646836aa2784a9d23165f3177a9819f2d7ffdae27a`.
- Bootstrap ZIP: `candidate-locked-bootstrap-release-2026-10-29/maos-industrial-bootstrap-windows-x64.zip`; 1,253,617 bytes; SHA-256 `1c6fcb695b495d5d79d3a22f2fb1ba56ec49183ae2ae7d30fa5fe439d676d36f`.
- Bundle manifest includes the package hash, root-lock hash, desktop-lock hash, installer hash, source commit, and source-delta hash. This unsigned manifest detects mismatched inputs; it does not attest a publisher or protect against a party replacing the whole bundle and manifest.
- Environment: Windows `10.0.26300` x64; PowerShell `7.6.9`; Node `v24.11.0`; npm `11.6.1`; Cargo/rustc `1.95.0`.
- The final ZIP installed successfully into a new empty destination at `install-release-short-...` with the task-isolated npm/Electron caches. Those caches had been populated by a prior corrected-candidate install that started empty and fetched the complete graph and Electron runtime. Final install log: `clean-install-bootstrap-release-short.txt` (exit 0). `npm ls --depth=0 --omit=dev` exited 0 for both application and desktop; app installed 77 packages and desktop installed 13. Electron runtime marker is `45.0.0`; executable is 249,797,632 bytes, SHA-256 `8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59`. Playwright was absent from the runtime.
- Installed `maos-industrial --help` (Node entrypoint) and `maos repl --help`: exit 0. The interactive REPL itself was not exercised in this installation-reliability slice.
- Installed doctor: missing configuration exit 1; missing provider credential exit 1; optional CLI runtime absence exit 0 with warnings; missing Industrial engine exit 1 with the required project path/build/copy instructions; candidate engine present and health-checked exit 0. Doctor output explicitly says connectivity is not tested. No inference calls were made.
- The only Electron invocation was `electron.exe --version` (exit 0, no console output); version identity was verified from the locked package and installed `dist/version` marker. The GUI was not launched from this new bootstrap.

## Rust engine delivery and trust boundary

The Rust engine is an explicit external prerequisite for Industrial projects, not bundled and never fetched/executed automatically. `maos doctor` checks its bounded health response and requires engine `maos-industrial-engine`, version `0.1.0`, protocol `1.0`, status `ok`, and `unsafe_code=false`. The missing-engine diagnostic gives the exact project destination and a source-build/copy command.

A local Windows x64 candidate was built from the declared source commit/tree using `cargo build --release --locked --offline --manifest-path rust/Cargo.toml`. Its manifest records 11 Rust source/lock files, tool versions, engine identity, size, and binary SHA-256 `011dd53795d025f11c605ee62bc25b1e85fcf7d5ae69503bbcef2fb3a40129de`. The manifest source tree matches the commit tree; installed doctor successfully queried this binary. The crate declares MIT, but third-party notice and redistribution review are unresolved. Manifest status is explicitly `UNAPPROVED LOCAL BUILD — NOT A PUBLISHER ATTESTATION`; no approved-manifest comparison or publisher signing exists. Rust 1.95.0 was used, but the repository does not pin the Rust toolchain.

Recommendation for a future consumer-oriented candidate: keep this binary external until third-party notice and redistribution review completes; then consider a separate platform-specific engine artifact plus notices. Owner decision needed before any future bundle includes it: approve redistribution only after that license/notice review. No such approval is assumed here.

## Doctor/runtime behavior not resolved here

The Industrial runbook says Python `>=3.10` is workflow-dependent and not used by the deterministic T-07 flow. Current `maos industrial preflight` still requires an interpreter to be present and displays a default minimum of `3.9` without enforcing a version comparison. This mismatch is documented and remains open; the package installer does not install Python. Optional Python/OCR/sandbox workflows may have additional configured prerequisites. Docker/Podman is optional unless `requireDocker=true`; Tesseract is optional unless `requireOcr=true`.

## Validation actually executed

- Isolated validation checkout: `npm ci --no-audit --no-fund --include=dev` exited 0. This was outside `C:\maos`; source checkout excluded `.maos`.
- `node_modules/.bin/vitest.cmd run tests/cli/doctor.test.ts tests/cli/meta-provider-entrypoints.test.ts tests/industrial/package-runtime-assets.test.ts`: 3 files, 18 tests passed, exit 0 (`focused-tests-final.txt`).
- `npm run build`: exit 0; Vite emitted the existing nonblocking >500 kB chunk warning (`backend-gui-build-current-source.txt`).
- `npm run typecheck:gui`: exit 0 (`gui-typecheck-current-source.txt`). The later changes were installation documentation/tests and the PowerShell installer, not GUI/backend contracts.
- PowerShell parser: installer and bundle-builder parse passed.
- `npm pack --ignore-scripts --json --pack-destination <candidate dir>`: exit 0; actual contents and exclusions recorded in `npm-pack-release.json` and `package-contents-release-verified.json`.
- `New-MaosIndustrialInstallBundle.ps1`: exit 0 (`bundle-build-release.txt`).
- Fresh dependency/Electron cache installation of the corrected runtime candidate: exit 0 (`clean-install-bootstrap-corrected.txt`). Final release bundle into a fresh empty destination with task-local caches: exit 0 (`clean-install-bootstrap-release-short.txt`). A nested temp destination attempt failed closed when the desktop lock path was 253 characters; the same bundle succeeded from a shorter 188-character task-temp path. The failed workspace was retained.
- Installed package CLI/dependency/doctor logs: `installed-runtime-smoke-release.txt`, `doctor-scenarios-final-installed-release.txt`.
- Candidate engine build/identity records: `rust-build.txt`, `engine-health-verification.txt`, and `engine-candidate-windows-x64/engine-artifact-manifest.json`.
- Final state: HEAD unchanged, index empty, all 15 source hashes match, reconstruction 15/15 LF-equal, exact task process filter returned zero (`final-state-release.json`, `task-process-check.json`).

## Incident record and limits

Read `review-packets/package-clean-install-2026-10-29/HANDOFF.md` and retain its incidents: the accidental root `npm ci` installed 252 packages into ignored `C:\maos\node_modules`; the prior ignored contents were unknown and were not inventoried or restored. An earlier invalid Electron attempt may have written to default `AppData\Roaming\Electron`; that directory was not inspected or cleaned. Earlier aborted task temp workspaces remain because cleanup was blocked; no test-owned processes remained at that time.

This session left its known task temp workspaces and caches intact; no broad cleanup was attempted. The initial task temp source export had `.maos` path names and was abandoned without opening contents; cleanup was blocked by policy. A separate no-`.git` temp-source `git status` accidentally discovered and enumerated path names above the temp root, including `.maos`; an installed doctor check also once reported an ancestor Git status (`master`, 89 modified paths). No content bytes were displayed and no writes occurred, but Git may stat/read tracked content while computing status, so no claim is made that the subprocess could not have read private bytes. Later doctor checks used `GIT_CEILING_DIRECTORIES` set to the task temp root. See `incident-addendum.txt`.

No package GUI journey, browser rehearsal, live Meta inference, signing, publisher attestation, evaluator distribution check, submission, or model-license clearance was performed. The earlier package/Electron mock rehearsal in the 2026-10-29 handoff remains separate evidence and is not counted as a new rehearsal here.

## Focused independent review requested

Review only this 15-file delta against `189e786ff0431b02b95ca618bb4791a5ad7b0215`, with emphasis on:

1. Bootstrap lockfile identity, safe archive extraction, empty-target behavior, and the explicit Electron 45 download/checksum path.
2. Doctor readiness semantics, exit-code propagation, secret-safe messages, and no inference side effect.
3. Installed CLI invocation/documentation and external Rust engine discovery/identity checks.
4. Package contents and known runtime/documentation limitations above.

Do not infer self-contained installer, code-signing, live Meta, licensing, browser, or submission readiness from these checks. Source approval remains pending independent inspection.