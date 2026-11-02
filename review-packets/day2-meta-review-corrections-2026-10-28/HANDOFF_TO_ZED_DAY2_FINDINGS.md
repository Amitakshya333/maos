# Focused handoff to Zed — Day 2 independent-review corrections

**Repository:** `C:\maos`  
**Branch / declared base:** `main` / `239a0042b08a3960d3c89f890f01ab194ff82f1f`  
**Status:** the three Day 2 findings have implementation and regression coverage; focused review is pending. Nothing was staged, committed, pushed, packaged, installed, or sent to a live provider.

## Findings and changes

### P1 — alternate Meta entrypoints and retries

A single policy in `src/backends/meta-api-policy.ts` is enforced by the shared OpenAI-compatible provider constructor, `RuntimeFactory`, and `createProviderDirect`. Meta requires explicit `metaApiEnabled: true`, configured endpoint exactly `https://api.meta.ai/v1`, model exactly `muse-spark-1.3`, and an environment-variable name in config. The key must be present in that named environment variable; config/credential-store key values do not satisfy it. Any Meta-host candidate that fails those checks, an SDK environment endpoint override, or another provider implementation is rejected before request construction. Plan and doctor use the shared factory path.

Meta sets the SDK retry count to zero, rejects redirects, fixes the 60-second timeout with abort propagation, caps output at 256 tokens, and omits temperature unless configured. The provider also owns a zero ceiling for Core transient request retries; `runAgent` applies the lower provider cap even if callers request more retries. `ApiRuntime` carries that zero cap to the orchestrator. The orchestrator passes it to both task-failure enqueue paths and holds already-queued records for zero-retry agents instead of draining them into another automatic attempt. Those pre-existing records are retained, so they remain visible in retry status until the runtime retry policy/configuration changes. Unrelated providers and runtimes retain the existing retry defaults/configuration.

Tests cover direct and factory construction, `maos plan`, `maos doctor`, missing/disabled opt-in, hostile host, wrong model, the SDK `OPENAI_BASE_URL` escape, missing named key before network, and a redirect whose target receives no request. Mock HTTP tests verify one attempt on 429/5xx. No request was made to `api.meta.ai`.

### P2 — successful output credential redaction

`src/backends/openai-provider.ts` sanitizes completion prose and provider identity before returning them to Core. If the exact configured credential appears anywhere in raw tool-call metadata or decoded arguments, it fails closed with a generic sanitized error before Core can execute or log the arguments. The SDK logger is disabled so raw response bodies are not emitted before sanitization. Industrial API/service tests inspect returned values, persisted explanation/receipt/audit output, and captured logs using synthetic test keys.

**Limit:** this protects exact occurrences of the configured credential only. It does not detect arbitrary unrelated secrets, transformed fragments, or secret encodings. The provider interface is non-streaming; no streamed response path is supported or claimed.

### P2 — hard four-generation Industrial budget

`src/industrial/analysis-agent-service.ts` sets `maxGenerationAttempts: 4`; `src/core/agent-runner.ts` counts every generation, including transient retry invocations and completion nudges/extensions, before sending it. The configured provider retry cap is applied within that hard ceiling. Industrial telemetry analysis remains limited to one tool execution. Rejected `run_command`, `write_file`, and `git_commit` calls do not earn adaptive budget; accepted output is not produced after exhaustion.

Tests cover repeated calls for each disallowed mutation name, mixed allowed/disallowed calls, successful mutations unable to exceed the hard cap, retries consuming the cap, and whole-task retry records remaining held for a runtime with a zero retry limit.

## New validation evidence

The final focused run is a single distinct execution: **9 files passed, 123 tests passed, 0 skipped, exit 0**. Its exact command and raw output are in `focused-tests-command-and-exit.txt` and `focused-tests-output.txt`. The suite includes the active-work REPL project-switch refusal test, plan/doctor, Core, provider, authenticated HTTP, Industrial contract/service, redaction, and one-attempt 429/5xx cases.

One earlier run in this slice had **122 passed / 1 failed** because the new isolated retry-queue fixture had not created `queue/pending`. The test was corrected to create that directory inside its temporary project; the final full focused run passed. The failed raw output and exit are retained in `retry-queue-fixture-failure-output.txt` and `retry-queue-fixture-failure-command-and-exit.txt`; it is not counted as passing evidence. An earlier 18-test recheck overlaps and is not added to the final count.

- `npm run build:backend` — PASS, exit 0.
- `npm run typecheck:gui` — PASS, exit 0.
- `npm run build:gui` — PASS, exit 0 (71 modules; existing 515.99 kB chunk-size warning).
- Scoped `git diff --check 239a0042b08a3960d3c89f890f01ab194ff82f1 -- <27 manifest paths>` — PASS, exit 0. Git emitted line-ending normalization advisories on nine tracked files; no whitespace error. Both patch added-line scans returned zero trailing-whitespace lines.

Raw command output and exit statuses are retained beside this handoff. The preliminary stale-temp packet-generation failure is also retained; the parent snapshot was freshly reconstructed from the base and verified before final packet generation.

## Mock versus live behavior

The Meta provider, output-redaction, request-count, timeout, redirect, plan/doctor, and Industrial agent tests use injected transports or loopback mock servers. They establish contract behavior only. **No hosted Meta call or other live inference was run.** No Electron/private-IPC/browser rehearsal was run in this correction; an earlier retained harness attempt stopped before launch because Playwright was unavailable. Do not infer Electron, live-model, package, or release readiness from these results.

## Packet provenance

The correction delta is against the rejected 15-file candidate reconstructed from the declared base plus its unchanged historical patch. Historical parent patch and manifest hashes are preserved in `packet-hashes.txt` and embedded as parent hashes in `correction-source-hashes.json`.

- Correction-only patch: **21 paths**, SHA-256 `7e91283f135b6ea55ccc7eac5e84a1273d6f19b1bfc1cc3ae830d7a79eac345c`.
- Correction source manifest: SHA-256 `f44b64a6a9a7b2e250b69c4e7fd0779e5864f5ed0cb8b948d264adb52511976d`.
- Complete post-checkpoint patch: **27 paths** against `239a0042b08a3960d3c89f890f01ab194ff82f1f`, SHA-256 `43dfbc70d4ff90f2d8dd30a5a6db665b63ee9996b0092db738b3f8ad3d3ea54a`.
- Complete source manifest: SHA-256 `b9bc4c605c07bdcf25e83de6a781a18095b523bd04866906099a02d2188dd6bc`.

Both patches passed `git apply --check` and applied in isolated temporary clones. Current candidate content matches all 27 manifest raw hashes. Each reconstructed candidate matches all 27 LF-normalized hashes; 18 also match raw bytes, with nine raw differences caused only by CRLF/LF checkout normalization. Both reconstructed working-tree path sets exactly equal the 27 manifest paths, with empty indexes. Details and exact mismatch paths are in `source-verification-output.json` and `reconstruction-result.txt`.

The complete candidate scope is listed in `complete-post-checkpoint-source-hashes.json`. It contains the prior Day 2 candidate plus the minimal runtime/retry-queue propagation needed to prevent Meta whole-task retries. The packet excludes the checklist, demo/submission planning, product proposals, `.maos` private state, generated outputs, and historical review packets.

## Focused review request

Please inspect the 21-path correction against the reconstructed rejected snapshot, especially (1) provider/factory policy and every retry path, (2) successful-response redaction before Core/persistence/logging, and (3) the four-generation budget and authorization-based adaptive extension. Review the 27-path full packet only where needed for context. Independent approval remains pending; mock coverage does not establish live-provider or Electron behavior.

**Checkpoint boundary:** no commit is requested or created. The root checkout remains on `main` at the declared base with an empty index; unrelated existing working-tree changes were not part of the candidate patch.
