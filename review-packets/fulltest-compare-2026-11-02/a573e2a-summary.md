# FULLTEST-OLD — pre-lanes base `a573e2a` full-suite results

- Commit: `a573e2a722a2db31dbb453ab43c9f36d0e0d6c30` — "Add the Ring agent loop and workspace" (old base, before contract+lanes)
- Worktree: `C:/clean/fulltest-a573e2a` (detached HEAD, clean; `git rev-parse HEAD` = `a573e2a…`)
- `BASETEN_API_KEY`: unset in shell; test run launched with `env -u BASETEN_API_KEY`
- Test command (verbatim from `package.json` scripts): `npm test` → `vitest run` (no subset flags)

## Exits

- `npm ci`: exit **0** (242 packages; own `node_modules` in the worktree)
- `npm test`: exit **1**

## Counts (vitest summary line, verbatim)

- Test Files: **92 failed | 59 passed | 1 skipped (152)**
- Tests: **761 failed | 2378 passed | 118 skipped (3257)**
- Errors: **1 unhandled error** (`EngineError` surfaced via `tests/industrial/f10-02-dashboard-trigger.test.ts`)
- Duration: **444.87s**

## Artifacts

- Raw full output: `C:/maos/review-packets/fulltest-compare-2026-11-02/a573e2a-results.txt`
  - SHA-256: `f91773bb1c8ca38bf9218f006dc870503eeb4e79546f0ea3280355763c505655`
- Machine-readable: `C:/maos/review-packets/fulltest-compare-2026-11-02/a573e2a-results.json`
  - SHA-256: `fc2583a3b840dc644faab50afecc4a561fe9ce91da351897446346bdce27d22c`
  - JSON holds: commit, command, both exits, counts, the 92-file failing list, the 767-entry failing named-test list (from `FAIL` headers), whole-file failure entries, and infra notes.
- Full failing named-test list (767 entries, from `FAIL` headers): see `a573e2a-results.json` → `failingNamedTestsFromFailHeaders`, and the raw `a573e2a-results.txt` (`FAIL` × 959 lines = named + whole-file + enclosing-suite headers).

## Failing file list (92)

- tests/f2-05-package-assets.test.ts
- tests/f3-03-rest-contract.test.ts
- tests/f3-06-audit-events.test.ts
- tests/f3-07-verifier-idempotency.test.ts
- tests/f5-03-kb-embedding.test.ts
- tests/f5-04-kb-vector-index.test.ts
- tests/f5-05-kb-search.test.ts
- tests/gui/ui1-01-spa-shell.test.ts
- tests/gui/ui1-06-csp-token-hygiene.test.ts
- tests/gui/ui1-07-role-presets.test.ts
- tests/gui/ui1-08-basic-settings.test.ts
- tests/gui/ui1-09-chat-task-feed.test.ts
- tests/gui/ui1-10-evidence-retention.test.ts
- tests/gui/ui1-11-model-manager.test.ts
- tests/gui/ui1-12-fair-queue.test.ts
- tests/gui/ui1-13-model-switcher.test.ts
- tests/gui/ui1-14-approvals.test.ts
- tests/gui/ui1-15-cockpit.test.ts
- tests/gui/ui1-16-evidence-workbench.test.ts
- tests/gui/ui1-17-document-generator.test.ts
- tests/gui/ui1-18-knowledge-sandbox.test.ts
- tests/gui/ui1-19-service-lifecycle.test.ts
- tests/gui/ui1-20-audit-sovereign-panel.test.ts
- tests/gui/ui1-21-project-isolation.test.ts
- tests/gui/ui1-22-accessibility-errors.test.ts
- tests/gui/ui1-23-component-interruption.test.ts
- tests/gui/ui1-24-one-project-v1-1.test.ts
- tests/industrial/analysis-agent-auth-http.test.ts
- tests/industrial/f10-01-industrial-cli.test.ts
- tests/industrial/f10-02-dashboard-trigger.test.ts
- tests/industrial/f10-04-public-demo-pack.test.ts
- tests/industrial/f10-05-deterministic-reset.test.ts
- tests/industrial/f10-06-judged-run.test.ts
- tests/industrial/f10-07-open-artifact.test.ts
- tests/industrial/f10-09-cli-gui-equivalence.test.ts
- tests/industrial/f11-01-full-e2e-automation.test.ts
- tests/industrial/f11-02-cold-warm-performance.test.ts
- tests/industrial/f11-03-failure-matrix.test.ts
- tests/industrial/f11-04-quality-security-suite.test.ts
- tests/industrial/f11-05-release-identities-sbom.test.ts
- tests/industrial/f11-06-clean-machine-rehearsal.test.ts
- tests/industrial/f11-07-three-consecutive-rehearsals.test.ts
- tests/industrial/f11-08-release-freeze.test.ts
- tests/industrial/f11-09-judge-qa-defense.test.ts
- tests/industrial/f11-10-independent-acceptance.test.ts
- tests/industrial/f4-01-pdf-rasterization.test.ts
- tests/industrial/f4-02-printed-text-ocr.test.ts
- tests/industrial/f4-03-ocr-document-tool.test.ts
- tests/industrial/f4-04-vlm-benchmark.test.ts
- tests/industrial/f4-05-analyze-image-tool.test.ts
- tests/industrial/f4-06-conflict-review.test.ts
- tests/industrial/f4-07-multimodal-benchmark.test.ts
- tests/industrial/f5-06-kb-retrieval-benchmark.test.ts
- tests/industrial/f5-07-kb-cli.test.ts
- tests/industrial/f6-01-office-artifact-inputs.test.ts
- tests/industrial/f6-02-generate-docx.test.ts
- tests/industrial/f6-03-generate-xlsx.test.ts
- tests/industrial/f6-04-generate-pptx.test.ts
- tests/industrial/f6-05-template-output-safety.test.ts
- tests/industrial/f6-06-visual-regression.test.ts
- tests/industrial/f7-01-task-requirements.test.ts
- tests/industrial/f7-02-deterministic-inference.test.ts
- tests/industrial/f7-03-workflow-planning.test.ts
- tests/industrial/f7-04-tool-approval-planning.test.ts
- tests/industrial/f7-05-adversarial-routing.test.ts
- tests/industrial/f7-05-cli-gui-parity.test.ts
- tests/industrial/f8-01-sandbox-image.test.ts
- tests/industrial/f8-02-container-runner.test.ts
- tests/industrial/f8-03-execute-code-sandbox-tool.test.ts
- tests/industrial/f8-04-sandbox-adversarial.test.ts
- tests/industrial/f8-06-calculation-trace.test.ts
- tests/industrial/f8-07-host-executor-disabled.test.ts
- tests/industrial/f9-01-threat-measurement-boundary.test.ts
- tests/industrial/f9-02-endpoint-allowlist.test.ts
- tests/industrial/f9-03-firewall-enforcement.test.ts
- tests/industrial/f9-04-network-monitor.test.ts
- tests/industrial/f9-05-service-process-identity.test.ts
- tests/industrial/f9-06-industrial-firewall-requirement.test.ts
- tests/industrial/f9-07-sovereignty-evidence-bundle.test.ts
- tests/industrial/f9-08-interruption-atomic-cleanup.test.ts
- tests/industrial/f9-09-disconnected-full-rehearsal.test.ts
- tests/industrial/f9-10-process-boundary.test.ts
- tests/industrial/f9-11-audit-append-lock.test.ts
- tests/industrial/g5-knowledge-grounding-gate.test.ts
- tests/industrial/g5-real-offline-embedding.test.ts
- tests/industrial/g6-deliverable-readiness-gate.test.ts
- tests/industrial/gate-g11-definition-of-done.test.ts
- tests/industrial/gate-g9-sovereignty-gate.test.ts
- tests/industrial/industrial-repl.test.ts
- tests/industrial/judge-verifier.test.ts
- tests/industrial/meta-model-api-contract.test.ts
- tests/industrial/read-only-completion.test.ts

## Infra notes (recorded, not fixed — per assignment)

- Engine binary (dominant signature, 783 matching lines; 395 `FAIL` detail blocks open with it). First 10 verbatim lines:
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-IfgF1s\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this p`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\no-model-VCjm1M\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. Fr`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-StKNT4\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this p`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-RFkGZN\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this p`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-jDhIXv\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a`
  - `❌ Verification process error: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-BM1ze1\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-YjT63g\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a`
  - `❌ Verification process error: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-YjT63g\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-CLyzfP\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this p`
  - `❌ Knowledge base build failed [code: 1]: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-f5-07-test-zW9S8f\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this p`
  - Representative thrown form: `EngineError: Engine executable not found: C:\Users\AMITAK~1\AppData\Local\Temp\maos-audit-test-SeDSfk\rust\target\release\maos-engine.exe. Install the platform-matched release binary at this path. From a MAOS source checkout, build it with: cargo build --relea` (via `src/industrial/rust-engine-bridge.ts:91`).
  - No `maos-engine.exe` was built (out of scope: no code changes / no fixes).
- `rust/test.txt` canary: hash-invariant tests fail through the engine-dependent verify path (e.g. `× strictly preserves rust/test.txt SHA-256 hash invariant`); no standalone canary corruption isolated — same engine-missing root cause in the sampled blocks.
- Python/OCR/local model: `OCR` (97 lines), `python`/`Python` (~29), `embedding` (54), `local model` (3) mentions observed; sampled OCR/Python/embedding failures co-occur with the engine-missing blocks. No standalone tesseract/toolchain error isolated from the sampled blocks.
- Baseten / live-call check: `BASETEN_API_KEY` unset; run launched via `env -u BASETEN_API_KEY`. Baseten-related tests use loopback/injected transport only (e.g. `baseten-api-provider-boundary`, `meta-model-api-contract` "loopback mock only"); the `meta-model-api-contract` Baseten checks pass, its 3 failures are `EngineError` blocks. One log line shows an injected 503 by design (`[baseten-test-agent] Agent error: Error: baseten is temporarily unavailable (HTTP 503)` with `Provider: baseten | Model: meta-models/muse-spark-open-1026 | This is a provider outage, not an auth issue`). No live-call evidence (no `ENOTFOUND`/`ECONNREFUSED`/`fetch failed`/`api.baseten` lines; the `401` hits are passing retry-policy assertions).
- Unhandled error: 1 `EngineError` unhandled exception attributed to `tests/industrial/f10-02-dashboard-trigger.test.ts`.
- No code changes, no commits, no pushes made. Worktree `node_modules` only (own install via `npm ci`).
