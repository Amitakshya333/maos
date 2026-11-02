# TASK RING-CONTRACT-01 — Run Log

- Date: 2026-11-02. PM-owned contract freeze for the Ring agent build; dev lanes A/B/C start after this.
- Base commit: `a573e2a722a2db31dbb453ab43c9f36d0e0d6c30` ("Add the Ring agent loop and workspace").
- Worktree: `C:\clean\ring-contract`, branch `ring/contract` (created via `git -C C:/maos worktree add -b ring/contract C:/clean/ring-contract main`).
- `C:\maos` was NOT modified except writing this review packet. No commits/pushes there. No live Baseten calls (no confirmed credit balance; `BASETEN_API_KEY` unset for the whole session — verified before each test run).
- `npm ci` in the worktree: exit 0 (own node_modules; 253 packages).

## Commands (exit codes)

| Command | Exit | Result |
|---|---|---|
| `git -C C:/maos worktree add -b ring/contract C:/clean/ring-contract main` | 0 | worktree at a573e2a, branch ring/contract |
| `npm ci` (in worktree) | 0 | own node_modules |
| `tsc -p tsconfig.json --noEmit` (build:backend) | 0 | clean |
| `tsc -p tsconfig.gui.json --noEmit` (typecheck:gui) | 0 | clean |
| `vitest run ring-agent ring-inference ring-wire-contract ring-contract ring-workspace ring-impl-01 ui1-02-api-clients` | 0 | 74 passed (7+6+2+5+9+12+33), 7 files |
| `git diff a573e2a --stat` (patch content check) | 0 | 18 files (see below) |

Total: 74 tests passed, backend + GUI typechecks clean.

## Files changed (vs base a573e2a)

New (frozen contract surface):
- `src/service/ring-contract.ts` — thread/role/tool/artifact/streaming type stubs, lane map, path constants, `isRingThreadId`/`isRingRole` guards
- `src/service/ring-tool-registry.ts` — `RingToolRegistry` (consequential gate, role visibility, fail-closed unknown tools) + shared `truncate`
- `src/service/ring-tools/{telemetry,read-document,search-knowledge,draft-note,verify-export,request-approval,index}.ts` — six tool stubs with frozen names/descriptions/parameters/flags + verbatim-migration notes for Dev C
- `src/service/ring-thread-service.ts` — Dev A thread-service interface stub (NOT_IMPLEMENTED bodies)
- `src/service/ring-artifacts.ts` — Dev C artifact-store interface stub
- `tests/industrial/ring-contract.test.ts` — 5 contract tests (thread shape, restart-reload, event union, registry gate, streaming hook)
- `CONTRACT.md` — human-readable frozen contract (deliverable)
- `PREFLIGHT.md` — tools-temp OCR/vision preflight (read-only; scan HAS text layer; tesseract absent; VLM weights absent; no live calls)

Modified (additive only; existing behavior untouched):
- `src/service/ring-agent-service.ts` — `RingStreamWireFields` + `onStreamEvent`/`emitStreamEvent` hook + streaming pass-through in `toWireEvent()`; all existing methods byte-identical in behavior
- `src/service/index.ts` — re-export contract/registry types (5 lines)
- `src/gui/src/api/ring-run-types.ts` — 4 additive event types + `RingPlanStep`/`RingArtifactDescriptor`/`RingMemoryRecord` + validator pass-through + `validateRingThreadState`
- `src/gui/src/api/rest-client.ts` — thread client methods + `getRingRunEvents` alias + artifact download stub (all new methods; existing run methods untouched)

Untouched (verified by diff): `src/backends/meta-api-policy.ts` (policy NOT weakened), `src/api/router.ts` (Dev A owns the thread block), `RingWorkspace.tsx` (Dev A/B own UI).

## Preflight summary (detail: PREFLIGHT.md)

- Scan PDF `demo/industrial/turbine_inspection_scan.pdf` (534 bytes): HAS a text layer — single FlateDecode stream decompresses to a `Tj` text op (`TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm`); no OCR needed for this fixture.
- Tesseract: NOT installed (`where tesseract` exit 1); preflight warns, not required by default.
- VisionService (Qwen2-VL-2B): code pinned, weights ABSENT (no `.maos/models`); runtime would raise `MODEL_RUNTIME_UNAVAILABLE` by design. Not executed (no weights; no installs).
- Python: PIL 12.3.0 present; PyMuPDF/pdf2image absent; transformers present. `pdf_rasterizer.py` is stdlib+PIL only.
- Baseten key unset; all validation evidence-only.

## Acceptance check

- [x] Patch applies to `a573e2a` with `git apply --check` semantics (generated via `git diff a573e2a`; PM merges with `--no-verify`)
- [x] Existing suites green: ring-agent (7), ring-inference (6), ring-wire-contract (2), ring-workspace (9), ring-impl-01 (12), ui1-02 (33)
- [x] New contract test green (5): threads + restart-reload + event union + registry + hook
- [x] `build:backend` + `typecheck:gui` exit 0
- [x] No live calls made; no keys in code
