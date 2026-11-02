# Current-source desktop validation handoff

Run evidence timestamp: `2026-10-28T19:02:17.417Z` (from the Electron evidence file).

## Checkpoint

- Repository: `C:\maos`; branch: `main`.
- Base: `239a0042b08a3960d3c89f890f01ab194ff82f1f`.
- Checkpoint: `189e786ff0431b02b95ca618bb4791a5ad7b0215` — `Enforce Meta provider and Industrial agent limits`.
- The authorized scope manifest is `review-packets/day2-meta-review-corrections-2026-10-28/complete-post-checkpoint-source-hashes.json`; SHA-256 `b9bc4c605c07bdcf25e83de6a781a18095b523bd04866906099a02d2188dd6bc`.
- The commit contains exactly the manifest's 27 paths. Current committed blobs and current worktree content match all 27 LF-normalized manifest hashes. Index is empty. No package manifest or lockfile changed.
- The commit used the authorized command-scoped hooks override because the known hook reformats files. Hooks were intentionally bypassed; lint and formatting were not claimed or run. No persistent hook configuration changed.

## Tooling and setup

- Inspected the existing desktop package manifest and lockfile. Installed their pinned `electron@45.0.0` and `playwright@1.64.1` in a temporary tools directory with `npm ci`; no unpinned `npx` fallback was used.
- Installed committed source dependencies with `npm ci` in an isolated temporary checkout at the checkpoint. Node `v24.11.0`, npm `11.6.1`.
- Installed the pinned Electron runtime with `install-electron.cmd --no`. Playwright controlled Electron's bundled Chromium; no separate browser download was needed.
- Built the committed Rust engine offline with `cargo build --release --locked --offline --manifest-path rust/Cargo.toml`; Cargo `1.95.0`, engine `0.1.0`, protocol `1.0`. Captured binary SHA-256: `26d899fa7c3404457aad5931240def6e8d468252fa630dd8def22696b451422f`. Comparison with an approved integrity manifest was not performed.
- The source checkout and app profile were isolated under a temporary directory; no private `.maos` state or credentials were copied.

## Validation results

- Focused suite: 9 files, 123 tests passed, 0 skipped. The first run, before the Rust prerequisite existed in the temporary checkout, had 117 passing and 6 failing tests; all six failures reported the missing engine. After the offline engine build, the same command passed 123/123. This initial failure was test setup, not a source correction.
- `npm run build:backend`: passed.
- `npm run typecheck:gui`: passed.
- `npm run build:gui`: passed. Vite emitted the existing 515.99 kB chunk-size warning.
- Actual visible Electron/Playwright rehearsal: passed using the current committed source, `desktop/main.cjs` launcher, private preload IPC session handoff, and loopback synthetic mock inference only. No live Meta or other hosted inference was called.
- Full scenario evidence is in `electron-rehearsal.json`; sanitized process output and exact commands/exit statuses are in the adjacent `*-output.txt` and `*-command-and-exit.txt` files.

## Desktop journey exercised

- Selected the held-out synthetic CSV `shift-end-pressure-ripple.csv` through the GUI. The independent oracle was 3 rows, peak vibration `8.7`, peak temperature `101`, verdict `CRITICAL`.
- Verified configured/requested model `mock-configured-model-v1` remained distinct from mock provider-reported model `mock-returned-model-v1`.
- Mock inference failure returned HTTP 502 without a successful result; cancellation while inference was pending did not appear successful; a subsequent retry completed.
- Verified replay numeric evidence separately from `UNVERIFIED` model explanation.
- Rejected one report and confirmed it produced no deliverable. Reloaded the GUI while another review was pending, resumed it, changed the selected source, and confirmed stale approval was refused with no artifact.
- Approved the final report. Execution completed while engineering verdict remained `FAIL` (`CRITICAL` underlying findings). Downloaded DOCX SHA-256 matched the accepted manifest hash: `7dd1b2031d08ca16080626f807aa69d31380ce34a90af88d78a6f11943191646`.
- Audit export verified, linking the same run `judged-run-agent-telemetry-1793214135375-63095596`, analysis `telemetry-1793214135375-63095596`, receipt, and deliverable hash.
- Missing/invalid session, wrong project, wrong origin, and unauthenticated download were rejected with `401`, `401`, `400`, `403`, and `401` respectively.
- No token appeared in URLs, persistent browser storage, cookies, event URL, or captured Electron logs. Evidence records Electron, service, UI, and mock process cleanup as successful.

## Known limits and next step

- Nonblocking coverage gap: mutating-tool authorization and hard generation limits have focused tests, but the mixed allowed/disallowed call matrix is not exhaustive.
- Do not describe objective replanning as globally disabled: `maxTaskRetries=0` controls task retries, not objective coordination. The bounded Industrial pilot calls Core `runAgent` directly from `analysis-agent-service.ts` and does not invoke the objective coordinator.
- The captured Rust hash is not proof of trusted provenance; no approved manifest comparison or publisher signature was established.
- This validates current-source desktop behavior only. No package was created or clean-installed. The next release step is a separate fresh-package contents and clean-install gate against this committed source.
- Live-model/Meta, licensing, signed-installer, packaging, and submission readiness remain unverified or blocked by their existing gates.

## Retained evidence files

- `electron-rehearsal.json`, `electron-rehearsal-output.txt`, `electron-rehearsal-command-and-exit.txt`
- `focused-tests-output.txt`, `focused-tests-command-and-exit.txt`
- `focused-tests-engine-prerequisite-failure-output.txt`, matching command/exit record
- `rust-engine-build-offline-output.txt`, matching command/exit record
- `build-backend-output.txt`, `typecheck-gui-output.txt`, `build-gui-output.txt`, each with command/exit record
- `desktop-tools-npm-ci-output.txt`, `source-npm-ci-output.txt`, and Electron runtime installation record
