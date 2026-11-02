# TASK DEV-C-REBASE-01 run log — Ring skills, safety, demo (Dev C lane, rebased)

- Date (UTC): 2026-11-02
- Rebuild scratch (uncommitted, detached HEAD): `C:/clean/ring-c-rebuild` at base
  `6e9bca363fbf84576e4a2d607f694cdea9966470` ("Add Ring overlay and workspace surface").
  `npm ci --no-audit --no-fund` there (own `node_modules`): exit 0 (added 242 packages).
- Original Dev C ground truth read (never applied): `C:/maos/review-packets/ring-dev-c-2026-11-02/`
  (base `8b39caf`; original lane worktree `C:/clean/ring-dev-c-skills`).
- `BASETEN_API_KEY`: unset for every command and test run; test files never set it. No live
  Baseten calls, evidence-only throughout. No commits, no pushes, no tags. Nothing written outside
  the rebuild/check/pristine scratches and this packet dir.

## Base recorded

- `6e9bca363fbf84576e4a2d607f694cdea9966470` = current `main` in `C:/maos`
  (Dev A `8e6a403` + Dev B `6e9bca3` on top of contracts `8b39caf`).

## Commands with exit codes (rebuild scratch `C:/clean/ring-c-rebuild`)

- `git worktree add --detach C:/clean/ring-c-rebuild <base>`: exit 0.
- `npm ci --no-audit --no-fund`: exit 0 (added 242 packages).
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx vitest run tests/industrial/ring-dev-c-safety.test.ts`: exit 0 — 8/8 pass.
- `npx vitest run <safety + ring-agent + ring-contract>`: exit 0 — 3 files, 20/20 pass.
- Gate + neighbours (safety + ring-agent + ring-contract + ring-dev-a, which imports
  ring-dev-audit-proxy): 29 passed / 1 failed of 30 — the single failure is
  `ring-dev-audit-proxy.test.ts > exposes the fixture helpers`
  (typeof engineFixturePath() is 'undefined'), which fails IDENTICALLY on pristine
  current main (see below). NOT touched, NOT fixed.
- `npm run build:backend`: exit 0.
- `npm run typecheck:gui`: exit 0.
- Pristine-base control (`C:/clean/ring-c-pristine` off the same base, own `npm ci` exit 0):
  `ring-dev-audit-proxy.test.ts` fails 1/1 there too — pre-existing on current main, out of lane.

## git apply --check against a second fresh current-main scratch

- `C:/clean/ring-c-check` off the same base; `git apply --check candidate.patch`: PASS
  (then applied, `npm ci` exit 0, backend typecheck exit 0, `typecheck:gui` exit 0,
  the same 3-file vitest gate 20/20). Patch contains only additions
  (15 files, 1941 insertions, 0 deletions).

## What changed (vs base 6e9bca3) — same lane scope as original Dev C report

- `src/service/ring-safety.ts` (NEW, byte-identical to original Dev C).
- `src/service/ring-roles.ts` (NEW, Dev C + 2-line tool-name update): 4 role personas. Only intentional
  change vs original: `operator.tools` gains `write_shift_handover`; `manager.tools` uses
  `generate_report_docx` + `generate_spreadsheet_xlsx` instead of the non-existent `generate_report`,
  because current main's registry has no `permit_checklist`/`loto_checklist`/`generate_report` tools.
  Permit/loto workflows only READ the SOP (no tool dependency), so no behavior is lost.
- `src/service/ring-skills.ts` (NEW, byte-identical): 6 slash-command templates + manifest.
- `src/service/ring-skill-workflows.ts` (NEW, byte-identical): deterministic server-side workflows
  (T-07 truthful numbers: RMS 2.637, peakV 8.3, peakT 97.2, rows 500, 2 warnings + 2 criticals).
- `src/service/ring-artifact-store.ts` (NEW, byte-identical): artifact store (sha256 from bytes,
  traversal-hardened flat-dir resolution).
- `src/service/ring-agent-service.ts` (+88, additive hunks on the current Dev A/B file): skill-run
  intent fields, `pendingSkillRuns` map, `executeSkillRun` path before `execute()`, `resolveApproval`
  drain (approve writes artifact + `artifact.created`; deny completes with no file).
- `src/api/router.ts` (+97): `GET /api/v1/ring/skills`, `GET /api/v1/ring/roles`,
  `POST /api/v1/ring/skill-runs` (202 + approvalId; refusal 200; unknown 400),
  `GET /api/v1/ring/runs/:id/artifacts/:filename` (escapes 400; missing 404).
  `GET /api/v1/tasks` preserved verbatim (original Dev C patch had deleted it — NOT repeated here).
- `src/service/index.ts` (+9): barrel re-exports appended after Dev B lines.
- `src/api/openapi-spec.ts` (+52): OpenAPI entries for the 4 new routes.
- `demo/industrial/`: P-12 assets COPIED from `C:/clean/ring-dev-c-skills` (present on disk there,
  not re-created): SOP md, maintenance txt, vibration CSV, 2 PNGs. Clearance-checked. NOT wired
  into skills (cut per brief, same as original).
- `tests/industrial/ring-dev-c-safety.test.ts` (NEW, byte-identical): 8-test safety eval + e2e.

## Conflicts resolved (Dev A/B vs Dev C) and how

1. `ring-agent-service.ts` rewritten by Dev A/B: hand-merged (intent fields; `pendingSkillRuns`;
   drain branch at TOP of current `resolveApproval`; new `executeSkillRun`; dispatch guard first
   in current `execute()`). Policy: A wins service core.
2. `router.ts`: Dev A threads block occupies Dev C's old anchor; Dev C routes re-anchored AFTER
   the threads block, before Tasks. `GET /tasks` deletion not carried over.
3. `index.ts`: Dev C exports appended after Dev B `RingThreadService` lines.
4. `openapi-spec.ts`: region untouched by Dev A/B; re-inserted at the same anchor.
5. Role tool names vs Dev B registry: operator/manager lists updated to registered names; no
   registry or tool files touched.
6. Patch hygiene: 5 new modules are NEW files; 4 modified files are additive hunks; PNGs as
   binary payloads. Verified via `git apply --check` + full rebuild on a second scratch.

## Scope cut vs the original Dev C report

- Same cut as original: P-12 drafts adopted as-is, unwired.
- Same as original: no GUI menu wiring (Dev B lane; contract is manifest + GET endpoint).
- Incidental: dropped Dev C's unused `runRingSkillWorkflow` / `parseRingSkillCommand` router
  imports (dead code; router delegates to the agent skill-run path).

## Validation summary

- Lane safety eval 8/8 pass evidence-only.
- Regression gate 20/20 green; `ring-dev-a` 9/10 (1 pre-existing audit-proxy failure, identical
  on pristine base); `build:backend` + `typecheck:gui` exit 0.
- Frozen contracts untouched: `ring-contract.ts`, `ring-tool-registry.ts`, `ring-tools/*`,
  thread shapes, artifact path, T-07 demo files.

## NOT verified

- Live hosted run against Baseten (no key by design, evidence-only only).
- DOCX/XLSX office generation (no engine binary; markdown artifacts by design).
- GUI rendering of the `/` menu against a live backend (Dev B lane).
- P-12 demo-path numbers on camera (adopted but unwired — cut per brief).
