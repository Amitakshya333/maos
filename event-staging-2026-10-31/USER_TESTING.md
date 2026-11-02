# User-testing preparation packet (Electron Cockpit round)

Round: manual user testing of the authenticated Cockpit (RUNBOOK Option B).
Tester profile: non-developer following on-screen labels. Boundaries below
are hard limits — anything outside them stops the session.

## Boundaries of this round (exact)

Synthetic fixtures only. No API key. No hosted calls. No real plant data.
If any step asks for a key, a login beyond the local session, network
access beyond loopback/npm setup, or real data: STOP, log a defect, do not
work around it.

## What the user tester should do

1. Launch Electron from the rehearsal recipe (RUNBOOK Option B, quoted
   exactly — run in the isolated project after staging its fixtures,
   profile, and Rust engine as in Task S step 9, same layout):

   ```powershell
   npm install --save-exact electron@45.0.0 C:\path\to\maosorch-0.3.0.tgz
   npx install-electron --no
   $projectRoot = (Get-Location).Path
   npx electron .\node_modules\maosorch\desktop\main.cjs --project-root $projectRoot --allow-temp
   ```

   BLOCKED note: `C:\path\to\maosorch-0.3.0.tgz` is a placeholder path in
   the RUNBOOK; no tarball build/pack step is documented in the RUNBOOK or
   B2 packet — the owner supplies the tarball or documents its provenance
   before this step. Prereqs from RUNBOOK: Node.js 22.12+ for the pinned
   Electron tooling; Node.js 20+ on `PATH` for the service child.
   Expected: shell starts `ProjectHostLauncher`, passes a bound in-memory
   session to the renderer over private Electron IPC (session never in a
   URL or browser storage), loopback-only API + WebSocket.
2. Run the bundled sample (PM-directed flow; click path not scripted in
   the RUNBOOK — follow the on-screen labels for the bundled/sample
   analysis exactly as shown; stop on anything unexpected).
3. Run the CSV file analysis on `turbine_vibration_log.csv` (same: follow
   on-screen labels; stop on anything unexpected).
4. Open Approvals; read the verdicts shown for each completed run.
5. Stop the session on anything unexpected, anything asking for
   credentials/hosted access/real data, or any result contradicting the
   checklist. Log every deviation (template below) — do not retry past it.

Rehearsal basis (RUNBOOK, Windows test build): three consecutive
installed-package Electron/Playwright rehearsals exercised pending-review
refresh/resume, approval, explicit rejection, source/rule stale-approval
failure, authenticated artifact download, matching audit linkage, and
exact returned-run-ID verification; invalid session/project/origin and
failed downloads were rejected; every approved completed run kept `FAIL`
as its engineering verdict. This round replays that shape manually.

## Pass/fail checklist (must all hold)

| # | Check | Pass |
|---|---|---|
| 1 | Session present (bound in-memory session reaches the renderer; nothing session-like in URL/storage) | yes / no |
| 2 | API healthy (app responds; no connection/auth errors) | yes / no |
| 3 | Bundled sample result shows its source and row count | yes / no |
| 4 | CSV file analysis produces a result | yes / no |
| 5 | Engine dot is grey (muted, NOT REPORTED), not amber | yes / no — see note |
| 6 | No new approval created by merely viewing/refreshing | yes / no |
| 7 | Completed runs read verdict FAIL (expected engineering result) | yes / no |

Note on check 5: the grey-muted "NOT REPORTED" engine indicator is
expected and verified by the Antigravity Electron rehearsal (DOM read:
`status-dot muted`, computed background rgb(85, 85, 85)). Verify engine
health separately via the CLI health check (Task S step 8). If the dot is
amber/red or shows any other state, log a defect (severity per guide)
instead of interpreting it.

## Defect log template (one row per deviation)

| Step | What happened (exact text/behavior) | Expected | Screenshot? (path or none) | Severity |
|---|---|---|---|---|
| | | | | |

Severity guide: Blocker = demo breaks or wrong result; Major = usable only
with a workaround; Minor = cosmetic.

## Fallback path if Electron will not launch

Abandon the Cockpit round (log the launch failure as a defect with the
exact error text and exit code) and run the CLI demo instead:
`C:\maos\event-staging-2026-10-31\DEMO_SCRIPT.md` (Task S), steps 1–12.
The CLI path is the B2-evidenced route; a failed Electron launch does not
block it.

## Grounding notes (honesty record)

- RUNBOOK-sourced: launch commands + prereqs, rehearsal recipe and its
  acceptance shape, FAIL-verdict expectation, CLI fallback commands.
- PM-directed (transcribed, not in RUNBOOK/B2 packet): the click-level
  tester flow (bundled sample → CSV analysis → Approvals → verdicts),
  checklist items 1–6 wording, grey-dot expectation, defect
  template/severity text. UI-navigation details are intentionally
  unscripted: follow on-screen labels and stop on deviation.
