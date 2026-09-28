# SIH National Round — MAOS Industrial Master Presentation & Recording Script

> **SUPERSEDED FOR RECORDING.** This earlier draft overstates the current GUI workflow and includes unverified T-07 approval/report steps. Do not use it as a live demo script. The current, verified MVP script is [SIH_NATIONAL_ACTUAL_MVP_DEMO.md](./SIH_NATIONAL_ACTUAL_MVP_DEMO.md). It shows the CSV evidence review followed by CLI replay and explicitly lists what is not yet demonstrated.

**Team:** CodeSplinter  
**Problem Statement:** 26117 — Sovereign On-Premise Agentic AI Workbench for Confidential Industrial Work  
**Theme / category:** Smart Automation / Software  
**Demo title:** **The average passes. The decision doesn’t.**  
**Default run time:** 7 minutes, including a GUI-first demo followed by CLI verification.

> Use the official SIH national-round timing, slide template, and submission
> instructions if they differ from this draft. This script is written to be
> modular: the main story is about 7 minutes, and the Q&A and rehearsal notes
> are separate. It is designed to feel polished and cinematic through clarity,
> restraint, and one coherent story—not to copy another company’s interface or
> exact presentation.

---

## 1. The national-round strategy

The college-level script leaned on broad claims about sovereign AI and a
four-agent pipeline. At national level, those claims are not enough—and some do
not match the current demonstrable path. The winning argument should be a
specific, inspectable product moment:

1. The overall average looks ordinary.
2. The source rows reveal exceptions that the average hides.
3. MAOS presents the evidence and waits for a human reviewer.
4. After approval, the GUI and CLI verify the **same run ID** and report.

If many teams are presenting local or private AI, treat that as table stakes.
Our intended distinction is the continuous evidence trail from source data to
review to a verifiable artifact—not the slogan “we run AI locally.” This is a
positioning strategy, not a guarantee of selection or a claim about every other
team.

### Story in one sentence

> “At shift handover, the average looks normal—but four individual events change
> the picture. MAOS makes those exceptions reviewable, waits for a human
> decision, and verifies the resulting report by the same run ID.”

### Why this story is memorable

- **A real tension, not an AI prompt trick:** an aggregate metric can conceal
  important events.
- **A visible human-control moment:** the report is held pending review; the
  presenter makes an explicit decision.
- **A cross-surface proof:** the CLI checks the same run that the audience saw
  in the GUI.
- **A bounded claim:** synthetic demonstration data and demonstration limits
  are identified plainly.

---

## 2. Claims to use—and claims to avoid

| Topic | Say this | Do not say this |
|---|---|---|
| Dataset | “This is a bundled synthetic T-07 demonstration pack.” | “These are real plant readings.” |
| Rules | “These are explicit hackathon demonstration thresholds, not certified operating rules.” | “MAOS certifies the turbine” or “this is an ISO safety decision.” |
| Result | “The deterministic demo analysis flags four configured threshold exceptions.” | “An AI model diagnosed or authorized a live turbine.” |
| Human role | “A human reviewer approves this demo report.” | “The system safely operates or shuts down equipment.” |
| Model | “Qwen is available locally for exploratory chat; plain chat is not source-verified unless citations are shown.” | “Every answer is grounded, verified, or used by this T-07 decision.” |
| Rust | “The Rust engine is used for audit append/verification.” | “Rust computes the T-07 RMS.” The current judged-run RMS calculation is JavaScript. |
| Network | “The app and model can use loopback/local runtime paths.” | “The entire workstation is air-gapped” or “Windows Firewall proves zero egress.” |
| Data retention | “Audit data and generated files remain on local disk.” | “Zero data remains after a run.” |
| Product status | “This is a working prototype with stated boundaries.” | “Production-certified,” “deployment-ready,” or “top-five guaranteed.” |

The optional model health test can establish that the local model endpoint is
responding. It does **not** prove every model uses the GPU or that the whole host
has no internet connection. If `industrial preflight` is shown, describe its
scope as process-scoped; it does not modify Windows Firewall.

---

## 3. Default 7-minute stage script

The spoken lines are a natural script, not text to read robotically. The demo
operator should practice the screen actions separately; the exact UI and CLI
checks are in Sections 4–6.

### 0:00–0:25 — Cold open: the quiet average

**Picture:** Start on a clean dark screen. One caption appears:
`SHIFT HANDOVER · T-07 · 500 SYNTHETIC SAMPLES`. Hold briefly, then show the
MAOS Cockpit. No stock refinery footage or busy animation.

**Say:**

> “At shift handover, the summary says the turbine’s average vibration is
> ordinary. Before an engineer signs off, there is one question: what did that
> average hide?”

### 0:25–0:55 — Problem and product

**Say:**

> “Industrial teams work across telemetry, maintenance notes, procedures, and
> approvals. Sensitive work may need to stay inside the organization’s
> environment, but keeping it local is only one part of trust. The result also
> needs a source, a reviewer, and a way to verify what happened.”
>
> “MAOS Industrial is our local-first workbench for that controlled workflow.
> Today I’ll follow one synthetic turbine case from the GUI review to a CLI
> verification of the same run.”

### 0:55–1:10 — Set the boundary

**Say:**

> “This is a public synthetic demo pack. Its thresholds are demonstration rules,
> not a certified safety standard or operating authorization. We’re showing
> evidence handling and review—not controlling plant equipment.”

### 1:10–3:55 — Live GUI: one case, one reviewer

**Action:** Open the Agent Cockpit and start the T-07 Safety Audit once. Use the
exact GUI actions/checks in Section 4. Keep the generated run ID visible.

**Say while the run appears:**

> “The system has prepared the case and paused for review. Notice the run ID and
> pending-approval state. At this point, the report for this run has not been
> generated.”

**Action:** Open Approvals. Select the pending approval with the identical run
ID. Show the four findings and the configured thresholds. Pause before the
critical finding.

**Say:**

> “The overall vibration RMS is about 2.64 millimetres per second—below this
> demo’s 4.5 warning threshold. But the individual rows tell a different
> story. Row 121 is 5.2, a warning. Row 238 is 88.4 degrees, a warning. Row 367
> reaches 8.3, above the 7.1 critical threshold. Row 442 reaches 97.2 degrees,
> above the 95-degree critical threshold.”
>
> “The maintenance note adds context. The important point is not that the model
> made a safety decision. These are explicit rules and source-backed findings,
> and the software pauses for a human reviewer.”

**Action:** Inspect the run ID, source hashes, and reviewer fields. Enter a
short, truthful reviewer note and approve the demo report. Return to Cockpit.

**Say:**

> “The reviewer—not a model—authorizes this demonstration report. Now the same
> run is complete, and its run-specific report path and hash are available.”

### 3:55–5:15 — CLI: verify the same run

**Action:** Switch to a terminal in `C:\maos`. Paste the exact run ID captured
from Cockpit. Do not run an unrelated generic verification and imply that it
belongs to this case.

```powershell
$runId = 'PASTE_THE_RUN_ID_SHOWN_IN_COCKPIT'
node .\dist\cli\index.js industrial verify audit --run-id $runId --json
```

**Say:**

> “The GUI handled the review. Now the CLI checks the audit chain and this
> specific run’s outputs. The run ID is the same one we just approved. We’re
> checking the report and audit-export hashes too—not just showing a green
> status from a different run.”

**Action:** Hold on the verification result, run ID, report path, and hashes.
Then open the exact run-specific DOCX path shown by the result or manifest:

```powershell
node .\dist\cli\index.js industrial open 'PASTE_THE_EXACT_RUN_SPECIFIC_DOCX_PATH'
```

If a local office viewer is unavailable, use:

```powershell
node .\dist\cli\index.js industrial open 'PASTE_THE_EXACT_RUN_SPECIFIC_DOCX_PATH' --dry-run --json
```

Call that a **validated launch plan**, not an opened report.

### 5:15–6:05 — Technical choices and feasibility

**Say:**

> “The displayed T-07 threshold analysis and RMS calculation are deterministic
> JavaScript in this judged path. The Rust engine is used for the tamper-evident
> audit append and verification. We keep those responsibilities distinct, and
> we don’t credit one component with work another component did.”
>
> “The application also supports a locally served open-weight Qwen model for
> exploratory chat. A chat response without verified source citations is
> visibly unverified; it is not silently promoted into an industrial finding.”
>
> “The next deployment step is validation with organization-approved data,
> rules, roles, and infrastructure controls. This prototype does not control
> PLCs or authorize operation.”

### 6:05–6:40 — Impact and scale path

**Say:**

> “The transferable idea is the governed pattern: local processing where
> appropriate, explicit rules, traceable evidence, a human checkpoint, and an
> independently checkable output. The next stage is not to turn on more
> autonomy; it is to validate the workflow with domain owners and expand only
> where evidence, safety, and integration requirements are met.”

### 6:40–7:00 — Close

**Picture:** Return to the GUI run ID and verified report hash. Keep the screen
still.

**Say:**

> “The average passed. The exceptions deserved review. MAOS made that review
> traceable—and let us verify the same result from the command line. Thank you.”

---

## 4. GUI sequence and recording test checklist

Keep the story to these sections. Do not give judges a tour of every menu.

| Order | GUI section/action | What to show | Pass check before continuing |
|---:|---|---|---|
| 1 | Agent Cockpit → **Run T-07 Safety Audit** | Synthetic data label, one fresh run, run ID, verdict, pending review | Exactly one new run; state is pending approval; capture the run ID. |
| 2 | Approvals → matching run | Run ID, four expected anomaly rows, RMS, source hashes, approval payload | Approval ID and run ID match the Cockpit run; all four expected rows appear. |
| 3 | Reviewer decision | Reviewer identity/role, note, decision controls | Read the summary before clicking; approve only the displayed demo run. |
| 4 | Agent Cockpit → same run | Completed state, run-specific DOCX path/hash | Same run ID; completion only after approval; no old report substituted. |
| 5 | Do **not** tour placeholder sections | Keep focus on the one case | Code, Terminal, Findings, Drawing are Preview; avoid Chat as proof of citations. |

### Exact values to recognize

| Evidence | Expected demo value | Interpretation |
|---|---:|---|
| CSV rows | 500 | Bundled synthetic telemetry; not live plant data. |
| Overall vibration RMS | 2.63711 mm/s (about 2.64) | Below this demo’s warning threshold, but does not erase individual excursions. |
| Vibration warning / critical | 4.5 / 7.1 mm/s RMS | Demonstration-only configured thresholds. |
| Temperature warning / critical | 85 / 95 °C | Demonstration-only configured thresholds. |
| Row 121 vibration | 5.2 mm/s | Warning. |
| Row 238 temperature | 88.4 °C | Warning. |
| Row 367 vibration | 8.3 mm/s | Critical / FAIL in this demo. |
| Row 442 temperature | 97.2 °C | Critical / FAIL in this demo. |

**Abort the take rather than narrate past a failure** if the run is not pending,
the approval shows another run ID, the report exists before approval, or the
resume step does not complete.

---

## 5. CLI sequence and exact verification points

Use a clean, readable PowerShell window. The CLI is the **second half** of the
story, not a separate demo.

```powershell
cd C:\maos
$runId = 'PASTE_THE_RUN_ID_SHOWN_IN_COCKPIT'
node .\dist\cli\index.js industrial verify audit --run-id $runId --json
```

Before continuing, confirm on-screen:

- the CLI used the same GUI run ID;
- audit verification is valid;
- the selected run is complete;
- run manifest, report path, report SHA-256, and audit-export SHA-256 are
  present and match the approved run;
- no output is from a previous run.

Open the exact report path emitted for this run, not a fixed filename guessed
from an older recording:

```powershell
node .\dist\cli\index.js industrial open 'EXACT_PATH_FROM_THIS_RUN'
```

Optional process-boundary diagnostic, only if a judge asks:

```powershell
node .\dist\cli\index.js industrial preflight
```

Describe this as **process-scoped**. It does not configure Windows Firewall,
does not prove the whole workstation is offline, and may report a degraded
process-attribution scope. Do not make a host-wide zero-egress claim from this
command.

---

## 6. Pre-record setup, rehearsal, and recovery

### Before the recording session

- [ ] Confirm the official national-round time limit and slide template; trim
  this script to that allocation.
- [ ] Rebuild from the intended source and restart the dashboard:

  ```powershell
  cd C:\maos
  npm run build
  node .\dist\cli\index.js dashboard
  ```

- [ ] Open the current production GUI at `http://127.0.0.1:3847/#/cockpit`.
- [ ] Confirm the dashboard is using the current build, not a stale tab or Vite
  dev server.
- [ ] Review existing approvals/history; do not reset all workspace state
  blindly. Choose a fresh run ID and keep it in a scratch note for CLI paste.
- [ ] Rehearse the complete Cockpit → Approvals → decision → Cockpit → CLI
  verify → exact report path sequence twice.
- [ ] Check that the exact run-specific DOCX does not exist before approval and
  appears only after approval.
- [ ] Use a clean desktop, disable pop-up notifications, close unrelated tabs,
  use readable browser zoom and terminal font, and hide personal file paths.
- [ ] Keep captions minimal: `SYNTHETIC DEMO DATA` and
  `DEMO THRESHOLDS — NOT CERTIFIED`.

The main T-07 decision story does not require a Qwen chat turn. Do not load an
extra model just for visual effect. If adding an optional model scene, first
verify the pinned cache, `/health`, device, and memory headroom; label ordinary
chat as unverified unless source citations are visibly attached.

### Go / no-go decision

**GO only when** two manual rehearsals pass, the approval is run-matched, the
report appears after the decision, and CLI verification confirms the same run
and hashes.

**NO-GO if** any stage is stale, run IDs differ, an approval is already
pre-approved, a report appears too early, or the CLI verifies another run. Fix
the cause and rehearse again; never hide the failure with a pre-recorded green
screen presented as live.

### Recovery during recording

- If the Cockpit start fails: stop, return to the checklist, and rerun after
  diagnosis. Do not narrate a previous persisted run as new.
- If no matching approval appears: do not approve an unrelated queue item.
- If post-approval resume fails: stop the take; do not open an older report.
- If CLI verification fails: preserve the output and investigate that run ID.
- If the office viewer is unavailable: use `--dry-run --json` and say only that
  path/hash/launch arguments were validated.
- If time runs short: cut the optional model and architecture remarks, not the
  reviewer pause or same-run CLI proof.

---

## 7. What to show, what to skip, and why

### Show in the main story

- **Agent Cockpit:** fresh T-07 run ID and pending-review status.
- **Approvals:** the four expected rows, evidence hashes, and the human decision.
- **Agent Cockpit again:** the same run completed and its exact report path/hash.
- **CLI:** same-run Rust-backed audit verification, then the exact report path.

### Skip in the main story

- **Chat:** plain model prose is exploratory/unverified; it is not the evidence
  path for this demonstration.
- **Code, Terminal, Findings, Drawing:** these destinations are marked Preview
  and are not connected end-to-end in this MVP.
- **Artifacts empty-state:** the current judged-run output is better shown from
  the Cockpit run panel and verified via CLI.
- **Legacy chart/log/report as “fresh run output”:** persisted workspace data may
  be older. Only narrate records with the run ID you just created.
- **Evidence conflict fixture as freshly scanned evidence:** it is a scripted
  benchmark path, not a new OCR/VLM extraction in this T-07 story.
- **Windows Firewall screens:** this demonstration does not test host-wide
  firewall enforcement.
- **Auto-approved CLI run:** `--auto-approve --yes` is a separate evaluation
  path and must not be described as a human engineer’s review.

---

## 8. Slide outline if a deck is required

Keep slides sparse; the live GUI and CLI are the proof.

| Slide | One message | Visual |
|---|---|---|
| 1. The hidden exception | “Averages can hide individual events.” | One large `2.64` beside a quiet telemetry line; no logo collage. |
| 2. The reviewer’s problem | Evidence is fragmented; a plausible summary is not enough. | CSV + maintenance note → one review queue. |
| 3. MAOS’s path | Evidence → deterministic demo thresholds → human review → report → CLI verification. | Five simple blocks; clearly mark the human gate. |
| 4. Proof | Four known rows; one run ID; one report hash. | Large 8.3 mm/s reveal and thin provenance strip. |
| 5. Feasibility and limits | Prototype is not certified and does not control a plant. | “Works now / next / not claimed” three-column card. |
| 6. Roadmap and close | Validate with domain owners before expanding. | On-prem pilot → integration & safety validation → broader asset packs. |

If the official format fixes a different slide count or fields, preserve its
structure and place these messages into that prescribed format.

---

## 9. Suggestions that add distinction without fake capability

Priority for the remaining preparation window:

1. **Make one fresh rehearsal flawless.** The direct GUI-to-CLI run-ID continuity
   is the strongest differentiator; spend more time validating it than adding
   another menu.
2. **Add a one-screen “run evidence” card if already safe to implement.** Show
   the run ID, source set, four findings, reviewer, report hash, and audit
   status. Each value must come from that live run.
3. **Put the provenance beside the surprise.** If there is already a safe link
   from a row to the maintenance evidence, show it. If not, do not invent a
   citation UI during the final recording window.
4. **Use honest product-launch craft:** quiet opening, one central visual,
   comfortable pauses, large type, clean cuts from GUI to terminal, restrained
   sound, and no rapid feature tour.
5. **Create a 30-second fallback answer, not a fake fallback demo.** If asked
   about full air-gap, certification, model routing, or live plant integration,
   state the boundary and the next validation gate.

The broader roadmap is plant-approved source connectors, explicit role and
threshold management, stronger deployment isolation, and integration with
approved historians/maintenance systems after security and domain validation.
Do not promise dates, savings, or performance values that have not been
measured.

---

## 10. Likely judge questions

**“Is this real plant data?”**  
“No. It is a bundled synthetic public demonstration dataset. We use it so the
expected values and rehearsal are reproducible.”

**“Are these certified turbine limits?”**  
“No. The rules are explicitly labeled hackathon demonstration thresholds. They
are not an operating standard or authorization.”

**“What is actually different from another local chatbot?”**  
“The core demo is not a chat answer. It ties a source dataset to explicit
threshold findings, pauses at a human review gate, generates a run-specific
report after approval, and verifies that same run from the CLI.”

**“Does the LLM decide PASS or FAIL?”**  
“No. In the T-07 judged path, the configured demo thresholds and deterministic
analysis produce the findings. The local Qwen chat path is separate and plain
chat prose remains unverified unless citations are attached.”

**“Does this prove the whole computer is offline?”**  
“No. The application and local-model path use loopback/local resources in this
setup. This demo does not disable or measure all network traffic from the
workstation.”

**“Why use a CLI after the GUI?”**  
“It makes the result independently inspectable. The CLI checks the same run ID
and output hashes; it is not a second, unrelated success screen.”

**“Can this control or protect a live turbine?”**  
“No. This prototype does not connect to or control PLC/SCADA equipment. A real
deployment would require plant-owned limits, domain approval, integration
testing, security assessment, and the organization’s operational safety
processes.”

**“What does Rust do here?”**  
“The Rust engine supports audit append and audit-chain verification. The
current judged-run RMS calculation is JavaScript; we do not claim Rust performs
that calculation.”

---

## 11. SIH alignment and reference note

This presentation emphasizes novelty, clarity, feasibility/practicability,
impact, user experience, and a credible future progression—the evaluation
themes listed in SIH’s published College SPOC guidance. That guide is for an
earlier SIH edition; **the current national-round invitation, prescribed format,
and SPOC/jury instructions take precedence**. Confirm the official allocated
time, slide template, and demo rules before recording.

- Official SIH College SPOC Guidelines (historical evaluation themes):
  https://www.sih.gov.in/letters/Guidelines-College-SPOC.pdf
- Repository demo inputs and expected outputs: `demo/industrial/`.
- Current T-07 GUI/CLI rehearsal plan and live-readiness gates:
  `demo/industrial/MASTER_DEMO_PLAN.md` and
  `demo/industrial/RECORDING_READINESS.md`.

---

## 12. Final operator checklist

- [ ] Correct SIH national-round format and timing confirmed.
- [ ] Clean production build started; GUI loads the production bundle.
- [ ] One fresh T-07 run created in Cockpit.
- [ ] Same run ID selected in Approvals; four expected findings visible.
- [ ] Reviewer note and explicit human approval recorded.
- [ ] Same run returns to completed in Cockpit; report appears only after approval.
- [ ] CLI verifies that same run and expected report/export hashes.
- [ ] Exact run-specific report opened or honest `--dry-run` fallback shown.
- [ ] No old logs or unrelated approvals narrated as current.
- [ ] No claims of real plant data, certification, whole-host air-gap, or Rust RMS.
- [ ] Two full manual rehearsals passed.
- [ ] Team can answer the eight questions above without overclaiming.
