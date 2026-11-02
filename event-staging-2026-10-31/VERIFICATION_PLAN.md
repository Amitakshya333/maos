# Minimum clean-room verification sequence (UNEXECUTED — plan only)

Scope split (reconciled 2026-10-31):
- **B2 scope (local only):** steps 1–6 + 9. No model key, no hosted calls.
  B2 stays OPEN until every step passes with no unrecorded deviation.
- **B3 scope (hosted, separately gated):** step 7 only. Requires owner
  decision D4 (Meta terms, data handling, billing/no-overage clearance)
  plus the judge's own key; separate run and separate records.
- **D6 lane:** step 8 (notice closure) consumes clean-room outputs; it is
  not part of the B2/B3 run verdicts.

Working directories (explicit): event material stays in the checkout this
plan was obtained from (staging); the Core checkout is the disposable
`C:\clean\core` (delete afterwards; never a profile holding unrelated
credentials). Each step names its directory. Nothing below has been
executed from staging. Record every command, output, exit code, and hash.

1. **Fetch published Core (from any directory).**
   `git clone --no-checkout https://github.com/Amitakshya333/maos.git C:\clean\core`
   → `git -C C:\clean\core fetch origin refs/tags/event-core-2cfdf9b`
   → `git -C C:\clean\core checkout f9525055c56a7f7771dd2fa029c147c2960a98a3`
   → `rev-parse HEAD` equals the base, `status --porcelain` empty.
2. **Apply overlays (from the staging/event checkout).**
   `.\scripts\apply-event-patches.ps1 -CorePath C:\clean\core` — applies
   0001–0003 with patch-hash, base, clean, partial-application, and
   per-overlay tree gates (fails closed, never resets). Independently
   confirm the result equals event tip `2cfdf9b`
   (tree `53305f48e6a7fb039bcf72fa38ab102bcccb9cb8`); any difference fails
   the run.
3. **Install, pinned only (from `C:\clean\core`).** `npm ci` at root;
   `npm ci --prefix desktop`. Least-privilege profile; network to the
   registry expected. Record npm/node versions.
4. **Build + static gates (from `C:\clean\core`).**
   `npm run build:backend`, `npm run typecheck:gui`; canary
   `Get-FileHash rust/test.txt` = `13922455…733435` — UNRESOLVED
   test-asset prerequisite per ENGINE-RESOLUTION-01 (`rust/test.txt`
   absent from the pinned tree, ignored/out-of-band: do not fabricate or
   silently copy it; absence is recorded, not a runtime failure or
   product-failure evidence). Then the targeted
   suites only: API/session auth, analysis-agent contracts, provider
   policy, review/DOCX/audit, desktop launcher bridge
   (`npx vitest run <files>` per map — full suite is out of minimum
   scope).
5. **Engine (from `C:\clean\core`).** `cargo build --release --locked
   --manifest-path rust/Cargo.toml` (toolchain 1.95.0 via
   `rust/rust-toolchain.toml`); health check expects
   `maos-industrial-engine/0.1.0/protocol 1.0/status ok`; record binary
   SHA-256 + size. Stage into the demo project per README §5.
6. **Local deterministic demo, B2 (from the demo project).** The judged
   run follows the source-confirmed local deterministic path — local code
   plus bundled synthetic fixtures, no hosted-model call (committed
   `demo/industrial/RUNBOOK.md`). It does NOT use mock transport; earlier
   "mock-first" wording is corrected here.
   `maos-industrial run --auto-approve --yes --json` (explicit synthetic
   auto-approval, not a human review); expect RMS `2.63711`, verdict
   `FAIL`, DOCX + audit-export artifacts (quoted from the runbook). The
   two negative gate probes are documented:
   `maos industrial run --auto-approve` (exit 4),
   `maos industrial run` (exit 10).
   Separate loopback mock check (distinct; not the judged path):
   automated contract tests use a local mock transport — e.g. staged
   `tests/industrial/analysis-agent-auth-http.test.ts` constructs a
   `mock` provider over loopback (see 0001 test content); those suites
   run under step 4. A mock run is not live-model verification — keep
   the two results distinct in the records.
7. **Hosted step, B3-gated (separate run; only after D4).** Fresh process
   (ideally a fresh disposable profile), judge's own key in the documented
   `apiKeyEnv` variable, exact Meta fragment; confirm spend/billing
   behavior first. Redact the key from all records. Records form a B3
   annex to step 9, never part of the B2 verdict.
8. **Notice closure (D6 lane).** Export full JS + remaining Rust license
   texts per `LICENSES_AND_NOTICES.md` Unresolved §1–§2; attach the
   scanner output.
9. **Provenance bundle (B2; plus B3 annex if step 7 ran).** Commit
   nothing; archive: source revs, lock/runtime versions, engine identity
   + hash, all outputs/exit codes, sanitized demo evidence. Engineering
   verdict (`FAIL`) stays distinct from execution status (pass/fail of
   this sequence).

Known doc discrepancies are resolved in `DISCREPANCIES.md` (D1: tree pin
wins, INSTALLATION.md sentence is stale; D2: presence-only preflight vs
≥3.10 workflow requirement — record the actual interpreter at step 4).

Exit criteria: B2 green requires steps 1–6 + 9 green (step 6 runs the
local deterministic path; the separate loopback mock check stays distinct
in the records); B3 green requires step 7 green after D4; step 8 follows
D6. Until the respective green, no run claim may be made for that scope.
Notice closure and legal clearance stay unresolved regardless.
