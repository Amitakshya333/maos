# Installed launcher cancellation rehearsal — attempt 8

Handoff written 2026-10-30. Execution evidence below was captured 2026-10-29.

## Candidate and checkpoint

- Repository: C:\maos, branch main
- Source commit: f201cfe38bf3a741b5d8c6b37793cc3c112c43a9
- Parent: bb871cb191184b5de1b790d42fc452a29f8f072e
- Commit subject: Fix pilot cancellation callback lifetime
- The commit contains exactly the four approved paths. Committed blobs and LF-normalized source hashes were verified against the reviewed manifest; the main index is empty.
- Reviewed patch SHA-256: d3eb82e46a242ff63aae6323c84820a3a1ff000fdd990bf7e23717b103c8b059
- Reviewed manifest SHA-256: 324baa7ee8869ecf2d74925d59c449f5df2628e866d887454cbde16af34e024d

## Installed candidate

- ZIP: candidate-artifacts-f201cfe/maos-industrial-bootstrap-windows-x64-commit-f201cfe-2026-10-29.zip
- ZIP size: 1,265,742 bytes
- ZIP SHA-256: 8ce5da16d81a788fd8c8596c445c95df8227aa551595171d95da75817273572c
- Embedded npm tarball size: 1,233,574 bytes; SHA-256: 2b9992e47e75cdfb91a23144d3c7460ae4fade01cddcbeddd56c7eb5d92f783f
- The exact ZIP was installed to a fresh isolated path containing spaces:
  C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\MAOS f201cfe installed ctrl-c rehearsal 6f51863fdb344e62a8147099926ab8b0\installed application
- The installed scripts match the committed source:
  - app/scripts/Start-BasetenSyntheticPilot.ps1: 7,060 bytes; SHA-256 87f6f8e44e595e36e93ffb8155631d7f7d95425f4ca0a3a6b0da52ed1378ca2a
  - app/scripts/Windows-ProcessTree.ps1: 14,298 bytes; SHA-256 2d662cbf4f69b1fb0e9bd95783dd1398d275bf869b4440e864e71df754af0c74

## Installed Ctrl+C rehearsal — PASS

Run through the installed launcher and process-tree mechanism, using a loopback mock endpoint and synthetic project/credential only. No hosted request was made.

- Selected a synthetic CSV in the installed UI and started an analysis request.
- The mock received one POST /v1/chat/completions for meta-models/muse-spark-open-1026; the request was active before cancellation.
- Sent an actual Windows CTRL_C_EVENT with GenerateConsoleCtrlEvent; Win32 error was 0.
- Native launcher exit code was captured from its process handle and written before the wrapper normalized it: 130. See launcher-cancel-native-exit-code.txt and launcher-cancel-native-result.json.
- Mock connection closed. The mock requestAborted flag was false, so this proves connection closure during process teardown, not that the mock runtime surfaced an abort signal.
- All six task-owned descendants were gone after exit; the recorded PID set was independently checked and none remained. Mock port 65016 had no listener.
- Launcher mutex was reacquirable; forced cleanup was false.
- The result records no synthetic credential in captured output or persisted state, and zero unexpected non-loopback fetches.
- No accepted model output/report was produced by the cancelled request.

## Installed normal exit — PASS

A separate fresh profile/project used the same installed ZIP.

- Native launcher exit code captured from its process handle: 0, recorded in launcher-normal-native-exit-code.txt and launcher-normal-native-result.json.
- Five task-owned descendants were recorded before close; none remained after exit.
- Mock port 57306 had no listener; mutex was reacquirable; forced cleanup was false.
- No unexpected non-loopback fetches or captured/persisted synthetic credential.

## Current-source regressions — PASS

Both suites were rerun after the checkpoint from C:\maos; they are distinct and do not overlap.

1. node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/baseten-pilot-process-tree.test.ts
   - Exit 0; 1 file passed; 10 tests passed; 18.84 seconds.
   - Raw sanitized command, stdout, stderr and exit code are in validation/process-tree-current-committed-source.*.

2. node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/meta-model-api-contract.test.ts
   - Exit 0; 1 file passed; 30 tests passed; 4.83 seconds; complete unfiltered suite.
   - Used external test engine via MAOS_TEST_ENGINE_PATH:
     C:\Users\AMITAKSHYA SUTAR\.codex\worktrees\baseten-gate-validation-2026-10-29\rust\target\release\maos-engine.exe
   - Raw sanitized command, stdout, stderr and exit code are in validation/meta-model-api-contract-unfiltered-current-committed-source.*.

## Cancellation lifetime

The adapter marks disposal requested under its lifetime gate and unsubscribes the console handler. A callback that entered first increments the active-callback count and is allowed to finish CancellationTokenSource.Cancel() without holding the gate, since cancellation invokes registered callbacks synchronously. A concurrent disposer waits for callbacks to drain; a callback arriving after disposal begins returns without touching the source. Disposal is coordinated once and is idempotent. The actual installed Ctrl+C run exercised this shutdown path.

## Failed earlier attempt retained

Attempt 7 remains preserved and is not counted. It was a harness failure: the runner timed out waiting for an active request and then blocked while draining redirected output before cleanup. No Ctrl+C event was sent in that attempt, and it is not cancellation evidence. Attempt 8 used a longer active-request window and cleanup-before-output-drain; no production package/source behavior was changed for that harness adjustment. See attempt-7 and attempt-8/normal-harness-adjustment.txt.

## Engine and readiness limits

The test engine was external and not part of the ZIP: 472,064 bytes, SHA-256 3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a. It is unsigned and unapproved; the hash identifies the captured bytes but does not attest source/build provenance or publisher trust. The UI reported ENGINE NOT REPORTED.

This is installed mock-inference launcher evidence. It does not establish live Meta/Baseten inference, account spending controls, model-use clearance, engine trust, or release/submission readiness.
