# Zed handoff — lazy analysis configuration and F2-08 fixture isolation

**Review request:** focused independent re-review of the correction delta below only. The prior P2/P3 cleanup/checkpoint findings were independently reviewed as resolved; they are preserved and not reopened here. Do not infer live-model or release readiness from mock tests.

## Exact reviewed parent and packet hashes

- Repository: `C:\maos`; base/HEAD: `f9525055c56a7f7771dd2fa029c147c2960a98a3`.
- Exact last reviewed candidate: `cleanup-checkpoint-canonical.patch`, 99 files, SHA-256 `a1e32ed71ea29540d29159e4e8afc8d6ae3eeaac3ffbde9d6dede6302e8e6ace`; `cleanup-checkpoint-canonical-source-hashes.json`, SHA-256 `c1d8eb2182218f4c80a45cbc772404ac3cf293af47ebaaa47dbca63ceaedaa8e`.
- Parent-relative correction: `uninitialized-f2-safety-delta.patch`, 7 files, SHA-256 `330120f2f6c12e88aefe90012d3b086228cf2b4243fc4ae7b19e7763af18eb86`; manifest `uninitialized-f2-safety-delta-source-hashes.json`, SHA-256 `14ec5a11970335c294627bed242bf28c6742c6a660276ebb3a4b0470c1bd3413`.
- Refreshed canonical candidate: `uninitialized-f2-safety-canonical.patch`, 100 files (78 tracked modifications, 22 additions), SHA-256 `41971ac2753b12eb414390cca892a9ad20f441aedfb41e596fcd27bb53dca661`; manifest `uninitialized-f2-safety-canonical-source-hashes.json`, SHA-256 `a8843a32c6803273be1ca440f02d248106d359d3bf20bff7dbae131ebac779c4`.
- The delta modifies six files already in the parent and adds the modification to the pre-existing base test `tests/f3-01-services.test.ts`. Applying parent plus delta reconstructed all 100 candidate files. The other 93 of the 99 parent files remain identical by LF-normalized source hash; there are zero outside-scope mismatches.
- Clean temporary materialization from the declared base passed canonical apply-check, apply, reverse-check, exact path-set comparison, and source-manifest comparison: 100/100 LF-normalized matches, 37/100 raw-byte matches. The other raw differences normalize exactly to LF; there are no non-line-ending mismatches.
- Scripts and retained command output are in `uninitialized-f2-safety-validation-2026-10-28/`: `build-uninitialized-f2-safety-delta.cjs`, `build-uninitialized-f2-safety-canonical.cjs`, `reproduce-uninitialized-f2-safety-canonical.cjs`, `delta-build-final.json`, `canonical-build-final.json`, and `canonical-reproduction-final.json`. The last-reviewed parent packet remains unchanged.

## Correction details

### Lazy Industrial analysis configuration

`src/service/index.ts` no longer loads project configuration while constructing the service container. It passes a small lazy resolver to `IndustrialAnalysisAgentService`; the resolver runs only when `analyze()` is called. It checks initialization, loads the configured project file, requires the explicit `ANALYST_AGENT`, and uses that agent's configured provider ID, model and endpoint. It does not select the first other agent when the analyst is incomplete. The provider uses the existing OpenAI-compatible transport, the fixed local-only placeholder credential, and the existing endpoint allowlist.

`src/industrial/analysis-agent-service.ts` resolves that runtime on invocation and preserves structured error codes. Missing project configuration yields `PROJECT_NOT_INITIALIZED`; malformed or unreadable configuration yields `PROJECT_CONFIG_INVALID`; missing analyst/provider settings yield `MODEL_NOT_CONFIGURED`. `src/api/router.ts` maps these service-availability/configuration errors to HTTP 503; `src/api/openapi-spec.ts` documents the cases. Config reads are not caught and replaced by defaults.

### F3-01 and agent regressions

`tests/f3-01-services.test.ts` retains and repairs the empty-root compatibility case: construction succeeds, the Industrial service is present, and `project.isInitialized()` is false; cleanup is guaranteed in `finally`.

`tests/industrial/analysis-agent-auth-http.test.ts` exercises the actual service-container/API composition with a loopback mock server. It checks:

- A configured project sends its configured model to the configured mock endpoint.
- Removing config after service startup yields structured `PROJECT_NOT_INITIALIZED` before inference.
- Malformed JSON and a simulated `EACCES` read failure yield `PROJECT_CONFIG_INVALID`, without a mock request.
- An `ANALYST_AGENT` without a provider does not fall back to a configured `CODER_1`; the result is `MODEL_NOT_CONFIGURED`, with zero mock requests.

The existing direct service and contract suites also pass. All provider traffic in these tests is mock transport; no real inference occurred.

### F2-08 test isolation

`tests/f2-08-lifecycle.test.ts` now creates a separate OS-temporary project per test, with only the `package.json` and `tsconfig.json` required by lifecycle preflight. All lifecycle state/lock/result writes and cleanup target that temp root. The optional executable path still points at the repository's release-binary location so the test can exercise it if present; neither platform binary exists here, so its existing placeholder branch ran. No test hook touched `C:\maos\.maos`.

## Changed correction files

- `src/api/openapi-spec.ts`
- `src/api/router.ts`
- `src/industrial/analysis-agent-service.ts`
- `src/service/index.ts`
- `tests/f2-08-lifecycle.test.ts`
- `tests/f3-01-services.test.ts`
- `tests/industrial/analysis-agent-auth-http.test.ts`

The checklist update is in `docs/MAOS_INDUSTRIAL_EXECUTION_CHECKLIST.md`, Slice 13; checklist/evidence are intentionally outside the source delta.

## Exact validation

Final combined command:

```powershell
npm exec -- vitest run tests/f2-08-lifecycle.test.ts tests/f3-01-services.test.ts tests/industrial/analysis-agent-service.test.ts tests/industrial/analysis-agent-contract.test.ts tests/industrial/analysis-agent-auth-http.test.ts --reporter=verbose
```

Result: **5 files / 129 passed / 0 skipped**, exit 0. Per-file counts: F2-08 43, F3-01 28, agent service 8, agent contract 10, authenticated agent HTTP 40. Output is `uninitialized-f2-safety-validation-2026-10-28/focused-regressions-final.txt`.

The standalone full isolated F2-08 invocation also passed **1 file / 43 tests**, output `f2-08-isolated-full-suite.txt`; it overlaps the combined run and is not added again.

Build and hygiene commands all exited 0:

```powershell
npm run build:backend
npm run typecheck:gui
npm run build:gui
git diff --check
```

Output files: `backend-build-final.txt`, `gui-typecheck-final.txt`, `gui-build-final.txt`, and `diff-check-final.txt`. GUI build retains the existing chunk-size warning.

## Remaining limits and next checkpoint

- Independent review of this 7-file correction delta: **PENDING**.
- F2-08's optional real Rust executable start/stop path did not run because the binary is absent; the suite's existing absent-binary placeholder passed. All stateful lifecycle tests did run against temporary roots.
- No browser/package rehearsal, live local model, live Meta call, provider expansion, or release packaging occurred.
- HEAD remains the base and the index is empty. The repository remains dirty from earlier work; `.maos/maos.config.json` and `.maos/pool.json` are listed modified, but their contents were not inspected or changed. The frozen deterministic RC remains unchanged.
- No staging or commit was performed. After focused re-review passes, the next step is an owner-authorized, carefully allowlisted local source checkpoint; no checkpoint is authorized by this handoff.
