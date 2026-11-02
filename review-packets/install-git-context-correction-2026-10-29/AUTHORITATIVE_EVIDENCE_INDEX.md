# Authoritative evidence index — installation/Git-context correction

**Status:** current local correction candidate, not independently reviewed, committed, or released. This index is authoritative for the final bundle in this packet. Historical logs and artifacts remain unchanged; their hashes still describe their own earlier candidates.

## Source and patch identity

- Repository: `C:\maos`
- Branch/HEAD at verification: `main` / `189e786ff0431b02b95ca618bb4791a5ad7b0215`
- Index: empty (`git diff --cached --quiet` exit 0); no commit or staging performed.
- Complete base-to-candidate scope: 17 source files, declared base `189e786ff0431b02b95ca618bb4791a5ad7b0215`.
- Authoritative complete patch: [`complete-delta.patch`](complete-delta.patch), SHA-256 `ea2ffa2c90cb571add1cab5d3b9f5b26ec2d44b30b0cadbfd621a852304903bb`.
- Authoritative complete source manifest: [`complete-source-hashes.json`](complete-source-hashes.json), SHA-256 `1d32ed58087d030a85d9e637c43bbb569f72ea4d102b02091c868aedb0a8edfd`.
- Correction-only review patch: [`correction-only.patch`](correction-only.patch), SHA-256 `0cf67fa1e66338e0f1116ba392c3485f115031fb02894bb2aee84104030695f4`.
- Correction-only source manifest: [`correction-source-hashes.json`](correction-source-hashes.json), SHA-256 `632deb5cf1ea909cb28c0c3d3cf219a70e9b8eb42bddb02fc1f99002481bce7b`.
- The correction patch has 8 paths and was created against the exact prior installation-review snapshot reconstructed from predecessor patch SHA `f2edd4658fcdba9716050d2a377ed941498300177656f3ff91a77e45fdd4b3e5` and predecessor manifest SHA `771081758b5747aeabd21f040ac98d75ecaea7c18db794883acefa9570955e75` in `review-packets/install-reliability-2026-10-29/`.
- [`final-candidate-verification.json`](final-candidate-verification.json) is the final live check: 17/17 raw and LF-normalized current source hashes match the complete manifest; all 8/8 correction paths match both; no mismatches. It records root, branch, HEAD, empty index, exact hashes, and the no-test-process scan.

## Patch reconstruction

[`reconstruction-results.json`](reconstruction-results.json) records successful isolated apply checks and applies for both patches (all four exit codes 0). The full patch reconstructs the 17-file source scope against base `189e786...`; the correction patch reconstructs its 8-file delta against the separately reconstructed prior snapshot. All 17 resulting files match after LF normalization. Raw bytes match 15/17; the two line-ending-only differences are `README.md` and `src/cli/index.ts`. No normalized content mismatch was found. Do not describe the correction patch as a direct patch against HEAD; the complete patch is the base-to-current packet.

The 17 complete-scope paths are: `README.md`, `desktop/README.md`, `desktop/package-lock.json`, `desktop/package.json`, `docs/INSTALLATION.md`, `package.json`, `scripts/Install-MaosIndustrial.ps1`, `scripts/New-MaosIndustrialInstallBundle.ps1`, `scripts/prepare-hooks.js`, `src/cli/doctor.ts`, `src/cli/index.ts`, `src/cli/repl.ts`, `src/utils/project-git-context.ts`, `tests/cli/doctor.test.ts`, `tests/cli/meta-provider-entrypoints.test.ts`, `tests/cli/project-git-context.test.ts`, and `tests/industrial/package-runtime-assets.test.ts`.

Correction-only paths: `docs/INSTALLATION.md`, `scripts/Install-MaosIndustrial.ps1`, `src/cli/doctor.ts`, `src/cli/index.ts`, `src/cli/repl.ts`, `src/utils/project-git-context.ts`, `tests/cli/project-git-context.test.ts`, and `tests/industrial/package-runtime-assets.test.ts`.

## Exact authoritative bundle

Only `artifacts-final6/` is the current bundle candidate:

- Bootstrap ZIP: `artifacts-final6/maos-industrial-bootstrap-windows-x64-install-final-ea2ffa2c-2026-10-29.zip`, 1,256,171 bytes, SHA-256 `e453b0b230d4919ec181d02fa5d8f0131231a2e5530005c7259d495ee88ed785`.
- npm package: `artifacts-final6/maosorch-0.3.0.tgz`, 1,224,098 bytes, SHA-256 `50b41f02d928404b10ef5f2a8c8f02118c8c24046db9da008356966ccc17f768`.
- Source identity embedded in the bundle: base commit `189e786...` plus complete delta `ea2ffa2c...`.
- [`bundle-contents-verification-final-6.json`](bundle-contents-verification-final-6.json) confirms 497 npm archive entries, all 19 required assets, 1 GUI JS and 1 CSS asset, 4 Python assets, 6 fixture/operator assets, verified application and desktop lockfiles, no forbidden paths or credential-pattern files, and no bundled Rust binary. Credential scan exit code 1 is the expected `rg` no-match result; the verifier permits 0/1 and reports zero matched files. [`npm-package-entries-final-6.txt`](npm-package-entries-final-6.txt) is the retained entry listing.
- The Rust executable is an external prerequisite. The candidate local engine build is 472,064 bytes, SHA-256 `3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77`; protocol health returned engine `maos-industrial-engine`, version `0.1.0`, protocol `1.0`, status `ok`, `unsafe_code=false`. [`candidate-rust-engine-artifact-manifest.json`](candidate-rust-engine-artifact-manifest.json) has SHA-256 `54a11c314bfdd4bb4aa033545ebc6ce0ecc14bdc9f483b5321a6906fb9420878` and explicitly marks itself candidate-only, unsigned, unapproved, without approved-manifest comparison or established redistribution approval. It proves file/build identity only.

## Install and runtime evidence

- **Cold-cache final6 install:** `clean-install-command-final-6.log`, `clean-install-final-6.log`, `clean-install-runner-final-6.log`, `installed-smoke-runner-final-6.log`, and `clean-install-smoke-results-final-6.json`. The exact final6 ZIP was installed to a fresh destination containing spaces after the runner asserted both isolated npm and Electron caches were empty. `npm ci` installed 77 application packages and 13 Electron dependencies; pinned Electron runtime `45.0.0` was downloaded. The install succeeded. The first combined post-install smoke had a harness-only failure because its synthetic config contained a UTF-8 BOM; the CLI correctly rejected it. The fixture was corrected without changing product source, then the installed CLI/doctor/Electron checks passed on that cold-installed tree. The fixture failure is retained in the runner log and is not counted as an application failure.
- **Warm-cache final6 install:** `warm2-cache-command-final-6.log`, `warm2-cache-runner-final-6.log`, `clean-install-warm2-final-6.log`, `clean-install-results-warm2-final-6.json`, and `installed-*-warm2-final-6.log`. The same exact ZIP hash was installed to a separate fresh destination with spaces; both caches were populated before invocation. It passed installation, generic CLI version, Industrial CLI help, actionable nonzero missing-config doctor, nested project refusing parent/redirect Git metadata, external-engine-missing diagnostic, and Electron runtime discovery/version (`45.0.0`). Projected 240+ character path was refused before destination files were written; tested projection was 281 characters, limit is 239.
- The exact installed generic REPL was run in the warm2 package against that synthetic selected child project with hostile Git overrides and `exit` input: exit 0, no parent/redirect branch, empty stderr. See `installed-repl-command-final-6.log` and sanitized `installed-repl-smoke-final-6.log`.
- [`installed-doctor-external-engine-final-6.log`](installed-doctor-external-engine-final-6.log) and its result/runner JSON record the same installed CLI with the separately built candidate engine placed at the documented project path; doctor reported engine compatibility and exited 0.
- GUI workflow was **not launched or exercised** in either final6 install. Electron executable discovery and `--version` are runtime checks, not GUI verification. No hosted or local-model inference occurred.

## Tests/builds and exact outcomes

- `vitest run tests/cli/project-git-context.test.ts tests/cli/doctor.test.ts tests/cli/meta-provider-entrypoints.test.ts tests/industrial/package-runtime-assets.test.ts`: 4 files, 23 tests passed, exit 0; [`focused-tests-install-capture-fix.log`](focused-tests-install-capture-fix.log). Includes parent-repository/child-project, normal repo, worktree, hostile Git environment, spaces, doctor readiness/credential and package installer checks.
- `npm run build`: exit 0; [`backend-gui-build.log`](backend-gui-build.log). Backend TypeScript and Python asset copy passed; Vite reports the existing 515.99 kB JS chunk warning.
- `npm run typecheck:gui`: exit 0; [`gui-typecheck.log`](gui-typecheck.log).
- `cargo build --release --locked --offline --manifest-path rust/Cargo.toml`: exit 0; [`engine-build-final.log`](engine-build-final.log). Rust source was unchanged by this installation correction. Toolchain is not pinned by the repository.
- Installer PowerShell AST parse: pass; final result in [`final-candidate-verification.json`](final-candidate-verification.json).
- [`final-task-process-scan.json`](final-task-process-scan.json) found no remaining process command lines tied to either the install root `M6-7c1a` or isolated candidate-source root `MAOS install correction validation 63ca169dc881484bb9c747ba5ab69add`. Temporary installs, caches, package files, and the external candidate engine remain in the task-owned temp root; no broad cleanup was performed.

## Superseded records and incident context

The records below remain intact and are **not the current bootstrap identity or standalone final6 install evidence**. The final5 npm tarball is byte-identical to the final6 tarball and was revalidated inside the final6 bootstrap; its earlier ZIP remains superseded.

- `artifacts/`: superseded package `a8bcb149c8a5c081611c1764ef1ba7e86a1d824a9b32d59c07a8f6cd65e83aeb` and ZIP `aac2afa0466a55dbf90d3500eaadeb67de044773377d024aa33f7adb1b465c80` (delta `021e5740...`). `artifacts-final/`: package `bc7ed56913a5afe3ae7bfe344004f2dee71c57371d3e4385b6bdb17fc55a7e0e` and ZIP `2090f13a70492e10df945a43863e00db7aa635440fbbdc205465bb69fbf0eb60` (delta `3d5a5114...`). The latter bundle used a PowerShell `ConvertFrom-Json` path that rejected npm lockfile package key `""`; the historical record says it was not installed.
- `artifacts-final2/`: package `2def02d94f806d591c552b9d9e993d18b949d9415ef8b441ebf7b5bd1c1632d9`, ZIP `9c55973910c8e4e6a04b0f91981decc8ff3346e91d16263d58e8fb5b80f7b0ad`.
- `artifacts-final3/`: same package hash as final2, ZIP `b2b04382e971c3ca41921519ce06d74ce1cc364ae42e1995faf574d6081011d8`.
- `artifacts-final4/`: package `edb1330aec5755ceaed504aa97154ad6d8d6693ca82ad9d8a1d28aa6a5d13e69`, ZIP `0db5cb952afc47421e54f9dfe8ce611364dbde5ebea6fe0785a71d51fd9a3307`.
- `artifacts-final5/`: package `50b41f02d928404b10ef5f2a8c8f02118c8c24046db9da008356966ccc17f768` (byte-identical to final6's npm tarball), but ZIP `0261e60a3a04f754720107f45da0f0a8d9a68331fd9c9d9704f32cf012978526` carries a superseded bootstrap identity. Final2–5 source delta IDs and/or installer/test harness differed; some attempts were incomplete or failed in harness setup. All are retained as history. Final6 alone binds the ZIP to full delta `ea2ffa2c...` and has separate cold- and warm-cache install evidence.
- `intermediate-build-superseded.json` and files under `historical/`: preserve earlier source/patch hashes and reconstruction results. They were superseded as later source fixes changed patch hashes and the PowerShell/.NET reconstruction helper was corrected. Do not rewrite those historical hashes.
- `review-packets/package-clean-install-2026-10-29/HANDOFF.md` describes the earlier `1dfcb0...` npm package and earlier Electron rehearsal, not the final6 bundle. That handoff did not retain a verifiable npm/Electron cache state; it is not combined with final6 cold/warm counts.
- `review-packets/install-reliability-2026-10-29/` is the exact parent snapshot for the 8-path correction patch, not the current full candidate packet.

The earlier handoff records an accidental `npm ci` in `C:\maos`; ignored `node_modules` contents from before that operation were not inventoried, so restoration cannot be claimed. It also records a possible Electron default user-data write under the user's `AppData\Roaming\Electron`; that location was not inspected or cleaned. This correction did not inspect private `.maos` state or alter either location. Prior failed browser attempts and their isolated task temp dirs remain described in the older handoff. The present task-owned `M6-7c1a` temp root is also retained, with no matching test processes.

## Supported installation boundary

The supported path is the Windows x64 bootstrap ZIP, not `npm install` from the registry and not a portable/self-contained installer. It installs the tested graph with the included lockfiles using `npm ci`, which runs dependency lifecycle scripts with the invoking user's permissions and inherited environment; scripts may access the network. The bootstrap separately runs the pinned Electron package's installer to download Electron. Lockfiles pin versions/integrity, not trust or sandbox behavior. Install in a dedicated least-privilege environment without unrelated secrets. Node/npm/PowerShell and network access are prerequisites. The Rust engine is external; no signing, approved publisher manifest, redistribution clearance, or publisher trust is established. Python remains an external runtime for documented features. Live Meta compatibility, GUI flow, production distribution, and submission readiness remain separate gates.
