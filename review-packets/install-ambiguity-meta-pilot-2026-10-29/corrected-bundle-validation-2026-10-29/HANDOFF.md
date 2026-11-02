# Corrected installer checkpoint and clean-install handoff

Date: 2026-10-29  
Repository: C:\maos, branch main  
Checkpoint: d526bfe95d334ad8a0c73a25db7611c1d0fc7417  
Parent: 27dd1711f47e6278a1b84a6089e900dbe79f1459  
Subject: Handle npm stderr in bootstrap installer

## Result

The two-file installer correction was committed exactly as authorized. The approved manifest hash was 140c518a3d91153ce925e9cf9dcae8c87c716b83b8c6367e1703d5f26215ed25. Staged path/blob equality and staged diff-check passed. The command-scoped hook bypass was used only to prevent formatting from changing reviewed bytes; lint/format were not claimed. The index is empty, and the commit contains only:

- scripts/Install-MaosIndustrial.ps1
- tests/industrial/package-runtime-assets.test.ts

The initial PowerShell/npm-notice failure was a real defect in the shipped installer. The former helper ran npm.cmd ci while $ErrorActionPreference was Stop; PowerShell 7 converted npm's stderr notice into a terminating error before the script could check $LASTEXITCODE. The original npm exit code was never captured. A prior retry hid the notice with NPM_CONFIG_UPDATE_NOTIFIER=false, which masked rather than fixed the defect.

The committed helper scopes Continue to the native npm call, leaves stderr visible, captures and honors $LASTEXITCODE, and restores the caller's error preference and working directory on success or failure. The separate first validation-wrapper attempt failed before installer launch because the wrapper narrowed PATH before resolving pwsh.exe; the successful wrapper resolves executables first. That wrapper failure was not a product result.

## PowerShell helper behavior

verify-native-npm-helper.ps1 parsed the committed production installer and invoked its actual Invoke-NpmCi function against a disposable fake npm.cmd.

- PowerShell 7.6.9: exit 0. Synthetic stderr with npm exit 0 was accepted; synthetic stderr with npm exit 23 failed with exit 23; error preference and working directory were restored after both.
- Windows PowerShell 5.1.26100.9711: same three assertions passed, exit 0.
- The test emitted the synthetic stderr in both cases. Results are in ../powershell-helper-verification/runtime-results.json and raw rerun logs.

## Corrected bundle and cold-cache install

The new local bootstrap candidate was built from isolated committed source d526bfe... after npm ci and npm run build passed.

- ZIP: candidate-artifacts/maos-industrial-bootstrap-windows-x64-commit-d526bfe-2026-10-29.zip
- ZIP size/hash: 1,256,200 bytes / a1bdd2bc00978b80cc4578a68de06bf426bf1cb5e6a9dbbd17b67125941b99fc
- npm tarball: 1,224,049 bytes / 3e4f8ee275194ae1f408768e6d798d11ba1cedd8f18c9ffaae2f745154312afb
- Commit delta: ba002a437f6cfcde26fa30bc41947193754a88dab31aa2a65a10c8904d44da10
- Embedded installer hash matches the committed production file and bundle manifest: df5bfdca073dcb89bd6b8f4b5995522135e586748bcbd4887dcbee6a2cbb38a1.

The exact new ZIP was extracted and installed into a fresh destination with spaces, using empty isolated npm and Electron caches. Runtime versions were PowerShell 7.6.9, Node 24.11.0, and npm 11.6.1. NPM_CONFIG_UPDATE_NOTIFIER was unset. npm emitted its update notice on stderr; install exit code was 0. The install used the lockfiles, ran dependency lifecycle scripts, and fetched Electron 45.0.0 into the application. The installed tree contains 9,769 files / 426,033,055 bytes.

The previous ZIP remains unchanged and is **SUPERSEDED for installation use**: 1,256,137 bytes, SHA-256 1f333348e92ea988e8fa9ef3be37dd362e69e6d1ab380d3e653f731240b8b61b. The prior handoff and failed-install logs are retained as historical evidence.

## Installed checks

All paths were under fresh isolated task temp locations with spaces; no source checkout or private project state was used.

- maos --help: exit 0.
- maos-industrial --help: exit 0.
- maos repl --help: exit 0. The interactive REPL itself was not opened.
- maos doctor in a fresh empty project: exit 1 with required Config failure and actionable maos init message; no inference call.
- Electron package discovery from installed app\desktop: exit 0, resolved the installed electron.exe; package and file version are 45.0.0. An initial Node resolution attempt from app root failed with MODULE_NOT_FOUND because Electron is nested under desktop; rerunning from the documented app\desktop root passed. A direct electron.exe --version probe exited 1 without output and is not counted as a supported health check.
- Reused the pinned Playwright 1.64.1 test harness from a separate prior test-tools directory; it launched the exact installed Electron 45.0.0 and used loopback mock inference only. The run exited 0.

The GUI rehearsal passed selected synthetic CSV analysis, mock failure (HTTP 502) without accepted success, cancellation while inference was pending, retry, rejection, stale-source approval refusal, and approval followed by DOCX download with matching content hash and same-run verified audit linkage. The synthetic oracle preserved CRITICAL readings; the final judged-run engineering verdict was FAIL while execution succeeded. Requested and provider-reported mock model identities were displayed separately. Session/project/origin rejection checks returned 401/400/403 as expected. The session token was absent from URL, persistent storage, cookies, and captured Electron logs. Reload/resume after service restart passed and all test child processes reported stopped.

## Exact outputs and limitations

See EVIDENCE_INDEX.md in the parent packet for the evidence map and immutable old/new bundle identities. Raw commands/results are in the .stdout.log, .stderr.log, and *-result.json files in this directory.

- No live Meta inference or model download occurred. The private-IPC rehearsal is mock-only and does not prove live provider compatibility.
- The Rust engine was supplied externally for the GUI test. Its candidate hash is 3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77; protocol health passed, but publisher trust is not established.
- The bootstrap is not self-contained: it needs Windows x64, PowerShell 5.1+, Node.js 22.12+, npm 9+, registry/Electron-host network access, plus Node.js 20+ for the service child. It does not bundle Node.js, Python, Rust, signatures, or publisher attestation. Lifecycle scripts execute with the installer's user permissions/environment.
- The test install and its temp caches/user-data remain in the temporary root because broad/deletion-policy bypass cleanup was not performed. No process associated with that root remained. The managed committed-source worktree was clean; its archive request was refused because the app identified it as the task's primary checkout, so it also remains in place.

No source change was made after the checkpoint. The repository index is empty. This is local installation evidence only, not a release approval.


