# Zed handoff — cleanup, checkpoint reset, dashboard contention

**Request:** delta-only independent source re-review for the bounded P2/P3 corrections below. Do not treat local tests as independent approval. The deterministic RC and previously reviewed publication/reset/idempotency work remain preserved.

## Snapshot and packet provenance

- Repository: `C:\maos`; declared base / current HEAD: `f9525055c56a7f7771dd2fa029c147c2960a98a3`.
- Exact latest reviewed parent: `shared-boundaries-canonical.patch`, SHA-256 `96fdbeb470c3862248021602707b6f657ec77893e9d76f7d948d4f2d77501e01`; manifest `shared-boundaries-source-hashes.json`, SHA-256 `f15af24c01a5c3cdff3ff911c6bb0381df553c15e43617174ac4e6ecdddb3fc2`. Parent scope is 94 files.
- Parent-relative delta: `cleanup-checkpoint-delta.patch`, SHA-256 `2e0a8d36449687b5e4c99232d681155d7c1f55d8f15d2c99f8b4dce546c7e98d`; manifest `cleanup-checkpoint-delta-source-hashes.json`, SHA-256 `3b318c4680ba9e2a96c1b6c4024d1cc5792a08fefa6a869d46eb9e2394464aef`. It is explicitly based on the parent patch and manifest hashes above, not directly on HEAD.
- Refreshed base-to-candidate packet: `cleanup-checkpoint-canonical.patch`, SHA-256 `a1e32ed71ea29540d29159e4e8afc8d6ae3eeaac3ffbde9d6dede6302e8e6ace`; manifest `cleanup-checkpoint-canonical-source-hashes.json`, SHA-256 `c1d8eb2182218f4c80a45cbc772404ac3cf293af47ebaaa47dbca63ceaedaa8e`. It contains 99 scoped files: 77 tracked modifications and 22 additions.
- The 13-file delta contains eight edits to files already in the 94-file parent and five tracked paths absent from that parent scope: `src/cli/dashboard-template.ts`, `src/industrial/lifecycle.ts`, `src/industrial/service-startup.ts`, `tests/f2-08-lifecycle.test.ts`, and `tests/industrial/f10-02-dashboard-trigger.test.ts`. The latter five are included as base-revision-to-current hunks. No unrelated dirty files, private `.maos` state, checklist, or evidence is in the delta.
- Clean-copy reconstruction passed for both packets. Parent plus delta applies and reverse-checks; all 99 candidate paths match current content after LF normalization (99/99), with raw-byte equality on 37/99. The other raw differences normalize exactly to LF. The refreshed canonical packet applies from the declared base, reverse-checks, has the exact 99-path scope, and matches 99/99 LF hashes (37/99 raw). There are no non-line-ending content mismatches.
- Reproducible scripts and actual JSON output are under `cleanup-checkpoint-validation-2026-10-28/`: `build-cleanup-checkpoint-delta.cjs`, `build-cleanup-checkpoint-canonical.cjs`, `reproduce-cleanup-checkpoint-canonical.cjs`, `delta-packet-build-final.json`, `canonical-packet-build-final.json`, and `canonical-packet-reproduction-final.json`. Delta builder output records its apply/reverse/content comparison. Existing packets were not overwritten; the old parent files retain their original hashes.

## Findings and bounded changes

### P2 — force bypass of a live lifecycle lock: fixed locally

`src/industrial/lifecycle.ts:145-244` uses the shared project-output lock around lifecycle lock creation, stale reclamation, and release. `removeAbandonedLifecycleLockUnderProjectOutputLock()` only removes a parseable, same-host lock when its PID is confirmed dead and it is at least 30 seconds old. `src/industrial/service-startup.ts:328-334` treats `EPERM` and any non-`ESRCH` process-liveness error as possibly alive. Malformed, foreign-host, recent, or ambiguous ownership fails closed. `src/industrial/atomic-cleanup-coordinator.ts:309-385,396-516` uses the same guard for orphan cleanup; `force` remains a compatibility option and cannot override lifecycle ownership or terminate the owner.

`tests/industrial/f9-08-interruption-atomic-cleanup.test.ts:712-800` covers forced cleanup preserving a live owner, a child lifecycle command being refused while the owner holds the lock, same-host dead-owner reclamation, EPERM-as-alive, foreign-host and malformed ownership. The existing lock/ownership tests in `tests/f2-08-lifecycle.test.ts` now use the current host identity. The full F2-08 suite was not executed because its before/after hooks delete state and lock files under the repository `.maos`; the F9 tests use temporary projects and exercise the relevant lock behavior.

**Limit:** coordination is the existing single-host/local-filesystem project-output guard. A non-MAOS actor that ignores this lock is outside this guarantee. Ambiguous lock records require manual inspection; no age-only stealing is supported.

### P2 — checkpoints omitted from queue reset: fixed locally

`src/core/checkpoint.ts:26-27,83` now shares `getCheckpointsDir()` from `src/utils/paths.ts:53-54`; `src/industrial/deterministic-reset.ts:5,205-213` adds precisely `.maos/checkpoints/**` to the queue category's existing allowlist, under the same project-output guard as queue scan/deletion. No unrelated private state was added to the allowlist. `tests/industrial/f10-05-deterministic-reset.test.ts:386-425` creates a task and meaningful checkpoint through APIs, resets queue state, reuses the explicit ID, interrupts the new attempt before a replacement checkpoint, then recovers; the old checkpoint is absent and the new task is requeued, not completed.

### P3 — interrupted entries do not establish worker quiescence: fixed by conservative refusal

`src/service/task-service.ts:194-224` and `src/industrial/deterministic-reset.ts:386-420` refuse cleanup while any non-hidden active-directory entry remains, including `interrupted`. Their messages explain that status alone does not confirm worker exit, and direct the operator to stop the owning MAOS worker, let it exit, restart MAOS to recover orphaned work, then retry. `tests/industrial/f10-05-deterministic-reset.test.ts:427-460` verifies reset and `TaskService.clean()` leave the interrupted entry and checkpoint intact.

**Separate unchanged risk:** `src/core/checkpoint.ts:179-257` still has the existing recovery heuristic that marks a task done at 60% or more when the checkpoint lists any changed files. This assignment ensures the old task checkpoint is removed before ID reuse; it does not redesign or validate that broader completion policy.

### P3 — legacy Industrial dashboard reports contention as ordinary failure: fixed locally

`src/cli/dashboard.ts:178-202,318-333` serializes `JUDGED_RUN_BUSY` as HTTP 409 `in_progress` and lock unavailability as HTTP 503 `unavailable`, both with verdict `UNAVAILABLE` and structured details. `src/cli/dashboard-template.ts:1035-1051` shows the actual message, distinguishes busy from unavailable, and refreshes while busy. `src/cli/index.ts:514-522` reports `maos clean` refusal and returns nonzero instead of throwing an opaque command error. `tests/industrial/f10-02-dashboard-trigger.test.ts:144-174` covers busy, lock unavailable, and a real engineering FAIL. The route remains supported; it is not silently reclassified as an ordinary failed dispatch.

## Exact changed source/test files

- `src/industrial/lifecycle.ts`
- `src/industrial/service-startup.ts`
- `src/industrial/atomic-cleanup-coordinator.ts`
- `src/core/checkpoint.ts`
- `src/service/task-service.ts`
- `src/industrial/deterministic-reset.ts`
- `src/cli/dashboard.ts`
- `src/cli/dashboard-template.ts`
- `src/cli/index.ts`
- `tests/f2-08-lifecycle.test.ts`
- `tests/industrial/f9-08-interruption-atomic-cleanup.test.ts`
- `tests/industrial/f10-05-deterministic-reset.test.ts`
- `tests/industrial/f10-02-dashboard-trigger.test.ts`

Checklist update: `docs/MAOS_INDUSTRIAL_EXECUTION_CHECKLIST.md`, Slice 12.

## Validation retained

Final focused regressions:

```powershell
npm exec -- vitest run tests/industrial/f9-08-interruption-atomic-cleanup.test.ts tests/industrial/f10-05-deterministic-reset.test.ts tests/industrial/f10-02-dashboard-trigger.test.ts --reporter=verbose
```

Pass: 3 files, 64 tests, 0 skipped; output is `cleanup-checkpoint-validation-2026-10-28/focused-regressions-final.txt`.

Task-service clean regression:

```powershell
npm exec -- vitest run tests/f3-01-services.test.ts -t 'should clean all queues' --reporter=verbose
```

Pass: 1 test; 27 tests were skipped by the name filter and are not counted as passes. Output is `task-service-regression.txt`.

Also passed: `npm run build:backend`, `npm run typecheck:gui`, `npm run build:gui`, and `git diff --check` (exit 0). The existing GUI chunk-size warning remains (515.99 kB). Logs are in the same validation directory.

The first combined attempt is retained as `focused-regressions.txt`: 85 passed / 10 failed. Six dashboard tests failed because the new temporary test project lacked MAOS configuration; two lifecycle cleanup cases exposed test fixture/order residue; one reset test asserted against the wrong checkpoint path after reset; the remaining failure was the unmodified F3-01 “non-initialized project” case, where `createServiceContainer(emptyDir)` throws at construction for missing `.maos/maos.config.json` before the test's `isInitialized()` assertion. The first three fixture/assertion classes were corrected and the final focused run passes. The F3-01 source was not changed or baseline-verified, so do not label it proven pre-existing. `focused-regressions-rerun.txt` is an intermediate 67-pass run containing a duplicate dashboard contention block; only the final 64-pass run counts.

For the previous broad accounting, retain the 19-file/378-pass result plus separate 1-file/3-pass provider result as 20 files/381 distinct passes. The same four-file focused output is retained at 109 passes (13:05:31) and 110 passes (13:07:36); neither contains per-test names, so evidence cannot attribute the one-test difference. They overlap and must not be added to each other or to the broad total. Their exact counts/timestamps are corrected in Slice 11/12 of the checklist.

## Proposed local checkpoint boundaries (not authorized to create)

1. **Lifecycle ownership and queue/reset safety (10 source/test files):** `src/industrial/lifecycle.ts`, `src/industrial/service-startup.ts`, `src/industrial/atomic-cleanup-coordinator.ts`, `src/core/checkpoint.ts`, `src/service/task-service.ts`, `src/industrial/deterministic-reset.ts`, `src/cli/index.ts`, `tests/f2-08-lifecycle.test.ts`, `tests/industrial/f9-08-interruption-atomic-cleanup.test.ts`, `tests/industrial/f10-05-deterministic-reset.test.ts`.
2. **Legacy dashboard contention (3 source/test files):** `src/cli/dashboard.ts`, `src/cli/dashboard-template.ts`, `tests/industrial/f10-02-dashboard-trigger.test.ts`.
3. Keep the checklist and packet/evidence as review material outside the source checkpoint unless the repository's owner chooses to retain those separately. The 99-file canonical packet remains the reproducible full candidate and includes the reviewed parent prerequisites.

## Remaining blockers and state

- Independent delta review: **PENDING**; this handoff does not claim reviewer approval.
- Unfiltered F3-01 `should detect non-initialized project` failure remains unresolved and was not proven against the declared base.
- Full F2-08 test file was intentionally not run due its repository `.maos` cleanup hooks.
- Checkpoint completion heuristic above remains unchanged.
- HEAD remains the declared base; index is empty. The checkout remains broadly dirty from earlier work, including modified `.maos/maos.config.json` and `.maos/pool.json`; their contents were not inspected or changed, and this slice's tests used temporary projects. No staging, commit, push, release archive, model installation, publication, browser rehearsal, or package rehearsal occurred. Frozen deterministic RC hash remains `70a476151e72dabd8f8a8e11faea6fa3bb9337abbbb2f652336c08a990fed360`. Repository/index/status and packet/archive hashes are retained in `cleanup-checkpoint-validation-2026-10-28/final-state.json`.
- These results do not establish live-model, production, packaging, or submission readiness.
