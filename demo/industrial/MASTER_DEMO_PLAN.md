# MAOS Industrial — Regional Demo Master Plan

**Purpose:** a single working document for the story, spoken script, exact GUI and CLI sequence, recording checklist, known constraints, and changes that will make the demo stand out.

**Recommended demo title:** **The average is green. The decision isn’t.**

**Core story:** A shift engineer has 500 synthetic turbine readings and a short maintenance note. The overall vibration average looks ordinary, but a few individual readings cross the demonstration limits and line up with field observations. MAOS makes the exception easy to inspect, runs the chosen audit path, produces a local record, and lets the operator check that record. The software supports a decision; it does not authorize a real turbine to operate.

> **Release status (2026-10-27):** The installed-package CLI and supported Windows Electron/private-IPC browser path passed three consecutive rehearsals on one tarball. See `RECORDING_READINESS.md` and `docs/MAOS_INDUSTRIAL_EXECUTION_CHECKLIST.md` for exact run IDs and evidence. A truthful local/synthetic recording script is prepared, but no video has been recorded. The public Meta waiver/form remains unavailable; confirm selected-participant rules and the Meta-use requirement before using a video for submission.

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

The supported package path is the native Electron shell using private launcher IPC for the authenticated project session. Three installed-package browser rehearsals on one tarball covered approval, explicit rejection, source/rule staleness, refresh/resume, authenticated DOCX download, same-run audit linkage, and exact-ID CLI verification. Each completed run kept the engineering verdict `FAIL`; failed/stale/rejected runs did not create reports. The historical direct CLI dashboard workflow and the Computer Use URL-identification attempt are not counted toward this gate. See `RECORDING_READINESS.md` for package hash, run IDs, and evidence location.

- The Agent Cockpit now starts the judged T-07 path and keeps its run ID in the browser so status survives switching to Approvals and back.
- Approvals shows the run-bound anomaly rows and source hashes. Deciding that approval resumes only that run. The report uses a run-specific filename and is not generated on the pending path.
- `industrial verify audit --run-id <id>` now checks the Rust-backed audit chain plus that run's completed manifest, DOCX hash, and audit-export hash.
- The legacy `/dashboard` chart remains a useful CSV-derived overview. Its trigger now uses the judged-run path too; its older dossier and event stream may still contain persisted data, so match a fresh run ID before narrating them.
- The Artifacts screen may remain an empty-state projection for this specific judged-run output. Use the Cockpit run panel and CLI verifier as the evidence trail.
- **Code & Sandbox**, **Terminal**, **Findings**, and **Drawing & Viewer** remain Preview; keep them out of the primary story.
- The Evidence Workbench conflict fixture is scripted benchmark data, not fresh OCR/VLM extraction. Keep it outside the T-07 narrative.
- UI labels now identify synthetic demo data and the local API; they do not claim that the whole host is air-gapped or report unmeasured GPU/model/latency values.
- Focused bridge tests and GUI typecheck passed; the installed-package browser gate now establishes the Windows test-shell topology. The desktop shell is not a signed installer, Rust remains a separately staged prerequisite, and no live Meta call was made.

---

## 4. Current recording script

Use [`PRESENTATION_SCRIPT.md`](PRESENTATION_SCRIPT.md) as the authoritative timed script. It covers the supported Electron/private-IPC launch, pending-review refresh/resume, approval, artifact download and exact-run verification, separate source/rules stale failures, explicit rejection, and truthful limitations. This older master plan is the story and claim reference; do not use the legacy `127.0.0.1:3847` launch steps previously shown here.
## 5. Capture setup

### Install and start the supported desktop shell

Use a temporary project with its fixtures, profile, and separately staged Rust
engine from `RUNBOOK.md`. Install the final local tarball and the pinned
Electron runtime in that project:

```powershell
$packageTarball = 'C:\path\to\maosorch-0.3.0.tgz'
$projectRoot = (Get-Location).Path
npm install --save-exact electron@45.0.0 $packageTarball
npx install-electron --no
npx electron .\node_modules\maosorch\desktop\main.cjs --project-root $projectRoot --allow-temp
```

For a project outside the system temp directory, omit `--allow-temp`. The
desktop shell chooses runtime loopback ports and initializes the renderer from
private launcher IPC; do not navigate to a hard-coded browser URL or use the
legacy direct dashboard for the supported recording.

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

The supported Windows test-shell path has passed three consecutive clean
installed-package browser rehearsals on one tarball. The exact IDs and evidence
location are in `RECORDING_READINESS.md`. This is not a signed installer or a
captured video. Do not call the hackathon submission ready until the owner has
reviewed participant rules and confirmed the Meta-use requirement.

### GUI checks

- [x] Launch the installed Electron shell against an isolated Industrial project.
- [x] Open `/#/cockpit`; start a synthetic T-07 run and match its run ID in Approvals.
- [x] Confirm four expected anomaly rows, RMS, source hashes, and no report before approval.
- [x] Approve with a reviewer note; confirm Cockpit shows the same completed run and run-specific DOCX path.
- [x] Download the DOCX and compare its byte hash with the generated artifact.
- [x] Verify the same run ID with the installed CLI and verify the browser audit chain.
- [x] Reload and resume the pending run; test source/rules stale refusal and explicit rejection in isolated project state.
- [x] Pass three consecutive installed-package browser rehearsals on the same tarball, including approve/download/verify.

### CLI checks

- [x] Run `maos-industrial verify audit --project-root <project-root> --run-id <same-run-id> --json` against the installed package.
- [x] Confirm the run is completed and valid, the report hash matches the download, and output includes the same run ID.
- [ ] Open the report in an office viewer during the final recording. Do not substitute an older fixed-name DOCX.
- [x] Record the supported Electron launch command and same-run CLI verification in `PRESENTATION_SCRIPT.md`.

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
“Confirm the participant rules and Meta-use requirement, then capture the reviewed local/synthetic demo without claiming a live Meta integration.”

---

## 10. Repository references for the demo operator

- `demo/industrial/RECORDING_READINESS.md` — current readiness and open gates.
- `demo/industrial/PRESENTATION_SCRIPT.md` — current timed recording script for the supported launcher and verified local flow.
- `demo/industrial/RECORDING_SCRIPT_DRAFT.md` — local model setup notes and safe wording.
- `HACKATHON_SUBMISSION.md` — draft summary and evidence inventory; adapt it to official fields before submission.
- `demo/industrial/RUNBOOK.md` — source-checkout and installed-package setup plus the exercised GUI flow.
- `demo/industrial/turbine_vibration_log.csv` — synthetic T-07 data.
- `demo/industrial/maintenance_report.txt` — synthetic inspection notes.
- `demo/industrial/safety_thresholds.json` — demo thresholds and mandatory disclaimer.
- `demo/industrial/expected_findings.json` and `ground_truth.json` — expected values for rehearsal.
- `src/cli/dashboard-state.ts` and `src/cli/dashboard-template.ts` — legacy `/dashboard` data and UI behavior.
- `src/gui/src/views/CockpitView.tsx` — Agent Cockpit plus the T-07 run control and status card.
- `src/gui/src/views/EvidenceView.tsx` — evidence workbench and benchmark conflict fixture path.
- `src/industrial/judged-run.ts` — T-07 analysis, pending manifest, approval resume, report generation, and run hashes.
- `src/service/audit-service.ts` — Rust-backed audit append and chain verification.

