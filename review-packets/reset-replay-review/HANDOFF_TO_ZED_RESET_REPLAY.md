# Zed re-review — reset/replay consistency

**Status: implementation and local validation pass; independent source approval remains PENDING.** This packet addresses reset/output serialization, current-success idempotency replay, and the T-07 busy verdict. The deterministic RC archive was not rebuilt or changed. No model, browser or package rehearsal was run.

## Source and packet identity

- Repository: `C:/maos`; HEAD and declared base: `f9525055c56a7f7771dd2fa029c147c2960a98a3`.
- Current canonical UTF-8/LF patch: `artifacts/verification/agent-gui-2026-10-27/reset-replay-canonical.patch`, SHA-256 `a80046ad68246c14c15adef5117437488317869a86220c9ef44ab5c082bedf65`.
- Current source manifest: `artifacts/verification/agent-gui-2026-10-27/reset-replay-source-hashes.json`, SHA-256 `fa817d567cd039768bfed2517d853ffc18270155b2a2c342ac114b19a7b3f825`.
- Canonical scope: 72 paths (50 tracked changes, 22 new files). Isolated clean-base application, reverse check and diff check passed. All 72 source files match after LF normalization; 32 also match byte-for-byte. The other 40 differ only by CRLF/LF. There are no normalized content mismatches.
- Separate follow-up patch: `reset-replay-followup.patch`, SHA-256 `a3738009bb73395b9d6993744c9462422f5dab85d32bf76edc306d05c1de9569`. Its exact base is `f9525055c56a7f7771dd2fa029c147c2960a98a3` plus the prior `concurrency-canonical.patch` (`65a8af3372eb4fdafcb9cb2dbb122481e1785cf3df70cf39384f0fbe343cba7d`) and its manifest (`878c4cd3503ce2b667b7e93f42dceb2aae8448324425a5b8920b0eb5c28b6aa0`). It changes 14 scoped files:
  - `src/api/middleware.ts`, `src/api/router.ts`, `src/gui/src/api/rest-client.ts`
  - `src/industrial/deterministic-reset.ts`, `src/industrial/industrial-cli.ts`, `src/industrial/judged-run.ts`, `src/industrial/judged-run-lock.ts`, `src/industrial/atomic-cleanup-coordinator.ts`
  - `src/service/artifact-service.ts`, `src/service/retention-service.ts`
  - `tests/f3-05-artifact-store.test.ts`, `tests/gui/ui1-10-evidence-retention.test.ts`, `tests/industrial/f10-05-deterministic-reset.test.ts`, `tests/industrial/analysis-agent-auth-http.test.ts`
- Prior packets and their hashes remain unchanged historical records. The refreshed packet comparison and 30 command results are in `reset-replay-validation-2026-10-28/packet-source-comparison.json` and `packet-reproduction-final.txt`.

## Finding 1 — serialize reset and output cleanup

**RESOLVED LOCALLY; independent review pending.** Current acceptance is derived from the persisted judged-run manifest, matching terminal audit history and validated source/approval/output evidence. Reset does not rewrite a historically completed manifest as an engineering failure. Removing or corrupting its deliverable makes current acceptance false, and list/content/download/verification paths reject or omit it.

`withJudgedRunOutputLock` in `src/industrial/judged-run-lock.ts:166` is the project-level cross-process guard. The shared order is **project-output → T-07 shared-output → per-run**. Preparation, approval/finalization, resume/recovery, T-07 API/CLI/dashboard execution, and current-success replay acquire it before reading or changing their relevant authoritative state. Reset holds it across candidate discovery, deletion and reset audit append in `src/industrial/deterministic-reset.ts:335`. Lock acquisition failures do not fall through to unlocked deletion.

Destructive-path inventory:

- The supported `maos industrial reset` and standalone `maos-industrial reset` CLI commands use `runIndustrialReset` → `executeDeterministicReset`; categories are queue, output, index, sandbox and conversation (`src/industrial/deterministic-reset.ts:27`, `src/cli/index.ts:842`, `src/industrial/industrial-cli.ts:846`). Live deletion still requires `--yes`; dry-run is read-only. A locked reset reports busy through the CLI and does not mark a judged run failed.
- `maos clean` only cleans task queue/status/log state. Settings/layout reset endpoints do not delete generated deliverables.
- Artifact temp cleanup also runs at `ArtifactService` startup and through service/force-stop/atomic-cleanup paths. `ArtifactService.cleanupOrphanTempFiles` now uses the same guard (`src/service/artifact-service.ts:661`); if the lock is busy/unavailable it defers and returns zero, without deleting. `AtomicCleanupCoordinator` no longer bypasses this guard with a second direct deletion of `artifacts/.tmp` (`src/industrial/atomic-cleanup-coordinator.ts:321`).
- Retention purge can delete old files under `artifacts/.tmp`. Mutating artifact-preview and all-expired purges now hold the project-output lock for the whole operation (`src/service/retention-service.ts:236`); dry-run remains non-destructive and unlocked. The HTTP route reports busy as 409 and lock unavailability as 503 (`src/api/router.ts:804`). Finalized office deliverables retain the existing retention protection.

Barrier tests cover reset during DOCX finalization and a separate CLI process during the terminal-audit/acceptance window. A reset immediately after completion leaves the manifest historically `completed`, records a reset audit event, removes the DOCX and causes artifact listing, detail/content download and current-run verification to report unavailable. Temporary artifact and retention cleanup tests verify that a held output lock prevents deletion.

**Limits:** locks use same-host, local-filesystem coordination with same-directory hard links. Multi-host and network-filesystem coordination is unsupported. A crash during physical reset can leave some files deleted before others; there is no transaction across filesystem and audit-chain writes. If the process crashes after deletion but before reset-audit append, acceptance still fails closed from missing output/hash, but the reset event can be absent. Ambiguous/live lock owners fail closed and may require manual recovery. No cross-file atomicity is claimed.

## Finding 2 — current-acceptance-aware replay

**RESOLVED LOCALLY; independent review pending.** The route-specific durable replay hook runs for successful judged-run start and approval responses only (`src/api/middleware.ts:196`, `src/api/router.ts:105`, `:440`, `:1874`). It checks current acceptance while holding project-output then run locks. The service container always supplies the durable idempotency store. A valid accepted run replays its original result. Source mutation, output corruption, or authorized reset returns HTTP 409 `JUDGED_RUN_NOT_ACCEPTED`; lock contention returns 409 `JUDGED_RUN_BUSY`. The historical idempotency record remains intact, work is not rerun, and no approval/output/terminal audit event is duplicated. Busy leaves the original idempotency record unchanged.

`tests/industrial/analysis-agent-auth-http.test.ts:1163` verifies unchanged success replay, source/output invalidation, no rerun and a single terminal event. `:1193` verifies reset invalidation; `:1237` barriers a replay against a separate CLI reset process. Finalization duplicate requests cover missing, equal and different idempotency keys earlier in the same file. Replays observe a consistent acceptance snapshot under the shared lock.

## Finding 3 — contention verdict

**RESOLVED LOCALLY; independent review pending.** When T-07 cannot acquire output/run coordination, `executeJudgedRun` returns `success:false`, `status: in_progress`, `overallVerdict: UNAVAILABLE`, and the lock error (`src/industrial/judged-run.ts:761`). The authenticated API test asserts the actual response is not FAIL (`tests/industrial/analysis-agent-auth-http.test.ts:1267`). A genuine completed engineering result of FAIL/CRITICAL remains unchanged.

## Validation evidence

Final affected regression command:

```text
npm exec -- vitest run tests/industrial/analysis-agent-auth-http.test.ts tests/industrial/f10-05-deterministic-reset.test.ts tests/industrial/judged-run-lock.test.ts tests/industrial/f10-06-judged-run.test.ts tests/f3-05-artifact-store.test.ts tests/gui/ui1-10-evidence-retention.test.ts tests/industrial/f6-02-generate-docx.test.ts tests/industrial/analysis-agent-contract.test.ts tests/industrial/analysis-agent-service.test.ts tests/f3-07-verifier-idempotency.test.ts tests/router.test.ts
```

**PASS — 11 files, 195 tests, no skips** (`reset-replay-validation-2026-10-28/affected-vitest-final.txt`). This is the distinct count for the current source. The focused two-test cleanup command also passed (52 tests were filtered/skipped by name and are not counted); it overlaps the final command. Its first attempt failed during the retention suite setup because the temporary fixture lacked `.maos/maos.config.json`; the fixture was corrected and both the focused rerun and full affected command passed. The initial failure was test setup, not product behavior.

Build and source checks:

- `npm run build:backend` — PASS, exit 0 (`build-backend-final.txt`).
- `npm run typecheck:gui` — PASS, exit 0 (`typecheck-gui-final.txt`).
- `npm run build:gui` — PASS, exit 0 (`build-gui-final.txt`); Vite reports the existing 515.42 kB chunk-size warning.
- `node artifacts/verification/agent-gui-2026-10-27/reset-replay-validation-2026-10-28/check-scoped-whitespace.cjs` — PASS, exit 0 over 50 manifest-tracked files (`scoped-diff-check-final.txt`); Git emitted CRLF/LF normalization warnings only.
- `node artifacts/verification/agent-gui-2026-10-27/reset-replay-validation-2026-10-28/reproduce-reset-replay-review-packet.cjs` — PASS. The canonical patch and separate follow-up both passed clean-copy apply-check, apply, reverse-apply-check and diff-check; all 72 source files matched normalized manifest hashes. Raw-byte equality is 32/72 because 40 files differ only in line endings.

The first focused cleanup attempt is retained as `output-cleanup-focused.txt` (failed suite setup); the corrected run is `output-cleanup-focused-rerun.txt`. No browser/package rehearsal, model inference, install, archive, staging, commit, push, publication or submission occurred. `HEAD` remains the declared base and the index is empty. Existing dirty `.maos` files and unrelated working-tree work were preserved and excluded from the packet.

## Proposed checkpoint boundaries (not created)

1. Candidate foundation: the prior 67-file `concurrency-canonical.patch` and its exact manifest, as one prerequisite checkpoint.
2. Reset/replay follow-up: the 14-file `reset-replay-followup.patch` above, dependent on boundary 1.
3. Keep checklist and generated verification evidence outside source commits unless the owner requests a separate evidence commit.

Do not treat these boundaries as approval to commit. A focused independent Zed source re-review is still required. Live local/Meta inference, licensing, browser, packaging and submission readiness remain separate gates.
