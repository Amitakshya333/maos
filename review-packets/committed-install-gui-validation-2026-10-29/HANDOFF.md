# Committed-source bootstrap and installed Electron validation

Date: 2026-10-29 (Asia/Kolkata)

## Checkpoint

- Repository: `C:\maos`, branch `main`.
- Commit: `27dd1711f47e6278a1b84a6089e900dbe79f1459` — `Harden installation and project Git discovery`.
- Parent: `189e786ff0431b02b95ca618bb4791a5ad7b0215`.
- Exactly 17 approved paths were committed. The sole post-review exception was removal of the one extra final LF in `src/cli/doctor.ts`; its original/corrected hashes are in `install-git-context-correction-2026-10-29/checkpoint-eof-whitespace-2026-10-29/whitespace-exception-record.json`.
- Corrected candidate source manifest SHA-256: `1d0590a93567b6ebc7dc51dc34c00923e40fd874eae70ae1f741dadebe08c5ed`.
- Committed source manifest SHA-256: `8d6df844f60e18b3a820cd73b01c2c40bcacda514b9a9c46336cea57fcd3fb11`.
- Commit delta patch SHA-256: `d3b267f3e1032eb26b1e814876d4ab17ccd74df63bee62bab4ab27f6e7180622`.
- Final check: branch/HEAD match; index empty; all 17 scoped working files match the commit. No further source changes were made. Hooks were bypassed with the authorized command-scoped override to preserve reviewed bytes; no lint or formatting pass is claimed.

The original reviewed packet was preserved. Its original patch and manifest hashes remain historical evidence, not rewritten records.

## New local bundle

- Built from a detached, isolated clone of commit `27dd1711f47e6278a1b84a6089e900dbe79f1459`; no source-checkout `node_modules`, `.maos` state, credentials, or unrelated dirty files were copied.
- Windows x64 bootstrap ZIP: `candidate-artifacts/maos-industrial-bootstrap-windows-x64-commit-27dd1711-2026-10-29.zip`, 1,256,137 bytes, SHA-256 `1f333348e92ea988e8fa9ef3be37dd362e69e6d1ab380d3e653f731240b8b61b`.
- Included npm archive: `candidate-artifacts/maosorch-0.3.0.tgz`, 1,223,971 bytes, SHA-256 `b4fb03a58b6f13fdbac1f97fa7c48bdb94cb9ee37709fef6cede40bec5f9a778`.
- The ZIP filename and bundle manifest bind the candidate to the commit and delta hash. It is a lockfile bootstrap, not a portable or self-contained installer.
- The package-content check found 497 npm entries; all 19 required backend/GUI/Electron/CLI/fixture/Python/script assets were present. One GUI JS and one CSS bundle were present. Secret-pattern hits: 0; forbidden private-state/review-packet/`node_modules` paths: 0. Four Python assets and six Industrial fixture assets are included. The Rust executable is not included.
- Build environment: Node `v24.11.0`, npm `11.6.1`, Vite `7.3.6`, Windows x64. `npm ci --no-audit --no-fund --include=dev`, `npm run build`, `npm run typecheck:gui`, focused tests, `npm pack --ignore-scripts`, and the bundle builder exited 0. Build emitted the existing nonblocking 515.99 kB Vite chunk warning.

Content verification: `bundle-contents-verification-committed.json`. Bundle identity: `bundle-identity.json`.

## Clean install

The exact ZIP was expanded and installed in a fresh destination containing spaces, outside the repository: `%LOCALAPPDATA%\Temp\M27-7d2e\installed app retry with spaces`. The app and Electron caches were empty before the successful attempt. The bootstrap installed 77 application packages and 13 desktop packages from the bundled lockfiles. The installation tree is 426,032,912 bytes across 9,769 files. No repository `node_modules` was used.

- Installed CLI: `node dist/cli/index.js --version` returned `0.3.0` (exit 0); installed Industrial CLI `--help` exited 0.
- Installed `doctor` on a fresh project exited 1 and gave an actionable `maos.config.json not found … Run: maos init` diagnostic.
- Electron resolved from the installed app as `45.0.0`; its executable is 249,797,632 bytes, SHA-256 `8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59`. This was independently checked via the pinned package, PE version fields and `node desktop/node_modules/electron/cli.js --version` (`v45.0.0`).
- The package requires Windows x64, Node `>=22.12.0`, npm `>=9`, PowerShell `5.1+`, and `tar.exe`. Installation runs `npm ci` lifecycle scripts with the invoking account's permissions and network access, then explicitly obtains the pinned Electron runtime. Isolated paths, npm configs/caches and user data were used, and secret-like environment variable names were removed from the test process; this is not an OS sandbox.
- The installer checks projected paths and refuses lengths `>=240` before writing. A path containing spaces passed; the path-length boundary was not re-exercised in this run.

The first install attempt stopped after app dependencies because PowerShell treated npm's nonfatal `npm notice` stderr as a terminating error. It left a partial task-owned destination. The second, fresh destination above succeeded after disabling npm's update notice; the package itself was unchanged. Both attempts are logged.

## External Rust prerequisite

The candidate engine was supplied separately to the test project; it was not added to the ZIP or installed product. The installed bridge verified engine `0.1.0`, protocol `1.0`, and binary SHA-256 `3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77`. Its retained local-build manifest names source commit `189e786ff0431b02b95ca618bb4791a5ad7b0215`; `git diff 189e786..27dd171 -- rust` returned 0, so the Rust source is unchanged in this checkpoint.

The candidate manifest explicitly says `approved: false`. No approved-artifact comparison, publisher signature/attestation, or redistribution approval exists. This validates protocol compatibility for this rehearsal, not engine trust or a supported consumer distribution.

## Installed Electron/private-IPC mock journey

One complete rehearsal is counted: `electron-installed-journey-attempt-3.json` (exit 0). It launched `desktop/main.cjs` from the installed app with the real private preload/launcher session handoff, a visible Electron window controlled through pinned Playwright `1.64.1`, isolated user data, a temporary project with spaces, held-out synthetic CSV and a loopback mock inference server. The test-only harness was copied from the exact committed source; no product source changed.

- Mock inference only; 8 requests. No live Meta or other hosted model call.
- Mock 502 failure and client cancellation did not produce accepted success. Retry returned the held-out oracle: 3 rows, 8.7 mm/s peak vibration, 101 C peak temperature, `CRITICAL`.
- GUI displayed configured/requested `mock-configured-model-v1` separately from returned `mock-returned-model-v1`, replay confidence, and unverified model prose.
- Rejection created no artifact. Page reload restored and resumed the pending review. After closing and relaunching Electron, the old UI/service listeners were down, a new private-IPC-issued session was observed, the old token received 401, and the pending approval was available in the authoritative Approval Queue and resumed there.
- The Cockpit-specific “Saved analysis review” marker did not automatically reappear after full process restart; the pending review was recoverable from Approval Queue. The same-process reload path did show the saved-review marker.
- Changed-source approval returned stale refusal; no artifact was exposed for that run. Final approval generated and accepted a DOCX. Download SHA-256 and manifest artifact SHA-256 both equal `563f580c92e3b093a976e5a3519008e6887561e16d88642bdf07b7d63600f58e`.
- Final logical run: `judged-run-agent-telemetry-1793266342354-62d8b6e2`; analysis ID `telemetry-1793266342354-62d8b6e2`. Completion audit references the same run, analysis, agent run and receipt; audit-chain verification was valid.
- Execution status was `completed`; judged-run verdict was `FAIL`; engineering verdict was `CRITICAL`. These were asserted separately. The raw harness retains a legacy field named `engineeringVerdict` that contains the judged-run `FAIL`; `electron-installed-journey-scenario-summary.json` corrects that interpretation explicitly.
- Auth checks: missing/invalid session 401, wrong project 400, wrong origin 403, unauthenticated download 401. Current and prior session tokens were not found in URLs, browser storage, cookies or captured Electron logs.
- Electron, service, UI and mock processes stopped. The synthetic project and isolated user-data directory were removed by the harness; a task-process scan found no Electron/Node test process.

Two earlier Electron attempts stopped at the Cockpit saved-review marker assertion after process restart; neither is counted as a completed rehearsal. They had already exercised the mock failure/cancel/rejection/retry path. The final run verifies resume through the Approval Queue instead of claiming the missing Cockpit marker.

## Limitations and remaining gates

- No installer removal/uninstall scenario was run.
- The bootstrap depends on an installed Node/npm runtime and network access for pinned npm packages and Electron. Dependency scripts are not sandboxed.
- Rust remains a separately supplied, unsigned, unapproved candidate prerequisite.
- No live Meta inference, hosted billing check, licensing clearance, signing, publication, submission or evaluator eligibility check occurred. Mock execution is not live Meta compatibility.
- The earlier `package-clean-install-2026-10-29/HANDOFF.md` incidents remain unchanged: an accidental `npm ci` ran in `C:\maos` and installed 252 packages into ignored `node_modules` while prior ignored contents were unknown; an earlier invalid Electron run may have written to the default Electron user-data location. Those locations were not inspected or cleaned in this task.
- Task-owned temporary build/install/tooling workspaces remain under `%LOCALAPPDATA%\Temp\M27-7d2e`; they were not recursively removed. No test-owned process remains.

No push, publication, signing, model installation, hosted call, terms acceptance, payment change or submission occurred.
