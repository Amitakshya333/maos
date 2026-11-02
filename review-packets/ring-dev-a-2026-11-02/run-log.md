# TASK DEV-A-01 run log - Ring brain (Dev A lane)

- Date (UTC): 2026-11-02
- Worktree: C:/clean/ring-dev-a-brain (branch ring/dev-a-brain)
- Base commit: 8b39caf36cacdb461504bd54ce66e7f8b9707855 (Freeze Ring contracts for threads streams and tools; == origin/main at start)
- BASETEN_API_KEY: unset for every command and test run (verified test -z). No live Baseten calls; hosted paths use loopback-mock providers only.
- npm ci run once in the worktree (own node_modules). No commits, no pushes, no tags. Nothing written outside C:/clean/ring-dev-a-brain except this packet dir.

## Commands (exit codes)

- npm ci --no-audit --no-fund (BASETEN_API_KEY unset): exit 0.
- tsc -p tsconfig.json --noEmit: exit 0 (after fixing staged Day-2 ocr-document.ts syntax errors: unclosed /Encrypt paren, missing comma; plus regex/filter/capture fixes and generate-report-docx casts and MemoryService.share).
- vitest run [ring-agent, ring-inference, ring-wire-contract, ring-contract, ring-dev-a, ring-dev-audit-proxy, ring-workspace, ring-impl-01]: exit 0 - 8 files, 54 tests, all pass.
- npm run build:backend: exit 0. npm run typecheck:gui: exit 0.
- patch -p1 --dry-run < candidate.patch against a clean 8b39caf export: applies with no failures/rejects.

## What changed (vs base 8b39caf)

- ring-agent-service.ts: registry dispatch for all 15 tools (registry.isConsequential is the single approval gate; unknowns fail closed); RING_AGENT_TOOLS derived from the registry (original six first); maxTurns 12 -> 20; thread linkage (threadId context, role inheritance, compacted prior-run carry-over from disk JSONL); refusal gate (restart/operation approval, safety certification) in both modes; hosted telemetry summary only when needed (Day 1d); __ringEvents envelope drain via record() with strip-before-model; __lastApproval/__telemetry stashed in run context; evidence-only extended with memory/plan/ocr/work-order intents and consequential approval. Deleted 5 superseded private tool methods. Frozen files and meta-api-policy untouched.
- ring-tools/*: six migrated modules registered unchanged; Day-2 tools (ocr/inspect/office/work-order/handover/xlsx/remember/recall/update-plan) + common/tool-deps/office/index wiring.
- memory-service.ts: additive share(entry) passthrough to MemoryStore.add.
- service/index.ts: container wires memory/ocr/vision/docx/xlsx/kbSearch into RingAgentService; exports RingThreadService + ringThread.
- api/router.ts: thread block only - POST/GET /api/v1/ring/threads, POST /threads/:id/messages (404 NOT_FOUND, 400 VALIDATION_FAILED). Existing /ring/runs routes untouched.
- gui api rest-client/adapter: additive thread pass-throughs (frozen client shape kept).
- RingWorkspace.tsx: optional thread methods on RingRunClient; thread bar renders only with thread fns; sends route via postThreadMessage when a thread is active. Existing 4-method mocks compile unchanged.
- Tests: ring-dev-a.test.ts (10 tests) + ring-dev-audit-proxy.test.ts (engine-fixture seeder) + 2 thread-UI tests in ring-workspace.test.ts.

## Validation summary

- Lane tests 10/10 pass evidence-only; DOCX asserts the real generator output with the same-platform engine fixture (rust/target/release/maos-engine.exe, as CI builds), else the honest engine-missing error text.
- Regression gate 54/54 green; build:backend + typecheck:gui clean.
- T-07 approval->DOCX->verify workflow not broken (no judged/verify changes; office artifacts under .maos/ring-runs/artifacts/<runId>/).

## Tool-reliability observations (MOCKS ONLY - no live calls)

- OCR: demo scan PDF text layer extracts deterministically; layer-less PDFs fall through to OcrService.ocrDocumentSync (needs raster engine). Tesseract not installed - preflight stands.
- Vision: weights absent, analyzeImageSync raises MODEL_RUNTIME_UNAVAILABLE by design; inspect_image surfaces it verbatim.
- DOCX/XLSX: inputs validate and packages build offline, but finalizeArtifact -> AuditService.recordAuditEvent chain-appends through the Rust engine binary; engine-less machines fail honestly (Engine executable not found). Same-platform fixture makes the full DOCX path pass - verified by seeding the temp root.
- Memory: MemoryStore.add works; MemoryService had no write path, hence additive share().
- Streaming: provider contract has no token streaming, so model.delta is never emitted (no fake typewriter). Tool/plan/approval/artifact/memory events fan out live via record() -> onStreamEvent in both modes.

## NOT verified

- Live hosted run against Baseten (no key by design).
- Multi-process restart of a live server (restart covered at service+JSONL level).
- GUI thread UI against a live backend (injected mock clients only).
