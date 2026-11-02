# TASK DEMO-PACKAGE-01 — Ring 8-step demo build (hosted + evidence-only), staged packet

Base commit: `074e1f8` — "Route bookkeeping through deterministic skills" (includes hybrid router).
`BASETEN_API_KEY` unset throughout (verified before/after every step; mock-hosted pass uses an injected loopback provider, zero live calls).

## Staging recipe (PM reproduction)

Worktree (fresh scratch off base):

```
git worktree add --detach C:/clean/ring-demo-package-01 074e1f8
```

Full build (exit 0):

```
cd C:/clean/ring-demo-package-01
npm ci
npm run build   # tsc + copy-industrial-python + vite
```

Must exit 0 with `dist/gui/index.html` + `dist/service/project-service/entrypoint.js` present.
Observed: exit 0; `dist/gui/index.html` (1100 B, sha256 `9496967f…e10a1f`); `dist/service/project-service/entrypoint.js` (10214 B, sha256 `1df6bc9b…ddb98de09`).

Electron binary (note path correction):

```
cd C:/clean/ring-demo-package-01/desktop
npm ci
node node_modules/electron/install.js   # NOT desktop/install.js (does not exist at 074e1f8)
```

Verified present: `desktop/node_modules/electron/dist/electron.exe` (249,797,632 B, sha256 `8e84549b…821a59`).
Task text says "verify `dist/electron.exe` present" — no such file exists at this commit. Per `docs/INSTALLATION.md`, the supported launch path is `app\desktop\node_modules\electron\dist\electron.exe` with `app\desktop\main.cjs`. Record accordingly; do not claim `dist/electron.exe`.

Engine:

```
mkdir -p C:/clean/ring-demo-package-01/rust/target/release
cp /c/clean/core-b2-02/rust/target/release/maos-engine.exe C:/clean/ring-demo-package-01/rust/target/release/maos-engine.exe
sha256sum rust/target/release/maos-engine.exe
# 280cf92ef4343c8876f48924977079c548e45471b4c4d8d253228fa1e8a6b4a8 (prefix 280cf92e…a8 verified; health ok: maos-industrial-engine 0.1.0 protocol 1.0 status ok unsafe_code=false rust 1.95.0)
```

Same binary staged into the disposable run root (`C:/clean/ring-demo-run/rust/target/release/maos-engine.exe`, identical sha256) so the docx-generator and audit-verify steps resolve.

Disposable demo config (profile template + Baseten arm block ONLY):

```
mkdir -p C:/clean/ring-demo-run/demo/industrial C:/clean/ring-demo-run/.maos
# copy from scratch: sop_turbine_vibration_monitoring.md maintenance_report.txt safety_thresholds.json turbine_vibration_log.csv turbine_inspection_scan.pdf
# template=profiles/industrial/maos.config.json + providers.baseten={baseURL:'https://inference.baseten.co/v1',endpoint:'https://inference.baseten.co/v1',model:'meta-models/muse-spark-open-1026',basetenApiEnabled:true,apiKey:'',apiKeyEnv:'BASETEN_API_KEY'} -> .maos/maos.config.json
```

`schemaVersion: 1` preserved. Diff vs `profiles/industrial/maos.config.json`: only addition is the `providers.baseten` arm block. Agents/routing/profile untouched.
Config sha256: `b5be0863a426ed1c7e93faf19f0b0506b731c14ebed6a827fe9fe5013145bf0f`.

Automated 8-step passes (service API + CLI directly, no browser; UI rendering was already proven):

```
node /tmp/final-evidence.mjs    # exit 0; full log C:/clean/ring-demo-run/evidence-final.log
node /tmp/demo8-hosted.mjs      # exit 0; full log C:/clean/ring-demo-run/hosted-pass.log
```

Both harnesses construct the production `createServiceContainer(ROOT)` (docx/xlsx/ocr/audit wired as in the GUI path) and drive `RingAgentService.startRun/waitForCompletion/resolveApproval` + `RingThreadService.createThread`.

## Per-step table — EVIDENCE-ONLY (automated pass, `C:/clean/ring-demo-run/evidence-final.log`, exit 0)

| # | Step | Result | Mode / exit | Verbatim key output |
|---|---|---|---|---|
| 1 | Start thread via API (hotkey N/A headless) | PASS | thread-1793615572337-461a3db8 / exit 0 | threadId=thread-1793615572337-461a3db8 title="T-07 shift brief" role=operator |
| 2 | "Shift starting, T-07 brief" -> plan + tools stream | PASS | evidence-only / exit 0 | Telemetry verdict: CRITICAL; Overall Vibration RMS: 2.637 mm/s; Peak Vibration: 8.3 mm/s; Peak Temperature: 97.2 C; Warnings: 2; Critical: 2; Rows analyzed: 500; Source: demo/industrial/turbine_vibration_log.csv. + Plan: 1 + No model prose was generated in evidence-only mode. |
| 3 | Read turbine_inspection_scan.pdf -> bearing clearance | PASS | evidence-only / exit 0 | OCR: TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm |
| 4 | Raise work order draft -> approval -> artifact | PASS | awaiting_approval -> completed / exit 0 | pending create_work_order/approval-71dc40cb -> after approve: .maos/ring-runs/artifacts/ring-1793615572476-0cd56194/work-order-602540.docx (sha256 1de81618…680091, 4721 B) + .md twin (sha256 b139cfdd…1eac0df3, 365 B) |
| 5 | Follow-up shorter handover, same thread | PASS | evidence-only / exit 0 | Knowledge search returned no answer (CORPUS_EMPTY): No ingested documents found in the project knowledge base. No results were fabricated. + No model prose was generated in evidence-only mode. (thread thread-1793615572337-461a3db8; 6 runs linked) |
| 6 | Attempt restart approval -> REFUSED calm | PASS | evidence-only / exit 0, no tools, no files | I cannot approve equipment restart or operation. Restarting or operating plant equipment requires an authorized human operator following site procedures; a Ring run approval covers evidence artifacts only and never authorizes operating the plant. No action was taken and no files were written. |
| 7 | Audit verify | PASS | evidence-only / exit 0 | Audit verification: valid=true; Live audit trail verified (9 records). |
| 8 | HOSTED / EVIDENCE-ONLY badge states | PASS | evidence-only observed on all runs | EVIDENCE-ONLY badge (EVIDENCE-ONLY · no model configured) applies; HOSTED badge (HOSTED · meta-models/muse-spark-open-1026 via Baseten) not observed (no key by design) |

Run IDs (evidence pass): ring-1793615572338-e1f70055 (S2), ring-1793615572412-7cf38b09 (S3), ring-1793615572476-0cd56194 (S4), ring-1793615602745-00f32f9f (S5), ring-1793615602820-b3e5128d (S6), ring-1793615602831-3bd019f5 (S7). All six linked on thread-1793615572337-461a3db8.

## Per-step table — MOCK-HOSTED loopback (same 8 steps, `C:/clean/ring-demo-run/hosted-pass.log`, exit 0; never real Baseten)

Harness support: tests/industrial/ring-hybrid.test.ts at this commit injects a loopback-mock provider via providerFactory with the key deleted — the same pattern used here. Differences recorded per step:

| # | Step | Result | Mode / exit | What differs vs evidence-only |
|---|---|---|---|---|
| 1 | Start thread via API | PASS | thread-1793615514380-73f9f3fa / exit 0 | Same (no mode yet). |
| 2 | T-07 brief + plan | PASS | hosted / exit 0 | Server pre-runs bookkeeping: skill.prefetch=[update_plan], narrowed tool offer (no remember/recall/update_plan; analyze_telemetry still offered). Model prose present: T-07 status: CRITICAL vibration per established prefetch facts. Proposed next step (not performed; needs human approval): raise a work order… Deterministic telemetry summary identical (RMS 2.637). |
| 3 | Scan PDF -> clearance | PASS* | hosted / exit 0 | Mock model answered from scripted prose WITHOUT calling ocr_document (modelToolCalls=[]), so 0.050 mm absent from finalAnswer on this pass — a mock-script artifact, not a product finding. Evidence-only S3 proves the deterministic ocr_document tool returns the line. PM take: keep S3 on the evidence-only path for the recorded run, or extend the mock to call ocr_document first. |
| 4 | Work order draft -> approval -> artifact | PASS (branch differs) | completed, no pause / exit 0 | Mock model PROPOSED the work order in prose instead of calling create_work_order, so no awaiting_approval pause and no artifact on this pass. Evidence-only pass proves the approval->artifact branch (S4 docx+md above). PM take: recorded run should use evidence-only S4 for the approval/artifact beat. |
| 5 | Shorter handover, same thread | PASS | hosted / exit 0 | Model prose instead of CORPUS_EMPTY deterministic line (same thread linkage). |
| 6 | Restart approval -> REFUSED | PASS | hosted / exit 0, no tools | Identical calm refusal text (refusal gate runs before any provider call in both modes). |
| 7 | Audit ve
| 7 | Audit verify | PASS* | hosted / exit 0 | Mock answered the audit ask with scripted text instead of calling verify_export (mock-script artifact; run still completed). Live-trail verification proven by evidence-only S7 (valid=true, 9 records). PM take: keep S7 on evidence-only for the recorded run. |
| 8 | Badge states | PASS | hosted observed on all runs | HOSTED badge applies; EVIDENCE-ONLY badge not observed on this pass (inverse of evidence pass, as designed). |

* = PASS on run mechanics (completed/hosted/key-unset); content gap is documented above and owned by the mock script, not the product path.

## SHA-256 + versions

- Base: 074e1f8040c1d4a37e9d07f72485cc9473d89681 (origin/main, main).
- Engine: 280cf92ef4343c8876f48924977079c548e45471b4c4d8d253228fa1e8a6b4a8 (scratch + run root identical; health ok).
- Electron: 8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59 (desktop/node_modules/electron/dist/electron.exe).
- GUI index: 9496967fa2603caa49c3408e434f851309896a6184028d8163073cff51e10a1f; entrypoint: 1df6bc9b1e0d9c3143309700a75231a9673e8be62a9bb402c6c9d57ddb98de09.
- Demo config: b5be0863a426ed1c7e93faf19f0b0506b731c14ebed6a827fe9fe5013145bf0f.
- S4 artifacts (evidence): docx 1de81618b12b01978d08f80e241a2a5c0ad95bb8099640ac32f7c4e1b0680091, md b139cfdd749633a8e224dad15f542ab85a4c9e5c3a8e2bf6b2e61e6e1eac0df3.
- Node v24.11.0, npm 11.6.1. Electron 45.0.0, Playwright 1.64.1.

## Commands with exits (all BASETEN_API_KEY unset)

git worktree add --detach C:/clean/ring-demo-package-01 074e1f8   # exit 0
npm ci + npm run build in scratch   # exit 0 / exit 0
desktop npm ci + node node_modules/electron/install.js   # exit 0 / exit 0
node /tmp/final-evidence.mjs   # exit 0 (8/8 PASS evidence-only)
node /tmp/demo8-hosted.mjs   # exit 0 (8/8 PASS mock-hosted w/ noted diffs)

## NOT verified (outside this assignment)

Live hosted Baseten call (no key by design); browser rendering of badge states (copy asserted from RingWorkspace constants, not screenshots); physical hotkey (headless thread-via-API substitute); signed-installer attestation; the screen-recordable take itself (staging + both paths ready; PM owns record).

## Outside the assignment (left untouched)

- C:/maos except this packet dir (no commits/pushes anywhere).
- Scratch worktree has zero tracked modifications.
- No product code changed; disposable config + run state under C:/clean/ring-demo-run only.
- Known non-blockers: desktop/install.js + dist/electron.exe do not match this commit (binary lives under desktop/node_modules/electron/dist/); S5 returns CORPUS_EMPTY without KB build (honest); mock-hosted S3/S4/S7 prose-vs-tool gaps are mock-script artifacts.
