# MAOS Industrial — Regional Demo Master Plan

**Purpose:** a single working document for the story, spoken script, exact GUI and CLI sequence, recording checklist, known constraints, and changes that will make the demo stand out.

**Recommended demo title:** **The average is green. The decision isn’t.**

**Core story:** A shift engineer has 500 synthetic turbine readings and a short maintenance note. The overall vibration average looks ordinary, but a few individual readings cross the demonstration limits and line up with field observations. MAOS makes the exception easy to inspect, runs the chosen audit path, produces a local record, and lets the operator check that record. The software supports a decision; it does not authorize a real turbine to operate.

> **Recording status:** the T-07 GUI start, real approval pause, after-approval report, and same-run CLI verification are implemented. The production build and GUI typecheck pass, and the local dashboard is running. The end-to-end reviewer click-through still needs two manual rehearsals before the judged take.

---

## 1. Why this story can stand out

Most agent demos show a prompt, a generated answer, and a busy dashboard. This one should show a more consequential question: **can an engineer trace a surprising result back to its source and understand who authorized the next step?**

The memorable reveal is the gap between the overall RMS and the individual exceptions:

- 500 rows in the bundled synthetic T-07 telemetry file.
- Overall vibration RMS: about **2.63711 mm/s**.
- Demonstration vibration limits: warning at **4.5 mm/s**, critical at **7.1 mm/s**.
- Demonstration bearing-temperature limits: warning at **85 °C**, critical at **95 °C**.
- Expected exceptions: row 121 at 5.2 mm/s (warning); row 238 at 88.4 °C (warning); row 367 at 8.3 mm/s (critical); row 442 at 97.2 °C (critical).
- The maintenance note mentions metallic sound, heat, lubricant residue, and preceding vibration alarms.

The story turn is: **the average alone would miss the events that matter.** The ending is a traceable result and a verifiable audit chain, not a claim that an AI model made a safety decision.

---

## 2. Truthful claim sheet

Use these exact distinctions in narration and on-screen text.

| Topic | Safe wording | Do not say |
|---|---|---|
| Input data | “This is a bundled, synthetic public demonstration pack.” | “These are real plant readings” or “real-world readings.” |
| Thresholds | “These are hackathon demonstration rules, not a certified standard or operating authorization.” | “MAOS certifies the turbine as safe/unsafe” or “this is an ISO-compliant safety decision.” |
| GUI binding | “The MAOS GUI uses the local loopback API; host-wide egress is unverified.” | “The whole computer is air-gapped” or “the machine cannot reach the internet.” |
| Dashboard chart | “The chart is derived from the bundled CSV and configured demo thresholds.” | “The chart is a fresh model inference” or “the chart proves the workflow just ran.” |
| GUI judged run | “The T-07 action prepares deterministic findings, creates a pending approval, and generates the report after approval.” | “The workflow is an AI-operated plant or that the report exists before approval.” |
| Approval details | “The queue shows the four parsed anomaly rows, overall RMS, source hashes, and reviewer decision.” | “An unrelated approval belongs to this run.” Match the displayed run ID. |
| CLI verification | “The CLI verifies the audit chain and the selected run’s report/export hashes using the same run ID.” | “A generic green chain check proves a different run or an operational safety decision.” |
| `industrial run` approval | “With `--auto-approve --yes`, this CLI path records the explicit demo auto-approval.” | “A human engineer reviewed this CLI run.” The command auto-approves under the `judge-evaluator` identity. |
| RMS implementation | “The judged-run path calculates this demo RMS from the CSV and applies the configured thresholds.” | “Rust computes this RMS” or “decimal-exact Rust math” for `industrial run`; the inspected implementation uses JavaScript `parseFloat` and `Math.sqrt`. |
| Rust engine | “The audit append and audit-chain verification use the Rust engine.” | “Every part of this workflow is executed by Rust.” |
| Chat | “Plain chat prose is exploratory/unverified unless the UI shows verified claims and citations.” | “A plausible local-model answer is a verified industrial finding.” |
| Persistence | “Audit data and generated files remain on local disk.” | “Zero data left behind.” |

All expected findings and thresholds are in the repository's synthetic demo pack. The disclaimer in `safety_thresholds.json` must remain visible or be spoken at least once.

---

## 3. Readiness and known GUI boundaries

The demo path is implemented and the current production build is serving at `127.0.0.1:3847`. Reload the browser tab before rehearsal. The full journey has not yet been manually clicked through from start to approval to report to CLI verification; a successful build alone is not a recording pass.

- The Agent Cockpit now starts the judged T-07 path and keeps its run ID in the browser so status survives switching to Approvals and back.
- Approvals shows the run-bound anomaly rows and source hashes. Deciding that approval resumes only that run. The report uses a run-specific filename and is not generated on the pending path.
- `industrial verify audit --run-id <id>` now checks the Rust-backed audit chain plus that run's completed manifest, DOCX hash, and audit-export hash.
- The legacy `/dashboard` chart remains a useful CSV-derived overview. Its trigger now uses the judged-run path too; its older dossier and event stream may still contain persisted data, so match a fresh run ID before narrating them.
- The Artifacts screen may remain an empty-state projection for this specific judged-run output. Use the Cockpit run panel and CLI verifier as the evidence trail.
- **Code & Sandbox**, **Terminal**, **Findings**, and **Drawing & Viewer** remain Preview; keep them out of the primary story.
- The Evidence Workbench conflict fixture is scripted benchmark data, not fresh OCR/VLM extraction. Keep it outside the T-07 narrative.
- UI labels now identify synthetic demo data and the local API; they do not claim that the whole host is air-gapped or report unmeasured GPU/model/latency values.
- The one targeted GUI test mentioned in the prior readiness snapshot is still an existing stale assertion. Do not claim a green test suite based on this change. The selected path still needs a current build and two manual rehearsals.

---

## 4. Recommended 4:45 recording script — one GUI decision, one CLI proof

**Demo title:** **The average passes. The decision doesn’t.**

**Story:** At shift handover, an engineer sees an ordinary overall vibration RMS. Four short excursions and a maintenance note change the picture. MAOS prepares the evidence, pauses for the human reviewer, and creates a report only after approval. The CLI then verifies the exact same run ID and artifact hash.

This is deliberately a narrow story, not a tour of every menu. Use slow cuts, generous pauses, quiet audio, one cursor action at a time, and readable type. Let the evidence reveal itself. Avoid generic AI theatrics and do not claim that an AI model made the threshold decision.

### 0:00–0:18 — Cold open

**Picture:** Black screen. One clean caption fades in: `SHIFT HANDOVER / T-07 / 500 SAMPLES`. Hold for two beats, then cut to the MAOS Agent Cockpit.

**Say:**

> “At shift change, the summary says the vibration average is normal. Before anyone signs off, let’s see what the average left out.”

### 0:18–0:55 — GUI: prepare one real run

**Screen:** Open `http://127.0.0.1:3847/#/cockpit`. Pause on **Run T-07 Safety Audit**. Click once and let the prepared T-07 run return its run ID, verdict, anomaly count, and pending-review state.

**Say:**

> “This uses the bundled synthetic T-07 evidence. The analysis checks the telemetry against the demo thresholds, then stops at a human approval gate. No report exists for this run yet.”

**Action:** Copy the displayed run ID to a notes window or clipboard for the CLI step. Keep it out of the audience-facing narration if the interface already shows it.

### 0:55–1:55 — GUI: reveal the evidence and make the decision

**Screen:** Open **Approvals**. Select the pending approval with the same run ID. Read the prepared findings slowly: row 121 vibration warning at 5.2 mm/s; row 238 temperature warning at 88.4 °C; row 367 critical vibration at 8.3 mm/s; row 442 critical temperature at 97.2 °C. Show overall vibration RMS of about 2.637 mm/s and the attached source hashes.

**Say:**

> “Here is the tension: the overall RMS is about 2.64, below the demo warning threshold of 4.5. But row 367 reaches 8.3, above the critical limit of 7.1, and row 442 reaches 97.2 degrees, above the 95 degree limit. The maintenance note also describes heat, a metallic sound, and dark lubricant residue.”

> “These are synthetic inputs and demonstration limits, not certified operating rules. MAOS has not made an operating decision. A human reviewer must decide whether to authorize the report.”

**Action:** Inspect the run ID, four findings, source-hash count, and approval payload hash. Enter a short reviewer note, then approve. Do not use an automated or pre-approved CLI path in this story.

### 1:55–2:35 — GUI: show the consequence of approval

**Screen:** Return to Cockpit. The run panel should refresh to `COMPLETED` and show the run-specific DOCX path and exact CLI verification command. If it still says pending, stop the take and resolve the service or approval issue instead of narrating past it.

**Say:**

> “Only after that review did MAOS create this run’s report. The approval identity and decision are attached to the same run record.”

**Action:** Hold on the run ID, completed state, and report path. The report is uniquely named for this run so an older file cannot masquerade as a fresh output.

### 2:35–3:40 — CLI: verify the same run

**Screen:** Switch to a terminal in `C:\maos`. Paste the run ID copied from the GUI.

```powershell
$runId = 'PASTE_THE_GUI_RUN_ID_HERE'
node .\dist\cli\index.js industrial verify audit --run-id $runId --json
```

**Say:**

> “Now the command line checks the audit chain and this run’s evidence together. The run ID is identical to the one we reviewed in the GUI. The command also checks the report and audit-export hashes stored for that run.”

**Action:** Keep the run ID, `valid: true`, report path, and report SHA-256 visible. If the check fails, stop and diagnose the exact run; do not switch to an unrelated green result.

### 3:40–4:15 — CLI: open the exact report

Read the run-specific report path from the GUI panel or manifest, then run:

```powershell
node .\dist\cli\index.js industrial open artifacts/generated/PASTE_THE_GUI_RUN_ID_HERE-turbine_safety_approval_note.docx
```

Show the executive summary, the human approval, its citations, and the demonstration-only limitation. If no office viewer is available, use `--dry-run --json` and describe it as a validated launch plan, not an opened document.

### 4:15–4:45 — Close

**Say:**

> “The average looked ordinary. The events did not. MAOS kept the evidence inspectable, paused for a human decision, and let us verify the resulting report by the same run ID. This is a synthetic demonstration, not a certified safety system or permission to operate equipment.”

**Picture:** Return to the GUI run ID and report hash. Hold one second, cut to black.

## 5. Capture setup

### Build and start the GUI/API

Run before recording, from the repository root:

```powershell
cd C:\maos
npm run build
node .\dist\cli\index.js dashboard
```

Open:

- Industrial mission-control page: `http://127.0.0.1:3847/dashboard`
- Primary demo surface: `http://127.0.0.1:3847/#/cockpit`
- Human review: `http://127.0.0.1:3847/#/approvals`
- Optional evidence/audit views: `http://127.0.0.1:3847/#/evidence` and `#/audit`

The server listens on `127.0.0.1:3847`. Keep the dashboard terminal open. Avoid starting a second service on port 3847.

### Optional local model

The primary story does not require a model response; avoiding a chat detour keeps the evidence narrative tight. If a local-model identity/chat scene is intentionally added, use the pinned model cache path recorded in `RECORDING_SCRIPT_DRAFT.md`, confirm the directory exists on the recording host, bind it to `127.0.0.1`, and confirm `/health` before capture. Do not claim that ordinary Chat output is source-verified.

### Screen and sound

- Record at 1920×1080 or higher; browser zoom 110–125% so the anomaly labels and terminal output are legible.
- Use a clean browser profile/window. Close notifications, unrelated tabs, terminals, and personal paths.
- Keep one cursor move per instruction. Pause after each result so a judge can read it.
- Use sparse voiceover and restrained sound. Let the evidence and result carry the scene; avoid a feature-tour rhythm, stock factory footage, glitch effects, or imitating another company’s exact interface.
- Use plain captions for `SYNTHETIC DEMO DATA` and `DEMO THRESHOLDS — NOT CERTIFIED` where the ruleset is visible.

---

## 6. Manual rehearsal and recording checks

Do not call the demo record-ready until the full browser journey has been rehearsed twice from a clean browser session and a known project state.

### GUI checks

- [ ] Rebuild and restart the dashboard so the browser serves the current code.
- [ ] Open `/#/cockpit`; start exactly one T-07 run and copy its run ID.
- [ ] Confirm the result is `pending_approval`, the approval queue has the same run ID, and it shows all expected anomaly rows, RMS, and source hashes.
- [ ] Confirm the report with this run's unique filename does not exist before approval.
- [ ] Approve once with a reviewer note. Confirm the queue records that identity, note, and decision.
- [ ] Return to Cockpit; confirm the same run ID changes to `COMPLETED` and reports its run-specific DOCX path.
- [ ] Inspect the DOCX and confirm its verdict, reviewer sign-off, citations, disclaimer, and expected content.

### CLI checks

- [ ] Run `industrial verify audit --run-id <same-run-id> --json` from `C:\maos`.
- [ ] Confirm the chain is valid, the run is completed, the DOCX hash matches, the audit-export hash matches, and the output includes the same run ID.
- [ ] Open the report using the exact run-specific path shown by Cockpit. Do not substitute an older fixed-name DOCX.
- [ ] Keep a text note with the known-good GUI URL, command, current run ID, output path, and one recovery action for each failure.

### Fresh-state discipline

The report has a unique filename per run, but approval and audit history persist. Before rehearsing, review the approval queue and recent history; do not reset all state blindly. For the final take, use one fresh run ID and narrate only records attached to it.

## 7. Go/no-go gates for a competition recording

### Go when

- The new production build is serving the GUI and API.
- One GUI-started run pauses at a real pending approval and shows the expected four source-derived rows.
- Approval generates a report only for that same run ID; the unique DOCX path and reviewer identity are visible.
- CLI verification reports the same run ID, valid audit chain, and matching report/export hashes.
- The entire flow has been manually rehearsed twice, including the screen transitions and the exact CLI paste.
- Every spoken safety, data, and networking claim uses the truthful claim sheet above.

### No-go when

- Start, review, report generation, or same-run CLI verification fails at any point.
- The report is visible before approval, the displayed approval has a different run ID, or the CLI command verifies a different run.
- The host is still serving old compiled code or the browser shows stale persisted data as if it were fresh.
- A speaker says “certified,” “real plant data,” or “air-gapped” without evidence.

## 8. High-impact additions that could raise the demo further

Keep these out of the core take unless they are implemented and rehearsed. The current single-run story is stronger than a rushed feature tour.

### P1 — Put corroborating evidence beside each anomaly

Show the exact maintenance-note excerpt and its citation beside the row 367/442 findings. The approval screen already presents telemetry rows and source hashes; a direct evidence link would make the cross-source story easier for judges to audit.

### P1 — Give the report a compact findings table

The current report emphasizes peak vibration and temperature. Add a table containing all four parsed rows, timestamps, configured thresholds, verdicts, and CSV citations so the human-reviewed evidence and report tell the same complete story.

### P2 — Make provenance one visual signature

Add the ruleset hash, reviewer, approval ID, run ID, document hash, and audit-chain status to a quiet final evidence card. Keep the source values and decision more prominent than decorative telemetry.

### P2 — Add an honest blocked-action beat

If there is enough time, show a second disposable run being rejected and no report being generated. Only include it after a separate rehearsal; the main story should remain one approval and one verified result.

### Presentation polish

Use a restrained monochrome palette, large readable measurements, one highlighted value at a time, a deliberate pause before the 8.3 mm/s reveal, and clean GUI-to-terminal cuts. Take inspiration from product-launch pacing through clarity and restraint without copying another brand's interface or language.

## 9. Judge questions: concise answers

**Is this real plant data?**  
“No. It is a synthetic, licensed public demonstration pack designed to exercise the workflow.”

**Are these certified safety limits?**  
“No. They are explicit hackathon demonstration thresholds. They are not an operating authorization or certified standard.”

**Does MAOS make the safety decision?**  
“No. The deterministic threshold path surfaces a result, and an authorized human must make operational decisions. The CLI judged-run’s auto-approval flag is a separate automated evaluation mode.”

**Does this prove the computer is offline?**  
“No. The MAOS service binds to loopback and the configured demo model can run locally. That does not prove the entire host has no network access.”

**What does Rust do in this shown path?**  
“The Rust engine appends and verifies the tamper-evident audit chain. The current judged-run RMS loop is implemented in JavaScript, so I do not attribute that calculation to Rust.”

**What is the clearest next milestone?**  
“Rehearse the new single-run GUI approval and same-run CLI verification twice, then add direct links from each anomaly to its maintenance-note evidence and include all four rows in the report.”

---

## 10. Repository references for the demo operator

- `demo/industrial/RECORDING_READINESS.md` — current readiness and open gates.
- `demo/industrial/RECORDING_SCRIPT_DRAFT.md` — tested local model setup notes and safe wording.
- `demo/industrial/RUNBOOK.md` — CLI setup and lifecycle commands; its old GUI click path should not be followed without rechecking it against the current source.
- `demo/industrial/turbine_vibration_log.csv` — synthetic T-07 data.
- `demo/industrial/maintenance_report.txt` — synthetic inspection notes.
- `demo/industrial/safety_thresholds.json` — demo thresholds and mandatory disclaimer.
- `demo/industrial/expected_findings.json` and `ground_truth.json` — expected values for rehearsal.
- `src/cli/dashboard-state.ts` and `src/cli/dashboard-template.ts` — legacy `/dashboard` data and UI behavior.
- `src/gui/src/views/CockpitView.tsx` — Agent Cockpit plus the T-07 run control and status card.
- `src/gui/src/views/EvidenceView.tsx` — evidence workbench and benchmark conflict fixture path.
- `src/industrial/judged-run.ts` — T-07 analysis, pending manifest, approval resume, report generation, and run hashes.
- `src/service/audit-service.ts` — Rust-backed audit append and chain verification.

