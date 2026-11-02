# Focused review: pilot launcher cancellation correction

**Status: uncommitted correction; focused independent review pending. No new package is approved.**

## Baseline and scope

- Main checkpoint remains `bb871cb191184b5de1b790d42fc452a29f8f072e` on `main`; index empty.
- Correction worktree is detached at the same base commit, with changes limited to:
  - `scripts/Start-BasetenSyntheticPilot.ps1`
  - `scripts/Windows-ProcessTree.ps1`
  - `tests/industrial/baseten-pilot-process-tree.test.ts`
- No staging, commit, push, package rebuild, live inference, terms acceptance, billing change, key retrieval, or private `.maos` inspection occurred.
- The existing bundle was not changed: 1,265,219 bytes; SHA-256 `353a719f2708669b3f978ac6aa023f72323cb96027dc34ec2a21cbe8e7429b9c`.

## Correction

The PowerShell `Console.CancelKeyPress` ScriptBlock callback ran on the console signal thread without a PowerShell runspace and raised `There is no Runspace available`. Replace it with the small C# `MaosPilotConsoleCancellation` event handler in the existing process-tree helper. The C# handler sets `Cancel = true` and cancels the token; the launcher disposes it after the owned process tree has ended. The regression asserts the launcher uses that adapter and not the PowerShell ScriptBlock event handler.

The initial CSV tool failure was a test-harness mismatch, not a product defect. The mock hardcoded `synthetic/pilot.csv`, but the GUI uploads its user-selected CSV to `.maos/industrial/evidence/<generated-name>.csv` and passes that exact path. The test-only mock was changed to extract the selected path from the request task; the installed application then completed the agent call. No application source changed for that path mismatch.

## Installed application exercise

The actual Electron executable came from the installed bundle in a path containing spaces. The corrected PowerShell launcher/helper were loaded from the temporary correction worktree because the old bundle necessarily contains the pre-fix scripts. The Electron app, backend, project and user-data were isolated; the mock redirected the configured Baseten provider request to loopback. This is a correction smoke using the installed Electron runtime, not a clean install of a newly rebuilt corrected bundle.

Observed scenarios:

- Successful mock analysis: selected `pilot.csv`; deterministic local result stayed `CRITICAL` (3 rows, RMS 5.572 mm/s, peak vibration 8.30 mm/s, peak temperature 97.0 C, 2 warnings / 2 criticals). The agent request and single telemetry tool call completed; same-analyzer replay and report/audit linkage passed. UI identified requested and mock-reported model IDs separately and labelled generated explanation `UNVERIFIED`.
- Second launcher while first held the mutex: refused with `Another Baseten synthetic pilot launcher is already running in this Windows session.`; no second app started.
- Active console cancellation: mock held the next generation; Ctrl+C entered the launcher's cancellation catch path, output `Pilot cancelled; the task-owned application process tree was terminated and waited before releasing the launcher lock.`, and mock logged `client_closed_active_request`.
- Normal close: a separate idle installed app run closed via Alt+F4 and returned exit code 0.
- Cleanup: after cancellation and normal close, installed Electron count 0, pilot engine count 0, loopback mock process stopped, and the named pilot mutex was immediately acquirable.
- Key handling: only synthetic values were used, set in the launching PowerShell process environment. Mock logs record `authorizationPresent: true`, not a value. The synthetic markers were absent from retained text/log files. The key was not passed in process arguments or printed. No hosted request was made. The app showed only session-token presence, not the token. Browser storage was not inspected in this slice.

The terminal tool reports every nonzero PowerShell exit as `1` (confirmed with simple PowerShell exits `23` and `130`). The active cancellation catch path was visibly taken, but this tool did not preserve the native final exit value `130` independently.

## Validation

- `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/baseten-pilot-process-tree.test.ts` — **8 passed, 0 skipped**, exit 0. It exercises the helper under installed PowerShell 7.6.9 and Windows PowerShell 5.1.26100.9711 where discovered; actual console Ctrl+C was additionally exercised in the installed Electron pilot run.
- `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/meta-model-api-contract.test.ts` with `MAOS_TEST_ENGINE_PATH` set to the established external engine — **28 passed, 2 failed, 0 skipped**, exit 1. Both failures are the existing endpoint-error expectation mismatch (`PROJECT_CONFIG_INVALID` returned versus expected `MODEL_ENDPOINT_BLOCKED`) in the no-opt-in Meta/remote endpoint tests. The tests stop at that assertion, before their following outbound-count assertions; this run does not count those two zero-request checks as passed. No provider source was changed in this correction.
- `git diff --check` — passed; Git emitted only Windows line-ending normalization warnings.
- No backend or GUI build was run because only PowerShell launcher/helper and the focused test changed.

External engine used by the provider regression fixture: 472,064 bytes, SHA-256 `3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2`, Authenticode `NotSigned`. A retained identity check reports v0.1.0 / protocol 1.0 and the current binary has the same hash. Source revision/build inputs and an approved artifact manifest are unavailable; the engine remains external, unsigned and unapproved.

## Patch provenance

- Base: `bb871cb191184b5de1b790d42fc452a29f8f072e`.
- Correction patch: `correction-only.patch`, SHA-256 `486b354bd53d2e80a4ba62350a83b9f58848a5884a73d185913d337e49eb1ba3`.
- Source manifest: `source-hashes.json`, SHA-256 `2031d8739b192893e841af97672ce1d14ce3397bdb46c0afc0625bd8cabb3461`.
- Clean-base apply succeeded in a separate detached worktree at the base commit. All three scoped files matched the current candidate after LF normalization. Two Windows working copies differ in raw bytes solely because the candidate has CRLF and the reconstructed worktree has LF; the helper file matches raw bytes. Exact per-file results are in `reconstruction-verification.json`.
- Raw validation logs and sanitized mock events are under `validation/`.

## Remaining gates

1. Independent review of this exact three-file correction, followed by owner-authorized checkpoint/package replacement. The existing bundle still contains the defective PowerShell callback and must not be used for a real hosted pilot.
2. No live inference was made. Owner-reported Baseten credits do not establish current Model API coverage/expiry or a hard no-overage guarantee. Applicable model-use terms for an industrial safety demonstration also remain unresolved; event eligibility is separate.
3. The external engine's source/build provenance and publisher trust remain unverified.

Do not infer live Meta/Baseten readiness, release readiness, licensing clearance, or submission eligibility from this mock rehearsal.