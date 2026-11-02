# TASK DEV-B-REBASE-02 — Dev B-only patch vs current main (8e6a403)

Base commit: `8e6a4039d57c17c023abe49b0aec75190e6284fb` ("Add Ring brain tools and threads", main HEAD — already contains Dev A).
Problem with the previous deliverable: combined A+B vs `8b39caf` cannot apply on top of `8e6a403` (Dev A is already committed). This packet is the B-only delta.

## Setup (scratch only; C:/maos sources untouched; no commits/pushes)

- `git -C C:/maos worktree add --detach C:/clean/ring-b-only 8e6a403` → exit 0
- Resolved source: `C:/clean/ring-ab-rebase` (A+B resolved; prior validation 54 tests / typecheck 0 / build 0). Confirmed it holds exactly the B delta vs `8e6a403`: 9 modified + 7 new files, matching the Dev B file set, nothing else.
- Copied the resolved Dev B files over the fresh scratch (`desktop/`, `src/gui/`, `src/service/`, `tests/gui/` subtrees); status in `ring-b-only` shows exactly the 16 expected paths.
- Patch generation: staged intent-to-add for the 7 new files (no commit), then `git -C C:/clean/ring-b-only diff HEAD -- <16 dev-b paths>` → `C:/maos/review-packets/ring-b-only-2026-11-02/candidate.patch` → exit 0, 136067 bytes, 16 files, 2759 insertions / 29 deletions.

## Verify (fresh second scratch C:/clean/ring-b-verify @ 8e6a403)

- `git -C C:/maos worktree add --detach C:/clean/ring-b-verify 8e6a403` → exit 0
- `git -C C:/clean/ring-b-verify apply --check candidate.patch` → exit 0 (CLEAN against current main)
- `git -C C:/clean/ring-b-verify apply candidate.patch` → exit 0; status shows exactly the 16 B paths.
- node_modules: reused via copy from `C:/clean/ring-ab-rebase` (exit 0); `package.json`/`package-lock.json` identical to base in both trees (no diff vs `8e6a403`) → `npm ci` skipped per the assignment allowance, recorded here.
- `npm --prefix C:/clean/ring-b-verify run test -- tests/gui/ring-devb-surface.test.ts tests/gui/ring-workspace.test.ts tests/gui/ring-impl-01.test.ts tests/gui/ui1-25-truthful-readiness.test.ts` → exit 0; 4 files, **54 passed** (28 devb incl. the EventService fan-out test; 11 workspace incl. 2 Dev A thread-UI tests; 12 impl-01; 3 ui1-25). Benign stderr: `ECONNREFUSED 127.0.0.1:3847` lines during the devb-surface run; all tests green.
- `npm --prefix C:/clean/ring-b-verify run typecheck:gui` → exit 0.
- `npm --prefix C:/clean/ring-b-verify run build` → exit 0 (tsc + vite, built in ~1s; only the pre-existing >500 kB chunk-size warning).
- Note: a bare `npm exec -- vitest` issued from outside the tree fails to resolve `vitest.config.ts` (cwd artifact — it needs the package script's cwd); the supported `npm run test --` path above is the recorded gate.

## Resolution notes (carried over from the A+B rebase — unchanged in this B-only cut)

- `maos:initialize` fix: the overlay is a SECOND Electron window with its OWN main frame; the old check compared every sender against the main window's `mainFrame`, so the overlay could never complete the session handshake. Each sender is now checked against its own main frame; the loopback-origin check is unchanged.
- `RoleOnboardingModal` deliberately NOT reused: it manages workspace layout presets, a different domain from Ring agent roles (`operator|maintenance|safety|manager`).
- Voice (push-to-talk) CUT: no local transcription engine exists in the repo; shipping cloud transcription would violate non-negotiables 2/3. No voice code was added.
- Thread-bar/import dedupe: kept Dev A's local `RingThreadSummary` interface + thread-bar testids (`ring-thread-bar` / `ring-new-thread-button` / `active-thread`); the `RingThreads` import takes only non-conflicting names (fixes TS2440).
- Glue summary (additive-only vs the Dev A brain): `adapter.ts` adds `downloadRingArtifact` + `storeRingCsvEvidence` around Dev A's thread pass-throughs; `RingWorkspace.tsx` adds `threadClient`/`attachmentClient`/`downloadArtifact` members, thread sidebar + expand-handoff + attachments state, role-aware handlers honoring both the Dev A direct methods and the sidebar `threadClient`, send prefers active-thread post with fail-closed fallback to unscoped start, render cases for `model.delta` / `plan.updated` / `artifact.created` / `memory.saved`; `service/index.ts` +1 line (`eventService: event`); `ring-agent-service.ts` fans the mapped wire copy into `EventService.recordEvent` as `ring.run.<type>`, reusing Dev A's `safeProjectId()` (the empty-`streamListeners` early return is removed so the fan-out works with zero direct listeners; exceptions swallowed; JSONL transcript untouched).

## Deliverable

- `C:/maos/review-packets/ring-b-only-2026-11-02/candidate.patch` (B-only vs `8e6a403`, 16 files)
- `C:/maos/review-packets/ring-b-only-2026-11-02/candidate.sha256`
- `C:/maos/review-packets/ring-b-only-2026-11-02/run-log.md` (this file)
- SHA-256: `9b3ce4d2c3a065e32301e3fe955883a727c89c0146ea3bcf39ba27fe6a8c6c6c`
- Base: `8e6a4039d57c17c023abe49b0aec75190e6284fb`

## NOT verified

- Live hosted run against Baseten (no key by design); multi-display overlay placement; visual translucency by eye; physical hotkey press from another app (smoke covers registration + toggle path only).
- Fresh `npm ci` in scratch (reused identical-manifest `node_modules`); wider `tests/gui` suite (known pre-existing env failures, untouched by this lane).
- `desktop/ring-smoke.cjs` re-run inside this packet (covered in the Dev B lane: 13/13, exit 0).

## Outside the assignment

- None. No `C:/maos` source edits (pre-existing working-tree modifications left untouched), no commits, no pushes, no tags, no branches. Scratch worktrees `C:/clean/ring-b-only` and `C:/clean/ring-b-verify` left in place (detached, uncommitted) for inspection.
