# Standard Operating Procedure (SOP): Turbine Vibration & Temperature Safety Audit

- **Document ID:** `SOP-TURBINE-VIB-DEMO-V1`
- **Version:** `1.0.0`
- **Effective Date:** `2026-09-24`
- **Target Asset:** Steam Turbine T-07 (Drive-End Bearing Assembly, 3000 RPM)
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

- **Unit:** Unit 7 Auxiliary Power Generation
- **Machine Type:** Industrial Multi-Stage Steam Turbine
- **Drive Type:** Direct rigid coupling to 50 Hz alternator
- **Operating Speed:** 3000 RPM nominal
- **Monitored Points:**
  - Drive-End (DE) Bearing Radial Vibration (`vibration_rms_mm_s`)
  - Non-Drive-End (NDE) Bearing Radial Vibration (`vibration_rms_mm_s`)
  - DE Bearing Metal Temperature (`bearing_temperature_c`)

---

## 3. Sensor Telemetry Ingestion & Format Rules

1. **Sampling Frequency:** Readings recorded at 15-second intervals over a standard 125-minute evaluation window (500 total readings).
2. **Ingestion File:** `turbine_vibration_log.csv` (SHA-256: `d2c310035a20066f71f0c367eacb9600ea8fa048821b8290335dc913b1b568a6`).
3. **Data Integrity:** Must be verified with streaming SHA-256 canonical digest before evaluation. Any NaN, null, or out-of-range sensor readings trigger ingestion quarantining.

---

## 4. Evaluation Thresholds & Zone Classifications

| Metric | Normal (Zone A/B) | Warning (Zone C) | Critical / Fail (Zone D) |
|---|---|---|---|
| **Vibration RMS** | `< 4.5 mm/s` | `4.5 mm/s` – `7.1 mm/s` | `≥ 7.1 mm/s` |
| **Bearing Temperature** | `< 85.0 °C` | `85.0 °C` – `95.0 °C` | `≥ 95.0 °C` |

### Action Directives by Severity:
- **Normal (PASS):** Continue nominal operating cycle. Log sensor export.
- **Warning (WARNING):** Increase monitoring frequency to 1-minute intervals. Dispatch field operator for visual inspection and thermal imaging.
- **Critical (FAIL):** Escalate immediately to Plant Engineering Lead. Initiate controlled load reduction or safe shutdown assessment within 30 minutes.

---

## 5. Multimodal Evidence Cross-Verification Protocol

1. **Scanned Physical Inspection:** Review `turbine_inspection_scan.pdf` for technician field annotations, nameplate corroboration, and initial visual status.
2. **Maintenance Observation Log:** Cross-correlate telemetry anomalies with field observations from `maintenance_report.txt`:
   - Anomaly at Row 121 (09:30:00, 5.2 mm/s): Corroborates intermittent metallic sound.
   - Anomaly at Row 238 (09:59:15, 88.4 °C): Corroborates DE housing thermal elevation.
   - Anomaly at Row 367 (10:31:30, 8.3 mm/s): Corroborates dark lubricant residue recurrence.
   - Anomaly at Row 442 (10:50:15, 97.2 °C): Triggers emergency critical escalation.
3. **P&ID and Equipment Inspection:** Validate piping and instrument connections against `images/pid_drawing.png` and `images/pressure_gauge.png`.

---

## 6. Sovereign Governance & Human Review Gate

1. **Air-Gapped Local Inference:** All analysis, OCR, code execution, and document synthesis must execute entirely within the on-premise local perimeter without non-loopback network egress.
2. **Mandatory Human-in-the-Loop Approval:** Any deliverable generation proposing machinery intervention or verdict determination requires human sign-off via the approval gate (`/api/v1/approvals`).
3. **Audit Trail Cryptography:** Generated reports must link back to input artifact hashes and record sequenced event logs in the immutable audit ledger.
