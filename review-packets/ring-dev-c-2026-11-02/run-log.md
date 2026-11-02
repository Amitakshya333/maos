# TASK DEV-C-01 run log — Ring skills, safety, demo (Dev C lane)

- Date (UTC): 2026-11-02
- Worktree: `C:/clean/ring-dev-c-skills` (branch `ring/dev-c-skills`)
- Base commit: `8b39caf36cacdb461504bd54ce66e7f8b9707855` ("Freeze Ring contracts for threads streams and tools"; `git merge origin/main` → already up to date, exit 0)
- `BASETEN_API_KEY`: unset for every command and test run (verified `env | grep -ci baseten` → 0; test files never set it). No live Baseten calls, evidence-only throughout. No commits, no pushes, no tags. Nothing written outside `C:/clean/ring-dev-c-skills` except this packet dir.

## Commands (exit codes)

- `git -C C:/clean/ring-dev-c-skills merge origin/main`: exit 0 (already up to date on `8b39caf`)
- `npm ci --no-audit --no-fund` in the worktree (own `node_modules`): exit 0 (`added 242 packages`)
- `npm run build:backend`: exit 0 (`tsc -p tsconfig.json && node scripts/copy-industrial-python.js`)
- `npm run typecheck:gui`: exit 0 (`tsc -p tsconfig.gui.json --noEmit`)
- `npx vitest run tests/industrial/ring-dev-c-safety.test.ts tests/industrial/ring-agent.test.ts tests/industrial/ring-contract.test.ts`: exit 0 — 3 files, 20 tests, all pass
- Pre-existing failures NOT caused by this lane (verified identical on pristine `8b39caf` via `git stash -u`): `f10-04-public-demo-pack.test.ts` 2 failed / 9 passed (RUNBOOK.md + PRESENTATION_SCRIPT.md hashes drifted on main; `rust/test.txt` canary differs on Windows line endings). NOT touched, NOT fixed (T-07 non-negotiable: do not break T-07).

## What changed (vs base 8b39caf)

- `src/service/ring-safety.ts` (NEW): shared safety policy — evidence-as-data delimiters, restart/certification refusal wording (calm + helpful), missing-data honesty, CSV-row stripping, injection predicates.
- `src/service/ring-roles.ts` (NEW): 4 role personas (`operator|maintenance|safety|manager`) with shop-floor prompts + allowed tool lists (default role `operator`).
- `src/service/ring-skills.ts` (NEW): 6 slash-command prompt templates (`/handover /rca /permit /loto /sop /report`) + `parseRingSkillCommand` + static `RING_SKILLS_MANIFEST` for Dev B's `/` menu.
- `src/service/ring-skill-workflows.ts` (NEW): deterministic server-side workflows (evidence-first; telemetry via frozen `analyzeTelemetryCsv` code path; doc reads wrapped as data with injection surfacing; restart requests refused; consequential skills flag `needsApproval`; T-07 truthful numbers: RMS 2.637, peakV 8.3, peakT 97.2, rows 500, 2 warnings + 2 critical).
- `src/service/ring-artifact-store.ts` (NEW): artifact store (`.maos/ring-runs/artifacts/<runId>/`, sha256 from bytes, traversal-hardened flat-dir resolution).
- `src/service/ring-agent-service.ts`: skill-run execution — `skillName/skillArg/skillRole` context intent, `pendingSkillRuns` map (no dangling promises), `executeSkillRun` workflow path, `resolveApproval` drain (approve → write artifact + `artifact.created`; deny → complete with no file). No frozen behavior changed (all edits additive; original late-path restored verbatim).
- `src/api/router.ts`: `GET /api/v1/ring/skills`, `GET /api/v1/ring/roles`, `POST /api/v1/ring/skill-runs` (consequential → 202 + approvalId; refusal path → 200; unknown skill → 400), `GET /api/v1/ring/runs/:id/artifacts/:filename` (path-checked download; escapes → 400).
- `src/service/index.ts`: barrel re-exports for all Dev C modules. `src/api/openapi-spec.ts`: OpenAPI entries for the 4 new routes.
- `demo/industrial/`: P-12 optional asset files (UNTRACKED drafts adopted as-is: `sop_pump_p12_monitoring.md`, `maintenance_report_p12.txt`, `pump_p12_vibration_log.csv`, `pump_p12_inspection_scan.png`, `images/pump_p12_photo.png`). Clearance-checked (no MRPL/confidential strings; SOP carries the demo disclaimer). NOT wired into skills (cut per brief).
- `tests/industrial/ring-dev-c-safety.test.ts` (NEW, 8 tests): safety eval (refuse restart/certification, no invented readings, approval-before-writes incl. deny-writes-nothing, no raw CSV leaks, prompt-injection SOP) + e2e (skills → roles → skill-run → approval → artifact → audit-handshake → traversal 400/404).

## Validation summary

- Lane safety eval 8/8 pass evidence-only (T-07 `handover` final answer contains `CRITICAL`; approved artifact sha256 matches `^[0-9a-f]{64}$` and exists on disk; deny path writes nothing).
- Regression gate 20/20 green (`ring-agent` 7 + `ring-contract` 5 + `ring-dev-c-safety` 8); `build:backend` + `typecheck:gui` clean.
- Frozen contracts untouched: `ring-contract.ts`, `ring-tool-registry.ts`, `ring-tools/*`, thread shapes, artifact path, T-07 demo files (provenance RUNBOOK/canary mismatches are pre-existing on `8b39caf`, out of lane).
- Manual HTTP probes (throwaway temp roots, evidence-only): skills menu 6 entries, roles 4, unknown skill 400, `/rca` 200 completed, `/handover` 202 → deny → completed/no-file, `/report` 202 → approve → completed + `artifact.created`, artifact download 200 `text/markdown`, `..` traversal refused.

## NOT verified

- Live hosted run against Baseten (no key by design; hosted paths use no mocks in this lane — evidence-only only).
- DOCX/XLSX office generation (no engine binary on this machine; skill artifacts are markdown by design, audit records degrade honestly).
- GUI rendering of the `/` menu against a live backend (Dev B's lane; contract is the static manifest + `GET /api/v1/ring/skills`).
- P-12 demo-path numbers on camera (files adopted but unwired; SOP anomaly rows were factually wrong vs the CSV — cut per brief).
