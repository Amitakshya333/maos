# TASK APPROVAL-ARTIFACT-FIX-01 — run log (scratch `C:/clean/ring-approval-fix`, base `074e1f8`)

Base: `074e1f8` (main HEAD at worktree creation). `BASETEN_API_KEY` unset throughout.
Scratch created via `git -C C:/maos worktree add --detach C:/clean/ring-approval-fix 074e1f8…`, then `npm ci` (exit 0).
`C:/maos` untouched except this packet. No commits, no pushes.

## Defect (reproduced pre-fix)

Instruction `Raise a work order and draft my handover` (evidence-only) paused for approval, then completed with **zero** `artifact.created` events. Transcript showed `tool.result create_work_order ok=False OFFICE_FINDING_CITATION: findings require at least one cited evidence file.` The overlay rendered no cards (nothing to render — the stall is backend, not the overlay wire path).

Root cause (`src/service/ring-agent-service.ts`, `executeEvidenceOnly`):
1. `wantsTelemetry` is keyword-gated; this wording matched nothing, so `analyze_telemetry` never ran, `__telemetry` stayed unset, and `create_work_order`'s `buildOfficeInput` threw `OFFICE_FINDING_CITATION` (findings require a tool-hashed citation). Generation works only when the wording accidentally mentions telemetry — proven by the packaged S4b run (`Raise a work order draft for T-07 vibration finding` → docx `1de81618` + md `b139cfdd`) vs the demo transcript (`ring-…-3bc78413`, zero artifacts).
2. No `wantsHandover` branch existed at all — `and draft my handover` was silently dropped; `write_shift_handover` never ran.

The overlay wire path itself was verified intact: `artifact.created` passes through `toWireEvent`/`RING_STREAM_EVENT_TYPES`, the GUI validator, `RingArtifactCard`, and the path-checked `GET /api/v1/ring/runs/:id/artifacts/:file` download endpoint.

## Fix (minimal)

- `src/service/ring-agent-service.ts` — `executeEvidenceOnly`:
  - Added `wantsHandover` detection (`handover|hand-over|hand over|shift…note|shift…summary`).
  - Evidence-first: when a work-order/handover artifact is requested but telemetry hasn't run, run deterministic `analyze_telemetry` (default CSV) before the approval-gated generation, so citations exist.
  - Runs `create_work_order` (approval) then `write_shift_handover` (own approval); a deny stops the artifact batch (`artifactsDenied`); cancel still returns immediately. Approval gate unchanged — deny still writes nothing.
  - Final answer gains a `Handover:` line mirroring `Work order:`.
- `src/gui/src/components/RingOverlay.tsx`: honest in-flight status — after an `approval.resolved(approved)` with the run still live and no `artifact.created` yet, the transcript shows `Generating approved artifacts…` (`data-testid="ring-overlay-generating"`, pure event projection, nothing invented).
- `src/gui/src/components/RingWorkspace.tsx`: `RingVerifyCard` caption `Audit verify runs automatically — no approval needed.` (`data-testid="ring-verify-no-approval"`; `RING_NO_EXPORT_VERIFIED` fallback copy untouched).
- Restart refusal text and follow-up same-thread handover behavior unchanged.
- Tests: new regression coverage in `tests/industrial/ring-agent.test.ts` (work-order+handover without telemetry wording → 2 approvals → 4 `artifact.created` twins, files exist, `validateRingRunState` passes; honest engine-missing fallback otherwise) and `tests/gui/ring-devb-surface.test.ts` (overlay renders 2 artifact cards with Open; generating status across the approval gap). Also removed a pre-existing duplicate `AuditService` import in `tests/industrial/ring-dev-a.test.ts` (that file previously failed to compile standalone).

## Validation (all from inside `C:/clean/ring-approval-fix`, `BASETEN_API_KEY` unset)

| Command | Exit |
|---|---|
| `npm run build:backend` | 0 |
| `npx tsc -p tsconfig.gui.json --noEmit` (typecheck:gui) | 0 |
| `./node_modules/.bin/vitest run tests/industrial/ring-dev-c-safety.test.ts` | 0 (8 passed) |
| `./node_modules/.bin/vitest run tests/industrial/ring-agent.test.ts` | 0 (9 passed) |
| `./node_modules/.bin/vitest run tests/gui/ring-workspace.test.ts tests/gui/ring-devb-surface.test.ts` | 0 (48 passed: 12 + 36) |
| `./node_modules/.bin/vitest run tests/industrial/ring-dev-a.test.ts` | 0 (13 passed) |
| `./node_modules/.bin/vitest run tests/gui/ring-impl-01.test.ts` (verify-copy guard) | 0 (12 passed) |

Note: the full DOCX path needs the `maos-engine` binary; the scratch had none, so the engine fixture was seeded from the local `C:/maos` release binary into the git-ignored `rust/target/release/` scratch path (test-only, not part of the patch). The new regression test asserts the honest engine-missing message when no fixture exists.

## Deliverable

- `candidate.patch` (this directory) — SHA-256 `6c54aec251a6d29ee22bf013fa09962f13e62127ad0ec18db302f420916ba11b`, base `074e1f8040c1d4a37e9d07f72485cc9473d89681`.
