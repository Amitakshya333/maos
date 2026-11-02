# Focused review handoff — cancellation callback/disposal lifetime

**Independent review: pending.** This is an uncommitted correction candidate at detached `bb871cb191184b5de1b790d42fc452a29f8f072e`; no source transfer or checkpoint was performed.

## Scope and checkout state

The candidate is `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-bb871cb191184b5de1-correction-20261029\repo`. `C:\maos` remains on branch `main` at the same expected HEAD. Both indexes are empty. The candidate's only tracked differences from the base are these four files:

- `scripts/Start-BasetenSyntheticPilot.ps1` — previously reviewed launcher correction, retained unchanged from the rejected four-file snapshot.
- `scripts/Windows-ProcessTree.ps1` — cancellation callback lifetime fix.
- `tests/industrial/baseten-pilot-process-tree.test.ts` — deterministic callback/disposal and owned-process regressions.
- `tests/industrial/meta-model-api-contract.test.ts` — previously justified error-code fixture/zero-outbound assertions, retained unchanged.

The small cancellation-only delta from the prior rejected four-file snapshot changes only `scripts/Windows-ProcessTree.ps1` and `tests/industrial/baseten-pilot-process-tree.test.ts`. The prior snapshot's patch SHA-256 is `dbb62ab351b474cd158071b34f47be173f890cb869391b6befa0e9ddb45b8ad1`; its retained manifest SHA-256 is `2f089126d37461c4bcb60633bfd35f3845a2b3274d99567c28984a147af64a92`. The prior snapshot reconstruction matches all four retained source hashes after LF normalization. Its raw hashes differ for three files because that reconstruction normalized line endings; the exact per-file raw/LF comparison is retained in `prior-snapshot-verification.json`.

## Lifetime protocol

`MaosPilotConsoleCancellation` in `scripts/Windows-ProcessTree.ps1:254-375` gives each entered callback a lease under `lifetimeGate` by incrementing `activeCallbacks`. A callback dispatched before event unsubscription but reaching the handler after disposal was requested returns under the gate before touching the token source. A callback that acquired its lease first remains counted until its `finally` path exits.

The handler calls `CancellationTokenSource.Cancel()` outside `lifetimeGate`: cancellation invokes token registrations synchronously, and a registration can reenter `Dispose()`. The private thread-local adapter stack distinguishes disposal reentered from this adapter's own cancellation callback from external disposal. Reentrant disposal marks the adapter disposed and unsubscribes, but defers source disposal until that callback releases its lease; it does not wait on itself. External disposal waits with `Monitor.Wait` for active callbacks to drain. Exactly one caller claims source disposal; it runs `CancellationTokenSource.Dispose()` outside the gate, and concurrent callers wait until physical disposal is recorded. This avoids holding the lifetime lock through user callbacks and makes repeated/concurrent `Dispose()` safe without swallowing errors or leaking the source.

The launcher still owns Ctrl+C handling through the C# adapter and keeps the session-scoped mutex until its owned-process shutdown/wait path finishes. The mutex is scoped to this Windows session and participating launcher instances; this is not an account-wide concurrency limit.

## Regressions and retained limits

The actual private `ConsoleCancelEventHandler` from the C# adapter is reflected and invoked by the test harness; this is not `CancelAfter` and not a source-string-only test. Barriers/events cover: callback already in progress as disposal begins, callback dispatched but entering after disposal, eight concurrent/repeated disposals, and cancellation reaching the owned-process Job Object shutdown/wait path. Separate child/grandchild PID checks assert no task-owned child survives. A cancellation-through-mutex test verifies the competing launch sees the held named mutex until cancellation and process shutdown complete. Normal zero and nonzero child exit-code cases remain covered.

Final validation, after the last source change:

| Command | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/baseten-pilot-process-tree.test.ts` | 10 passed, 0 failed, exit 0. Dynamically discovered PowerShell 7.6.9 and Windows PowerShell 5.1.26100.9711; both ran the adapter/process cases. |
| `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/meta-model-api-contract.test.ts` with `MAOS_TEST_ENGINE_PATH` set to the established external fixture | Unfiltered: 30 passed, 0 failed, exit 0. |
| `git diff --check bb871cb191184b5de1b790d42fc452a29f8f072e -- <four scoped paths>` | Exit 0. Git printed only its CRLF-to-LF working-copy warnings. |

These are 40 distinct passing tests across the two final runs; the suites do not overlap. The earlier 28-pass/2-fail provider run remains preserved under `C:\maos\review-packets\baseten-pilot-correction-close-2026-10-29\history\initial-unfiltered-failure.txt`; those failed assertions were corrected in the earlier reviewed four-file snapshot and are not counted as passing evidence. The present unfiltered provider rerun also exercises its retained zero-outbound assertions.

The provider fixture used external `maos-engine.exe`, 472,064 bytes, SHA-256 `3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2`. It is unsigned/unapproved and its source/build provenance is unavailable. It was not added to either source checkout or packet.

## Patch and reconstruction

- Complete candidate patch against `bb871cb191184b5de1b790d42fc452a29f8f072e`: `complete-correction.patch`, SHA-256 `d3eb82e46a242ff63aae6323c84820a3a1ff000fdd990bf7e23717b103c8b059`.
- Complete four-file source manifest: `complete-source-hashes.json`, SHA-256 `324baa7ee8869ecf2d74925d59c449f5df2628e866d887454cbde16af34e024d`.
- Cancellation-only delta from the rejected four-file snapshot: `lifetime-delta-from-rejected-four-file-snapshot.patch`, SHA-256 `c90e4ea595eb7226580f75288041a649759dd4c413220003c6f374d01cfd04cd`.
- Delta source manifest: `delta-source-hashes.json`, SHA-256 `ade42f0343fec0d8e3f8710c8e4abcc492933000eeab9aab98bc6ec40b6376eb`.

The complete patch applied cleanly to files extracted from the exact `bb871…` Git blobs. All four reconstructed files match the candidate after LF normalization; raw equality is recorded per file and is false where Git/working-copy line endings differ. The two-file delta applied cleanly to the prior four-file snapshot reconstructed from its retained manifest and patch; all four resulting files match the current candidate after LF normalization. No file outside the four-file scope was reconstructed. Details and temporary paths are in `complete-reconstruction-verification.json`, `delta-reconstruction-verification.json`, and `prior-snapshot-verification.json`.

## Review boundaries

No package was rebuilt. No installed-app Ctrl+C rehearsal or native launcher exit-code capture was run; the next step after source approval remains the rebuilt-package Ctrl+C rehearsal with native exit-code capture. No live inference, hosted call, credential access, model download, terms acceptance, billing change, source transfer, staging, commit, push, or publication occurred. The old packet and earlier failed outputs remain intact; this folder is the authoritative final evidence for this correction slice.