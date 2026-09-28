# SIH National Demo — What the MVP Actually Does

**Status:** honest, runnable demo script for the currently verified MAOS MVP  
**Demo path:** GUI CSV review → CLI source/ruleset/calculation replay  
**Target length:** 3 minutes 30 seconds  
**Important:** use the bundled sample unless you have a real CSV you are authorized to show. The bundled file is synthetic. Never call it plant data.

> This replaces the earlier ambitious demo plan as the recording source of truth. The earlier script described a larger T-07 approval/report journey that was not demonstrated in the creator's current GUI. Do not record that journey unless it is separately rehearsed and proven on the actual demo machine.

## The story

An engineer has a telemetry CSV and wants a quick, inspectable first-pass check—not a confident-sounding model answer. MAOS lets the operator choose a CSV (or use a clearly labeled synthetic sample), applies simple configured thresholds, records a local evidence copy and hashes, displays the individual rows that crossed the thresholds, and lets the operator rerun the calculation from the command line against the same source.

The point is not “AI declares a turbine safe.” It is: **a result should be inspectable and reproducible, and a human—not this demo—owns the operational decision.**

## Exactly what is and is not being demonstrated

| Demonstrated on this path | Not demonstrated by this path |
|---|---|
| Cockpit CSV chooser for a file on this device; CSV only, max 5 MB | Attaching a device file to ordinary chat and having the language model read it |
| Optional bundled synthetic CSV button | Any real turbine, refinery, or customer dataset |
| Deterministic row checks and vibration RMS calculation in the MAOS Node service | AI/LLM discovering the anomalies, OCR/PDF ingestion, or multi-agent execution |
| Local evidence copy with source SHA-256 and a receipt | A signed or tamper-proof receipt / immutable external notarization |
| CLI recomputation and comparison of source hash, current threshold-file hash, and results | T-07 human approval, DOCX generation, audit-chain proof for this telemetry receipt, or operational sign-off |
| Local loopback API call | Whole-host offline/air-gap, firewall enforcement, or proof that no other process has network access |

**Important UI distinction:** Chat’s “Attach” control is still a project-root file picker, not a device-file upload. The new device picker is in **Agent Cockpit → Evidence review · CSV telemetry**. The chat response does not consume the uploaded CSV. Do not show Chat Attach as part of this data-analysis story.

**Important data distinction:** `demo/industrial/turbine_vibration_log.csv` is a synthetic benchmark fixture. It is not data supplied by the presenter, a plant, or a customer. If the team does not have permission-cleared real sample data, use the fixture and say so plainly.

## The 3:30 spoken script and screen direction

### 0:00–0:20 — Set the boundary

**Screen:** Title card, then open `http://127.0.0.1:3847/#/cockpit`.

**Say:**

> “Industrial teams often receive measurements in files. A generated answer is not enough—we need to see which values crossed which rule, and reproduce the calculation. We built a small, local-first evidence review for that first check. Today’s sample is synthetic, and the thresholds are for demonstration only.”

### 0:20–0:45 — Show the actual input

**Screen:** In **Evidence review · CSV telemetry**, click **Use bundled synthetic sample**. This is the reliable path for the recorded take. If the team chooses to demonstrate the device picker instead, select the repository’s same synthetic CSV and keep the “synthetic sample” disclosure visible; do not select a personal or confidential file.

**Say:**

> “I’m loading a 500-row synthetic CSV. MAOS accepts a CSV with vibration and bearing-temperature columns. This is a local threshold calculation; it is not a language model reading a turbine or making a safety decision.”

### 0:45–1:50 — Let the evidence tell the story

**Screen:** Hold on the result panel and findings table. Point to RMS, then the four rows.

Expected bundled-sample values:

- 500 data rows.
- Overall vibration RMS: `2.637109971... mm/s`.
- Demo vibration warning/critical thresholds: `4.5` / `7.1 mm/s RMS`.
- Demo temperature warning/critical thresholds: `85` / `95 °C`.
- Two warnings: row 121 vibration `5.2`; row 238 temperature `88.4`.
- Two critical threshold findings: row 367 vibration `8.3`; row 442 temperature `97.2`.

**Say:**

> “The aggregate RMS is about 2.64, below the configured demo warning level of 4.5. But a summary can hide excursions: row 367 is 8.3 against a 7.1 demo critical threshold, and row 442 is 97.2 degrees against 95. The interface shows the source row, reading, rule, and severity side by side.”

> “Those labels mean only that the values crossed these demonstration thresholds. They are not certified limits and do not authorize anyone to operate, stop, or repair equipment.”

### 1:50–2:10 — Show provenance, carefully

**Screen:** Point to the source SHA-256, analysis ID, and receipt path.

**Say:**

> “The selected CSV is stored in MAOS’s local project data area with a source hash. The receipt records the thresholds and result used for this analysis. This is useful for repeatability; it is not a digital signature or a tamper-proof external record.”

### 2:10–3:10 — Verify the same analysis in CLI

**Screen:** Switch to PowerShell at `C:\maos`. Use the analysis ID shown in the GUI—not a previous sample ID.

```powershell
cd C:\maos
$analysisId = 'PASTE_THE_CURRENT_GUI_ANALYSIS_ID'
node .\dist\cli\index.js industrial verify telemetry --analysis-id $analysisId --json
```

**Say:**

> “Now I’m asking the CLI to reopen that exact analysis receipt. It re-hashes the stored source, checks the current demo threshold file, and runs the calculation again. We want all three checks—source, ruleset, and recomputation—to match.”

**On-screen checks:**

- `valid: true`
- `sourceHashMatched: true`
- `rulesetHashMatched: true`
- `recomputationMatched: true`
- same `analysisId`; `rowsAnalyzed: 500`; same four findings.

If any field is false, stop the recording. Do not swap in a different analysis ID or a generic green audit-chain result.

### 3:10–3:30 — Close with restraint

**Screen:** Return briefly to the GUI table, then end card.

**Say:**

> “That is the MVP today: bring in a CSV, inspect the threshold crossings, and replay the same calculation from the CLI. We are not claiming real plant validation, autonomous safety decisions, or a fully isolated host. Our next step is validating this workflow with authorized domain data and qualified engineers.”

## Operator runbook

### Build and start

In PowerShell:

```powershell
cd C:\maos
npm run build
npm run typecheck:gui
npm exec vitest run tests/industrial/telemetry-analysis.test.ts
node .\dist\cli\index.js dashboard
```

Leave the dashboard terminal open and use `http://127.0.0.1:3847/#/cockpit`. Do not start a second server if port 3847 is already serving the current build. Hard-refresh after rebuilding.

### GUI steps to rehearse

1. Confirm the Cockpit page loads and the **Evidence review · CSV telemetry** panel is visible.
2. For the dependable recorded path, click **Use bundled synthetic sample**.
3. Confirm the result says `bundled synthetic data`, `500 rows`, `CRITICAL`, RMS about `2.637`, `2 / 2` warnings/critical, and the four expected source rows.
4. Copy the new analysis ID shown on the page.
5. If testing the device picker: choose only an authorized `.csv` file under 5 MB with `vibration_rms_mm_s` and `bearing_temperature_c` columns. The included synthetic sample is suitable for a functional rehearsal; it is not real plant data.
6. Do not press **Run T-07 Safety Audit** as part of this short demo. That is a separate workflow and not the evidence path being validated here.

### CLI steps to rehearse

```powershell
$analysisId = 'PASTE_THE_NEW_GUI_ANALYSIS_ID'
node .\dist\cli\index.js industrial verify telemetry --analysis-id $analysisId --json
```

Expected: process exit code `0`, `valid: true`, and all three `*Matched` fields true. If a source or threshold file changed after analysis, verification should fail—that is expected fail-closed behavior.

## Recording setup and go/no-go checklist

- [ ] Run build, GUI typecheck, and focused tests from this checkout.
- [ ] Start one dashboard; verify the page is serving the fresh `dist/gui` bundle.
- [ ] Rehearse from the exact browser and screen resolution planned for capture.
- [ ] Decide whether the take uses the one-click bundled sample or the device picker. For no external dataset, use the bundled sample.
- [ ] The first screen must visibly disclose **synthetic demo data** and **demo thresholds only**.
- [ ] Click the sample button and check all expected values before recording.
- [ ] Copy the fresh analysis ID directly from the current GUI result.
- [ ] Run the CLI verifier and check same ID plus all three successful matches.
- [ ] Make sure no personal files, credentials, `.env` contents, or unrelated browser tabs are in frame.
- [ ] Two consecutive clean rehearsals pass before saying “record-ready.”
- [ ] If any step fails, do not narrate through it; fix the cause or shorten the demo.

## What to show, what to skip

**Show:** Cockpit → Evidence review · CSV telemetry → one result table → source hash and analysis ID → CLI telemetry verification for that exact ID.

**Skip in this demo:** free-form Chat and its unverified prose banner; the legacy dashboard tabs; models/VRAM claims; generic “zero exposure” or “air-gapped” banners; unvalidated Evidence Workbench/PDF/OCR; Code & Sandbox; generic task history; approval and DOCX screens; firewalls; unrelated audit-chain output.

If a panel says `DISCONNECTED`, contains stale history, has no fresh result, or disagrees with the current run, do not explain it away—keep it out of frame and log it as a product issue.

## Judge questions — concise truthful answers

**“Is this real turbine data?”**  
“No. This is a synthetic public demo fixture. We are not presenting customer or plant data.”

**“Is this AI?”**  
“This particular analysis is deterministic threshold logic and RMS math in the local MAOS service. We intentionally do not ask a language model to invent a safety verdict.”

**“Why not use a spreadsheet or a short script?”**  
“They can calculate values too. Our narrow prototype adds a guided local evidence intake, visible row-level comparisons, stored source/ruleset provenance, and a repeatable CLI check. We still need more domain validation before making broader claims.”

**“Is it fully offline / air-gapped?”**  
“We have not proven that for the whole host. The demonstrated request goes to the local loopback service; OS-wide network isolation and other processes are outside this claim.”

**“Can I upload a PDF or make Chat read it?”**  
“Not in this verified demo. This new review path accepts CSV only. Chat’s current attachment picker browses project files and does not make this telemetry analysis.”

**“Is the report approved or is the turbine safe?”**  
“No. This path produces a threshold review and reproducible calculation only. It does not produce an approved safety report or operating authorization.”

## Differentiation without bluffing

Many teams can put an LLM in front of data. Make this presentation stand out through trust and precision instead of feature-count theatre:

1. Put one real user problem on screen immediately: “The average is below the demo threshold; individual samples still cross rules.”
2. Keep the raw row, threshold, severity, source hash, and analysis ID visible together.
3. Show GUI-to-CLI continuity with the same analysis ID. Do not substitute a pre-recorded, unrelated CLI success.
4. Be unusually direct about what is synthetic and what the MVP does not yet do.
5. Use deliberate pacing, high contrast, legible text, clean cuts, and short captions. Do not imitate another brand’s exact interface, sound, or launch script.
6. End with a specific next validation step: authorized data, engineer-reviewed thresholds, and supervised acceptance testing—not autonomous operation.

## Current verification snapshot

Verified during this implementation session:

- `npm run build` — passed.
- `npm run typecheck:gui` — passed.
- `npm exec vitest run tests/industrial/telemetry-analysis.test.ts` — 4 tests passed.
- Production GUI sample-button path — displayed 500 rows and expected findings.
- Local analysis endpoint with `kind: device-upload` using the bundled synthetic CSV — accepted it, stored the source, and created a receipt.
- `industrial verify telemetry` on that same analysis ID — `valid: true`, source/ruleset/recomputation matched.

Still requires the operator’s rehearsal on the actual recording setup:

- Open the native file chooser and select an authorized CSV in the recording browser.
- Confirm display scaling, readable text, and no personal data visible.
- Complete two clean consecutive demo rehearsals.

The full repository test suite and the larger T-07 approval/report workflow are not certified by these focused checks.
