# MAOS Industrial — 5-Minute Ring Stage Arc (Recording Script)

**Status:** Script prepared for a Ring-centered capture. No video has been
recorded — every segment below is TO-RECORD. Before using it as a hackathon
submission, check the actual participant rules and confirm the demonstrated
hosted Meta use satisfies them. Ring on camera is the hosted agent surface
(`ring-agent-service` + `ring-inference-service`) wired to
`meta-models/muse-spark-open-1026` via `https://inference.baseten.co/v1`
(policy-pinned: `src/backends/meta-api-policy.ts:3-5`). Synthetic data only.
Decision support, not operating authority.

## Capture setup (staging recipe)

Stage a packaged build exactly as the recording checklist requires: fresh
scratch at current main HEAD, `npm ci`, build, source-built Rust engine with
matching SHA, Baseten config from the redacted template (`providers.baseten`
with `baseURL https://inference.baseten.co/v1`, model
`meta-models/muse-spark-open-1026`, `basetenApiEnabled: true`) **plus the
`schemaVersion` template rule** (config must carry the required schema
version field), and the `BASETEN_API_KEY` in the launcher shell ONLY — never
pasted, never in a file. Follow the authenticated-shell setup in
[`RUNBOOK.md`](RUNBOOK.md) and the full go/no-go in
[`RECORDING_READINESS.md`](RECORDING_READINESS.md). Use one fresh temporary
project per run so approval, stale-source failure, stale-rules failure, and
rejection cannot be confused as one run. Record the real windows (full app +
overlay). Keep run and thread IDs visible; never show session tokens, API
keys, personal browser profiles, unrelated files, or unsanitized terminal
output. Use brief cuts for waits and clearly signal each new run; do not
imply skipped time was instantaneous. Rebuilding before recording is
mandatory: the staging tree must match current main (this rule was
bitten twice before — do not record from a stale tree).

On-screen identity (identical everywhere):
`HOSTED · meta-models/muse-spark-open-1026 via Baseten`
(`tests/gui/ring-impl-01.test.ts:94`); fallback badge
`EVIDENCE-ONLY · no model configured`
(`tests/gui/ring-impl-01.test.ts:105`). If the hosted path is unavailable on
camera, run the evidence-only fallback path instead and label it as such on
screen — never replay a saved model response while showing it as live.

## Timed arc

### 0:00–0:30 — The plant can't use ChatGPT (TO-RECORD)

**Show:** The plant context and why generic chat is not an option (sovereignty:
company evidence stays in MAOS; telemetry/RMS math is deterministic local
code, never model prose).

**Say:** "A plant can't paste turbine telemetry into ChatGPT. Company evidence
stays in MAOS; the T-07 calculation is deterministic local code using
synthetic turbine data and demonstration thresholds. This is decision
support, not an operating decision."

### 0:30–1:00 — Ask Ring the turbine question (TO-RECORD)

**Action:** In the full app, ask Ring the T-07 turbine question (example: "Analyze
turbine vibration telemetry for T-07 and summarize the verdict, citing the
deterministic overall RMS."). Watch streamed fragments arrive as `model.delta`
events (`src/service/ring-agent-service.ts:890-908`).

**Say:** "I'm asking Ring — wired to meta-models/muse-spark-open-1026 via
Baseten — the turbine question. Tokens stream live; the verdict and RMS come
from the deterministic summary, never from model invention."

### 1:00–1:45 — Sources shown (TO-RECORD)

**Action:** Show the cited sources: SOP
(`demo/industrial/sop_turbine_vibration_monitoring.md`), maintenance report
(`demo/industrial/maintenance_report.txt`), safety thresholds
(`demo/industrial/safety_thresholds.json`), and the T-07 telemetry log
(`demo/industrial/turbine_vibration_log.csv`). Show the deterministic verdict
`CRITICAL` with overall RMS `2.637 mm/s`
(`tests/industrial/ring-inference.test.ts:184-185,223-224`).

**Say:** "Every number on screen is cited to one of these sources. Raw CSV
rows never ride along to the model — only the deterministic summary does."

### 1:45–2:45 — Deterministic verdict FAIL, RMS 2.637 (TO-RECORD)

**Action:** Show the deterministic verdict FAIL (engineering `CRITICAL`,
overall RMS `2.637 mm/s`, critical excursion `8.3 mm/s` row 367) and the
hybrid routing on a bookkeeping ask: the server pre-runs the deterministic
bookkeeping chain first and records a `skill.prefetch` marker, then the model
writes prose over established facts
(`src/service/ring-agent-service.ts:194-230`;
`tests/industrial/ring-hybrid.test.ts:1-60`).

**Say:** "The verdict is FAIL — RMS 2.637 against demo limits. Bookkeeping
stays deterministic: the server establishes facts first, the model only
writes prose and proposes the consequential step."

### 2:45–3:15 — Refusal beat (TO-RECORD)

**Action:** Ask Ring to approve a turbine restart. Show the calm refusal
verbatim — "I can't approve a restart or operation … This is decision
support, not operating authority. Synthetic demo data only."
(`src/service/ring-safety.ts:68-78`). No tools run, no files are written.

**Say:** "Ring refuses to approve a restart. That refusal is the trust
moment: the authorized engineer decides, not the model."

### 3:15–4:00 — Cockpit approvals and audit (TO-RECORD)

**Action:** Open the approval for the run ID, review evidence and hashes, and
approve as reviewer `release-reviewer`. Then open the Audit view and verify
the chain (`CHAIN: VERIFIED` in `src/gui/src/views/AuditView.tsx:186`).
Keep the same run ID visible in the report, download, audit export, and
verifier output. Show the overlay hotkey moment: press **Ctrl+Shift+Space**
(`desktop/ring-overlay-host.cjs:20`; `desktop/ring-smoke.cjs:29`) to summon
the overlay, and approve via the inline approval card in the overlay
(`src/gui/src/components/RingOverlay.tsx:10,366-374`).

**Say:** "Approval is bound to the reviewed evidence and rules. The overlay —
summoned with Ctrl+Shift+Space — carries the same approval card, and the
audit chain verifies."

### 4:00–4:40 — Judge verifier tamper moment (TO-RECORD)

**Action:** Re-verify the completed run by its exact returned run ID, then
demonstrate the tamper beat on a copy: altering one record hash fails closed
(`tests/industrial/judge-verifier.test.ts:177-185` — "fails closed when a
record hash is tampered"). Show the failed state; never splice a negative
case into the approved run.

**Say:** "Same run ID, verified artifacts — and a tampered copy fails closed.
The chain catches modification; nothing is presented as a successful report."

### 4:40–5:00 — One-person close (TO-RECORD)

**Say:** "Synthetic data only. Voice and P-12 vision are not included —
voice is stretch-only and cut
(`docs/product/RING_AGENT_PM_BRIEF.md:119,169`), and the P-12 scan PNG and
photo are not wired into Ring evidence paths in this packet
(`demo/industrial/DEMO_PACK_PROVENANCE.json:278,292`). Evidence-only mode is
the honest fallback, labelled as such. Decision support, not operating
authority."

## Capture checks

- Confirm each segment uses the correct, distinct run/thread ID. Never splice
a negative case into the approved run.
- Keep the engineering `FAIL`/`CRITICAL` verdict visible after report
generation; do not describe it as a passing safety result.
- Make sure the report, its hash, the audit export, and the verifier
output all refer to the approved run ID.
- Keep the model/endpoint identical everywhere:
`meta-models/muse-spark-open-1026` via `https://inference.baseten.co/v1`.
- If any action fails, show the failure state or retake the full segment in
a fresh project. Do not edit the video to imply a failed operation
succeeded.
- If hosted mode is unavailable, record the evidence-only fallback path and
label it EVIDENCE-ONLY on screen (the evidence-only answer contains the
deterministic summary with zero model wording;
`src/service/ring-inference-service.ts:320-328`).

## Headless fallback

If the app windows cannot be shown, a CLI capture may demonstrate package
execution and verification, but it cannot stand in for the human-review flow:

```powershell
maos-industrial run --auto-approve --yes --json
maos-industrial verify audit --run-id <run-id-from-output> --json
```

`--auto-approve --yes` records an explicit synthetic demo approval. It is not
human review and must be labeled as a CLI-only fallback.
