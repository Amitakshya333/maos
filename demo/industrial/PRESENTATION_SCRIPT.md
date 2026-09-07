# MAOS Industrial — 3-Minute Demo Script

## 0:00–0:20 — Establish the problem

Say: “Industrial teams cannot send turbine logs or maintenance reports to a cloud AI service. MAOS Industrial is an optional sovereign solution pack on top of MAOS Core: the orchestration stays general, while this profile adds industrial evidence and safety workflows.”

Turn Wi-Fi off. Keep the browser on `http://localhost:3847/dashboard` and show the sovereign banner: local Ollama, Qwen 2.5 3B, local endpoint, zero cloud cost.

## 0:20–0:45 — Show the evidence

Open `demo/industrial/turbine_vibration_log.csv` and `maintenance_report.txt`. Point out that the dataset contains 500 readings and four known events. Do not claim these thresholds are a certified standard; they are the demonstration ruleset shown in `safety_thresholds.json`.

## 0:45–1:45 — Run the workflow

Use the exact command from `RUNBOOK.md` to activate the profile and submit:

```text
Audit demo/industrial/turbine_vibration_log.csv and maintenance_report.txt for safety violations and generate a traceable compliance report.
```

Narrate the visible route: INGEST preserves provenance, ANALYST finds time-series anomalies, AUDITOR calls deterministic `check_compliance`, and SYNTHESIZER compiles the report. The model explains and coordinates; code owns threshold arithmetic.

## 1:45–2:30 — Inspect the result

Open the generated report. Show the four documented rows, observed values, thresholds, deviations, FAIL/WARNING verdicts, corroborating maintenance evidence, and recommendations. Highlight the overall FAIL verdict and the ruleset disclaimer.

Upload one evidence file through the dashboard and show that it is stored under `.maos/industrial/evidence` on the same machine.

## 2:30–3:00 — Close with the platform story

Say: “The industrial workflow is a vertical pack, not a replacement for MAOS. The same MAOS Core can orchestrate software, research, or operations agents. This profile proves that confidential, auditable agentic workflows can run entirely on-premise.”

## Recovery path

If live inference is slow, use the checked-in evidence and the last verified generated report. Keep the cached `Qwen/Qwen2.5-3B-Instruct` runtime as the known local model. Never reconnect Wi-Fi during the demo; the offline claim is the point.
