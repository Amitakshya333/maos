# MAOS Ring — submission narrative (docs only, 2026-11-01)

Framing note: product names (Ring = agent, Cockpit = dashboard), the demo
arc, and positioning language below are PM-directed. Every mechanism,
value, and behavior claim cites its source; anything not verifiable in
staging docs, review-packets, or the committed tree is marked UNVERIFIED.
Nothing here was executed.

## One-line pitch

MAOS Ring is the company agent: employees ask in plain language, and it
works from the company's own governed data inside MAOS — telemetry, SOPs,
incident notes, documents, approvals — with deterministic checks, human
approval gates, and a tamper-evident audit. (Framing PM-directed;
components grounded per section.)

## The problem (PM positioning)

Companies want AI productivity but cannot send plant and company data to
hosted chatbots they do not control. Generic chatbots also give answers
with no verifiable computation, no approval boundary, and no audit trail
— unacceptable where safety and sign-off matter.

## How Ring solves it

1. Ask in Ring: the employee types a plain-language question (arc step 1
   below; UX flow PM-directed).
2. Evidence is retrieved from MAOS: Ring shows its sources — rehearsal
   step C records source + row count + analysis ID for the bundled sample
   (`electron-rehearsal-2026-11-01/run-log.md`); staged sources include
   SOP `SOP-TURBINE-VIB-DEMO-V1`
   (`demo/industrial/sop_turbine_vibration_monitoring.md`), thresholds,
   vibration log, maintenance report, inspection scan (B2
   `demo-staging.json` with 4 SHAs).
3. Deterministic checks compute the verdict: RMS `2.63710997` mm/s,
   verdict FAIL — B2 `runtime-acceptance.json` + step 17 output. No model
   call is involved in this computation (B2 scope: no hosted calls).
4. Ring drafts the work: the DOCX safety note,
   `artifacts/generated/turbine_safety_approval_note.docx` (`d489ab37…`,
   5,436 bytes, B2-evidenced) is assembled by the deterministic pipeline.
   When a model is configured, Ring uses Muse Spark Open via Baseten for
   reasoning and drafting over the retrieved evidence
   (`src/backends/meta-api-policy.ts:3-5` pins
   `https://inference.baseten.co/v1` + `meta-models/muse-spark-open-1026`
   + `BASETEN_API_KEY`; contract test
   `tests/backends/baseten-api-provider-boundary.test.ts:93` pins the
   model id; OpenAI-compatible client per that file's `OpenAIProvider`
   usage). B2 ran model-free, so model-assisted drafting itself is
   narrative-described, not B2-executed.
5. Approval gates stay with humans: unapproved runs stop at exit 10
   `WAITING_FOR_APPROVAL` (B2 step 21) and confirmations at exit 4
   (B2 step 20); Cockpit approval flow was rehearsal-exercised
   (RUNBOOK rehearsal basis; rehearsal step F shows the queue).
6. Audit seals the result: `verify audit` returns `valid: true`, 9
   records, empty errors (B2 step 18); tamper negatives are covered by
   `tests/f3-06-audit-events.test.ts` (payload/hash tamper → `valid:
   false`, "hash mismatch") and bundle-manifest `tampered[]` reporting
   (`tests/f2-03`, `tests/f2-bundle-commands`).

## How Cockpit fits

Cockpit is the operational dashboard officials use to see what is
happening and what is waiting: session presence, API health, analysis
results with source and row counts, the approvals queue (0 pending in
rehearsal), and audit linkage (rehearsal steps A–F; RUNBOOK rehearsal
basis). When work is needed, officials open Ring from the operational
picture (general UX link PM-directed; nearest grounded link: the
rehearsal scope names an "Ask about this CSV" path as out-of-scope,
i.e. acknowledged but not exercised).

## Why Meta Muse Spark Open fits

Reasoning, planning, and drafting are the model's job; MAOS keeps the
governed data plane (role split PM-directed; mechanism grounded):
exact opt-in provider policy (model id + endpoint + key variable pinned
in code and contract-tested as above; hostile endpoints, wrong provider
names, and missing keys are all refused by the boundary tests).
Honesty rule (PM-directed, mechanism-consistent): hosted model reasoning
happens at Baseten; the company's raw data, index, approvals, and audit
stay in MAOS. Never call the demo "fully offline" — only the
deterministic checks and the verifier run offline (B2 built and ran
offline; any Baseten call is hosted by definition).

## Exact demo arc

1. "Why is turbine 7 above its vibration limit, and what do we do next?"
   (PM-verbatim question; typed into Ring.)
2. Ring shows its sources: SOP `SOP-TURBINE-VIB-DEMO-V1`, incident/
   telemetry evidence (maintenance report, vibration log, thresholds,
   scan per B2 fixture SHAs), with source + row count + analysis ID per
   rehearsal step C. Exact on-screen rendering: UNVERIFIED — tester
   records verbatim.
3. Deterministic verdict: RMS 2.63711 mm/s, FAIL expected (B2).
4. Drafted safety note / DOCX (`d489ab37…`, B2; model-drafting split per
   §"How Ring solves it" step 4).
5. Refusal: "Try to claim completion without the required tool" → refused
   on screen. Grounded reference: CLI confirmation gate refuses with
   `AAP-01/POLICY-01: confirmation gate requires explicit approval…`
   (exit 4, B2 step 20); approval wait at exit 10 (B2 step 21); explicit
   rejection covered in the rehearsal basis. Exact GUI refusal text:
   UNVERIFIED — tester records verbatim.
6. Cockpit: approvals queue (0 pending in rehearsal) + audit linkage.
7. Judge verifier: original export verifies (`valid: true`, 9 records);
   a tampered copy FAILS closed (`valid: false`, hash-mismatch errors
   per f3-06 semantics). Procedure — copy the export, alter one byte,
   re-run `verify audit`: derived from documented verifier semantics,
   not B2-executed.

Ring must never pretend a model ran. With no model configured it runs in
"evidence-only mode" and says so (term PM-directed — absent from sources;
behavior grounded: B2's full run completed with no key and no hosted
calls; nearest product strings: `text-model not configured`
preflight detail, `no model server configured — skipped` rehearsal
detail). Evidence-only operation is expected, not a failure.

## What we do not claim

- Not fully offline when Baseten is used: only deterministic checks and
  the verifier run offline.
- No legal or license clearance beyond the documented notices
  (`THIRD_PARTY_NOTICES/COMPATIBILITY-SCREEN.md` is preliminary).
- No claim that JS licenses are fully resolved (70 root + 15 desktop
  entries unresolved per `JS-CLOSURE-RUN-2026-10-31.md`, incl. 10
  MPL-2.0 platform texts).
- The canary test gap is a setup gap: 46 baseline failures, all ENOENT
  on ignored out-of-band `rust/test.txt` (Task D comparison), expected,
  not product failure.

## 30-second rejection-proof opening (for the submission page)

"MAOS Ring answers employees from the company's own governed data.
Ask about turbine 7: Ring shows its sources, deterministic checks
compute RMS 2.637 and verdict FAIL, the safety note is drafted, humans
approve, and audit seals it — reproducible from public repos at pinned
revisions. Hosted reasoning runs at Baseten only when configured; the
data plane, checks, and verifier stay in MAOS. Evidence-only without a
model, refusal gates enforced, tampering detected — and everything we
don't claim is listed below."
