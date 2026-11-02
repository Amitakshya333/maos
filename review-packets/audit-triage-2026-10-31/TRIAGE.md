# MAOS Core npm Audit Triage Report

**Date:** 2026-10-31  
**Target Clean-room Checkout:** `C:\clean\core-b2-02`  
**Review Packet Directory:** `C:\maos\review-packets\audit-triage-2026-10-31`  
**Audit Exit Code:** `1` (6 vulnerabilities identified)  
**Lockfile Integrity:** Verified Byte-Identical (Pre/Post SHA-256 Match)  

---

## 1. Executive Summary & Verification

An npm vulnerability audit was conducted against the clean-room checkout `C:\clean\core-b2-02` without modifying dependencies or lockfiles.

### Lockfile Byte-Identity Verification
- **Target File:** `C:\clean\core-b2-02\package-lock.json`
- **Pre-Audit SHA-256:** `5D9577C499C53D1E78457D00901D117F626FCB824BA76EF8E5FA76637D7EAE27`
- **Post-Audit SHA-256:** `5D9577C499C53D1E78457D00901D117F626FCB824BA76EF8E5FA76637D7EAE27`
- **Verification Status:** Unchanged / Byte-identical

### Finding Counts
- **Total Findings:** 6
- **By Severity:**
  - Critical: 2 (`simple-git`, `@simple-git/argv-parser`)
  - High: 2 (`source-map-js`, `vite`)
  - Moderate: 2 (`vitest`, `@vitest/mocker`)
  - Low: 0
  - Info: 0
- **By Scope (package.json):**
  - **Runtime (`dependencies`):** 2 (1 direct, 1 transitive)
  - **Dev-only (`devDependencies`):** 4 (1 direct, 3 transitive)

---

## 2. Findings Matrix

| Package | Installed Version | Severity | Scope | Type | Advisory ID(s) | Fix Available | Owner Disposition |
|---|---|---|---|---|---|---|---|
| `simple-git` | 3.36.0 | **Critical** | Runtime (`dependencies`) | Direct | GHSA-x6jw-m9v5-85vh<br>GHSA-g4wm-2vf7-vfgr<br>GHSA-858h-whjf-mvg5 | `simple-git@4.0.2` (SemVer Major) | Needs owner decision |
| `@simple-git/argv-parser` | 1.1.1 | **Critical** | Runtime (via `simple-git`) | Transitive | GHSA-v5rq-49vh-5v5c | Via `simple-git@4.0.2` | Needs owner decision |
| `vite` | 7.3.6 | **High** | Dev-only (`devDependencies`) | Transitive | GHSA-587h-7wmj-h5pm<br>GHSA-698v-4r3x-3vcv<br>GHSA-r825-w8mm-5pxw<br>GHSA-rq7h-c2jc-7f22<br>GHSA-9jrq-w75r-8gcw | `>=7.3.7` (SemVer Minor/Patch) | Needs owner decision |
| `source-map-js` | 1.2.1 | **High** | Dev-only (`devDependencies`) | Transitive | GHSA-68fv-2mgg-jv7q | `>=1.2.2` (SemVer Minor/Patch) | Needs owner decision |
| `vitest` | 4.1.11 | **Moderate** | Dev-only (`devDependencies`) | Direct | Via `@vitest/mocker` | `>=4.1.12` (SemVer Minor/Patch) | Needs owner decision |
| `@vitest/mocker` | 4.1.11 | **Moderate** | Dev-only (`devDependencies`) | Transitive | GHSA-qxg6-89mg-rqv8<br>GHSA-xp26-3454-mjgp | `>=4.1.12` (SemVer Minor/Patch) | Needs owner decision |

---

## 3. Detailed Finding Profiles

### Finding 1: `simple-git`
- **Package Name & Version:** `simple-git@3.36.0`
- **Severity:** Critical
- **Dependency Scope:** Runtime (`dependencies` in `package.json:87`)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  └── simple-git@3.36.0 (direct)
  ```
- **Advisories:**
  - `GHSA-x6jw-m9v5-85vh` (Critical, CVSS: N/A, CWE-78/CWE-184): Unsafe-operation guard does not block trailer command configuration (`>=3.15.0 <4.0.1`).
  - `GHSA-g4wm-2vf7-vfgr` (High, CVSS: 8.1, CWE-77/CWE-78): Allows command execution through unblocked Git configuration includes (`<=3.36.0`).
  - `GHSA-858h-whjf-mvg5` (High, CVSS: 8.1, CWE-77/CWE-88): Unsafe-operations plugin bypass via git long-option abbreviation (`--receive-p`/`--exe`) (`<=3.36.0`).
  - Also impacted by transitive dependency `@simple-git/argv-parser`.
- **Fix Available:** Yes. Update to `simple-git@4.0.2` (Requires semver major upgrade).
- **MAOS Code Path Impact:** **Unused in MAOS codebase.**
  - Codebase analysis confirmed that `simple-git` is never imported (`import ... from 'simple-git'`) or required (`require('simple-git')`) in any source files under `src/`, `desktop/`, `scripts/`, or `tests/`.
  - MAOS executes git commands directly via Node's native `child_process.execFileSync('git', ...)` inside `src/integrations/git.ts`, `src/integrations/tools.ts`, and `src/integrations/worktree.ts`.
  - However, because `simple-git` is declared in `dependencies` (rather than `devDependencies` or removed entirely), it is packaged into the production tarball.
- **Disposition:** Needs owner decision (Recommended action: Evaluate whether `simple-git` can be completely purged from `package.json` dependencies since native `execFileSync` is used, or bump to `^4.0.2` if planned for future usage).

---

### Finding 2: `@simple-git/argv-parser`
- **Package Name & Version:** `@simple-git/argv-parser@1.1.1`
- **Severity:** Critical
- **Dependency Scope:** Runtime (Transitive dependency of production dependency `simple-git`)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  └── simple-git@3.36.0
      └── @simple-git/argv-parser@1.1.1 (transitive)
  ```
- **Advisories:**
  - `GHSA-v5rq-49vh-5v5c` (Critical, CWE-78/CWE-184, Range `<2.0.1`): `VISUAL` editor environment variable is omitted from unsafe editor detection in argv parser.
- **Fix Available:** Yes. Bundled with `simple-git@4.0.2` (requires upgrading `simple-git` to 4.0.2).
- **MAOS Code Path Impact:** **Unused in MAOS codebase.**
  - This package is only invoked internally by `simple-git`. Because `simple-git` is not called anywhere in MAOS, this code path is not exercised during execution.
- **Disposition:** Needs owner decision (Tied directly to owner decision on `simple-git`).

---

### Finding 3: `vite`
- **Package Name & Version:** `vite@7.3.6`
- **Severity:** High
- **Dependency Scope:** Dev-only (`devDependencies` via `@vitejs/plugin-react` and `vitest`)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  ├── @vitejs/plugin-react@4.7.0 (devDependencies)
  │   └── vite@7.3.6 (transitive)
  └── vitest@4.1.11 (devDependencies)
      └── vite@7.3.6 (transitive, deduped)
  ```
- **Advisories:**
  - `GHSA-587h-7wmj-h5pm` (High, CWE-77): `launch-editor`: `fs.existsSync()` existence check can be bypassed on Windows (`>=7.0.0 <=7.3.6`).
  - `GHSA-698v-4r3x-3vcv` (Moderate, CWE-78): `launch-editor`: `escapeCmdArgs()` omits `%` escaping on Windows (`>=7.0.0 <=7.3.6`).
  - `GHSA-r825-w8mm-5pxw` (Moderate, CWE-88): `launch-editor`: Editor CLI flag misinterpretation causing arbitrary command execution (`>=7.0.0 <=7.3.6`).
  - `GHSA-rq7h-c2jc-7f22` (Moderate, CWE-22/CWE-284): Files outside `server.fs.allow` served on system path matches (`>=7.0.0 <=7.3.6`).
  - `GHSA-9jrq-w75r-8gcw` (Low, CWE-80): Cross origin script execution through custom middleware (`>=7.0.0 <=7.3.6`).
- **Fix Available:** Yes. Update to `vite@>=7.3.7` (SemVer patch/minor compatible).
- **MAOS Code Path Impact:** **Dev / Build toolchain only.**
  - In MAOS, `vite` is used exclusively during the frontend build step (`npm run build:gui` / `vite build`) to bundle `src/gui` into static assets in `dist/gui`.
  - The reported vulnerabilities specifically exploit interactive Vite dev-server features (`launch-editor` invoked during dev-mode error overlays, and dev-server static middleware). MAOS does not expose or run the Vite development server in production runtime environments.
- **Disposition:** Needs owner decision (Recommended action: Bump devDependencies to pull in `vite >= 7.3.7` during the next scheduled dependency update).

---

### Finding 4: `source-map-js`
- **Package Name & Version:** `source-map-js@1.2.1`
- **Severity:** High
- **Dependency Scope:** Dev-only (Transitive child of `vite` build pipeline)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  └── @vitejs/plugin-react@4.7.0 (devDependencies)
      └── vite@7.3.6
          └── postcss@8.5.26
              └── source-map-js@1.2.1 (transitive)
  ```
- **Advisories:**
  - `GHSA-68fv-2mgg-jv7q` (High, CVSS: 7.5, CWE-1284, Range `>=1.0.0 <1.2.2`): Allows event-loop denial of service through indexed source-map section offsets.
- **Fix Available:** Yes. Upstream patch available in `source-map-js@>=1.2.2`.
- **MAOS Code Path Impact:** **Build toolchain only / Not active.**
  - `source-map-js` is consumed by `postcss` during CSS processing in Vite.
  - In `vite.config.ts`, sourcemaps are explicitly disabled (`build.sourcemap: false`), and MAOS does not process untrusted external sourcemaps during build or runtime.
- **Disposition:** Needs owner decision (Resolved via devDependencies refresh or lockfile update).

---

### Finding 5: `vitest`
- **Package Name & Version:** `vitest@4.1.11`
- **Severity:** Moderate
- **Dependency Scope:** Dev-only (`devDependencies` in `package.json:101`)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  └── vitest@4.1.11 (direct)
  ```
- **Advisories:**
  - Affected transitively via `@vitest/mocker`.
- **Fix Available:** Yes. Update to `vitest@>=4.1.12` (SemVer patch compatible).
- **MAOS Code Path Impact:** **Test environment only.**
  - `vitest` is invoked solely when running unit/integration tests (`npm test` -> `vitest run`). It is never invoked or distributed in production runtime (`start` / `dashboard` runs `dist/cli/index.js`).
- **Disposition:** Needs owner decision (Recommended action: Routine update to `^4.1.12`).

---

### Finding 6: `@vitest/mocker`
- **Package Name & Version:** `@vitest/mocker@4.1.11`
- **Severity:** Moderate
- **Dependency Scope:** Dev-only (Transitive dependency of `vitest`)
- **Dependency Chain:**
  ```text
  maosorch@0.3.0
  └── vitest@4.1.11
      └── @vitest/mocker@4.1.11 (transitive)
  ```
- **Advisories:**
  - `GHSA-qxg6-89mg-rqv8` (Moderate, CVSS: 4.7, CWE-94/CWE-116/CWE-306, Range `>=2.1.0-beta.7 <4.1.12`): Code injection via unauthenticated manual mock registration.
  - `GHSA-xp26-3454-mjgp` (Moderate, CVSS: 5.9, CWE-22, Range `>=4.1.11 <4.1.12`): Windows backslash traversal bypasses the `@vitest/mocker` redirect allowlist fix.
- **Fix Available:** Yes. Upgraded alongside `vitest@>=4.1.12`.
- **MAOS Code Path Impact:** **Test environment only.**
  - Internal mocking module for Vitest test runner. No manual unauthenticated mock registrations exist in test suite, and the package does not exist in production runtime.
- **Disposition:** Needs owner decision.

---

## 4. Architectural Observations & Recommendations

1. **Unused Production Dependency (`simple-git`):**
   - Both Critical findings (`simple-git` and `@simple-git/argv-parser`) originate from `simple-git@3.36.0` being declared in `dependencies`.
   - MAOS has built its own git execution integration layer via `execFileSync` in `src/integrations/git.ts`, `tools.ts`, and `worktree.ts`.
   - **Recommendation:** Verify if `simple-git` can be completely uninstalled from `package.json`. Removing it eliminates both Critical vulnerabilities without requiring a SemVer-major upgrade to v4.
2. **Build and Test Toolchain Isolation:**
   - The remaining 4 vulnerabilities (2 High, 2 Moderate) reside strictly within the development and build toolchain (`vite`, `source-map-js`, `vitest`, `@vitest/mocker`).
   - None of these packages run in production server/dashboard runtime.
   - **Recommendation:** Upgrade `vitest` to `^4.1.12` and refresh dev toolchain lockfile entries when ready.

---

## Addendum (orchestrator, 2026-10-31)

Verified against npm-audit.json and the checkout. Delta's findings and fix versions are consistent with the audit data (affected ranges: vite 7.0.0-7.3.6, source-map-js 1.0.0-1.2.1, vitest through 4.1.11, argv-parser <2.0.1). Corrections and additions:

- vitest is declared at package.json line 100, not 101.
- simple-git advisories (critical, direct): GHSA-x6jw-m9v5-85vh, GHSA-g4wm-2vf7-vfgr, GHSA-858h-whjf-mvg5. The argv-parser advisory is GHSA-v5rq-49vh-5v5c.
- Desktop graph (desktop/package-lock.json): npm audit exit 0, 0 findings (npm-audit-desktop.json). Desktop lockfile SHA-256 unchanged before and after (722FBFD4...DD922A43).
- Code references verified: src/integrations/git.ts, tools.ts, and worktree.ts exist and use execFileSync. vite.config.ts:27 sets sourcemap: false. The build:gui script is "vite build" (package.json:62).

Files in this directory after the run: npm-audit.json (root, exit 1), npm-audit-desktop.json (exit 0), npm-audit.exitcode.txt, lockfile-before/after.sha256, desktop-lockfile-before/after.sha256, *.stderr.log (empty), TRIAGE.md (this file).
