# Authoritative installation-correction evidence index

Updated: 2026-10-29

## Current candidate identity

- Checkpoint commit: d526bfe95d334ad8a0c73a25db7611c1d0fc7417 (Handle npm stderr in bootstrap installer), parent 27dd1711f47e6278a1b84a6089e900dbe79f1459.
- Exact committed scope: scripts/Install-MaosIndustrial.ps1 and tests/industrial/package-runtime-assets.test.ts.
- The approved two-path manifest was source-correction-manifest.json, SHA-256 140c518a3d91153ce925e9cf9dcae8c87c716b83b8c6367e1703d5f26215ed25; staged path/blob equality and staged diff-check passed.
- Corrected bootstrap ZIP: corrected-bundle-validation-2026-10-29/candidate-artifacts/maos-industrial-bootstrap-windows-x64-commit-d526bfe-2026-10-29.zip; 1,256,200 bytes; SHA-256 a1bdd2bc00978b80cc4578a68de06bf426bf1cb5e6a9dbbd17b67125941b99fc.
- Embedded npm tarball: corrected-bundle-validation-2026-10-29/candidate-artifacts/maosorch-0.3.0.tgz; 1,224,049 bytes; SHA-256 3e4f8ee275194ae1f408768e6d798d11ba1cedd8f18c9ffaae2f745154312afb.
- The bundle manifest binds source commit d526bfe..., the committed source delta SHA-256 ba002a437f6cfcde26fa30bc41947193754a88dab31aa2a65a10c8904d44da10, and installer SHA-256 df5bfdca073dcb89bd6b8f4b5995522135e586748bcbd4887dcbee6a2cbb38a1.
- The command-scoped Git hook bypass was used only to prevent the known formatting hook from rewriting the reviewed bytes; lint and formatting were not claimed. This is a local mock-validation candidate. It is not published, signed, or a self-contained installer.

## Superseded bundle and preserved history

The prior bundle at review-packets/committed-install-gui-validation-2026-10-29/candidate-artifacts/maos-industrial-bootstrap-windows-x64-commit-27dd1711-2026-10-29.zip remains unchanged at 1,256,137 bytes with SHA-256 1f333348e92ea988e8fa9ef3be37dd362e69e6d1ab380d3e653f731240b8b61b. Mark it **SUPERSEDED for installation use** because it contains the installer with the npm-stderr defect. It was not overwritten or deleted. The earlier HANDOFF.md, logs, and bundle identity are historical evidence and have not been edited.

The original incident was a shipped-installer defect: with $ErrorActionPreference = 'Stop', PowerShell 7 treated npm.cmd ci notice text on stderr as a terminating NativeCommandError before the installer checked $LASTEXITCODE. The original npm process exit code was not captured; do not infer it. A previous retry suppressed NPM_CONFIG_UPDATE_NOTIFIER, hiding the stderr symptom but not fixing the installer.

Commit d526bfe... changes the shared Invoke-NpmCi helper to use Continue only around the native npm invocation, forward its stderr, capture $LASTEXITCODE immediately, restore the caller's preference/location, and throw with the actual nonzero code. The current cold-cache install did **not** set NPM_CONFIG_UPDATE_NOTIFIER=false: npm's update notice appeared on stderr and the shipped installer exited 0.

A separate early validation-wrapper invocation did not start the installer because it looked up pwsh.exe after narrowing PATH. The successful wrapper resolves required executables before narrowing its environment. This was a harness setup failure, separate from the real product defect above.

## Evidence map

- corrected-bundle-validation-2026-10-29/HANDOFF.md — current concise results and limits. The top-level HANDOFF.md remains the historical pre-checkpoint record.
- corrected-bundle-validation-2026-10-29/candidate-state-verification.json — repository/checkpoint, exact paths, old/new bundle hashes, index and process checks.
- corrected-bundle-validation-2026-10-29/bundle-identity-verification.json — source, tarball, bundle, and embedded-installer identity checks.
- corrected-bundle-validation-2026-10-29/npm-ci-result.json, npm-ci.stdout.log, npm-ci.stderr.log — cold-cache application install and raw npm notice.
- corrected-bundle-validation-2026-10-29/npm-build-result.json, npm-build.stdout.log, npm-build.stderr.log — isolated committed-source build.
- corrected-bundle-validation-2026-10-29/npm-pack-result.json, npm-pack.stdout.log, npm-pack.stderr.log, bundle-build-result.json, bundle-build.stdout.log, bundle-build.stderr.log — package and bootstrap build.
- corrected-bundle-validation-2026-10-29/clean-install-result.json, clean-install.stdout.log, clean-install.stderr.log — exact corrected ZIP installation from empty isolated npm/Electron caches; npm notice is unsuppressed.
- corrected-bundle-validation-2026-10-29/installed-help-results.json and installed-cli-help.*, installed-industrial-cli-help.*, installed-repl-help.* logs — packaged CLI, Industrial CLI, and REPL help.
- corrected-bundle-validation-2026-10-29/installed-runtime-checks.json and installed-doctor-missing-config.* logs — expected nonzero readiness result in a fresh empty project.
- corrected-bundle-validation-2026-10-29/electron-package-discovery-desktop.json and its raw logs — Electron package resolves from installed app\desktop; package/file version 45.0.0. The earlier app-root probe and its MODULE_NOT_FOUND output are retained as a harness working-directory correction.
- corrected-bundle-validation-2026-10-29/corrected-bundle-electron-journey-run.json, corrected-bundle-electron-journey.json, corrected-bundle-electron-journey.stdout.log, corrected-bundle-electron-journey.stderr.log — actual installed Electron/private-IPC rehearsal with loopback mock inference.
- powershell-helper-verification/runtime-results.json, powershell-helper-verification/PowerShell7-rerun.*.log, and powershell-helper-verification/WindowsPowerShell51-rerun.*.log — synthetic stderr/exit-code tests against the committed helper in PowerShell 7 and Windows PowerShell 5.1.
- HANDOFF.md, installer-regression.*.log, and bundle-immutability-hashes.json — preserved pre-checkpoint incident record and prior-candidate evidence.

## Runtime and package limits

- Install validation used Windows x64, PowerShell 7.6.9, Node.js 24.11.0, npm 11.6.1, and installed Electron 45.0.0. The independent helper test also passed under Windows PowerShell 5.1.26100.9711.
- Application and desktop dependencies were installed from the committed lockfiles with npm ci. Empty isolated npm and Electron caches were used. The installer explicitly fetched the pinned Electron runtime. npm emitted an update notice on stderr; no notifier-suppression setting was used.
- The successful install destination and temporary project/user-data locations contained spaces. The installed application tree contained 9,769 files (426,033,055 bytes). The test temp root remains because cleanup was not authorized through the available deletion mechanism; the process check found no process associated with that root.
- The bootstrap is a dependency installer, not a portable/self-contained Windows installer. It requires Windows x64, PowerShell 5.1+, Node.js 22.12+, npm 9+, network access to npm and the Electron binary host, and Node.js 20+ available for the desktop service process. Lifecycle scripts run with the invoking user's permissions and environment. The bootstrap does not install Node, Python, or the Rust engine.
- The Rust engine remains an external prerequisite. The rehearsal used candidate binary SHA-256 3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77, version 0.1.0/protocol 1.0. Its candidate manifest records a local Windows x64 build from source revision 189e786ff0431b02b95ca618bb4791a5ad7b0215, Cargo/rustc 1.95.0, without an exact toolchain pin. Hash identity and protocol health do not prove publisher trust; the engine has no publisher signature/attestation and no approved-manifest comparison.
- The candidate is unsigned and has no publisher attestation. No live Meta call, model download, terms acceptance, billing change, publication, or push occurred.
- A first Node module-resolution probe from app root returned MODULE_NOT_FOUND because Electron is installed under app\desktop; the same probe from the documented app\desktop root passed. Direct electron.exe --version exited 1 with no output and is not counted as a supported runtime check. The installed package API resolved the executable/version, and the actual Electron application launched and completed the private-IPC rehearsal successfully.




