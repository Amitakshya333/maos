# T-07 CLI demo script (non-developer runbook)

Follow top to bottom in Windows PowerShell. Every command below is quoted
from the B2 clean-room retry packet
(`C:\maos\review-packets\b2-cleanroom-retry-2026-10-31\`) or the committed
`demo/industrial/RUNBOOK.md` — nothing is invented. Stop at the first
unexpected result and report it; do not improvise, do not run anything
with an API key, do not use real plant data. Synthetic fixtures only.

B2 ran these steps in `C:/clean/core-b2-02` / `C:/clean/demo-b2-02`. Those
directories are retained evidence — use FRESH disposable directories. The
commands below use `C:/maos-demo/...`; if you pick other paths, substitute
them consistently everywhere (the staging scripts refuse existing
directories, so never reuse a previous run's folders).

## Prerequisites (one line each)

- Node.js: B2 ran Node v24.11.0 + npm 11.6.1 (minimum per plan: Node 20+, npm 9+); check with `node --version` and `npm --version`.
- Engine binary: B2-built `rust/target/release/maos-engine.exe`, SHA-256 `280cf92ef4343c8876f48924977079c548e45471b4c4d8d253228fa1e8a6b4a8` (462,848 bytes, Rust 1.95.0, offline) — your fresh build gets its own hash; the health identity check in step 8 (not hash equality) is the real gate.
- Core repo: `git clone https://github.com/Amitakshya333/maos.git C:/maos-demo/core` (public; then fetch `refs/tags/event-core-2cfdf9b` and check out `f9525055…` per steps 2–3).
- Event repo: `git clone https://github.com/Amitakshya333/maos-ind_.git C:/maos-demo/event` — BLOCKED content: the clone succeeds but the repo is EMPTY pending owner publication (D5); until then obtain patches + apply script from the owner-provided staging bundle (B2 used `C:/maos/event-staging-2026-10-31`; verified apply-script SHA-256 `2B8674AA323C98ABDD9E5A54FDCBFF61332E715286CA690CC9BD530DA5C256A7`).

## Steps

### 1. Clone Core (default settings)

```powershell
git clone https://github.com/Amitakshya333/maos.git C:/maos-demo/core
```

Expected: clone completes, exit 0 (B2 used `--no-checkout`; default settings check out `main`, which step 3 replaces).
If different: network or URL problem — stop and report.

### 2. Fetch the dependency tag (from `C:/maos-demo/core`)

```powershell
git -C C:/maos-demo/core fetch origin refs/tags/event-core-2cfdf9b
```

Expected: exit 0, quiet. If different: tag missing or network problem — stop.

### 3. Check out the pinned base (from `C:/maos-demo/core`)

```powershell
git -C C:/maos-demo/core -c advice.detachedHead=false checkout --detach f9525055c56a7f7771dd2fa029c147c2960a98a3
git -C C:/maos-demo/core rev-parse HEAD
git -C C:/maos-demo/core status --porcelain
```

Expected: `rev-parse` prints exactly `f9525055c56a7f7771dd2fa029c147c2960a98a3`; status prints nothing (clean).
If different: wrong commit or dirty tree — stop; start over in a fresh directory.

### 4. Apply overlays 0001–0003 (from the staging bundle directory)

```powershell
powershell.exe -NoProfile -NonInteractive -File C:/maos/event-staging-2026-10-31/scripts/apply-event-patches.ps1 -CorePath C:/maos-demo/core
```

Expected: exit 0 and `Applied overlays 0001-0003 … tree verifies exactly against event tip 2cfdf9b… No commit was created.`
If different: read the refusal (wrong base / dirty / partial / hash mismatch) — it names the cause; restore a clean base checkout and retry. Never force it.

### 5. Install dependencies (from `C:/maos-demo/core`)

```powershell
npm ci
```

Expected: exit 0, `added 252 packages`, plus `6 vulnerabilities (2 moderate, 2 high, 2 critical)` (known issue below — do NOT run `npm audit fix`; B2 did not).
If different (non-zero exit): install failure — stop and report.

### 6. Build the backend (from `C:/maos-demo/core`)

```powershell
npm run build:backend
```

Expected: exit 0 (`tsc -p tsconfig.json && node scripts/copy-industrial-python.js`).
If different: build break — stop. (B2 additionally ran `npm run typecheck:gui`, exit 0; optional here.)

### 7. Build the engine (from `C:/maos-demo/core/rust`)

Pre-check (B2-executed): `rustup run 1.95.0 rustc -vV` → `rustc 1.95.0 …`; `rustup run 1.95.0 cargo --version` → `cargo 1.95.0 …`.

```powershell
rustup run 1.95.0 cargo build --release --locked --offline --manifest-path Cargo.toml
```

Expected: exit 0 (compiler warnings on stderr are fine); binary at `rust/target/release/maos-engine.exe`.
Alternative instead of building: copy a previously built `maos-engine.exe` — then the health check below MUST still pass exactly, and you record its SHA-256 for provenance (B2 reference `280cf92e…`; yours will differ).
If different (non-zero exit, or any fresh crate download instead of vendored/offline): stop.

### 8. Check engine health (from `C:/maos-demo/core`)

RUNBOOK form (B2 ran the equivalent check via a node harness — same contract):

```powershell
$health = '{"version":"1.0","operation":"health"}' | & .\rust\target\release\maos-engine.exe | ConvertFrom-Json
$health.data | Select-Object engine,version,protocol_version,status
```

Expected: `maos-industrial-engine / 0.1.0 / protocol 1.0 / ok` (B2 recorded exactly this plus `rust_version 1.95.0`, `unsafe_code false`).
If different: wrong or stale binary — rebuild or re-copy, never substitute an unknown binary.

### 9. Stage the demo project (from `C:/maos-demo/core`)

Copy-paste exactly (B2 step 16; paths already pointed at fresh `C:/maos-demo/project`):

```powershell
node -e "const fs=require('fs'),crypto=require('crypto');const root='C:/maos-demo/core',demo='C:/maos-demo/project',out='.';if(fs.existsSync(demo))throw Error('Refusing existing demo project');fs.mkdirSync(demo+'/demo/industrial',{recursive:true});fs.mkdirSync(demo+'/.maos');const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const records=[];for(const n of ['safety_thresholds.json','turbine_vibration_log.csv','maintenance_report.txt','turbine_inspection_scan.pdf']){const src=root+'/demo/industrial/'+n,dst=demo+'/demo/industrial/'+n;fs.copyFileSync(src,dst);const h=sha(src);if(sha(dst)!==h)throw Error('Fixture copy mismatch');records.push({name:n,sha256:h});}fs.copyFileSync(root+'/profiles/industrial/maos.config.json',demo+'/.maos/maos.config.json');fs.mkdirSync(demo+'/rust/target/release',{recursive:true});const src=root+'/rust/target/release/maos-engine.exe',dst=demo+'/rust/target/release/maos-engine.exe';fs.copyFileSync(src,dst);const h=sha(src);if(sha(dst)!==h)throw Error('Engine copy mismatch');console.log(JSON.stringify({demoRoot:demo,fixtures:records,engineSha256:h},null,2));"
```

Expected: exit 0 and a JSON listing the 4 fixture SHAs (`e860af9e…`, `d2c31003…`, `7ed8e5b9…`, `fcb75e92…`) plus your engine SHA. (`Refusing existing demo project` means: pick a fresh directory.)
If different (any `mismatch` error): copy corruption — delete the project dir and retry.

### 10. Run the judged demo (from `C:/maos-demo/project`)

```powershell
node.exe C:/maos-demo/core/dist/industrial/entrypoint.js run --project-root C:/maos-demo/project --auto-approve --yes --json
```

(RUNBOOK equivalent when the package bin is installed: `maos-industrial run --auto-approve --yes --json`.)
Expected: exit 0; `"success": true`; a `runId` (yours differs from B2's); `overallRms` ≈ `2.63710997` (shown as 2.637); `overallVerdict` **`FAIL` — this is the EXPECTED engineering result** (the synthetic data is engineered over-threshold); `anomalyCount` 4; DOCX + audit-export paths printed.
If different: exit ≠ 0, missing run ID, RMS far from 2.637, or verdict `PASS` = defect — stop and report. (`FAIL` + exit 0 = success.)

### 11. Verify the audit (from `C:/maos-demo/project`)

```powershell
node.exe C:/maos-demo/core/dist/industrial/entrypoint.js verify audit --project-root C:/maos-demo/project --run-id <your-run-id-from-step-10> --json
```

Expected: exit 0; `"valid": true`, `recordCount` 9, `"errors": []`, verdict `FAIL`.
If different (`valid: false`, errors listed): audit break — stop and report.

### 12. Gate probes (separate demo projects)

Stage two probe projects (B2 step 19, fresh paths):

```powershell
node -e "const fs=require('fs'),crypto=require('crypto');const root='C:/maos-demo/core',engine=root+'/rust/target/release/maos-engine.exe';const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');for(const demo of ['C:/maos-demo/gate4','C:/maos-demo/gate10']){if(fs.existsSync(demo))throw Error('Refusing existing gate project');fs.mkdirSync(demo+'/demo/industrial',{recursive:true});fs.mkdirSync(demo+'/.maos');fs.mkdirSync(demo+'/rust/target/release',{recursive:true});for(const n of ['safety_thresholds.json','turbine_vibration_log.csv','maintenance_report.txt','turbine_inspection_scan.pdf'])fs.copyFileSync(root+'/demo/industrial/'+n,demo+'/demo/industrial/'+n);fs.copyFileSync(root+'/profiles/industrial/maos.config.json',demo+'/.maos/maos.config.json');const dst=demo+'/rust/target/release/maos-engine.exe';fs.copyFileSync(engine,dst);if(sha(dst)!==sha(engine))throw Error('Engine copy mismatch');console.log('Staged synthetic gate project: '+demo);}"
```

Probe 1 — confirmation required (expect exit **4**):

```powershell
node.exe C:/maos-demo/core/dist/industrial/entrypoint.js run --project-root C:/maos-demo/gate4 --auto-approve --json
```

Expected: exit 4, `CONFIRMATION_REQUIRED`, `approvalStatus pending`. Exit 4 here is CORRECT gate behavior.

Probe 2 — human approval required (expect exit **10**):

```powershell
node.exe C:/maos-demo/core/dist/industrial/entrypoint.js run --project-root C:/maos-demo/gate10 --json
```

Expected: exit 10, `WAITING_FOR_APPROVAL`, `approvalStatus pending`. Exit 10 here is CORRECT.
If different (exit 0, or any other code/message): gate defect — stop and report.

## Known issues (do not "fix" during the demo)

1. 46 test failures from the absent `rust/test.txt` canary — verified in the Antigravity Task D baseline (review-packets/simple-git-removal-candidate-2026-11-01/baseline-comparison.json: 490 tests, 46 canary failures, 120 candidate-only engine-trace failures, 0 broken imports). This is a test-setup gap, expected per the owner canary disposition.
2. GUI engine status shows muted-grey "NOT REPORTED" — verified by the Antigravity Electron rehearsal (DOM read: `status-dot muted`, computed background rgb(85, 85, 85); review-packets/electron-rehearsal-2026-11-01). Verify engine health via the CLI health check in step 8; the API does not report engine health.
3. npm audit findings (B2-evidenced): `6 vulnerabilities (2 moderate, 2 high, 2 critical)` from the install log; B2 ran no audit fix. NOTE: the task brief said "high/moderate" — the packet additionally records 2 critical; reported exactly as evidenced.
4. JS notice gap (staging-evidenced): 70 root + 15 desktop entries unresolved (`THIRD_PARTY_NOTICES/COMPATIBILITY-SCREEN.md`, `JS-CLOSURE-RUN-2026-10-31.md`). Disclosed; not a clearance.

Also by design: the `rust/test.txt` canary is absent from the pinned tree (ignored, out-of-band fixture per ENGINE-RESOLUTION-01; B2 step 09 exited 1 with `STOP: required plan canary … absent`). Do not fabricate or copy it; absence is recorded, never a product failure.

## Sources

B2 packet steps 01–04, 06–08, 12–22 with per-step command/exit/stdout records; `runtime-acceptance.json` (PASS, RMS `2.637109971161612`, verdict FAIL, 9 records); `engine-build-identity.json`; `demo-staging.json`; `CANARY-DISPOSITION.md`; RUNBOOK §§4–6 (Option A commands, gate codes 4/10, verify-audit, health contract). RUNLOG.md describes the pre-disposition canary stop ("B2 remains UNVERIFIED") while `runtime-acceptance.json` records the post-disposition runtime PASS — both cited as filed; reconciling them is an owner call.
