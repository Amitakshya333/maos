# TASK C-HANDMERGE-01 run log — Dev C Day-2 resolved onto A+B (surgical, ONE hunk hand-merged)

- Setup: fresh scratch `C:/clean/ring-c-handmerge` (detached `ba451de`, exit 0); second scratch `C:/clean/ring-c-handmerge-ab` (same base, exit 0).
- Applied in order: ring-dev-a-day2 `candidate.patch` (SHA-256 `15973ad3…`, exit 0), ring-dev-b-day2 `candidate.patch` (SHA-256 `c9ca1daf…`, exit 0, 1 trailing-whitespace warning at `tests/gui/ring-workspace.test.ts` — stripped, see below).
- ring-dev-c-day2 `candidate.patch` (SHA-256 `5e9eedb7…`) fails at `src/service/ring-agent-service.ts ~808` as predicted: Dev A inserted `generateHostedTurn` + the turn-loop call; Dev C inserted `defaultAssetPaths` + `hostedNeedsTelemetry`/`executeHosted` edits on the same anchor.
- All 7 non-conflicting C files applied clean with `--exclude=src/service/ring-agent-service.ts` (exit 0). The service file was hand-merged hunk-by-hunk (below). `BASETEN_API_KEY` unset for every run. No live calls. No commits/pushes. Nothing written outside the two scratches except this packet dir.

## Merge decisions (ONE conflict hunk + hardened C hunks, all in src/service/ring-agent-service.ts)

Kept BOTH lanes; no logic dropped:

1. `ring-agent-service.ts:331` (C @328, clean context but applied by hand with the rest): C's artifact-filename sanitize kept verbatim — `${(skillIntent.arg || 'asset').trim().replace(...)}`. No A/B overlap here.
2. `ring-agent-service.ts:656` (C @653): C's approval-summary hunk kept HARDENED per assignment: `(arg || '').trim() ? (arg || '').trim() : skill.name` (guards non-string/empty arg; original C used `arg.trim()`).
3. `ring-agent-service.ts:739,741` (C @736): C's `wantsPumpRestart` insert + refusal-gate widening kept (`|| wantsPumpRestart`).
4. `ring-agent-service.ts:751-756` (C @747): C's evidence-only P-12 defaults (`wantsPumpAsset` → csvPath/documentPath) + widened `wantsTelemetry` regex (`pump|p-12` added) kept.
5. `ring-agent-service.ts:851-868` (C @808, THE conflict): kept A's `generateHostedTurn` (831) + A's `await this.generateHostedTurn(provider, run)` turn-loop call (880) AND C's `defaultAssetPaths(run)` method (851) + C's `this.defaultAssetPaths(run)` call in `executeHosted` (868) + C's widened `hostedNeedsTelemetry` regex (861). A's streaming helper and C's asset routing coexist; no lines removed from either.
6. `tests/gui/ring-workspace.test.ts` (B fallout): stripped the one trailing-whitespace line B's patch adds (blank line with two spaces after the `/dev/null` new-file guard test) — `git diff --check` now clean (exit 0). Content unchanged.

## C-only patch construction

- Committed A+B in `C:/clean/ring-c-handmerge-ab` as local scratch commit `ddc3cb0` ("A+B baseline") so the C portion = that commit's tree vs the hand-merged `C:/clean/ring-c-handmerge` tree. Patch built per-file with `git diff --no-index`, paths normalized to repo-relative `a/​/`b/`, verified: `git apply --check` exit 0 on the A+B scratch AND on a third scratch (`C:/clean/ring-c-handmerge-verify` off `ddc3cb0`); applied tree there is byte-identical to the hand-merged tree (`diff -rq` excluding node_modules/.git/dist exit 0).
- Patch: 8 files — the 7 original C files + the 1-line whitespace fix in `tests/gui/ring-workspace.test.ts`. No A/B content included.

## Validation (scratch C:/clean/ring-c-handmerge; node_modules copied from C:/clean/ring-c-day2 — package.json + lock byte-identical, no fresh npm ci needed)

| Command | Exit |
|---|---|
| `npx vitest run ring-dev-c-safety + ring-agent + ring-contract` (assignment gate: ring-dev-c-safety) — 4 files | 0 — 28 passed |
| required: `vitest run ring-dev-c-safety + ring-agent + ring-contract` (incl. new `ring-dev-c-day2.test.ts` 8/8) | 0 — 28/28 (c-safety 8, c-day2 8, agent 7, contract 5) |
| `npm run build:backend` | 0 |
| `npm run typecheck:gui` | 0 |
| `git diff --check` (whitespace) | 0 |
| `git apply --check candidate.patch` on A+B baseline scratch | 0 |

- `BASETEN_API_KEY` unset (verified `echo` before vitest); no live/hosted calls.
- `package.json` identical to Day-2 scratch, so `npm ci` was reused via copy (242 packages) rather than re-run.

## Files in this packet

- `candidate.patch` (37069 bytes; SHA-256 `e8b21072ecf79da71bf74f362341bb193d35989fbcf3899819fe89ba9da8d3db`)
- `run-log.md` (this file, with the exact merge decisions)
- `SHA-256.txt`

## NOT verified

- Live hosted path (no key by design; hosted P-12 default code present, untested live).
- Full test suite / packaging / perf; GUI rendering of P-12 menu entries.
- Rust engine paths.

## Anything outside the assignment

- None. `C:/maos` untouched except this packet dir; no commits, pushes, or tags on any branch. Scratch worktrees (`ring-c-handmerge`, `ring-c-handmerge-ab`, `ring-c-handmerge-verify`) left in place detached/uncommitted (AB scratch has one local scratch-only commit as the diff baseline). Helper scripts (`gen-c-portion.cjs`, `fix-c-patch*.cjs`, `sha-c-patch.cjs`, `write-*.cjs`, `c-portion.patch`) remain in the agent's own worktree only, NOT in `C:/maos`.
