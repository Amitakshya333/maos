# FULLTEST-NEW — post-lanes commit b666518 (2026-11-02)

## Commit
- `b66651882a4648b81fe2c44a2a408a1e3fe6d67c` ("Add Ring roles, skills, and safety")
- Verified in worktree: `git -C C:/clean/fulltest-b666518 rev-parse HEAD` = `b66651882a4648b81fe2c44a2a408a1e3fe6d67c` (detached, main).
- Worktree clean after run: `git status --porcelain` empty. No code changes, no commits, no pushes.

## Environment / guardrails
- `BASETEN_API_KEY` = `unset` in the shell that ran both `npm ci` and `npm test` (verified via `process.env`). No live Baseten calls possible.
- Baseten suites ran on loopback/injected transport only: results contain 91x `loopback`, 2x `injected transport`, 3x simulated `HTTP 503` (`baseten is temporarily unavailable`); `✓ tests/industrial/baseten-pilot-process-tree.test.ts (10 tests) 17450ms`; zero `FAIL` detail lines mention Baseten. The only two `Baseten*key` hits are key-contamination guard tests (pass).
- No `.env` file exists in the worktree.
- `package.json` scripts.test = `vitest run` (vitest 4.1.11, serial workers, 60 s timeout). The full command was run exactly as defined — no subset.
- `rust/` exists but `rust/test.txt` canary, `rust/target/`, and `dist/` are all absent in the worktree.

## Commands and exit codes
| Step | Command | Exit |
|---|---|---|
| npm ci | `npm ci --prefix C:/clean/fulltest-b666518 --no-audit --no-fund` | **0** (242 packages) |
| full test (text) | `npm test --prefix C:/clean/fulltest-b666518` -> `b666518-results.txt` | **1** |
| full test (JSON) | `npm test --prefix C:/clean/fulltest-b666518 -- --reporter=json` -> `b666518-results.json` (npm banner stripped; stderr -> `b666518-json-stderr.txt`) | **1** |

## Counts (vitest's own tally, text run)
- `Test Files  95 failed | 61 passed | 1 skipped (157)`
- `Tests  763 failed | 2430 passed | 118 skipped (3311)`
- `⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯` (unhandled — engine binary, see below)
- `Duration  448.92s (transform 7.66s, setup 0ms, import 90.91s, tests 322.03s, environment 1.56s)`
- JSON reporter agrees: suites 1161 total / 678 passed (describe-level), tests total/passed/failed/pending = 3311/2431/762/118 across 157 files. The 763rd text-run failure is the ui1-04 flake below (passed in the JSON run).

## Failing file list (94 files with status failed in JSON; text "Test Files 95 failed" = these + collection-level counting of the 4 zero-test gate files; the 1 skipped file is tests/r1-rust-engine.test.ts, all-22-skipped)
- `tests/f2-05-package-assets.test.ts`
- `tests/f3-03-rest-contract.test.ts`
- `tests/f3-06-audit-events.test.ts`
- `tests/f3-07-verifier-idempotency.test.ts`
- `tests/f5-03-kb-embedding.test.ts`
- `tests/f5-04-kb-vector-index.test.ts`
- `tests/f5-05-kb-search.test.ts`
- `tests/gui/ui1-01-spa-shell.test.ts`
- `tests/gui/ui1-06-csp-token-hygiene.test.ts`
- `tests/gui/ui1-07-role-presets.test.ts`
- `tests/gui/ui1-08-basic-settings.test.ts`
- `tests/gui/ui1-09-chat-task-feed.test.ts` (all tests skipped; suite aborted on canary)
- `tests/gui/ui1-10-evidence-retention.test.ts`
- `tests/gui/ui1-11-model-manager.test.ts`
- `tests/gui/ui1-12-fair-queue.test.ts`
- `tests/gui/ui1-13-model-switcher.test.ts`
- `tests/gui/ui1-14-approvals.test.ts`
- `tests/gui/ui1-15-cockpit.test.ts`
- `tests/gui/ui1-16-evidence-workbench.test.ts`
- `tests/gui/ui1-17-document-generator.test.ts`
- `tests/gui/ui1-18-knowledge-sandbox.test.ts`
- `tests/gui/ui1-19-service-lifecycle.test.ts`
- `tests/gui/ui1-20-audit-sovereign-panel.test.ts`
- `tests/gui/ui1-21-project-isolation.test.ts`
- `tests/gui/ui1-22-accessibility-errors.test.ts`
- `tests/gui/ui1-23-component-interruption.test.ts`
- `tests/gui/ui1-24-one-project-v1-1.test.ts`
- `tests/industrial/analysis-agent-auth-http.test.ts`
- `tests/industrial/f10-01-industrial-cli.test.ts`
- `tests/industrial/f10-02-dashboard-trigger.test.ts`
- `tests/industrial/f10-04-public-demo-pack.test.ts`
- `tests/industrial/f10-05-deterministic-reset.test.ts`
- `tests/industrial/f10-06-judged-run.test.ts`
- `tests/industrial/f10-07-open-artifact.test.ts`
- `tests/industrial/f10-09-cli-gui-equivalence.test.ts`
- `tests/industrial/f11-01-full-e2e-automation.test.ts`
- `tests/industrial/f11-02-cold-warm-performance.test.ts`
- `tests/industrial/f11-03-failure-matrix.test.ts`
- `tests/industrial/f11-04-quality-security-suite.test.ts`
- `tests/industrial/f11-05-release-identities-sbom.test.ts` (all tests skipped; suite aborted on canary)
- `tests/industrial/f11-06-clean-machine-rehearsal.test.ts` (all tests skipped; suite aborted on canary)
- `tests/industrial/f11-07-three-consecutive-rehearsals.test.ts` (all tests skipped; suite aborted on canary)
- `tests/industrial/f11-08-release-freeze.test.ts` (0 tests, suite collection error)
- `tests/industrial/f11-09-judge-qa-defense.test.ts` (0 tests, suite collection error)
- `tests/industrial/f11-10-independent-acceptance.test.ts` (0 tests, suite collection error)
- `tests/industrial/f4-01-pdf-rasterization.test.ts`
- `tests/industrial/f4-02-printed-text-ocr.test.ts`
- `tests/industrial/f4-03-ocr-document-tool.test.ts`
- `tests/industrial/f4-04-vlm-benchmark.test.ts`
- `tests/industrial/f4-05-analyze-image-tool.test.ts`
- `tests/industrial/f4-06-conflict-review.test.ts`
- `tests/industrial/f4-07-multimodal-benchmark.test.ts`
- `tests/industrial/f5-06-kb-retrieval-benchmark.test.ts`
- `tests/industrial/f5-07-kb-cli.test.ts`
- `tests/industrial/f6-01-office-artifact-inputs.test.ts`
- `tests/industrial/f6-02-generate-docx.test.ts`
- `tests/industrial/f6-03-generate-xlsx.test.ts`
- `tests/industrial/f6-04-generate-pptx.test.ts`
- `tests/industrial/f6-05-template-output-safety.test.ts`
- `tests/industrial/f6-06-visual-regression.test.ts`
- `tests/industrial/f7-01-task-requirements.test.ts`
- `tests/industrial/f7-02-deterministic-inference.test.ts`
- `tests/industrial/f7-03-workflow-planning.test.ts`
- `tests/industrial/f7-04-tool-approval-planning.test.ts`
- `tests/industrial/f7-05-adversarial-routing.test.ts`
- `tests/industrial/f7-05-cli-gui-parity.test.ts`
- `tests/industrial/f8-01-sandbox-image.test.ts`
- `tests/industrial/f8-02-container-runner.test.ts`
- `tests/industrial/f8-03-execute-code-sandbox-tool.test.ts`
- `tests/industrial/f8-04-sandbox-adversarial.test.ts`
- `tests/industrial/f8-06-calculation-trace.test.ts`
- `tests/industrial/f8-07-host-executor-disabled.test.ts`
- `tests/industrial/f9-01-threat-measurement-boundary.test.ts`
- `tests/industrial/f9-02-endpoint-allowlist.test.ts`
- `tests/industrial/f9-03-firewall-enforcement.test.ts`
- `tests/industrial/f9-04-network-monitor.test.ts`
- `tests/industrial/f9-05-service-process-identity.test.ts`
- `tests/industrial/f9-06-industrial-firewall-requirement.test.ts`
- `tests/industrial/f9-07-sovereignty-evidence-bundle.test.ts`
- `tests/industrial/f9-08-interruption-atomic-cleanup.test.ts`
- `tests/industrial/f9-09-disconnected-full-rehearsal.test.ts`
- `tests/industrial/f9-10-process-boundary.test.ts`
- `tests/industrial/f9-11-audit-append-lock.test.ts`
- `tests/industrial/g5-knowledge-grounding-gate.test.ts`
- `tests/industrial/g5-real-offline-embedding.test.ts`
- `tests/industrial/g6-deliverable-readiness-gate.test.ts`
- `tests/industrial/gate-g11-definition-of-done.test.ts` (0 tests, suite collection error)
- `tests/industrial/gate-g9-sovereignty-gate.test.ts`
- `tests/industrial/industrial-repl.test.ts`
- `tests/industrial/judge-verifier.test.ts` (all tests skipped; suite aborted on canary)
- `tests/industrial/meta-model-api-contract.test.ts`
- `tests/industrial/read-only-completion.test.ts`
- `tests/industrial/ring-dev-a.test.ts`
- `tests/industrial/ring-dev-audit-proxy.test.ts`

## Failing test names
- Full per-test list (763 names, text run): `b666518-failing-tests.txt`
- JSON-run list (762 names): `b666518-failing-tests-json-run.txt`
- Run-to-run flake (failed in text run, passed in JSON run): `tests/gui/ui1-04-launcher-handshake.test.ts > UI1-04: Launcher Handshake and Project Validation > 4. Concurrency, Lifecycle & Zero Orphans > spawns two distinct projects concurrently on different ports without interference`

## Infra notes (failure signatures verbatim, first lines each)

Engine binary missing (most F4/F6/F8/F10/F11 failures + the 1 unhandled error; `rust/target/` absent, binary never built):
```
 FAIL  tests/industrial/f10-02-dashboard-trigger.test.ts > F10-02: Typed Dashboard Workflow Trigger > handleIndustrialTrigger execution > dispatches typed workflow stage and returns run and stage links
EngineError: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-test-temp-f10-02-XRLHUW\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a MAOS source checkout, build it with: cargo build --release --locked --manifest-path rust/Cargo.toml, then copy rust/target/release/maos-engine[.exe] to the missing path.
 ❯ verifyExecutable src/industrial/rust-engine-bridge.ts:91:11
     89|
     90|   if (!fs.existsSync(absPath)) {
     91|     throw new EngineError(
       |           ^
     92|       `Engine executable not found: ${absPath}. Install the platform-m…
     93|         `From a MAOS source checkout, build it with: cargo build --rel…
 ❯ AuditService.getEngineManifest src/service/audit-service.ts:315:12
```

rust/test.txt canary (F11-05/06/07 suites abort, ui1-09 fully skipped 29/29; `rust/test.txt` absent in worktree):
```
Error: ENOENT: no such file or directory, open 'C:\clean\fulltest-b666518\rust\test.txt'
 ❯ tests/gui/ui1-09-chat-task-feed.test.ts:119:28
    117|   beforeAll(async () => {
    118|     // 1. Canary check
    119|     const canaryBytes = fs.readFileSync(CANARY_PATH);
       |                            ^
    120|     const initialCanaryHash = crypto.createHash('sha256').update(canar…
```

Python/OCR via engine (F4 OCR suites; Python reached only through the missing binary):
```
OcrError: [OCR_ENGINE_FAILED] OCR processing failed: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-ocr-test-aEKxtB\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a MAOS source checkout, build it with: cargo build --release --locked --manifest-path rust/Cargo.toml, then copy rust/target/release/maos-engine[.exe] to the missing path.
 ❯ OcrService.ocrImage src/service/ocr-service.ts:157:13
    155|     } catch (err: unknown) {
    156|       if (err instanceof OcrError) throw err;
    157|       throw new OcrError('OCR_ENGINE_FAILED', `OCR processing failed: …
       |             ^
    158|     } finally {
    159|       if (fs.existsSync(tmpJsonPath)) {
 ❯ tests/industrial/f4-02-printed-text-ocr.test.ts:221:20

```

Local model (G5 real-offline-embedding; harness fails at engine-manifest step before any Python/model load):
```
 FAIL  tests/industrial/g5-real-offline-embedding.test.ts > Gate G5: Real Offline Embedding Weights Verification > 4. Real Semantic Retrieval Quality & Provenance
EngineError: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-g5-retrieval-ZpL9h6\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a MAOS source checkout, build it with: cargo build --release --locked --manifest-path rust/Cargo.toml, then copy rust/target/release/maos-engine[.exe] to the missing path.
 ❯ verifyExecutable src/industrial/rust-engine-bridge.ts:91:11
     89|
     90|   if (!fs.existsSync(absPath)) {
     91|     throw new EngineError(
       |           ^
     92|       `Engine executable not found: ${absPath}. Install the platform-m…
     93|         `From a MAOS source checkout, build it with: cargo build --rel…
 ❯ AuditService.getEngineManifest src/service/audit-service.ts:315:12
```

Unhandled error (same missing-binary root cause):
```
⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
EngineError: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-test-temp-f10-02-BTcsM2\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a MAOS source checkout, build it with: cargo build --release --locked --manifest-path rust/Cargo.toml, then copy rust/target/release/maos-engine[.exe] to the missing path.
 ❯ verifyExecutable src/industrial/rust-engine-bridge.ts:91:11
     89|
     90|   if (!fs.existsSync(absPath)) {
     91|     throw new EngineError(
       |           ^
     92|       `Engine executable not found: ${absPath}. Install the platform-m…
     93|         `From a MAOS source checkout, build it with: cargo build --rel…
 ❯ AuditService.getEngineManifest src/service/audit-service.ts:315:12
```

JSON-run stderr shows loopback-only `Error: connect ECONNREFUSED 127.0.0.1:3847` (test-harness service probes, no external network):
```
Error: connect ECONNREFUSED 127.0.0.1:3847
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16) {
  errno: -4078,
  code: 'ECONNREFUSED',
  syscall: 'connect',
  address: '127.0.0.1',
  port: 3847
}
Error: connect ECONNREFUSED 127.0.0.1:3847
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16) {
```

Non-infra failures also present (not fixed per assignment) — dominant assertions:
- 59x `AssertionError: expected false to be true // Object.is equality`
- 11x `AssertionError: expected error to be instance of PptxGenerationError`
- 10x `AssertionError: expected 500 to be 200 // Object.is equality`
- 9x `AssertionError: expected 1 to be +0 // Object.is equality`
- 8x `AssertionError: expected undefined to be defined`
- 7x `327|         manifest = verifyExecutable(enginePath, options.expectedEngine…`
- 6x `AssertionError: expected 500 to be 201 // Object.is equality`
- 6x `AssertionError: expected [Function] to throw error matching /TEMPLATE_SAFETY_VIOLATION/ but got 'Eng`
- 4x `AssertionError: expected 0 to be greater than 0`
- 4x `AssertionError: expected 404 to be 200 // Object.is equality`
- 4x `AssertionError: expected [Function] to throw error matching /STALE_SOURCE_HASH/ but got 'Engine exec`
- 3x `AssertionError: expected '<!DOCTYPE html>\n<html lang="en">\n<h…' to contain '<div id="root">'`

Nothing was fixed, committed, or pushed, per instructions.

## Artifact hashes (SHA-256)
- `b666518-results.txt` (1695582 bytes): `b24f07c4906de95428204e4322799a27917521407b452a2f616be39dce6897ca`
- `b666518-results.json` (2319608 bytes): `9ce1598f31795f8a984f54a254eb3c3f9084eed3b5bb648cde440d495644eab9`
- `b666518-failing-tests.txt` (148135 bytes): `d87e5d0a6d48ac6a4cfc343759479852184a9accfe799def5a42aafc9dc30532`
- `b666518-failing-files.txt` (4439 bytes): `a934f5ce53fb8cb4d3697ea5431175868bf99244401ce1d252a89d2f1ea2752b`
