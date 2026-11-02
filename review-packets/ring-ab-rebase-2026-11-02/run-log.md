# TASK DEV-B-REBASE-01 — Ring surface rebased onto Dev A brain (scratch only)

Base: old 8b39caf (Freeze Ring contracts). New main HEAD: 8e6a403 (Add Ring brain tools and threads).
Scratch: C:/clean/ring-ab-rebase (detached @ 8e6a403 via: git -C C:/maos worktree add --detach C:/clean/ring-ab-rebase 8e6a403, exit 0).
C:/maos untouched except this packet dir; no commits to any branch.

## apply --check (Dev B candidate.patch vs new main)
- cmd: git -C C:/clean/ring-ab-rebase apply --check C:/maos/review-packets/ring-dev-b-2026-11-02/candidate.patch
- exit: 1 (CONFLICTS — 4 overlapping files, all also touched by Dev A):
  - src/gui/src/api/adapter.ts (Dev A added thread routes; Dev B added downloadRingArtifact + thread routes + storeRingCsvEvidence)
  - src/gui/src/components/RingWorkspace.tsx (Dev A added RingThreadSummary/optional thread methods/thread bar/handleNewThread; Dev B added streaming panels + sidebar + attachments + handoff + render cases)
  - src/service/index.ts (Dev A added ringThread service + brain deps; Dev B added eventService: event wiring)
  - src/service/ring-agent-service.ts (Dev A rewrote service around registry/toolDeps/thread linkage/stream hook; Dev B added EventService fan-out)
- 12 non-conflicting files applied cleanly first with --exclude of the 4 (exit 0).

## Resolution policy (per assignment)
- Dev A wins src/service/* (brain owns tools/threads/registry): kept Dev A's registry wiring, thread service, toolDeps, snapshot/thread-linkage code untouched. Dev B's event-bus fan-out preserved as additive code inside emitStreamEvent: same onStreamEvent-mapped wire copy fanned into EventService.recordEvent as ring.run.<type> (runId-scoped, sequenced), bus optional (early return when unwired), exceptions swallowed so the run never breaks, JSONL untouched. Reused Dev A's safeProjectId() instead of Dev B's duplicate safeProjectName helper. Wired eventService: event at the container call site (single added line).
- Dev B wins src/gui/* and desktop/* (surface owns UI/shell): all 12 non-conflicting surface files taken verbatim (overlay host/smoke, App, rest-client, native.d.ts, RingAttachments/Overlay/StreamPanels/Threads, devb-surface tests).
- Shared glue merged by hand preserving both lanes:
  - adapter.ts: Dev A thread pass-throughs kept; added downloadRingArtifact (-> rest.downloadRingArtifact) and storeRingCsvEvidence (CSV -> analyzeIndustrialTelemetry receipt path, verbatim).
  - RingWorkspace.tsx: kept Dev A RingRunClient optional thread methods + default client + thread bar (testids ring-thread-bar/ring-new-thread-button/active-thread) + handleNewThread core; added Dev B threadClient/attachmentClient/downloadArtifact members, thread sidebar + expand-handoff + attachments state, role-aware handleNewThread/handleSelectThread/handlePickRole honoring both the Dev A direct methods and the Dev B sidebar threadClient, send path prefers active-thread postMessage with fail-closed fallback to unscoped start, render cases for model.delta/plan.updated/artifact.created/memory.saved, expand notice, sidebar, role picker, attachment bar. Single dedupe: local RingThreadSummary interface kept, import takes only non-conflicting names from RingThreads.

## Files touched to resolve (scratch only)
- src/gui/src/api/adapter.ts (added 2 Dev B methods around Dev A thread block)
- src/service/index.ts (+1 line: eventService: event)
- src/service/ring-agent-service.ts (EventService import + option/field/ctor + emitStreamEvent fan-out reusing safeProjectId)
- src/gui/src/components/RingWorkspace.tsx (imports, client iface + default client, state, handoff effect, send, threads handlers, render cases, layout)
- (verbatim from Dev B, no resolution needed): desktop/main.cjs, desktop/preload.cjs, src/gui/src/App.tsx, src/gui/src/api/rest-client.ts, src/gui/src/native.d.ts, desktop/ring-overlay-host.cjs, desktop/ring-smoke.cjs, src/gui/src/components/{RingAttachments,RingOverlay,RingStreamPanels,RingThreads}.tsx, tests/gui/ring-devb-surface.test.ts

## Validation (all in scratch C:/clean/ring-ab-rebase; node_modules copied from Dev B lane worktree, no fresh npm ci needed — package.json identical)
- npx vitest run tests/gui/ring-devb-surface.test.ts tests/gui/ring-workspace.test.ts tests/gui/ring-impl-01.test.ts tests/gui/ui1-25-truthful-readiness.test.ts -> exit 0, 4 files, 54 passed (28 devb incl. EventService fan-out test, 11 workspace incl. 2 Dev A thread-UI tests, 12 impl-01, 3 ui1-25)
- npm run typecheck:gui -> exit 0 (one fix during rebase: deduped RingThreadSummary import vs local interface, TS2440)
- npm run build -> exit 0 (vite built in ~1s)
- Extra (not required, informational): tests/industrial/ring-dev-a.test.ts -> 9/10 pass; the single failure is the pre-existing engine-fixture helper assert (expects rust/target/release/maos-engine inside the scratch worktree; binary exists only at C:/maos, gitignored, not copied into scratch). Same failure shape on pristine main without the binary; no lane code implicated. ring-dev-audit-proxy.test.ts same single helper assert. No hosted/Baseten calls anywhere (BASETEN_API_KEY unset).

## Security sweeps (rebased tree)
- meta-api-policy.ts: empty diff vs HEAD (untouched).
- grep sk-|fa29|AKIA|apiKeys*[:=] over all touched/new files: no hardcoded keys (only pre-existing apiKey field plumbing in service internals: recordEvent payload wiring + OpenAIProvider ctor + local-only stub, all from Dev A/main, no secrets).

## Deliverable
- C:/maos/review-packets/ring-ab-rebase-2026-11-02/candidate.patch (REBASED combined A+B vs 8b39caf, 41 files, verified with git apply --check on a pristine 8b39caf checkout -> CLEAN)
- C:/maos/review-packets/ring-ab-rebase-2026-11-02/candidate.sha256
- C:/maos/review-packets/ring-ab-rebase-2026-11-02/run-log.md (this file)
- SHA-256: 4b6a0faa387ef1c6669c9f02e8bdc17e7f503033dfdbba7ae64e6c0770b41c72

## NOT verified
- Live hosted run against Baseten (no key by design); multi-display overlay placement (single display on this machine); visual translucency by eye; physical hotkey press from another app (smoke covers registration + toggle path only).
- Fresh npm ci in scratch (reused Dev B lane node_modules; package.json/lock identical to Dev B lane).
- Wider tests/gui suite (known pre-existing env failures per Dev B run-log, untouched by this rebase).

## Outside the assignment
- None. No C:/maos edits outside this packet dir, no commits, no pushes, no tags. Scratch worktree C:/clean/ring-ab-rebase left in place (detached, uncommitted) for inspection; verify worktree C:/clean/ring-ab-verify removed.
