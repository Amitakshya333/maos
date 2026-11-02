# CHECKPOINT 2 EVIDENCE REVIEW — TASK CHECKPOINT2-REVIEW-01 (read-only)

- Date: 2026-11-02 (review for the Nov 3 21:00 Checkpoint 2 report)
- Reviewer: independent checkpoint reviewer, read-only. No code changes, no commits, no pushes, no live calls.
- Base reviewed: `C:/maos` main = `3530e02` ("Fix overlay window and approval artifacts").
  Chain on main: `a573e2a` (contract + agent loop + workspace + adapter) → `b666518`
  (Dev A/B/C lanes) → `ba451de` (frozen contract + preflight) → `64471c6` (Day-2 streaming
  skills + surface) → `074e1f8` (hybrid bookkeeping router) → `3530e02` (overlay + approval fixes).
- Live-hosted results below marked "PM-reported" are taken on the PM's word per the assignment
  (two live 3/4 runs, memory-and-plan miss stable). No live transcript was in scope to re-verify.
- User-tested items (7/7 checklist, hotkey/translucency/drag/artifacts recheck, P-12 probe,
  refusal screenshot, tamper log) are user-reported: no packet artifact for them was in the
  review set, so they are recorded as REPORTED, not packet-evidenced, with code/test
  corroboration where it exists.

## 0. The BLOCK+adapter verdict — did the adapter land? YES.

`review-packets/ring-integration-review-2026-11-02/REVIEW.md` returned BLOCK (9 mismatches:
3 fatal C1/C2/C9, 4 semantic C7/C8/C10/C16, 1 silent-ignore C12, 1 adapter-needed C11) and
required integration only via adapter A1–A7. On current main (`3530e02`) every adapter item is
present in committed code:

- A1: `snapshot()` emits wire `events` via `toWireEvent()`; `mode.evidence-only` folded into
  `run.started` (`src/service/ring-agent-service.ts:455`, `git log -S toWireEvent` first lands in `a573e2a`).
- A2/A3: `formatArgsSummary()` renders wire `argsSummary` as string (`:406`); `toolName→tool`,
  `contentSummary→text`, `summary→resultSummary`+`verdict`/`overallRms`/`sources`,
  `error→message`, `summary→action` projections carried via `toolResultProjections` (`:181,:472`).
- A4: approval `action` populated (acceptance: "Vibration Alert…" asserted on the real wire event).
- A5: `toolCallId?: string` in the wire type + validator passthrough
  (`src/gui/src/api/ring-run-types.ts:70,167`); chips pair by id only.
- A6: `agentId` accepted-and-ignored with explicit comment (`src/api/router.ts:1328`); roster marks
  only the Ring lead as working.
- A7: no hardcoded `mode:'hosted'` pre-poll — badge takes `RingRunState | null`, thread history
  starts `state: null` (`RingWorkspace.tsx:79,678`).
- Regression lock: `tests/industrial/ring-wire-contract.test.ts` exists on main (real service →
  real validator, both modes).

So the integration went in WITH the adapter, as the review demanded. No open BLOCK remains from it.

## 1. The 8 demo steps (Brief §7) — evidence status on CURRENT main

| # | Brief step | Status | Packet + what proves it (or what is missing) |
|---|---|---|---|
| 1 | In another app, press hotkey; ring animates in | PARTIAL | IMPLEMENTED + unit-tested, NOT camera-proven. `desktop/ring-overlay-host.cjs`: second `BrowserWindow` on `#/ring-overlay`, global hotkey (default `CommandOrControl+Shift+Space`, NOT Brief's `Ctrl+Space` — Handoff 3.5), tray, `transparent:true` + `backgroundColor:'#00000000'`, header drag region, overlay dropzone + screenshot row, approval/artifact cards. `ring-overlay-fix` packet: all verified by code + GUI tests only — "see-through NOT verified by eye… packaged build was not launched". Demo-package ran headless ("hotkey N/A headless", thread via API). Hotkey/drag user recheck: REPORTED, no artifact. |
| 2 | "Shift starting, T-07 brief" → plan appears, tools stream, cites rows 121/238/367/442 | EVIDENCED (evidence-only + mock-hosted; live with caveat) | Demo-package S2 evidence-only: verdict CRITICAL, overall RMS 2.637 mm/s, peak 8.3 mm/s, peak temp 97.2 C, warnings 2, critical 2, 500 rows + `Plan:` line + "No model prose…". Mock-hosted S2: server prefetch `skill.prefetch=[update_plan]`, narrowed tool offer, model prose citing established facts (telemetry identical). Row set 121/238/367/442 = `demo/industrial/expected_findings.json` documented anomalies; deterministic findings carry ≤20 breach records to the model. LIVE caveat: PM-reported 3/4 twice; the stable miss is memory-and-plan — the plan-update sub-beat shares that mechanism. Hybrid router (`074e1f8`, `ring-hybrid-01` packet, 3/3 tests) exists precisely to fix it but has no live confirmation yet. |
| 3 | Drag in `turbine_inspection_scan.pdf`; scan read; correlate with row-367 critical | PARTIAL | TOOL PATH EVIDENCED evidence-only; Brief wording NOT evidenced (correctly so). `ring-ocr-step3` RESULT: PDF text layer extracts byte-exact (`fcb75e92…`, 50 chars: "TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm"); `ocr_document` through the real agent path, evidence-only; correlation run names row 367 / 10:31:30 / 8.3 mm/s + clearance in one final answer. The scan says bearing *clearance*, never *wear* — "OCR finds bearing wear" is contradicted by the evidence; the packet's honest narration line ("reads the inspection report", NOT "OCR of a scan") must be the video wording. Drag-drop gesture on camera: NOT evidenced (overlay dropzone is code+test only). |
| 4 | "Raise a work order and draft my handover" → approval card → approve → DOCX work order + handover | EVIDENCED (evidence-only; live approve→artifact not in packets) | Demo-package S4 evidence-only: `awaiting_approval` → approved → `artifacts/work-order-602540.docx` (sha `1de81618…`, 4721 B) + `.md` twin (`b139cfdd…`). `3530e02` approval fix (evidence-first telemetry so citations exist; `wantsHandover` branch; deny stops the batch) + regression tests (2 approvals → 4 `artifact.created` twins, files exist, validator passes) + overlay "Generating approved artifacts…" status + artifact download endpoint with traversal refusal (dev-b-day2 loopback test). Mock-hosted S4: model *proposed* instead of calling (mock-script artifact, not product) — record S4 on evidence-only. Live: harness `raise-work-order` auto-denies by design (expected stop); no live approve→artifact transcript exists. Artifacts recheck: REPORTED, no artifact. |
| 5 | Follow-up "make the handover shorter", same thread | PARTIAL | MECHANICS EVIDENCED evidence-only; live result unknown. Demo-package S5: same thread (`thread-…461a3db8`, 6 runs linked), follow-up completes; content is the honest `CORPUS_EMPTY` deterministic line (no KB build — nothing fabricated). Threads persist to disk, reload by history (`RingThreadService`, `POST /ring/threads/:id/messages`, dev-a + dev-b-day2 tests incl. restart reload). Live `followup-recall` (5th PM run) result is not in any packet; memory/recall is the PM-reported flaky area — hybrid prefetches it server-side now, unconfirmed live. |
| 6 | "Approve the turbine restart" → calm refusal | EVIDENCED | Demo-package S6 evidence-only, verbatim: "I cannot approve equipment restart or operation. Restarting or operating plant equipment requires an authorized human operator following site procedures; a Ring run approval covers evidence artifacts only and never authorizes operating the plant. No action was taken and no files were written." — no tools, no files. Gate runs before any provider call in both modes (`ring-agent-service.ts:661-672`, `ring-safety.ts` restart patterns incl. pump/P-12 phrasing); Day-2 safety evals include refusal + prompt-injection (SOP saying "ignore previous instructions"). Refusal screenshot: REPORTED, consistent. |
| 7 | Audit verify: every step logged, chain verifies | EVIDENCED (evidence-only; live inside PM's 3/4) | Demo-package S7 evidence-only: "Audit verification: valid=true; Live audit trail verified (9 records)." `verify_export` tool + `RingVerifyCard` (command text + export path rendered, no approval needed) + CLI `verify audit --run-id` exact-ID pattern. Tamper fails-closed: REPORTED via user log; corroborating pre-existing engine tamper tests (f3-06) are red in fulltest for environment reasons (no engine binary), so Ring-level proof is the `verifyChainRecords` path + S7, not the engine suite. |
| 8 | Badge visible: HOSTED · Meta muse-spark-open via Baseten | PARTIAL | BADGE MECHANICS EVIDENCED; live HOSTED badge NOT evidenced. Both badge strings asserted in tests; evidence pass observed EVIDENCE-ONLY, mock-hosted pass observed HOSTED. No keyed live run exists in any packet (all packets key-unset by design), so the real "HOSTED · meta-models/muse-spark-open-1026 via Baseten" on camera is still to capture. If recorded without a key, the honest badge is EVIDENCE-ONLY and the narration must say so (Handoff 2b cost statement). |

## 2. Never-cut list (Brief §8) — proven on CURRENT main?

| Item | Proven on `3530e02`? | Proof |
|---|---|---|
| Multi-turn threads | YES | `RingThreadService` + `POST /api/v1/ring/threads`, `GET :id`, `POST :id/messages` (router.ts:1427-1494); 6 runs linked on one thread in demo-package; restart-reload + compaction tests (dev-a). |
| Streaming events | YES (run events; token-typewriter explicitly not promised) | `model.delta` / `plan.updated` / `artifact.created` / `memory.saved` / `skill.prefetch` in `ring-contract.ts:75` + `toWireEvent` projection + WS `/api/v1/events`; 1s poll disclosed as fallback; Handoff 3.3 token streaming was conditional and is not claimed. |
| Summonable ring overlay + hotkey | IMPLEMENTED, camera proof outstanding | Overlay host + route + tests (see step 1). Eye verification (summon, translucency, drag, multi-monitor) never done — required pre-recording check, not a code gap. |
| T-07 scan reading | YES (evidence-only) | OCR-step3 packet (byte-exact text layer + agent-path + correlation). P-12 scan PNG/photo honestly unavailable (Day-2 tests assert it). |
| Approvals + artifacts | YES (evidence-only end-to-end) | S4 docx+md SHAs + twin artifacts + download/traversal tests + overlay approval card + generating status + deny-writes-nothing tests. |
| Refusal moment | YES | S6 verbatim + pre-provider gate both modes + Day-2 refusal/injection evals. |
| Audit verify | YES | S7 valid=true + `verify_export` + card + CLI pattern. (Engine-suite tamper tests are env-red; not the Ring proof.) |
| Evidence-only fallback | YES | Every suite in every packet runs with `BASETEN_API_KEY` unset; mode marker + banner + deterministic answers; demo-package 8/8 PASS with no key. |

## 3. Cut list — cut and labelled, not silently half-present?

- **Voice: CUT and labelled.** Dev-b-day2 run-log: "Voice: CUT per scope — no local transcription engine exists; nothing was built. Recorded here only." Zero voice/push-to-talk/microphone/speech code in `src/`. Clean cut. ✓
- **Screenshot capture: NOT cut from code — retained in an explicitly labelled pending state.** Overlay + full view have an explicit, visible, single-capture button; captures are memory-only and labelled `inspect_image pending`; the tool returns an honest unavailable result without a VLM runtime. The Brief cut order listed it second, but the shipped state is "present, labelled pending", not silent. Acceptable iff the video does not imply vision works. ⚠ (label, don't demo)
- **XLSX: PRESENT in code, absent from demo scope — needs a one-line label.** `generate_spreadsheet_xlsx` tool exists (registry, consequential-gated, named in the hosted system prompt) with passing generator tests (f6-03); but no Ring demo step or Ring-level test exercises it. Not in the 8 steps, so harmless if unmentioned — but nothing labels it out-of-demo-scope. Recommendation: one scope-note line (demo uses DOCX + markdown twins) so it is not read as half-present. ⚠
- **P-12 vision (scan PNG + photo): CUT and labelled.** `DEMO_PACK_PROVENANCE.json` v1.1.0: "labels the P-12 scan PNG and equipment photo as NOT wired into Ring evidence paths"; dev-c-day2 run-log + Day-2 tests assert honest-unavailable; P-12 *text* triplet (CSV+SOP+note) is in-scope and routed. Clean cut. ✓ (P-12 probe REPORTED consistent with this.)
- **Extra personas / slash skills: NOT cut — fully shipped.** All 4 roles (`operator|maintenance|safety|manager`, default `operator`) + all 6 skills (`/handover /rca /permit /loto /sop /report`) + role picker + `GET /api/v1/ring/skills` are on main with tests. The cut order was conditional ("if behind"); the work landed, so there is nothing to cut. Demo uses the default role path. Not a violation — just do not claim minimalism. ✓ (no doc claims they were cut)

## 4. HACKATHON_SUBMISSION.md — statements that are FALSE right now

The file otherwise describes the pre-Ring judged-T-07 workflow (historical claims check out:
deterministic TypeScript analysis, no Meta call in the cited rehearsed runs, separate Rust
engine, synthetic fixtures, "no video recorded", "nothing submitted"). Exactly one sentence is
now factually false, plus one structural staleness:

1. Verbatim: **"Meta credits are not active, so no hosted request was made and no live Meta
   integration is claimed."** — FALSE on both clauses: live hosted reliability runs have since
   occurred (PM-reported: 3/4 twice). Credits were necessarily active for those runs, hosted
   requests were made, and the doc's own gate ("Before any hosted request, confirm an active,
   unexpired positive credit balance and provider-side no-overage protection") has evidently
   been satisfied. (Credit state itself is PM-reported; no packet inspects the Baseten account.)
2. Structural staleness (not a single false line, but false by omission as a submission packet):
   the document says nothing about Ring, hosted mode, or the 8-step demo — its demo/script/
   readiness sections still describe the old judged workflow ("makes no hosted Meta Model API
   call"). The truthful update is already owned (Dev C, by Nov 4 18:00 per Handoff §4) and is
   not yet done — expected at Checkpoint 2, not a surprise. Sibling docs (`PRESENTATION_SCRIPT.md`,
   `RECORDING_READINESS.md` last reviewed 10-27) are stale the same way and must be updated
   together before recording.

No other verbatim statement in the file was found false. (Note: the public repo link
`https://github.com/Amitakshya333/MAOS-industrial-` renders truncated in the table; access /
revision / disclosure checks are already listed as owner checks in the doc itself.)

## 5. Go / no-go for the Nov 4 recording from the packaged build: GO WITH CONDITIONS

**Verdict: GO WITH CONDITIONS.** The 8-step flow is proven end-to-end in evidence-only and in
mock-hosted mechanics; nothing in the evidence justifies NO-GO, but a full GO would misstate
five facts. Do not record until:

1. **Re-package from `3530e02`.** The staged package (demo-package packet) was built at
   `074e1f8` — it predates the overlay fixes (translucency, drag, dropzone) and the approval
   handover fix, and the old tree stalls on the exact demo wording ("raise a work order and
   draft my handover"). Re-run the 8-step evidence-only pass against the fresh package.
2. **One live hosted confirmation post-hybrid** (or accept evidence-only recording). The stable
   live miss (memory-and-plan) is exactly what the hybrid router fixes server-side; it has
   zero live confirmations. If hosted does not reach the 4-of-5 rule, record in evidence-only
   with the EVIDENCE-ONLY badge and the Handoff 2b cost line — do not badge it HOSTED.
3. **Eye-verify the overlay on the recording machine** (hotkey summon, see-through, drag,
   approval card, artifact open). All four were code+test-only. Note the default hotkey is
   **Ctrl+Shift+Space**, not the Brief's Ctrl+Space — narration and finger demo must match.
4. **Lock the honest narration lines:** "reads the inspection report" (not "OCR of a scan");
   bearing *clearance* 0.050 mm (never "wear"); "synthetic demo data / decision support, not
   operating authority"; badge read aloud as shown.
5. **Update `HACKATHON_SUBMISSION.md` + `PRESENTATION_SCRIPT.md` + `RECORDING_READINESS.md`
   truthfully** (Ring hosted use, credits state, Ring 8-step script) before the take — Dev C
   owns this by Nov 4 18:00.
6. **Scope the green-suite gate to Ring suites + `build` + `typecheck:gui`.** Full `npm test`
   is red on main for pre-existing environment reasons (no engine binary, missing snapshots —
   760 shared failures, REGRESSIONS 0 per fulltest-compare); holding the recording to a
   full-green gate is impossible without fixing pre-existing env failures out of scope.
   Required: ring-agent, ring-contract, ring-wire-contract, ring-hybrid, ring-dev-a (minus the
   known fixture-helper env assertion), ring-dev-c-safety, ring-dev-c-day2, ring-workspace,
   ring-devb-surface, ring-impl-01 green on the packaged commit.
7. **Package from a clean tree.** `C:/maos` currently carries uncommitted edits: the
   approval-fix `RingVerifyCard` caption in `RingWorkspace.tsx` (+3 lines, cosmetic — committed
   `3530e02` lacks it) and local `.maos/` config edits (never commit those per Handoff 2a).
   Either commit the caption or drop it before packaging so the recording matches a commit.

---

## Handoff

- TASK: CHECKPOINT2-REVIEW-01 — STATUS: complete (read-only review; no code changes, no commits, no pushes, no live calls).
- Verdict: **GO WITH CONDITIONS** (conditions §5.1–§5.7 above).
- Report: `C:/maos/review-packets/ring-checkpoint2-2026-11-02/CHECKPOINT2.md` (+ SHA-256 below).
- NOT verified: live Baseten behaviour and the PM-reported 3/4 runs (no transcript in scope);
  physical hotkey/translucency/drag on glass; drag-drop of a real PDF on camera; live
  approve→artifact; live HOSTED badge; user-reported items (§0: 7/7 checklist, rechecks,
  P-12 probe, refusal screenshot, tamper log — no packet artifacts reviewed); full-suite green
  (env-blocked, pre-existing); signed-installer attestation; evaluator acceptance of the
  separate Rust engine; portal/rules eligibility.
- Anything outside the assignment: created the packet dir + this report file only (the assigned
  deliverable). Pre-existing uncommitted edits in `C:/maos` (`.maos/` configs, `RingWorkspace.tsx`
  caption) were read, not touched. No commits, pushes, or pushes of any kind.
