# Tools-temp preflight — OCR / vision on THIS machine (read-only)

Date: 2026-11-02. Task: RING-CONTRACT-01 packet preflight.
Method: existing preflight code paths + read-only binary/data checks.
No installs performed. No live Baseten calls (no key configured).

## 1. Demo PDF: demo/industrial/turbine_inspection_scan.pdf

- Size: 534 bytes. Single page (MediaBox 612x792), one FlateDecode content stream.
- Decompressed content stream (100 bytes, exact):
  `BT /F1 12 Tf 50 700 Td (TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm) Tj ET 20 20 572 752 re S`
- Verdict: **the scan HAS a text layer.** The inspection line is embedded as a
  PDF text-showing operation (`Tj`), extractable with zlib only — no OCR
  needed for this file. No `/Font`, no `ToUnicode`, no images: it is a
  minimal synthetic fixture, not a real scan.
- Consequence for the lanes: the OCR path is NOT exercised by this fixture.
  Any lane demoing OCR/vision must bring its own image fixture; do not claim
  this PDF proves OCR works.

## 2. Tesseract OCR

- `where tesseract` → not found in PATH (exit 1).
- Existing preflight (`src/industrial/preflight.ts`, stage 2f) reports
  `Tesseract OCR: tesseract not found in PATH` and fails only when
  `requireOcr === true`; default config does not require it.
- `src/industrial/python/ocr_engine.py` is a bundled NumPy/PIL template-matching
  engine (no tesseract import) — readable as a fallback, but it was NOT
  executed here (running it would be a behavior probe beyond read-only checks,
  and the fixture needs no OCR anyway).

## 3. VisionService (Qwen/Qwen2-VL-2B-Instruct)

- Pinned model: `Qwen/Qwen2-VL-2B-Instruct` rev `aa70c964147048705c93c4e16ff2bc55255470d0`
  (`src/domain/vision.ts` PINNED_VLM_CONFIG). Backend: `src/industrial/python/vlm_engine.py`.
- **Cannot run on this machine as-is:** no `.maos/models` weights directory
  exists in the worktree, `transformers` IS importable in C:\Python314 but the
  pinned weights are absent, and no `inferenceHandler` is configured.
  `VisionService.analyzeImage` without weights raises
  `MODEL_RUNTIME_UNAVAILABLE` by design (synthetic fallback is disabled).
- Honest status: VisionService code path is present and pinned; runtime is
  unavailable here for lack of weights, not for lack of code.

## 4. Python raster support (read-only import probes, C:\Python314)

- `PIL` 12.3.0: present.
- `fitz` (PyMuPDF): absent. `pdf2image`: absent. `transformers`: present.
- `src/industrial/python/pdf_rasterizer.py` is stdlib + PIL only (zlib,
  DCTDecode/FlateDecode extraction) — needs no poppler for the bundled
  fixture class; real-world scans still need a rasterizer outside this box.

## 5. Summary for the lanes

| Probe | Result |
|---|---|
| Scan PDF text layer | PRESENT (zlib-extractable `Tj` line; OCR unnecessary for this fixture) |
| Tesseract | NOT INSTALLED (preflight warns; not required by default) |
| Python OCR fallback (`ocr_engine.py`) | PRESENT in tree, not executed |
| VisionService weights | ABSENT (runtime unavailable; `MODEL_RUNTIME_UNAVAILABLE` by design) |
| Baseten key | NOT SET (no live calls made; all tests evidence-only) |

Nothing was installed, no network calls were made, no keys exist in code.
