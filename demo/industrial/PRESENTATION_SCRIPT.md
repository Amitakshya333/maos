# MAOS Industrial — 3–5 Minute Recording Script

**Status:** Script prepared for a truthful local/synthetic capture. No video has
been recorded. Before using it as a hackathon submission, check the actual
participant rules and confirm that a local demo with no live Meta request is
eligible.

## Capture setup

Use the final installed package from the same release rehearsal gate, a fresh
temporary project, the bundled synthetic T-07 fixtures/profile, and the
separately staged Rust engine. Follow the authenticated-shell setup in
[`RUNBOOK.md`](RUNBOOK.md). The Windows launch command is:

```powershell
$projectRoot = (Resolve-Path .\demo-project).Path
npx electron .\node_modules\maosorch\desktop\main.cjs --project-root $projectRoot --allow-temp
```

Record the real Electron window. Keep run IDs visible; never show session
tokens, API keys, personal browser profiles, unrelated files, or unsanitized
terminal output. Use four isolated runs so approval, stale-source failure,
stale-rules failure, and rejection cannot be confused as one run. Use brief
cuts for waits and clearly signal each new run; do not imply skipped time was
instantaneous.

## Timed script

### 0:00–0:25 — Explain the boundary

**Show:** The Cockpit running in the native shell and the synthetic T-07 input.

**Say:** “This is a local industrial evidence workflow using synthetic turbine
data and demonstration thresholds. The T-07 calculation is deterministic. This
capture makes no hosted Meta Model API call and is not an operating decision.”

### 0:25–1:10 — Analyze and resume the pending review

**Action:** In a fresh project, click **Run T-07 Safety Audit**. Copy the run ID
shown in the T-07 judged-run panel. Show the pending approval and that no report
exists yet. Open **Review the evidence**, reload the window, click **Refresh**
in approvals, return to **Cockpit** and show the same pending run ID, then open
**Review the evidence** again.

**Say:** “The workflow pauses for review. Refresh reconnects to the same
project-scoped run; it does not silently approve it.”

### 1:10–2:05 — Review and approve that run

**Action:** Open the approval for the same ID. Inspect the evidence and
source/rule hashes. Click **Review & Approve**, enter reviewer
`release-reviewer`, and note “Reviewed synthetic T-07 evidence; not operational
authorization.” Confirm approval. Return to the Cockpit and show the completed
report for that run.

**Say:** “This approval is bound to the reviewed evidence and rules. A later
change invalidates it.”

### 2:05–2:55 — Download and verify the exact run

**Action:** Open **Deliverables**, download that run’s DOCX, then in the
project-root terminal run:

```powershell
$runId = '<the exact run ID shown in the Cockpit>'
& .\node_modules\.bin\maos-industrial.cmd verify audit --run-id $runId --json
```

Open the Audit view, click **Verify Cryptographic Chain**, and show
`CHAIN: VERIFIED`. Keep the same run ID visible in the report, download, audit
export, and verifier output.

**Say:** “The software workflow completed and the artifacts verify. Its
engineering verdict is still **FAIL** because the synthetic measurements cross
the configured demo limits.”

### 2:55–3:40 — Show source and rules stale-approval failures

**Action:** In a separate fresh project, start a new run and change one byte in
`demo/industrial/turbine_vibration_log.csv` after analysis but before approval.
Attempt approval/resume; show the failed state and absence of a report. In
another fresh project, repeat but change
`demo/industrial/safety_thresholds.json` after analysis. Show the failed state
and absence of a report. Keep the different run IDs visible between cuts.

**Say:** “Both source evidence and the safety-rule input are checked again at
resume. A stale review fails closed; no report is created.”

### 3:40–4:10 — Show explicit rejection

**Action:** In a third fresh project, analyze a new run, open its approval,
choose **Reject**, enter a concise reason, and confirm. Show the persisted
rejected state and that no report is listed for that run.

**Say:** “A reviewer can reject the evidence. Rejection is persisted, and the
system does not present it as a successful report.”

### 4:10–4:35 — Close with limitations

**Say:** “The fixtures and limits are synthetic and not safety certification.
TypeScript performs the T-07 analysis; a separately installed Rust engine
provides audit hashing and verification. No live Meta integration is shown.
Loopback binding does not prove the whole workstation is offline.”

## Capture checks

- Confirm each segment uses the correct, distinct run ID. Never splice a
  negative case into the approved run.
- Keep the engineering `FAIL` verdict visible after report generation; do not
  describe it as a passing safety result.
- Make sure the DOCX download, report hash, audit export, and CLI verification
  all refer to the approved run ID.
- If any action fails, show the failure state or retake the full segment in a
  fresh project. Do not edit the video to imply a failed operation succeeded.
- The earlier three rehearsals used a separate browser context and temporary
  project on one installed Windows package. They are test evidence, not a
  recording, submission, safety certification, or live Meta integration.

## Headless fallback

If the Cockpit cannot be shown, a separate CLI capture may demonstrate package
execution and verification, but it cannot stand in for the human-review flow:

```powershell
maos-industrial run --auto-approve --yes --json
maos-industrial verify audit --run-id <run-id-from-output> --json
```

`--auto-approve --yes` records an explicit synthetic demo approval. It is not
human review and must be labeled as a CLI-only fallback.
