# TASK RING-SVC-01: Run Log & Verification Record

- **Task**: `RING-SVC-01` (Server-side Ring Inference Service & API Route)
- **Base Commit**: `5cf1afe28fa514d91a62e871885a8406f40316f3`
- **Worktree**: `C:\clean\ring-svc-01` (isolated detached worktree)
- **Patch Path**: `C:\maos\review-packets\ring-svc-01-2026-11-02\candidate.patch`
- **Patch SHA-256**: `557EC5D67D9772E43E86F44F22855870F3B04DD375B6EE4C88B273D37F846E22`
- **Date**: 2026-11-01
- **Executor**: Antigravity (Verification & Triage)

---

## 1. Scope & House Rules Adherence

1. **Isolation**:
   - Zero edits to `C:\maos` (only review packet deliverable written to `review-packets/ring-svc-01-2026-11-02/`).
   - No commits, pushes, tags, or package installations executed.
   - All compilation, typing, and vitest runs took place inside `C:\clean\ring-svc-01`.

2. **Policy Reuse (No Reinvention)**:
   - Reused constants from `src/backends/meta-api-policy.ts`:
     - `BASETEN_API_BASE_URL` (`https://inference.baseten.co/v1`)
     - `BASETEN_API_MODEL` (`meta-models/muse-spark-open-1026`)
     - `BASETEN_API_KEY_ENV` (`BASETEN_API_KEY`)
     - `ProviderApiPolicyError` (`BASETEN_API_CONFIGURATION_INVALID`, `BASETEN_API_OPT_IN_REQUIRED`)
   - Did **NOT** modify `ChatInferenceService`.
   - Did **NOT** modify `src/backends/factory.ts` (`enforceLoopbackOnly` continues firing for sovereign-local agent runtimes).

3. **Deterministic Integration**:
   - Prefetches demo SOP (`demo/industrial/sop_turbine_vibration_monitoring.md`), incident note (`demo/industrial/maintenance_report.txt`), safety thresholds (`demo/industrial/safety_thresholds.json`), and deterministic telemetry analysis (`demo/industrial/turbine_vibration_log.csv` or receipt for `analysisId`).
   - Verdict text (`CRITICAL`) and vibration RMS (`2.637 mm/s`) are produced byte-for-byte by the deterministic calculation engine, never fabricated or summarized by model prose.
   - Evidence-only mode returns this composed summary directly with zero model wording.

4. **Hosted Prompt Hygiene**:
   - Prompt sent to the hosted model contains strictly the deterministic summary and user question.
   - Raw CSV rows / telemetry data streams are never included in prompt context.

---

## 2. Write Set Summary

| File | Change Type | Lines | Description |
|---|---|---|---|
| `src/service/ring-inference-service.ts` | Added | +399 | Implements `RingInferenceService` with `ask(input)`, arming validation, deterministic prefetch, evidence composition, OpenAIProvider delegation, and error handling. |
| `src/service/index.ts` | Modified | +17 | Exports `RingInferenceService` and mounts `ringInference` onto `ServiceContainer` and `createServiceContainer`. |
| `src/api/router.ts` | Modified | +37 | Mounts `POST /api/v1/ring/ask` with input validation, policy error handling, and delegation to `ringInference.ask()`. |
| `tests/industrial/ring-inference.test.ts` | Added | +414 | Comprehensive vitest test suite covering requirements (a) through (f) using local loopback HTTP mock. |

---

## 3. Test & Verification Execution

### 3.1 Backend Build (`npm run build:backend`)
- **Command**: `npm run build:backend`
- **Exit Code**: `0`
- **Output**:
  ```
  > maosorch@0.3.0 build:backend
  > tsc -p tsconfig.json && node scripts/copy-industrial-python.js
  ```

### 3.2 GUI Typecheck (`npm run typecheck:gui`)
- **Command**: `npm run typecheck:gui`
- **Exit Code**: `0`
- **Output**:
  ```
  > maosorch@0.3.0 typecheck:gui
  > tsc -p tsconfig.gui.json --noEmit
  ```

### 3.3 Test Suite Execution (vitest)
- **Command**: `npx vitest run tests/industrial/ring-inference.test.ts tests/industrial/telemetry-analysis.test.ts tests/gui/ui1-02-api-clients.test.ts`
- **Exit Code**: `0`
- **Results**:
  - `tests/industrial/ring-inference.test.ts`: **6 passed**
    - (a) armed + mock returns a message -> mode hosted, served id only when echoed
    - (b) key missing -> evidence-only, deterministic verdict still present
    - (c) basetenApiEnabled false -> evidence-only
    - (d) endpoint/model mismatch -> rejected with BASETEN_API_CONFIGURATION_INVALID
    - (e) prompt sent to mock contains the summary and NOT raw telemetry rows
    - (f) malformed route body rejected by REST API router
  - `tests/industrial/telemetry-analysis.test.ts`: **4 passed**
  - `tests/gui/ui1-02-api-clients.test.ts`: **33 passed**
  - **Total**: **43 passed across 3 test files (0 failures)**
  - **Duration**: 5.81s

### 3.4 Patch Cleanliness (`git apply --check`)
- **Command**: `git -C C:\clean\core-b2-02 apply --check C:\maos\review-packets\ring-svc-01-2026-11-02\candidate.patch`
- **Exit Code**: `0` (applied cleanly against clean HEAD with zero offset/errors).

---

## 4. Deliverable Artifacts

- `C:\maos\review-packets\ring-svc-01-2026-11-02\candidate.patch`
- `C:\maos\review-packets\ring-svc-01-2026-11-02\run-log.md`
