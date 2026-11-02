# TASK W1-BASELINE: Verification Result Report

**Date**: 2026-11-01  
**Investigation**: Is the `f9-11` failure in the merged tree a W1 defect or an engine-staging gap?  
**Target Commit**: `5cf1afe28fa514d91a62e871885a8406f40316f3` (merged tree containing `f54dd7e` + W2 `262df98` + W1 `5cf1afe`)  
**Workspace**: Isolated clone at `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-w1-baseline-20261101-144500\core`  
**Staged Engine Path**: `rust/target/release/maos-engine.exe`  
**Staged Engine Size**: 462,848 bytes  
**Staged Engine SHA-256**: `280cf92ef4343c8876f48924977079c548e45471b4c4d8d253228fa1e8a6b4a8`  

---

## 1. Conclusion: Acceptance Condition (a) Confirmed

**Finding**: **ENGINE-STAGING GAP IN MAIN TREE** (NOT a W1 defect).

All four test files pass 100% (74/74 passed, 0 failed, exit code 0) when `rust/target/release/maos-engine.exe` is staged according to the repository contract.

The 27 failures observed when running the 10-file focused set in `C:\maos` (including the 6 failures in `tests/industrial/f9-11-audit-append-lock.test.ts`) are entirely `EngineError: Engine executable not found` errors caused by the absent engine binary in `C:\maos\rust\target\release\maos-engine.exe`.

W1 (`5cf1afe`) did not alter the runtime behavior or contract of `f9-11-audit-append-lock.test.ts` or audit lock handling.

---

## 2. Command Execution & Exit Codes

| Step | Command | Exit Code | Outcome |
|------|---------|-----------|---------|
| 1. Clone & Checkout | `git clone -c core.autocrlf=false C:\maos <temp>\core`<br>`git checkout --detach 5cf1afe28fa514d91a62e871885a8406f40316f3` | **0** | Clean clone at `5cf1afe28fa514d91a62e871885a8406f40316f3` with working tree clean. |
| 2. Rebuild Backend | `npm run build:backend` | **0** | Compiled TypeScript to `dist/` cleanly. |
| 3. Engine Staging | Copy from `C:\clean\core-b2-02\rust\target\release\maos-engine.exe` to `rust/target/release/maos-engine.exe` | **0** | Verified length 462,848 bytes, SHA-256: `280cf92ef4343c8876f48924977079c548e45471b4c4d8d253228fa1e8a6b4a8`. |
| 4. Vitest Execution | `npx vitest run tests/industrial/f9-11-audit-append-lock.test.ts tests/f3-06-audit-events.test.ts tests/f3-07-verifier-idempotency.test.ts tests/industrial/judge-verifier.test.ts` | **0** | 4 test files passed, 74 tests passed, 0 failed. |

---

## 3. Test Suite Breakdown

```text
 RUN  v4.1.11 C:/Users/AMITAKSHYA SUTAR/AppData/Local/Temp/maos-w1-baseline-20261101-144500/core

 ✓ tests/f3-07-verifier-idempotency.test.ts (27 tests) 1172ms
 ✓ tests/f3-06-audit-events.test.ts (25 tests) 1663ms
       ✓ should record events across all 10 required audit categories  310ms
 ✓ tests/industrial/judge-verifier.test.ts (13 tests) 711ms
 ✓ tests/industrial/f9-11-audit-append-lock.test.ts (9 tests) 2199ms
       ✓ two concurrent processes produce a linear chain with a consistent head  1280ms

 Test Files  4 passed (4)
      Tests  74 passed (74)
   Start at  14:47:56
   Duration  10.64s (transform 2.02s, setup 0ms, import 4.15s, tests 5.74s, environment 0ms)
```

- `tests/industrial/f9-11-audit-append-lock.test.ts`: **9 passed, 0 failed**
  - Section 5 ("Concurrent OS processes > two concurrent processes produce a linear chain with a consistent head"): **PASSED** (1280ms).
- `tests/f3-06-audit-events.test.ts`: **25 passed, 0 failed**
- `tests/f3-07-verifier-idempotency.test.ts`: **27 passed, 0 failed**
- `tests/industrial/judge-verifier.test.ts`: **13 passed, 0 failed**

**Total**: **74 passed, 0 failed**.

---

## 4. Verification Boundaries

- **Hosts Contacted**: None (100% offline, local Rust engine binary verification).
- **Secrets / Keys Read**: None (`MODEL_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, Baseten keys strictly avoided).
- **Modifications to C:\maos**: None (verification performed strictly in isolated temporary clone).
- **What is NOT Verified**: Unrelated pre-existing absent canary (`rust/test.txt`) and remote network endpoints.
