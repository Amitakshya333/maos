# Ring tool-calling reliability — live instructions (5)

Base: main HEAD `64471c6`. Harness: `scripts/ring-tool-reliability-check.mjs`
(Dev A Day-2, read in full at base). The harness as shipped runs **4**
built-in instructions on the `--live` path; instruction 5 below
(`followup-recall`) is provided here as a PM-pasteable fifth live run for
the on-camera set. The scorer contract in `runOne()` (expected tools
present, args-shape valid, tool.call/result pairing, completion +
non-empty final answer, `modelTurns <= 20`, no raw-row leak, exit
non-zero on any provider error with no retry loop) applies identically
to all 5.

Ground data (all T-07, all in `demo/industrial/` staged by the harness
into its temp project):
- `turbine_vibration_log.csv` — 500 data rows (1-based excl. header);
  row 367 = `2026-08-22T10:31:30+05:30`, `vibration_rms_mm_s` 8.3, FAIL.
- `sop_turbine_vibration_monitoring.md` — SOP-TURBINE-VIB-DEMO-V1,
  documents anomalies incl. row 367 (10:31:30, 8.3 mm/s).
- `safety_thresholds.json` — vibration warn 4.5 / critical 7.1 mm/s RMS;
  temperature warn 85 / critical 95 C.
- `maintenance_report.txt` — corroborating evidence (metallic sound,
  warm DE housing, dark lubricant residue, prior-shift alarms).

Each instruction needs 2-3 tool calls on T-07 data. Expected tools are
listed in order. Tool schemas are identical on `--dry-run` (same
registry, `RING_AGENT_TOOLS` built from `createRingToolRegistry`) and
`--live`; only the driver differs (evidence-only keyword router vs
hosted model). Consequential tools (`create_work_order`,
`generate_report_docx`, `write_shift_handover`, `draft_safety_note`,
`request_approval`) pause at `awaiting_approval`; the harness
auto-denies and records the denial, and the run stops that branch
rather than retrying.

## 1. `brief-t07-verdict` — T-07 brief + verdict (2-3 calls)

> Analyze turbine vibration telemetry for T-07 and summarize the verdict,
> citing the deterministic overall RMS. Then update the run plan with the
> next monitoring steps.

Expected tools in order: `analyze_telemetry` -> `update_plan`.
(Hosted model may additionally cite thresholds; `read_company_document`
on `safety_thresholds.json` is acceptable but not required. Refusal or
restart-approval language fails this instruction.)

## 2. `correlate-scan-row-367` — correlate scan finding with row 367 (2-3 calls)

> Read the turbine vibration monitoring SOP, then analyze T-07 vibration
> telemetry and correlate the documented row-367 anomaly (10:31:30,
> 8.3 mm/s) with the deterministic findings. Report the row, timestamp,
> observed value, and the SOP corroboration.

Expected tools in order: `read_company_document` (path:
`sop_turbine_vibration_monitoring.md`) -> `analyze_telemetry`.
(Final answer must name row 367 / 10:31:30 / 8.3 mm/s and the lubricant
finding; a CSV header line in the answer fails the instruction.)

## 3. `raise-work-order` — raise work order draft (2-3 calls)

> Analyze T-07 vibration telemetry, then draft a work order for asset T-07
> recording the verdict as the finding with priority urgent, citing the
> turbine vibration log as evidence. Stop after the approval decision is
> recorded; do not retry a denied write.

Expected tools in order: `analyze_telemetry` -> `create_work_order`
(consequential: harness auto-denies at `awaiting_approval`; the denial
recorded in the transcript is the expected stop, not a failure of the
harness). Args validity checked on `assetId: T-07`,
`finding: <verdict text>`, `priority: urgent`.

## 4. `verify-last-export` — verify last export (2-3 calls)

> Analyze T-07 vibration telemetry for the current verdict, then verify
> the audit export chain and report whether the audit trail is valid.

Expected tools in order: `analyze_telemetry` -> `verify_export`.
(Final answer must state valid/invalid; empty final answer or a thrown
incomplete-loop error fails the instruction.)

## 5. `followup-recall` — follow-up recall (2-3 calls)

> Remember that T-07 is a critical asset needing vibration watch, then
> recall stored notes for T-07 vibration follow-up and update the run plan
> with the next monitoring steps.

Expected tools in order: `remember` (content names T-07 + vibration
watch, tags include `T-07`) -> `recall` (query `T-07 vibration`) ->
`update_plan` (steps reference the recalled follow-up).
(This is the fifth PM run; the shipped harness covers 1-4 above, so
record this run's transcript fields by hand per RUNCARD.md. The harness
scorer contract — expected tools present, args valid, pairing ok,
completion + non-empty final answer, turns <= 20, no raw-row leak —
applies unchanged.)
