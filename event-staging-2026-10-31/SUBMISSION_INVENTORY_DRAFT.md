# Submission inventory — DRAFT (2026-11-03, document-only)

Every value below cites the file it was read from. Anything not directly
verified here is marked UNVERIFIED. No hosted calls were made for this
draft, so all "current remote state" rows re-cite the latest dated
evidence and are stale until re-checked live.

## Repositories and pins

- Public Core repo: `https://github.com/Amitakshya333/maos.git`.
- Core `main`: `f54dd7e6db33b0683ff2f2583516bca5dc3f6ce3` per Task E
  (`final-proof-2026-11-01/RESULT.md`, 2026-11-01 12:44 IST) and
  staging `UPSTREAM-SYNC-2026-11-01.md`. Live re-check: UNVERIFIED here.
- Event tag: `refs/tags/event-core-2cfdf9b` → object
  `ee569a1b67507c37cf6e968895405a6bd36d0181` → commit `2cfdf9b`
  (pushed + `ls-remote`/API-verified 2026-10-31; unchanged per
  UPSTREAM-SYNC). Live re-check: UNVERIFIED here.
- Public event repo: `https://github.com/Amitakshya333/maos-ind_.git`.
- Event `main`: `c655cd01b8afda39f5f0605737bd002670f63cc9` per Task C
  (`judge-path-verify-2026-11-01/run-log.md`, 11:18 IST, 300-file exact
  staging match) and Task E step 6 (12:44 IST). Live re-check:
  UNVERIFIED here. Four staging files postdate the Task C snapshot
  (`DEMO_SCRIPT.md`, `USER_TESTING.md`, `UPSTREAM-SYNC-2026-11-01.md`,
  `.gitattributes`; staging now 304 files) and are therefore NOT in
  verified event content — presumed unpublished pending owner
  confirmation.
- Pinned base: `f9525055c56a7f7771dd2fa029c147c2960a98a3`; reconstructed
  tree `53305f48e6a7fb039bcf72fa38ab102bcccb9cb8` (B2 steps 05/10, Task C
  step 5, Task E step 6b, apply-script evidence sets — all match).

## Patch chain (hashes re-verified in staging this session)

- `patches/0001-industrial-agent-workflow.patch`: `40777EE7…03DD6` (full:
  `40777EE7EA4EDBF534377BBE3012EAD6B2588B6B070681F1686003C699C03DD6`).
- `patches/0002-meta-provider-and-bounded-agent.patch`: `EB68E07B…4D0EC`
  (full: `EB68E07BCE21E9AC9D5245274BC5FCEA787C0A2AE6EC7810E756F933B764D0EC`).
- `patches/0003-install-workflows-pilot-baseten.patch`: `99FBF264…E4ABE4`
  (full: `99FBF264719871D0B25F4075FDFABA8D881963B0AC5AF0749095D06613E4ABE4`).
- `scripts/apply-event-patches.ps1`: `2B8674AA…256A7` (full:
  `2B8674AA323C98ABDD9E5A54FDCBFF61332E715286CA690CC9BD530DA5C256A7`).
- `scripts/test-apply-script.ps1` (durable regression test, kept): hash in
  STAGING_NOTES APPLY-SCRIPT-07 entry session record.
- Pending corrections FIX-06/08/10/12 and FIX-16 are NOT in this chain
  (B2 SCOPE.md; CONTRIBUTION_MAP.md exclusion register).

## Evidence locations (local paths)

- B2 clean-room: `review-packets/b2-cleanroom-retry-2026-10-31/` (22
  step files + `runtime-acceptance.json` PASS, `engine-build-identity.json`,
  `demo-staging.json`, `CANARY-DISPOSITION.md`; RUNLOG.md records the
  pre-disposition canary stop) and first attempt
  `review-packets/b2-cleanroom-2026-10-31/`.
- Task A (simple-git removal): `review-packets/simple-git-removal-candidate-2026-11-01/run-log.md`.
- Task B (Electron rehearsal): `review-packets/electron-rehearsal-2026-11-01/run-log.md` (§1–§7).
- Task C (event reconstruction + CRLF finding):
  `review-packets/judge-path-verify-2026-11-01/run-log.md`.
- Task D (baseline comparison, 46 canary failures):
  `review-packets/simple-git-removal-candidate-2026-11-01/run-log.md`
  §Task D plus `baseline-test-list.txt`, `baseline-comparison.json`
  (as recorded there; file presence re-check below).
- Task E (final proof, new HEAD): `review-packets/final-proof-2026-11-01/RESULT.md` + step files.
- Task G (engine-indicator fix + tests):
  `review-packets/engine-indicator-candidate-2026-10-31/` (`taskG-notes.txt`,
  `candidate.patch`, ui1-25 logs).
- Task R (core review d324129+f54dd7e):
  `review-packets/core-review-d324129-f54dd7e-2026-11-01/REVIEW.md`
  (+ `validation/`), verdict no blockers, 4 minors (F1a/F1b/F3/F4).
- Electron rehearsal: `review-packets/electron-rehearsal-2026-11-01/`
  (`run-log.md`, `rehearsal-results.json`, `screenshots/` ×6) on tag
  `2cfdf9b` PLUS 12 GUI-fix-candidate files (§1 file table) — not the
  bare event tip. Screenshot SHA quirk as filed: a/b share one SHA-256,
  d/e share another.
- Execution checklist (RUNBOOK-cited, uncommitted):
  `C:\maos\docs\MAOS_INDUSTRIAL_EXECUTION_CHECKLIST.md` (absent from the
  sanitized snapshot; working-tree only).

## Demo artifacts and hashes (B2 evidences; rebuilds differ)

- Engine: `rust/target/release/maos-engine.exe`, `280cf92e…6b4a8`
  (462,848 bytes, Rust 1.95.0, offline) — build-specific reference.
- DOCX: `artifacts/generated/turbine_safety_approval_note.docx`,
  `d489ab37…4c005` (5,436 bytes); audit export
  `judged-run-1793462662903-370574-audit-export.json`, `0d9f2990…86864`
  (6,255 bytes); RMS `2.637109971161612`, verdict FAIL, 9 audit records,
  run `judged-run-1793462662903-370574` (`runtime-acceptance.json`).
- Fixtures (4 SHAs): `demo-staging.json` (`e860af9e…`, `d2c31003…`,
  `7ed8e5b9…`, `fcb75e92…`).
- Stable expectations across rebuilds: RMS value, verdict FAIL, exit
  codes (0/4/10), engine health identity, tree SHA — not artifact hashes.

## Known limitations and unresolved items

- Canary `rust/test.txt` absent (ignored, out-of-band); 46 Task-D
  baseline failures are that setup gap (expected, not product failure).
- JS notices: 70 root + 15 desktop unresolved; MPL-2.0 texts 10/11
  missing; no legal clearance (staging screen + closure run).
- CRLF: default Windows clones convert patch bytes and break the
  script's hash check (Task C finding); staging `.gitattributes` fix
  exists but was unpublished as of the last check — fallback is
  `-c core.autocrlf=false`.
- Event HEAD live state, Core main live state: UNVERIFIED here (no
  hosted calls); latest dated values cited above.
- `maosorch-0.3.0.tgz` provenance for Electron launch: BLOCKED
  (RUNBOOK placeholder path; owner supplies or documents).
- UI click-paths, grey-dot spec: PM-directed / rehearsal-evidenced, not
  in RUNBOOK; rehearsal ran on fix-augmented snapshot (scope caveat).
- Task R minors F1a (prettier-hash discontinuity), F1b (bundled commit
  message), F3 (17-entry lockfile prune, behavior-neutral), F4
  (`npm-cache-manifest.json` open, test-pinned, not a demo blocker).
- Audits: B2 tree shows 6 vulns incl. 2 critical (2026-10-31 record);
  new Core HEAD shows 4 (2 mod, 2 high, simple-git advisories gone)
  per Task E — different trees, both cited, neither fixed here.
- RUNLOG vs acceptance: B2 RUNLOG says "STOPPED AT CANARY /
  UNVERIFIED" (pre-disposition phase record) while
  `runtime-acceptance.json` records post-disposition runtime PASS —
  both filed as-is; reconciliation is an owner call.

## Anything that must not be claimed

No hosted Meta inference ran; no live-model verification (mock ≠ live);
no full-suite green; no legal clearance; no notice completeness; the tag
is a reproducibility pointer, not event-authorship proof; rehearsal
results cover the fix-augmented snapshot, not the bare tip; Electron ran
from local cache in rehearsal (no external binary-host claim); demo
artifact hashes are build-specific evidence, not fixed acceptance
values; main-branch advances do not change the pinned judged build.
