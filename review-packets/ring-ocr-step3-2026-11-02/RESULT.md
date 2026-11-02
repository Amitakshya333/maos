# OCR-STEP3-01 RESULT — demo step 3 (inspection report reading), evidence-only

Status: **PASS** (text-layer extraction proven on disk + `ocr_document` tool proven through the Ring agent path, evidence-only; no live calls). Scope: T-07 scan PDF only. P-12 scan PNG/photo remain honestly-unavailable per Day-2 (no pixels fabricated); they are out of scope for this packet.

## 1. Environment / guardrails

- Base: `main` HEAD `64471c6` ("Add Ring Day-2 streaming skills and surface").
- Scratch: `C:/clean/ring-ocr-step3` (detached worktree at `64471c6`, `npm ci` exit 0, own `node_modules`). Packet dir `C:/maos/review-packets/ring-ocr-step3-2026-11-02/` is the ONLY path touched under `C:/maos`. No commits to main, no pushes (scratch worktree has no branch; packet written directly, not committed).
- Evidence-only: `BASETEN_API_KEY` confirmed **unset** before every run (`[unset]`). No network use: text-layer path needs no engine/Python/poppler; scratch-local probe tests deleted after the run, worktree left clean (`git status --short` empty).

## 2. Step 1 — scan PDF text layer extracts (exit 0)

Target: `demo/industrial/turbine_inspection_scan.pdf` (identical in scratch and `C:/maos`; `cmp` identical).

- `node` byte probe (stdlib + `zlib.inflateSync`, same decode as the repo's `createOcrDocumentTool`): exit 0.
- bytes: **534**; magic: `%PDF-1.4`; `/FlateDecode`: yes; `/Encrypt`: no.
- Stream 1 inflates to 100 bytes: `BT /F1 12 Tf 50 700 Td (TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm) Tj ET 20 20 572 752 re S`.
- SHA-256: `fcb75e928d0ada2ce7cbf187d3ec880c821d89b99563a06d86bb36f70211b9bd` (matches `ground_truth.json` -> `documents.scannedInspection.sha256`).
- Extracted text (first 500 chars = full text, 50 chars):
  `TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm`
- Mentions **bearing**: yes. Mentions **clearance**: yes. Mentions **wear**: **no** (the scan says clearance, not wear — nothing invented).
- No OCR engine was needed or used (repo path: `src/service/ring-tools/ocr-document.ts` tries embedded text-layer first; engine is fallback only).

## 3. Step 2 — `ocr_document` through the Ring agent path, evidence-only (exit 0)

Scratch-local probe (`tests/industrial/zz-ocr-step3-probe.test.ts`, since deleted; 2 tests, exit 0), mirroring the `ring-agent.test.ts` (d) evidence-only pattern (`BASETEN_API_KEY` deleted, no mock server, real `RingAgentService` + `AuditService`, temp root seeded from the scratch's `demo/industrial/`):

- Instruction `Read the turbine inspection scan PDF and report the bearing finding` -> `snap.status` completed, `snap.mode` === `evidence-only`, `mode.evidence-only` in transcript.
- Tool called: exactly one `tool.call` for `ocr_document`, args valid: `{ path: 'turbine_inspection_scan.pdf' }`.
- Result valid: one `tool.result` for `ocr_document`, `ok: true`.
- Tool result **verbatim** (`tool.result` entry):
  `{"type":"tool.result","toolCallId":"evidence-3","toolName":"ocr_document","argsSummary":{"path":"turbine_inspection_scan.pdf"},"ok":true,"summary":"TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm"}`
- Final answer contains `TURBINE INSPECTION LOG`; run JSONL on disk contains `ocr_document` + `TURBINE INSPECTION LOG`.
- No invented readings: combined tool-result + final-answer text contains no `bearing wear` and no `ocr engine` claim.
- Step-3 correlation probe (`Analyze turbine vibration telemetry and read the turbine inspection scan; correlate the bearing finding with the critical vibration`): transcript contains BOTH `analyze_telemetry` (`ok: true`, `Verdict: CRITICAL`, overall RMS 2.637 mm/s, peak 8.3 mm/s = ground-truth row 367: `2026-08-22T10:31:30+05:30`, value 8.3, FAIL) AND `ocr_document` (`BEARING CLEARANCE 0.050 mm`); final answer contains both `CRITICAL` and `BEARING CLEARANCE`. **Verbatim final answer:**
  `Deterministic evidence-only answer (no hosted model was called). / Instruction: Analyze turbine vibration telemetry and read the turbine inspection scan; correlate the bearing finding with the critical vibration / Telemetry verdict: CRITICAL; Overall Vibration RMS: 2.637 mm/s; Peak Vibration: 8.3 mm/s; Peak Temperature: 97.2 C; Warnings: 2; Critical: 2; Rows analyzed: 500; Source: demo/industrial/turbine_vibration_log.csv. / OCR: TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm / No model prose was generated in evidence-only mode.`
  (Note: that run also logged one `read_company_document` `ok:false` entry — the probe temp root intentionally seeded only scan+telemetry+thresholds, so the unrelated default SOP lookup honestly reported `Company document not found under the evidence root`. OCR and telemetry results above are unaffected.)

## 4. Step 3 — existing suites in the scratch (all with `BASETEN_API_KEY` unset)

| Suite | Result | Exit |
|---|---|---|
| `tests/industrial/ring-dev-c-safety.test.ts` | 8/8 passed | 0 |
| `tests/industrial/ring-agent.test.ts` + `tests/industrial/ring-contract.test.ts` | 12/12 passed (7 agent + 5 contract) | 0 |
| `tests/industrial/ring-dev-a.test.ts` + `tests/industrial/ring-dev-c-day2.test.ts` | 20/21 passed; 1 pre-existing env failure (`ring-dev-audit-proxy.test.ts` -> `exposes the fixture helpers`: `engineFixturePath()` returns `undefined` — scratch has no `rust/target/release` engine binary and `/c/maos/...` does not resolve under this runtime; fails identically on unmodified `main` HEAD, unrelated to OCR step 3). Notable: `ocr reads the demo scan text layer` and `P-12 scan PNG + photo: OCR/vision report honestly unavailable` both pass. | 1 (solely the fixture-helper env failure) |

## 5. Honest narration line

> The video says **"reads the inspection report"** — NOT "OCR of a scan." What works is deterministic text-layer extraction of the embedded PDF text; no OCR engine ran and the word "wear" never appears in the scan (it says bearing *clearance* 0.050 mm). P-12 scan PNG/photo stay honestly-unavailable per Day-2.

## 6. Notes / NOT verified

- NOT verified: any hosted/Baseten path (key unset by design); any real OCR-engine fallback (`OcrService.ocrDocumentSync` raster path untested here — not needed since the text layer extracts); row-367 correlation beyond the deterministic verdict + scan text co-occurring in one evidence-only final answer (no model prose involved).
- Nothing outside the assignment was changed. Scratch worktree left clean; no commits, no pushes.
