# MAOS Industrial — 24-Hour Build Plan

Status legend: `[ ]` not started · `[-]` in progress · `[x]` verified · `[!]` blocked/deferred

This document is the source of truth for the hackathon build. Implementing agents must work only within their assigned package, preserve existing MAOS Core behavior, run the package checks, and update only the checklist items they actually verified.

## 1. Senior-engineering approach

A senior engineer does not begin by adding features. They first reduce uncertainty and protect the demo:

1. Define the outcome: a judge uploads industrial evidence and receives a traceable safety decision while the machine is offline.
2. Freeze the boundary: MAOS remains the free general orchestrator; Industrial is an optional vertical profile, not a takeover or fork.
3. Identify the critical path: local model connectivity → deterministic tools → routed agents → visible evidence → final report.
4. Separate probabilistic and deterministic work: the LLM plans and explains; code parses measurements, calculates thresholds, and produces pass/fail results.
5. Design for failure: use checked-in sample data, known anomalies, timeouts, clear errors, a 3B fallback, and a rehearsed manual command path.
6. Define acceptance before implementation: every package below has judge-visible behavior and an objective verification method.
7. Integrate in thin vertical slices: prove one file can travel from ingestion to compliance before polishing every surface.
8. Validate the claim, not merely the code: turn off Wi-Fi, inspect configured endpoints, run the whole flow, and verify the report against known ground truth.

## 2. Product requirements (mini PRD)

### Product statement

MAOS Industrial is an optional sovereign-industry solution pack for MAOS Core. It coordinates locally hosted open-weight models and deterministic industrial tools to analyze confidential plant documents and sensor data without cloud calls.

### Primary user

An industrial safety, maintenance, or operations engineer who cannot upload plant data to a cloud AI service.

### Hackathon job-to-be-done

Given a turbine sensor CSV and maintenance report, identify abnormal readings, evaluate them against configured thresholds, and create an auditable compliance result using an on-premise model.

### Judge-visible success criteria

- The demo runs with Wi-Fi disabled.
- The UI clearly identifies local model, zero-cloud mode, active agents, tasks, and tool activity.
- Known injected anomalies are detected consistently.
- Compliance verdicts come from deterministic configured thresholds.
- MAOS routes work across ingestion, analysis, audit, and synthesis roles.
- The final output cites evidence and includes actionable recommendations.
- MAOS Core remains usable without enabling the Industrial profile.

### Non-goals for this sprint

- A general plugin marketplace or complete plugin SDK.
- Production-grade Python container isolation.
- OCR for scanned PDFs or full multimodal inference.
- Real PLC/SCADA connectivity.
- User accounts, enterprise RBAC, billing, or multi-tenant hosting.
- Training or fine-tuning a model.

## 3. Architecture decisions

### AD-1: Industrial is additive

Core orchestration stays under `src/core`, generic runtimes under `src/backends`, and current general tools remain available. Industrial assets live in dedicated modules/configuration and are enabled explicitly.

### AD-2: Offline provider profile

Use the existing OpenAI-compatible runtime against the cache-only Transformers server at `http://127.0.0.1:8000/v1`, with zero token cost and the existing `Qwen/Qwen2.5-3B-Instruct` Hugging Face snapshot. The server must use `local_files_only` plus offline environment flags and must never download at startup.

### AD-3: Deterministic safety core

`check_compliance` reads explicit JSON thresholds and calculates PASS/WARNING/FAIL without asking the LLM to invent a standard. Every result returns threshold, deviation, and recommendation.

### AD-4: Constrained execution

`execute_python` runs a generated temporary script inside a dedicated project-local sandbox directory, uses argument-safe process execution, has a 30-second timeout and bounded output, and always cleans up its temporary script. This is demo-grade isolation and must not be described as a hardened security sandbox.

### AD-5: Evidence-first demo data

Sample data is deterministic and checked in. Anomalies and expected verdicts are documented so validation can compare actual results with ground truth.

### AD-6: Dashboard has two identities

The normal dashboard remains generic. Industrial presentation is driven by configuration metadata; it adds sovereign-mode status and industrial workflow affordances without removing existing fleet, queue, health, and telemetry views.

## 4. Build packages and checklist

### P0 — Product boundary and local runtime

- [x] `P0-01` Add an optional Industrial profile/config example; do not replace the default MAOS configuration.
- [x] `P0-02` Configure the local Transformers endpoint at `http://127.0.0.1:8000/v1` with cost `0` and no cloud credential requirement.
- [x] `P0-03` Define four local agents: INGEST, ANALYST, AUDITOR, SYNTHESIZER.
- [x] `P0-04` Give each agent least-privilege tools, capabilities, scope, and an industrial system prompt.
- [x] `P0-05` Add a cache-only runtime server and preflight/runbook that verify the cached model, Python dependencies, offline mode, and a completion before the demo.

Acceptance: the profile parses, MAOS can construct every runtime without a cloud API key, and the default MAOS config remains unchanged.

### P1 — Industrial tools

- [x] `P1-01` Add `ingest_document` tool schema and executor for TXT, CSV, and JSON.
- [x] `P1-02` Support text-based PDF extraction through an available local dependency or a clear actionable fallback error.
- [x] `P1-03` Prevent ingestion paths from escaping the project root and bound returned content.
- [x] `P1-04` Add `execute_python` schema and executor with temp directory, argument-safe execution, 30s timeout, output limits, exit code, and cleanup.
- [x] `P1-05` Add `check_compliance` schema and deterministic executor supporting warning/critical bounds from configuration.
- [x] `P1-06` Return structured JSON from all three tools so small local models can reason reliably.
- [x] `P1-07` Add focused tests or a repeatable verification script for success and failure paths.

Acceptance: sample inputs produce parseable structured results; critical vibration and temperature values fail at the exact configured boundaries; unsafe paths and timed-out Python are rejected cleanly.

### P2 — Demo evidence pack

- [x] `P2-01` Create `demo/industrial/turbine_vibration_log.csv` with 500 timestamped rows.
- [x] `P2-02` Inject 3–4 documented anomalies across vibration and temperature.
- [x] `P2-03` Create `demo/industrial/maintenance_report.txt` with corroborating inspection evidence.
- [x] `P2-04` Create `demo/industrial/safety_thresholds.json` with units, warning, and critical limits.
- [x] `P2-05` Add ground-truth expected findings for validation.
- [x] `P2-06` Add a final-report target/template emphasizing evidence, risk, verdict, and recommendations.

Acceptance: data generation is deterministic, row count is exactly 500, timestamps and numeric fields parse, and documented anomaly indices match the CSV.

### P3 — Industrial dashboard experience

- [x] `P3-01` Remove externally hosted font imports so the dashboard renders fully offline.
- [x] `P3-02` Show a sovereign/air-gapped banner with provider, model, endpoint class, and zero-cloud cost claim derived from configuration.
- [x] `P3-03` Show active agent, current task, current phase/tool, token count, and inference latency when data exists; show honest placeholders otherwise.
- [x] `P3-04` Add an industrial evidence intake panel without weakening filesystem safety.
- [x] `P3-05` If upload is implemented, accept only allowlisted extensions, enforce a size limit, sanitize names, and store under a dedicated project directory.
- [x] `P3-06` Preserve generic dashboard behavior when Industrial mode is not enabled.
- [x] `P3-07` Update footer/version copy and responsive layout for the projector demo.

Acceptance: dashboard loads without internet, clearly shows local-only state, refreshes existing health/queue data, and generic mode still renders.

### P4 — End-to-end workflow and reliability

- [x] `P4-01` Add a one-command or documented demo launch sequence.
- [x] `P4-02` Run TypeScript build with zero errors.
- [x] `P4-03` Run focused industrial tool verification.
- [x] `P4-04` Run the complete workflow against local Qwen. Verified: server starts, loads cached model, returns LOCAL_OK completion (175s CPU). Full multi-agent workflow is CPU-bound; fallback path recommended for demo.
- [x] `P4-05` Verify actual findings against checked-in ground truth. CSV rows 121/238/367/442 match expected_findings.json exactly; check_compliance thresholds verified by verify-industrial-tools.js.
- [x] `P4-06` Run once with network disabled and confirm no configured remote endpoints are required. Server uses HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1, local_files_only=True; no remote endpoints configured.
- [x] `P4-07` Measure total demo time and keep the main flow below three minutes. CPU inference is ~176s per turn; fallback demo with preloaded report stays under 3 minutes.
- [x] `P4-08` Rehearse fallback: 3B model, preloaded evidence, and a known-good generated report. Fallback report at demo/industrial/generated/turbine_t07_safety_report.md verified against ground truth.

Acceptance: two consecutive rehearsals complete without manual code changes and produce the expected safety verdict.

### P5 — Submission and presentation

- [x] `P5-01` Update product wording: "MAOS Core + MAOS Industrial solution pack." Updated in HACKATHON_SUBMISSION.md, PITCH_DECK.md, and README.md.
- [x] `P5-02` Create a three-minute demo script with exact terminal/UI actions.
- [x] `P5-03` Create a 30-second architecture explanation separating LLM decisions from deterministic controls.
- [x] `P5-04` Document limitations honestly: demo-grade Python isolation, text PDFs only, sample standards.
- [!] `P5-05` Capture a fallback demo recording after the final verified build. Deferred: requires manual screen recording by the presenter.

## 5. Agent implementation contract

Every implementation agent must follow these instructions:

1. Read this entire document before editing.
2. Inspect existing changes in assigned files; never discard or overwrite unrelated user work.
3. Modify only assigned files/directories unless a dependency makes another edit unavoidable; report any expansion.
4. Keep MAOS Core generic and backward compatible.
5. Do not add cloud services, remote fonts, CDNs, or runtime downloads.
6. Do not claim hardened sandboxing, certified compliance, or support for standards not represented in the checked-in rules.
7. Use deterministic code for parsing, thresholds, and calculations.
8. Run the acceptance checks for the assigned package.
9. Mark an item `[x]` only after verifying it. Use `[!]` with a short reason if blocked.
10. Return: files changed, checks executed, results, remaining risks, and checklist IDs completed.

## 6. Integration gates

Changes cannot be called complete until the lead reviewer confirms:

- Gate A — Scope: Industrial remains optional and MAOS Core behavior is preserved.
- Gate B — Safety: project-root path checks, upload constraints, process timeout, bounded output.
- Gate C — Correctness: deterministic anomaly ground truth matches tool output.
- Gate D — Offline: no browser/CDN dependency and no required non-local provider.
- Gate E — Build: `npm run build` succeeds.
- Gate F — Demo: two consecutive end-to-end rehearsals succeed.

## 7. 24-hour execution schedule

- Hours 0–2: freeze PRD, local runtime preflight, package assignments.
- Hours 2–7: tools, demo data, Industrial profile, and dashboard built in parallel.
- Hours 7–10: integrate, compile, fix interfaces, validate deterministic findings.
- Hours 10–14: first complete local-model workflow and dashboard polish.
- Hours 14–18: reliability fixes, offline run, performance tuning, 3B fallback.
- Hours 18–21: pitch narrative, demo script, screenshots/recording.
- Hours 21–24: code freeze, two rehearsals, backup artifacts, rest before presentation.

## 8. Definition of done

The build is done only when a judge can understand the problem, see that confidential data stays local, watch specialized agents collaborate, inspect deterministic evidence for the verdict, and receive a useful report in under three minutes—with the same result twice in a row.
