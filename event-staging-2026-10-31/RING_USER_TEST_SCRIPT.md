# Ring user test script (Electron app, human tester)

Boundaries (hard): synthetic fixtures only; no API key unless the
model-configured branch is explicitly authorized; no hosted calls in the
evidence-only branch; no real plant data. Stop on anything unexpected and
log it. Companion: `USER_TESTING.md` (Cockpit round), `RING_NARRATIVE.md`
(story + honesty rules).

## Setup (once)

Launch per RUNBOOK Option B exact commands (see USER_TESTING.md step 1;
`maosorch-0.3.0.tgz` provenance BLOCKED — owner supplies). Confirm session
PRESENT and API HEALTHY before proceeding (rehearsal steps A–B).

## Steps (model-configured branch)

| # | Do this (exact) | Expected visible result | Pass? |
|---|---|---|---|
| 1 | Open Ring; type exactly: `Why is turbine 7 above its vibration limit, and what do we do next?` | Question accepted; work starts | [ ] |
| 2 | Read the sources Ring shows | SOP `SOP-TURBINE-VIB-DEMO-V1`, telemetry/incident evidence (vibration log, maintenance report, thresholds, scan) with source + row count + analysis ID (form per rehearsal step C; exact rendering UNVERIFIED — record verbatim) | [ ] |
| 3 | Read the verdict | RMS ≈ 2.63711 mm/s, verdict FAIL (expected: over-threshold synthetic data); Cockpit renders the equivalent `RESULT: CRITICAL` | [ ] |
| 4 | Open the drafted safety note / DOCX | Note/DOCX present and readable; content references the cited evidence | [ ] |
| 5 | Refusal: try to claim completion without the required tool | On-screen refusal (record verbatim; reference: CLI gate refuses `AAP-01/POLICY-01…`, exit 4; approval wait exit 10) | [ ] |
| 6 | Open Cockpit approvals + audit | Queue state shown (rehearsal: 0 pending); audit linkage present for the run | [ ] |
| 7a | Verifier, original | `verify audit` on the sealed export → valid, 9 records, no errors | [ ] |
| 7b | Verifier, tampered copy | Copy the export, alter one byte, re-run verify → `valid: false` with hash-mismatch errors (f3-06 semantics; procedure derived, B2-unexecuted) | [ ] |

## Fallback: no model configured (expected branch, not a failure)

If no model is configured, Ring runs in evidence-only mode and says so —
record the exact announcement verbatim (the term itself is PM-directed;
nearest grounded product strings: `text-model not configured`,
`no model server configured — skipped`). Deterministic verdict, DOCX,
gates, and audit must all still work (B2 proved the full path keyless).
Ring must never pretend a model ran: any model-attributed text without a
configured model is a Blocker defect. Record which branch you ran.

## Defect log template (one row per deviation)

| Step | What happened (exact text/behavior) | Expected | Screenshot? (path or none) | Severity |
|---|---|---|---|---|
| | | | | |

Severity guide: Blocker = demo breaks or wrong result; Major = usable only
with a workaround; Minor = cosmetic.

## Grounding notes

Grounded: Baseten endpoint/model/key-var pins (`meta-api-policy.ts:3-5`,
contract test), RMS/verdict/DOCX/audit values (B2 packet), gate exits 4/10
(B2), rehearsal A–F expectations, tamper-negative semantics (f3-06/f2-03),
SOP doc id, fixture SHAs. PM-directed/UNVERIFIED: Ring/Cockpit naming,
exact question text, on-screen renderings, GUI refusal text,
evidence-only announcement wording, model-drafted prose behavior
(B2 ran model-free).
