# Zed handoff — shared-boundary fixes and stable evidence

Captured 2026-10-28 13:23:59 +05:30 (`2026-10-28T07:53:59.183Z`) from repository `C:\maos`, branch `main`, HEAD/base `f9525055c56a7f7771dd2fa029c147c2960a98a3`. The index is empty. The working tree still contains prior candidate work, private local changes and unrelated proposal prose; this packet deliberately excludes those categories. The frozen deterministic RC was not changed or repackaged; its archive SHA-256 remains `70a476151e72dabd8f8a8e11faea6fa3bb9337abbbb2f652336c08a990fed360`.

## Finding resolution

| Finding | Local result | Evidence |
|---|---|---|
| Missing review evidence | **Availability resolved; original deletion event unproven.** The required verification folder lived under ignored `artifacts/`; `.gitignore:54` ignores that parent and nested negations do not restore it. No exact deletion operation was established. The current packet is under `review-packets/reset-replay-review/`, which is outside reset/retention targets and not ignored. | `validation-shared-boundaries-2026-10-28/preserved-evidence-check-final.txt`; `VALIDATION_START.json` |
| Publication/reset coordination | **Resolved locally.** The canonical project-output lock covers publication, cleanup and the complete queue/output reset scan/delete/audit operation. Unsupported reset categories fail with an actionable error. | `tests/industrial/f10-05-deterministic-reset.test.ts`; `src/industrial/judged-run-lock.ts`; `src/industrial/deterministic-reset.ts` |
| Idempotency identity | **Resolved locally.** Replay identity includes canonical project, project ID, method, canonical target path/resource (including approval ID), and canonical request payload. Old records without sufficient context fail closed. | `src/api/middleware.ts`; `src/core/idempotency-store.ts`; `tests/industrial/analysis-agent-auth-http.test.ts` |
| Busy attempt poisoning | **Resolved locally.** Only the matching active claim token can be made retryable; completed records are preserved. Same-key retry after busy is covered. | `src/core/idempotency-store.ts:292`; `src/api/router.ts:498`; `tests/industrial/analysis-agent-auth-http.test.ts:832` |
| Reset queue paths/reporting | **Resolved locally.** Reset uses shared queue paths, refuses active work, separates scanned from confirmed removed bytes, and tests partial deletion/disappearing candidates. | `src/industrial/deterministic-reset.ts:399`; `tests/industrial/f10-05-deterministic-reset.test.ts` |
| Lock-unavailable result | **Resolved locally.** T-07 returns unavailable/in-progress with engineering verdict `UNAVAILABLE`; GUI API errors retain structured details. | `src/api/router.ts:481`; `src/gui/src/api/errors.ts`; `src/gui/src/views/CockpitView.tsx:106`; `tests/gui/ui1-02-api-clients.test.ts` |

Independent Zed source approval remains **PENDING**.

## Evidence availability investigation

The missing packet was under `artifacts/verification/agent-gui-2026-10-27/`. The `artifacts/` ignore at `.gitignore:54` applies before its nested unignore rules, so a clean checkout cannot obtain that directory from Git. Runtime reset does not scan `.maos/audit` or `artifacts/verification`. The evidence does not establish a particular delete operation; the most supportable cause is that the packet was never transferred as a tracked file. Separately, the F9/G9 tests previously wrote evidence into repository-level verification paths and F9-08 rooted its temp project inside repository `.maos`. Those fixtures now write only in OS-temporary projects. No runtime artifact cleanup was broadened to touch review evidence.

At validation start, the four tracked historical files remained unchanged:

- `artifacts/verification/G9-evidence.json` — `baa4eff91a9f9ab97356caa1744cc61b794e6b0b83cdae89d3013520047a0608`
- `artifacts/verification/G9-evidence.zip` — `02bd8aef71096843a33fa794418106e5a2f1516f019c89d0f4e49f61fea4691e`
- `artifacts/verification/G9.md` — `6bdd867c5889e9fc9ea0188d95dc2cfc6bfa4496fe62811022bd5acc217d397e`
- `artifacts/verification/F9-09-rehearsal.json` — `d03ff73ebeebf0dc6c33400c63437f08387d35e8f561fb7ddf6143958bab02ad`

All four and all 30 packet/evidence files listed in the pre-validation snapshot matched their recorded hashes (34/34). The snapshot records repository root, HEAD and time `2026-10-28T13:03:26.307+05:30`.

## Writer/deleter coordination matrix

| Operation | Shared boundary | Current handling |
|---|---|---|
| Judged-run preparation, approval/finalization, resume, recovery and T-07 | `withJudgedRunOutputLock` → T-07 shared-output lock where applicable → per-run lock | Same logical run is serialized before authoritative state access. Busy never becomes engineering FAIL. Lock failure is closed. |
| Generic artifact/DOCX publication | `ArtifactService.finalizeArtifact` takes the project-output lock; DOCX generation reaches the same artifact registration service | Registration and finalization cannot race a supported reset or cleanup. |
| Artifact previews and orphan temp cleanup | `ArtifactService.cleanupOrphanTempFiles`, `RetentionService.purge`, and `AtomicCleanupCoordinator.cleanupOrphanFiles` use the project-output lock | Same async operation reuses the lock; another process sees busy and defers cleanup. Bundle staging cleanup occurs inside the coordinator’s project lock. |
| Reset | `executeDeterministicReset` owns the project-output lock across scan, active-queue check, delete, audit and result accounting | Only `queue` and `output` are enabled. `index`, `sandbox`, and `conversation` fail with `RESET_CATEGORY_UNSUPPORTED` until their writers are coordinated. Dry-run is non-destructive; `--yes` remains required for deletion. |
| Tasks, queues and retries | `TaskService`, core queue create/move helpers, retry queue helpers, and CLI `clean` | Shared queue paths; active task reset/clean is refused. Cross-process queue writer is covered. |
| Events, checkpoints, objectives and workflow plans/status | EventStore, checkpoint, objective store, WorkflowPlanningService and WorkflowService | Mutations use the same project-output lock; cross-process event/checkpoint attempts fail busy during reset. Orchestrator deletion paths use it too. |

The supported lock order for judged output is project-output → T-07 shared-output → per-run. The lock uses same-directory hard links and conservative same-host PID ownership/reclamation. This is a **single-host local-filesystem** boundary; multi-host and network-filesystem guarantees are not claimed. A process failure or ambiguous ownership can leave cleanup unavailable pending inspection. It is not a transaction across files, audit storage and manifests. A crash during reset may leave partial physical deletion; accepted availability is rechecked from current artifacts and reset history.

## Reset and replay behavior

- Queue/output reset uses the same shared queue-path helper as TaskService. Active work is refused rather than deleted.
- `scannedBytes` reports the candidate snapshot; `removedBytes` increases only after successful `unlink`. A candidate disappearing before deletion and a failed deletion are separately exercised.
- Current success replay is checked under the output/run locks. Unchanged accepted output replays. Source mutation, artifact deletion/corruption or authorized reset returns `JUDGED_RUN_NOT_ACCEPTED`; it does not rerun the operation or erase the historical idempotency result.
- Middleware identity is canonical project identity + project ID + HTTP method + canonical URL/resource path + canonical JSON body. Approval IDs in the URL participate. It does not include tokens or timestamps.
- A fresh busy/lock-unavailable claim becomes `retryable` only if the route still owns that claim token. It does not delete completed records or allow another claimant to release the claim. Different key/body/route/resource contexts conflict; insufficient legacy context fails closed.
- T-07 busy serializes as `in_progress` with verdict `UNAVAILABLE`; lock unavailable serializes as `unavailable` with verdict `UNAVAILABLE`. Genuine calculation FAIL/CRITICAL is preserved.

## Validation

Final broad command passed **19 files, 378 tests, 0 skipped**. The separate provider/model-identity regression passed **1 file, 3 tests**. Distinct total: **20 files, 381 tests, 0 skipped**. Exact commands and sanitized output are in `validation-shared-boundaries-2026-10-28/affected-regressions-final.txt` and `provider-identity-regression-final.txt`; the overlapping 4-file/110-test focused rerun is not added. The broad suite includes reset, cross-process publication/cleanup and queue/event/checkpoint writers, active task refusal, idempotency replay, judged-run, authenticated HTTP, artifact/DOCX, retention and the isolated F9/G9 suites. The provider test confirms the earlier model-identity provenance fix remains intact.

Builds passed:

- `npm run build:backend` — exit 0
- `npm run typecheck:gui` — exit 0
- `npm run build:gui` — exit 0; Vite retains the existing 515.99 kB chunk-size warning
- `git diff --check` — exit 0; Git emitted CRLF normalization notices only

The first broader attempt failed and is retained as `affected-regressions-current.txt`: it exposed same-context reentrancy assertions that expected a false busy result, missing `.maos/maos.config.json` in temp projects, a test path evaluated before setup, and the old F9-08 fixture rooted in repository `.maos`. Those assertions/fixtures are corrected in the scoped tests; the final 19-file run is clean. All Vitest commands exited; no standalone service was launched or intentionally left running.

## Canonical packet and provenance

- Patch: `shared-boundaries-canonical.patch`
- Base: `f9525055c56a7f7771dd2fa029c147c2960a98a3`
- Patch SHA-256: `96fdbeb470c3862248021602707b6f657ec77893e9d76f7d948d4f2d77501e01`
- Manifest: `shared-boundaries-source-hashes.json`
- Manifest SHA-256: `f15af24c01a5c3cdff3ff911c6bb0381df553c15e43617174ac4e6ecdddb3fc2`
- Scope: 94 files (72 tracked changes, 22 new files). Complete path/raw/LF hash inventory is in the manifest.

Isolated reproduction materialized only scoped tracked blobs from the declared base into a disposable temp checkout; it did not copy/read `.maos` state or touch the source index/worktree. `git apply --check`, apply, reverse-check, and scoped path comparison passed. All 94/94 files match LF-normalized manifest content. 37/94 match raw bytes; 57 differ only by LF/CRLF representation. The successful run is retained in `validation-shared-boundaries-2026-10-28/packet-reproduction-final.txt`; the earlier script-classification attempt is retained separately and explains that raw-only line-ending differences are not content mismatches. Current source-hash recheck is also 94/94 raw and LF matches. `validation-shared-boundaries-2026-10-28/FINAL_STATUS.json` records root/HEAD/index, hashes, tests, protected-evidence check and frozen-RC hash.

The scope contains the agent-to-deliverable prerequisites and shared-boundary changes so the source can be reconstructed as one candidate. It excludes `.maos` private/local state, demo planning/readiness prose, hackathon submission draft, proposed product specs, this checklist, review evidence and frozen RC artifacts. Prior packets and hashes are retained as historical records; this packet supersedes them for the current review.

## Proposed checkpoint boundary and gates

After independent review, the safest local checkpoint is one scoped source checkpoint of the 94 manifest files: the API/router and idempotency changes overlap agent-to-deliverable and reset semantics, so splitting by feature would require fragile partial-file/hunk boundaries. Keep checklist, handoff and raw validation evidence as review attachments, not source commit content. No stage or commit is authorized by this handoff.

Independent source approval: **PENDING**. Live local model: **not approved / not run**. Hosted Meta: **blocked pending active credit and provider-enforced no-overage confirmation**. Browser/package release rehearsals, recording, legal clearance, eligibility and submission were not addressed or newly verified in this slice. Frozen deterministic RC remains unchanged.
