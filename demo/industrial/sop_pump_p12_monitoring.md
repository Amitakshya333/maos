# Standard Operating Procedure (SOP): Pump P-12 Vibration & Temperature Safety Audit

- **Document ID:** `SOP-PUMP-P12-DEMO-V1`
- **Version:** `1.0.0`
- **Effective Date:** `2026-09-10`
- **Target Asset:** Centrifugal Pump P-12 (Drive-End Bearing Assembly, 3000 RPM class)
- **License:** CC0-1.0 Universal (Public Domain Dedication) — Non-Proprietary Synthetic Demonstration Asset

---

## 1. Regulatory Disclaimer & Negative Clearance Notice

> [!WARNING]
> **HACKATHON DEMONSTRATION RULES ONLY; NOT A CERTIFIED STANDARD OR OPERATING AUTHORIZATION.**
>
> 1. **Negative Clearance:** This document contains zero proprietary refinery, petrochemical, or MRPL confidential data. All equipment identifiers, sensor thresholds, timestamps, and readings are synthetic public assets created exclusively for offline benchmarking.
> 2. **Evaluation Framework:** Vibration thresholds are derived from public demonstration adaptations of ISO 10816-3 mechanical vibration evaluation guidelines for demonstration evaluation only.
> 3. **Non-Commercial Use:** This document cannot be used as an authorized operating manual or plant safety standard.

---

## 2. Scope & Equipment Profile

- **Unit:** Unit 3 Utility Water Transfer
- **Machine Type:** Single-Stage Centrifugal Pump, close-coupled to 4-pole motor
- **Operating Speed:** 3000 RPM nominal (2980-3020 RPM envelope)
- **Monitored Points:**
  - Drive-End (DE) Bearing Radial Vibration (`vibration_rms_mm_s`)
  - DE Bearing Metal Temperature (`bearing_temperature_c`)

---

## 3. Sensor Telemetry Ingestion & Format Rules

1. **Sampling Frequency:** Readings recorded at 20-second intervals over a standard 120-minute evaluation window (360 total readings).
2. **Ingestion File:** `pump_p12_vibration_log.csv` (SHA-256 recorded in `DEMO_PACK_PROVENANCE.json`).
3. **Data Integrity:** Must be verified with streaming SHA-256 canonical digest before evaluation. Any NaN, null, or out-of-range sensor readings trigger ingestion quarantining.

---

## 4. Evaluation Thresholds & Zone Classifications

| Metric | Normal (Zone A/B) | Warning (Zone C) | Critical / Fail (Zone D) |
|---|---|---|---|
| **Vibration RMS** | `< 4.5 mm/s` | `4.5 mm/s` – `7.1 mm/s` | `≥ 7.1 mm/s` |
| **Bearing Temperature** | `< 85.0 °C` | `85.0 °C` – `95.0 °C` | `≥ 95.0 °C` |

### Action Directives by Severity:
- **Normal (PASS):** Continue nominal operating cycle. Log sensor export.
- **Warning (WARNING):** Increase monitoring frequency to 1-minute intervals. Dispatch field operator for visual inspection and seal check.
- **Critical (FAIL):** Escalate immediately to Plant Engineering Lead. Initiate controlled load reduction or safe shutdown assessment within 30 minutes.

---

## 5. Multimodal Evidence Cross-Verification Protocol

1. **Scanned Physical Inspection:** Review `pump_p12_inspection_scan.png` for field annotations, seal-weep notes, and initial visual status.
2. **Maintenance Observation Log:** Cross-correlate telemetry anomalies with field observations from `maintenance_report_p12.txt`:
   - Anomaly at Row 61 (08:20:00, 5.6 mm/s): Corroborates higher-than-baseline vibration feel.
   - Anomaly at Row 151 (08:50:00, 88.9 °C): Corroborates DE housing warmth.
   - Anomaly at Row 241 (09:20:00, 7.8 mm/s): Corroborates seal-weep recurrence.
   - Anomaly at Row 331 (09:50:00, 96.4 °C): Triggers emergency critical escalation.
3. **Equipment Photo:** Validate skid layout and coupling guard presence against `images/pump_p12_photo.png`.

---

## 6. Sovereign Governance & Human Review Gate

1. **Air-Gapped Local Inference:** All analysis, OCR, code execution, and document synthesis must execute entirely within the on-premise local perimeter without non-loopback network egress.
2. **Mandatory Human-in-the-Loop Approval:** Any deliverable generation proposing machinery intervention or verdict determination requires human sign-off via the approval gate (`/api/v1/approvals`).
3. **Audit Trail Cryptography:** Generated reports must link back to input artifact hashes and record sequenced event logs in the immutable audit ledger.

---

## 7. Lockout/Tagout Reminder (verify against your site procedure)

Isolate pump P-12 before hands-on work: stop the pump, isolate suction and discharge valves, lock the motor starter, drain/vent as needed, verify zero energy, then fit personal locks and tags. This summary is a demo checklist only — **verify against your site procedure** before any real isolation.
