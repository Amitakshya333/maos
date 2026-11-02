# Simple-Git Removal Candidate — Task A Report
Agent: Antigravity (replacing Delta)
Date: 2026-11-01T11:25 IST
Base commit: 2cfdf9b81f56eada7df2041625da18e44531151e (event-core-2cfdf9b)
Temp clone: C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\maos-antigravity-20261101-111414\core-taskA

---

## Step 1: Confirm no imports of simple-git (excluding node_modules, dist, .git)
- Command: git grep -rn "require.*simple-git|from.*simple-git|import.*simple-git" -- ':!node_modules' ':!dist' ':!.git'
- Exit code: 1 (no matches)
- Additional search of all .ts/.tsx/.js/.jsx files: exit 1 (no matches)
- simple-git appears only in: package.json (line 87), package-lock.json, npm-cache-manifest.json, Have a Look.md (documentation mention)
- CONFIRMED: no code imports simple-git. Safe to remove.

## Step 2-3: Remove simple-git + update lockfile
- Command: npm uninstall simple-git --package-lock-only
- Exit code: 0
- package.json: simple-git entry removed. JSON valid.
- package-lock.json: no references to simple-git or @simple-git/* remain.
- npm-cache-manifest.json: NOT modified (not a package manifest; it's a cache reference file).
  This is expected — npm uninstall does not touch this file.

## Step 4: npm ci + build + typecheck
| Command | Exit Code |
|---------|-----------|
| npm ci | 0 (235 packages installed; lifecycle: prepare -> scripts/prepare-hooks.js) |
| npm run build:backend | 0 (tsc -p tsconfig.json && node scripts/copy-industrial-python.js) |
| npm run typecheck:gui | 0 (tsc -p tsconfig.gui.json --noEmit) |

## Step 5: Run git integration tests
- Test files found (17 files matching "integrations/git", "integrations/worktree", "integrations/tools"):
  f1-trust-boundaries, f5-05-kb-search, phase-e, f11-02, f11-03, f4-03, f4-05,
  f6-02, f6-03, f6-04, f6-05, f7-04, f8-03, f8-04, f8-05, f8-07, g5
- Command: npx vitest run [17 files]
- Exit code: 1
- Results: 490 tests total — 324 passed, 166 failed

### Failure Attribution (all pre-existing, not caused by simple-git removal):
| Cause | # Failures | Files |
|-------|-----------|-------|
| Missing engine binary (maos-engine.exe not in clone) | ~majority | f4-03, f4-05, f6-02, f6-03, f6-04, f6-05, f7-04, f8-07, g5 |
| Missing rust/test.txt canary (absent by owner decision) | several | f6-02, f6-03, f6-04, f6-05, f8-03, f8-04, g5 |
| Pre-existing audit/engine dependencies | remainder | f5-05, f11-02, f11-03, f8-07 |

Passed test files (3): f1-trust-boundaries, phase-e, f8-05-sovereign-coding-demo

NO test failure references simple-git or any module that depends on it.

## Step 6: npm audit
- Command: npm audit --json
- Exit code: 1 (vulnerabilities remain, but not simple-git ones)
- simple-git advisories removed:
  - GHSA-x6jw-m9v5-85vh: NOT PRESENT (removed)
  - GHSA-g4wm-2vf7-vfgr: NOT PRESENT (removed)
  - GHSA-858h-whjf-mvg5: NOT PRESENT (removed)
  - GHSA-v5rq-49vh-5v5c: NOT PRESENT (removed)
- Remaining vulnerabilities: 4 (2 moderate, 2 high, 0 critical) — pre-existing, unrelated to simple-git

## Step 7: Candidate Patch
- File: candidate.patch
- SHA-256: d4468a6e85cab37049cee8ce6abaed280c75c10eaa36fcd623757dcb5da92c8d
- Base commit: 2cfdf9b81f56eada7df2041625da18e44531151e
- Files touched: package.json, package-lock.json (2 files only)
- git apply --check: exit 0 (applies cleanly)
- Stats: 5 insertions, 293 deletions

## Hosts Contacted
- github.com (Amitakshya333/maos.git clone) — allowlist
- registry.npmjs.org (npm ci, npm uninstall, npm audit) — allowlist

## Lifecycle Scripts Run
- prepare: node scripts/prepare-hooks.js (during npm ci)

## What is NOT Verified
- Whether npm-cache-manifest.json needs manual cleanup (it's not a package manager artifact; simple-git references remain there)
- The 166 test failures attributed above — they need engine binary and canary to pass, which are outside this task's scope
- Application of the patch to C:\maos (PM responsibility)

## Anything Not in the Assignment
- None

---

## Task D: Baseline Comparison (Isolation of 166 Failures)
Date: 2026-11-01T12:17 IST
Baseline Environment: C:\clean\core-b2-02 (clean-room B2 checkout; maos-engine.exe staged; simple-git present; rust/test.txt canary absent)
Candidate Environment: <temp>\core-taskA (simple-git removed; maos-engine.exe not staged; rust/test.txt canary absent)

### Summary of Comparison:
- Total tests executed: 490 across 17 git integration test files (both runs)
- Baseline failures: 46 (444 passed, exit 1)
- Candidate failures: 166 (324 passed, exit 1)
- Exact matching failures: 46 / 46 (100% of baseline failures match candidate failures exactly)
- Only in candidate: 120
- Only in baseline: 0

### Attribution of the 120 Candidate-Only Failures:
- Every one of the 120 candidate-only failures is directly caused by the absence of maos-engine.exe in <temp>\core-taskA\rust\target\release\:
  - EngineError: Engine executable not found: ...\maos-engine.exe
  - OcrError: [RENDER_FAILED] PDF rasterization audit append failed: Engine executable not found
  - Expected error assertions that received the unhandled EngineError instead of the domain error
- Zero candidate-only failures are caused by missing modules, broken imports, or simple-git references.
- All 46 baseline failures are caused by ENOENT: no such file or directory, open 'C:\clean\core-b2-02\rust\test.txt' (the known missing canary invariant).

### Deliverables Added:
- baseline-test-list.txt
- baseline-comparison.json