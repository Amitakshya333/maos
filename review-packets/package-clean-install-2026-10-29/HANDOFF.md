# Clean package and install handoff — 2026-10-29

## Result

The npm package was built from the clean committed source and installed outside the repository. Its packaged CLI workflow and the installed Electron/private-IPC mock journey passed. This is a local candidate validation only; it does not establish live Meta compatibility, a signed distribution, or submission readiness.

## Candidate

- Source: `main` at `189e786ff0431b02b95ca618bb4791a5ad7b0215`.
- Archive: `candidate/maosorch-0.3.0-commit-189e786ff0431b02b95ca618bb4791a5ad7b0215.tgz`.
- Type/size: npm `.tgz`, 1,217,278 bytes.
- SHA-256: `1dfcb0edd2de9f17b1a8bc499b223b03a821ace69585dea44073b71775097aa6`.
- Build environment: Node `v24.11.0`, npm `11.6.1`, Vite `7.3.6`; Electron `45.0.0`, Playwright `1.64.1` for the rehearsal.
- The isolated source checkout was detached at the exact commit, with clean tracked tree and empty index. The repository remained on `main` at the same HEAD with an empty index.

## Build and contents

`npm ci --no-audit --no-fund --include=dev`, `cargo build --release --locked --offline --manifest-path rust/Cargo.toml`, and `npm run build` all exited 0 in the isolated exact-commit checkout. Vite emitted a non-blocking 515.99 kB JavaScript chunk warning.

The actual archive and installed tree each contained 491 files. Path sets and per-file SHA-256 values matched. Required backend, GUI, Electron main/preload, Industrial CLI/REPL, fixtures, profile/configuration, scripts, and Python runtime assets were present. Secret-pattern scan hits: 0. Review-packet, private project state, `node_modules`, Rust build output, `.env` and engine binary entries: 0. See `package-contents.txt` and `package-install-content-verification.txt`.

The exact `npm pack` invocation was not retained in the earlier command log; the resulting archive identity, size, hash, contents, and install-tree equality were verified directly. The tarball does not contain a package lockfile; its dependencies use semver ranges. Validation installed it into a clean environment whose dependencies had first been installed from the committed lockfile. A general consumer install can resolve newer compatible dependency versions than this validation environment.

## Installed CLI

The tarball was installed under a temporary prefix outside `C:\maos`; the installed entrypoints were used.

- `maos-industrial help`: passed.
- `maos-industrial` REPL `help` and `exit`: passed; output states that analysis needs a configured credential-free loopback provider.
- `maos init` in a temporary project: passed and created the selected local-provider setup.
- Missing configuration and missing credential diagnostics were actionable. `maos doctor` returned exit code 0 in both diagnostic cases even while displaying a configuration/credential failure; this behavior is retained as a CLI status limitation.
- Without the Rust engine, installed `maos-industrial run` failed before execution with exit 1 and an actionable missing-executable/build/copy message. The engine is **not bundled**. See `installed-cli-missing-engine-output.txt`.
- After supplying the separate locally built engine to the temporary project, the deterministic installed-package run completed as `judged-run-1793215649111-7ad1d4`: manifest completed, engineering verdict `FAIL`, audit verification `valid=true`, DOCX and audit export present. The installed `verify` command returned `valid=true` for the same run. See `installed-cli-run-output.txt` and `installed-cli-verify-output.txt`.

The external engine was built from this exact source checkout: version `0.1.0`, protocol `1.0`, captured binary SHA-256 `fb874225cae45d9cc4629f3cf0b038bf2680d9f36d56b6cf968b41775dfb255b`. No approved artifact-manifest comparison or publisher signature exists. Supplying this locally built executable proves protocol compatibility for this rehearsal, not a supported evaluator distribution or engine provenance.

## Installed Electron journey

Only attempt 12 is counted as a completed rehearsal. It launched `desktop/main.cjs` from the installed package, used the real Electron launcher/private preload IPC session handoff, a separate loopback mock inference server, an isolated project/user-data directory, and a held-out synthetic CSV. No live provider request was made.

The journey passed: select CSV → mock failure and honest error → cancellation → retry and evidence → reject a report → reload/resume pending review → restart Electron and verify old listeners stopped/new session issued → refuse approval after source mutation → analyze again → approve → accept DOCX → authenticated download and hash check → same-run audit verification. The final run was `judged-run-agent-telemetry-1793219853616-17ca1a2d`; analysis ID was `telemetry-1793219853616-17ca1a2d`. The manifest kept execution status `completed` and run verdict `FAIL` separate from engineering verdict `CRITICAL`. Downloaded DOCX hash matched the accepted manifest and audit linkage; audit chain verification was valid.

Auth/privacy checks: missing and invalid session `401`; wrong project `400`; wrong origin `403`; unauthenticated artifact download `401`. Tokens were absent from URLs, persistent browser storage, cookies, and captured Electron logs. Electron, service, UI and mock processes all stopped after the successful run. See `electron-attempt-12-evidence-sanitized.json`, `electron-attempt-12-sanitized-output.txt`, and `electron-attempt-12-command-and-exit.txt`.


Evidence-label note: the attempt 12 JSON contains a legacy `engineeringVerdict` field populated from `manifest.verdict` (`FAIL`). A separate passing assertion checked `manifest.details.engineeringVerdict === 'CRITICAL'`. Read that legacy field as `runVerdict`; the engineering verdict was CRITICAL. This label defect is in the temporary evidence harness only, not packaged source.
Package removal then exited 0: the installed package and `maos-industrial` shim were absent; temporary `package.json` and lockfile hashes were unchanged. See `package-uninstall-command-and-exit.txt` and `package-uninstall-output.txt`.

## Incomplete attempts and setup incidents

- Attempts 9 and 10 reached pending review, then were interrupted because the temporary Playwright harness awaited all request-header promises indefinitely. Attempt 11 reached the stale-source refusal but failed in the harness because a file-input locator remained bound to the pre-restart page. The temporary harness was adjusted only under the validation temp root; no production source was changed. Attempt 12 passed the full journey. These attempts are not additional completed rehearsals.
- Ctrl+C ended attempts 9 and 10 before their `finally` cleanup. Their isolated temp work directories remain under the task-specific OS temp root; no test-owned processes remain. A recursive removal request for those directories was blocked by the command policy, so they were left intact. The successful attempt 12 cleaned its own project directory.
- The first `npm ci` was accidentally run from `C:\maos`; it installed 252 locked packages into ignored `C:\maos\node_modules`. Prior ignored contents were not inventoried, so their preservation cannot be confirmed. No tracked source, manifest, lockfile, or index entry was changed by that setup incident. Subsequent build and package work used the isolated checkout.
- An earlier invalid Electron attempt used Electron's default user-data location rather than the isolated temp profile. It may have written Electron state under the user's default `AppData\Roaming\Electron` directory. That profile was not inspected or cleaned. All later valid attempts specified and verified `--user-data-dir` beneath the test temp root.
- An early doctor run discovered the parent Git checkout from a temporary project and reported its status; no source contents were read or written. Later test commands set `GIT_CEILING_DIRECTORIES` to the isolated validation boundary.

## Remaining gates

1. Define and verify an evaluator-supported Rust-engine distribution, including integrity-manifest and signing status; do not imply the executable is bundled.
2. Decide whether ordinary consumer installs need a committed/resolved dependency lock or another reproducible dependency policy.
3. Improve or explicitly accept the current `doctor` zero-exit diagnostic behavior.
4. If required, exercise packaged Python-backed features with the supported Python runtime; this milestone verified asset inclusion and the primary CLI/Electron path, not every optional Python engine.
5. Live Meta inference, active-credit/no-overage enforcement, licensing applicability, code signing, external submission eligibility and distribution remain unverified or unauthorized.

Evidence files in this directory are sanitized and the package remains local. No commit, push, publication, model installation, hosted inference, terms acceptance, billing change, or submission occurred.

