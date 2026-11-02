# TASK RING-AGENT-LOOP-01 — Run Log

- Base commit: b76363a77e931c417327b7a5fe8cb3a299f125c1
- Worktree: C:\clean\ring-agent-01 (detached at base, own node_modules via npm ci)
- C:\maos was NOT modified except writing this review packet.

## Commands

1. git -C C:/maos worktree add --detach C:/clean/ring-agent-01 b76363a77e931c417327b7a5fe8cb3a299f125c1 — exit 0
2. npm --prefix C:/clean/ring-agent-01 ci --no-audit --no-fund — exit 0 (235 packages)
3. npm --prefix C:/clean/ring-agent-01 run build:backend — exit 0
   (tsc -p tsconfig.json && node scripts/copy-industrial-python.js)
4. npx --prefix C:/clean/ring-agent-01 vitest run tests/industrial/ring-agent.test.ts --root C:/clean/ring-agent-01 — exit 0, 7 tests passed
5. npx --prefix C:/clean/ring-agent-01 vitest run tests/industrial/ring-inference.test.ts --root C:/clean/ring-agent-01 — included in combined run, 6 tests passed
6. npx --prefix C:/clean/ring-agent-01 vitest run tests/gui/ui1-02-api-clients.test.ts --root C:/clean/ring-agent-01 — exit 0, 33 tests passed
7. Combined: npx --prefix C:/clean/ring-agent-01 vitest run tests/industrial/ring-agent.test.ts tests/industrial/ring-inference.test.ts tests/gui/ui1-02-api-clients.test.ts --root C:/clean/ring-agent-01 — exit 0, 46 tests passed (7 + 6 + 33), 3 files
8. npm --prefix C:/clean/ring-agent-01 run typecheck:gui — exit 0

An additional scratch REST test (ring-agent-extra, 1 test: start/get/approve via live router with mock model) passed during development, then was consolidated into ring-agent.test.ts as test (g) covering router start/get + 400/404 validation. Counts above reflect final on-disk test files.

## Files changed (vs base b76363a)

- src/service/ring-agent-service.ts — NEW, 582 lines
- src/service/index.ts — +19 lines (mount ringAgent, export types)
- src/api/router.ts — +94/-1 lines (POST /api/v1/ring/runs, GET /api/v1/ring/runs/:id, POST /api/v1/ring/runs/:id/cancel, POST /api/v1/ring/runs/:id/approvals/:approvalId)
- tests/industrial/ring-agent.test.ts — NEW, 256 lines, 7 tests

Untouched (verified empty diff): src/service/chat-inference-service.ts, src/backends/factory.ts.

## Design notes

- Multi-turn loop in RingAgentService.executeHosted, maxTurns=12, fresh AbortController per run.
- Model via OpenAIProvider (baseten armed) exactly as RingInferenceService does; providerFactory fetch bridge reused for the loopback mock in tests.
- Tools are real code paths: analyze_telemetry -> analyzeTelemetryCsv + loadTelemetryDemoThresholds; read_company_document -> evidence-root-confined fs read (realpath symlink re-check, .csv never returned raw); search_knowledge -> wired KbSearchService.searchSync/search with honest unavailable/no-answer; verify_export -> AuditService.exportAuditTrail / verifyChainRecords; draft_safety_note -> writes only after approval to .maos/ring-runs/drafts/<runId>-*.md; request_approval -> pauses.
- Consequential set: draft_safety_note, request_approval. Approval awaits a promise resolved only by resolveApproval; deny completes the run with an explicit denial message and performs no write (verified: drafts dir stays empty).
- Persistence: append-only .maos/ring-runs/<runId>.jsonl; entries carry run start, model turns (summaries only), tool calls/results (args+result summaries, ok/error), approval.pending/resolved, final/cancelled/failed. No raw CSV rows, no API key (redacted).
- Cancellation: cancelRun aborts the AbortController, marks cancelled, resolves any pending approval as cancelled; loop checks cancelled after each await. Tested with a 400 ms-delayed mock: status=cancelled.
- Evidence-only: reuses RingInferenceService arming rules (basetenApiEnabled + exact base URL + exact model + BASETEN_API_KEY present; invalid explicit config throws ProviderApiPolicyError). Not armed => no provider is constructed, deterministic tools run, zero mock requests asserted.
- Prompt safety: only the deterministic summary (verdict/RMS/breaches/source) is placed in the conversation; captured mock body asserted free of raw CSV header/rows.

## NOT verified

- Real Baseten network call (only loopback mock). Hostname stays pinned to inference.baseten.co via existing policy.
- OCC/docx generation via docx-generator-service was NOT invoked: it requires a full OfficeDocxInput + approval record contract; draft_safety_note writes an approved markdown draft instead (still approval-gated). Flagged as the main scope judgement call.
- verify_export full judged-run path (verifyAuditExport in judged-run.ts) was not used; verify_export uses AuditService exportAuditTrail/verifyChainRecords (the real chain verifier underneath) to avoid coupling to a judged-run manifest.
- No GUI changes; typecheck:gui passes unchanged.
- SSE/streaming endpoint not added; progress is via onEvent listener + transcript polling (GET run). No Server-Sent Events route exists in this router to follow.
