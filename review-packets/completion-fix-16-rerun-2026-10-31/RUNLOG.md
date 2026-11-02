# FIX16-EVIDENCE-CLOSEOUT rerun log

- Date (UTC): 2026-10-31
- Candidate (isolated, unmodified by this run): `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-fix16-candidate` @ `2cfdf9b81f56eada7df2041625da18e44531151e`
- Evidence dir (sibling; frozen FIX-16 packet untouched): `C:\maos\review-packets\completion-fix-16-rerun-2026-10-31\`
- Engine: `C:\maos\rust\target\release\maos-engine.exe` via `$env:MAOS_TEST_ENGINE_PATH` (identity in `engine-provenance.txt`; no source/build provenance claimed)
- Dependencies: junction `<candidate>\node_modules` -> `C:\maos\node_modules`, created only after verifying absence, removed after verifying reparse-point + exact target. DISCLOSURE: commands could access the shared dependency tree; not read-only isolation. Junction state afterward: absent; `C:\maos\node_modules` intact.
- Pre-run: index empty (exit 0), `git diff --check` exit 0, 9/9 scoped hashes match FIX-16 manifest (NO_DRIFT).
- Post-run: 9/9 scoped hashes match FIX-16 manifest (NO_DRIFT); status diff vs before: none (tracked scope identical). `dist/` exists on disk and is gitignored (`!! dist/`); classified as generated build output from step 4, left in place, not deleted.

## Step results (command / log / exitcode triplets in this directory)

1. `targeted-suites`: 9 files, 130 passed — exit 0
2. `new-suites-verbose`: 4 files, 56 passed — exit 0
3. `ui1-02-api-clients`: 1 file, 33 passed — exit 0
4. `build-backend`: exit 0 (log holds the npm banner + tsc output)
5. `typecheck-gui`: exit 0 (log holds the npm banner)
6. `ui1-19`: exit 1 — 3 failed / 23 passed (26). Failing tests and verbatim errors from `ui1-19.log`:
   - `5. Stop Controls & Interruption Defense > confirmed force stop marks active tasks INTERRUPTED and records audit event` → `ApiError: AUDIT_PERSISTENCE_FAILED: ... Engine executable not found: ...\maos-fix16-candidate\rust\target\release\maos-engine.exe ...`
   - `6. Interactive Disconnect & Client Abort > cancels chat completion on client abort without breaking service` → `AssertionError: expected [Function] to throw error matching /cancelled/i but got 'Engine executable not found: C:\Users…'`
   - `9. Canary Invariant > rust/test.txt SHA-256 hash is strictly preserved` → `Error: ENOENT: no such file or directory, open '...\maos-fix16-candidate\rust\test.txt'`
   - Recorded as-is. No baseline comparison is claimed here (none was run in this rerun).
7. `repl` (industrial-repl): exit 1 — 1 failed / 1 passed (2). Failing test and verbatim error from `repl.log`:
   - `runs the selected-file mock analysis through persisted review, report and verification` → `Error: Timed out waiting for REPL output: Review run: judged-run-agent-`; transcript also contains `Error: Engine executable not found: ...\maos-industrial-repl-BbHi1P\rust\target\release\maos-engine.exe ...`
   - Recorded as-is. No baseline comparison is claimed here (none was run in this rerun).

Counts: each test counted once within its own run. ui1-19/repl are separate suites reported separately, never folded into pass totals. No repairs, relabelling, installs, source edits, commits, or integration were performed.
