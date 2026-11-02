# Ring Surface — Buildable Spec (demo: Muse Spark Open via Baseten)

- Status: SPEC ONLY. No code changed, nothing implemented.
- Base tree verified against: `2cfdf9b` + committed `d324129`/`f54dd7e` (all file:line citations below are against that tree).
- Conventions: **EXISTS** = implemented + committed, cited with file:line. **NEW (cost)** = to build;
  cost scale XS ≤40 lines + tests, S ≈40–150 lines + tests, M ≈150–400 lines + tests + review.
- Names are fixed: the agent is **Ring** (primary conversational surface); the dashboard is **Cockpit**
  (secondary operational view). Demo model: `meta-models/muse-spark-open-1026` via
  `https://inference.baseten.co/v1` (OpenAI-compatible).

## 0. Foundational findings (read, not assumed)

1. Chat is local-only by construction today. `ChatInferenceService`
   (`src/service/chat-inference-service.ts:1-13,58-61`) hardcodes the loopback endpoint
   `http://127.0.0.1:8000` and model `qwen2.5-3b-instruct-local`, and rejects non-loopback
   endpoints via the endpoint allowlist (`:104-130`, `NON_LOOPBACK_ENDPOINT`). Its system
   prompt states "running entirely on this machine … never transmitted externally" (`:63-70`).
   The Baseten path exists ONLY for the Industrial analysis agent
   (`basetenApiEnabled` opt-in + exact endpoint/model policy in
   `src/backends/meta-api-policy.ts:3-5,106-113,206-243`, enforced at construction).
   Consequence: Ring-on-Baseten requires a NEW hosted inference path; the sovereign
   chat path must not be altered to allow it (see §F).
2. `INDUSTRIAL_DEMO_VIEWS` (`src/gui/src/components/ActivityBar.tsx:29-35`) is
   `[cockpit, evidence, approvals, documents, audit]` — **chat is excluded**. Ring cannot
   appear in industrial-demo mode without a decision → open question O-1.
3. The refusal mechanism is committed (`TelemetryReviewCoordinator.prepareReview` →
   `POST /api/v1/industrial/judged-runs` → `prepareAgentJudgedRun` gate,
   `src/industrial/judged-run.ts:449-467`); the W2 demo button
   (`CompletionRefusalDemo.tsx`) is candidate-only, uncommitted. §C accounts for both.
4. No test pins the ActivityBar label `Chat & Sessions` (repo-wide grep, zero hits),
   so relabelling it to `Ring` carries no known test impact.

## A. How Ring names itself and signals state

### A1. Brand and naming (minimal rename-in-place; ChatView BECOMES Ring, no parallel view)
- ActivityBar entry `chat`: label `Chat & Sessions` → **`Ring`**, sublabel/title
  "Primary conversational surface" (`ActivityBar.tsx:49`; aria-label updated to match). XS.
- In-conversation attribution: assistant message header currently renders the bare role
  (`ChatView.tsx:675-683`, uppercase `ASSISTANT`). Spec: render **`RING`** for
  `role === 'assistant'`; `USER` unchanged. XS.
- App header brand (`Header.tsx:31`, "MAOS // MONOCHROME MISSION CONTROL") unchanged.
- Rationale for rename-in-place over a new view: ChatView is 1055 lines of conversations,
  modes, citations, and promotion logic; duplicating it would fork behavior. Forbidden
  alternative: a second chat implementation.

### A2. Model identity line (extends the existing badge)
- Exists today: `chat-active-model-badge` (`ChatView.tsx:529-531`) shows
  `{DEVICE|LOCAL}: {modelId|'None'}` from the local registry
  (`GET /api/v1/models`, `GET /api/v1/models/active` → `rest-client.ts:1358ff` area,
  `adapter.ts:475-476,562-563`; registry schema `src/domain/model-manifest.ts:29-36`,
  `device: 'cuda'|'cpu'` — cannot represent a hosted model, so the registry is NOT extended).
- NEW (XS): when the hosted path is armed (project config `providers.baseten` with
  `basetenApiEnabled: true` + exact model id + `BASETEN_API_KEY` present), the badge shows:
  `HOSTED · meta-models/muse-spark-open-1026 via Baseten`
  When the provider echoes a served model id, append `· reported <id>`; when absent,
  append nothing (never invent it). Identity source: project config + runtime
  provider echo, via a NEW small selector (reads existing config loader + response field).
- Local path unchanged: `{DEVICE}: {modelId}` exactly as today.

### A3. State banner (NEW, XS)
- Placement: full-width informational strip at the top of the Ring view, above the
  conversation (sibling of the existing `chat-error-banner`, `ChatView.tsx:560-574`,
  but informational styling, never red).
- Shown iff hosted path is armed (same condition as A2). Exact copy:
  - Title: `Hosted Meta inference · Data stays in MAOS`
  - Body: `Ring drafts with meta-models/muse-spark-open-1026 via Baseten. Telemetry evidence,
    receipts, and audit records stay in this MAOS project; only the request text and derived
    findings leave the device. Threshold verdicts always come from local deterministic replay,
    never from model prose.`
- Never shown in sovereign-local mode (no opt-in). Never shown in evidence-only mode.

### A4. Fallback when no model is configured (exact copy — NEW wiring, XS)
- Trigger: no local model server reachable (`GET /api/v1/chat/health` → `available: false`,
  `router.ts:1277-1281` + `ChatInferenceService.isModelServerAvailable`, `:323-338`) AND
  no armed Baseten path (opt-in off or key missing).
- Ring shows, in the banner slot, verbatim:
  > Ring is running in evidence-only mode: no model is configured, so no hosted or local
  > inference will run. Local evidence, verification, and review tools remain available.
- Behavior in this mode: message send is disabled with `aria-disabled` + tooltip repeating
  the first sentence; telemetry analysis, verification, review, and audit tools all work
  (they need no model). Re-evaluate on the existing 5 s model poll (`ChatView.tsx:73-76`).
- Empty-state title `Sovereign Local Chat Ready` (`ChatView.tsx:649`) becomes mode-aware:
  hosted → `Ring Ready — hosted Meta inference`; evidence-only → `Ring Ready — evidence only`;
  sovereign-local unchanged.

## B. Primary demo arc, mapped to real components

User asks in Ring: **"Why is turbine 7 above its vibration limit, and what do we do next?"**

| Step | What happens | Component / service today, or NEW + cost |
|---|---|---|
| 1. Ask | Message stored in the conversation via existing conversations API; Ring sends history for completion | EXISTS: `ChatView.tsx:148-188` input+send, `POST /api/v1/conversations`, `POST /api/v1/chat/completions` (`router.ts:1221-1280`). Completion call itself routes to the NEW hosted path (§B.0) |
| B.0 NEW | Hosted inference for Ring | **NEW (M)**: new `RingInferenceService` + explicit route (recommended: `POST /api/v1/ring/completions`), reusing `createProviderDirect('baseten', …)` (`factory.ts:563-593`), `OpenAIProvider.generate`, and `meta-api-policy.ts` opt-in/env-key enforcement; its own system prompt stating hosted processing + data boundary (the current prompt at `chat-inference-service.ts:63-70` asserts local-only and MUST NOT be reused). Explicitly NOT an extension of `ChatInferenceService` (sovereign path stays loopback-only). Includes tests + policy review. |
| 2a. Retrieve SOP | Load `demo/industrial/sop_turbine_vibration_monitoring.md` (SOP-TURBINE-VIB-DEMO-V1; action directives §4: Warning→monitor, Critical→escalate) | Recommended: **NEW (S)**: deterministic prefetch in the Ring flow reusing the existing `read_file`/`ingest_document` implementations as library calls; cites Document ID + section. Alternatives (not recommended): agent-tool allowlist expansion (M + security review — analyst agent today allows only telemetry+complete); KB seed + `search_knowledge_base` (M — seeding flow unproven for this corpus; KB infra itself exists: `KbSearchService`, `kb` CLI build/verify). PM confirms mechanism (O-4). |
| 2b. Retrieve incident | Load `demo/industrial/maintenance_report.txt` (MR-T07-2026-0822: metallic sound, warm DE housing, lubricant residue, two vibration alarms) | Same mechanism as 2a (same NEW cost line — one retrieval helper, two documents). |
| 2c. Retrieve telemetry | Deterministic local analysis of `demo/industrial/turbine_vibration_log.csv` (500 rows) against `safety_thresholds.json` | EXISTS: `analyze_telemetry_csv` tool / `storeTelemetryAnalysis` + `verifyTelemetryAnalysis` (`src/industrial/telemetry-analysis.ts`); judged-run engineering verdict downstream. **Only derived findings cross into the prompt** (rows/peaks/verdict/findings ≤30 + omitted count — the existing evidence-result contract); the raw CSV never does (§F). |
| 3. Verdict | Ring states the deterministic verdict, citing receipt ID + row numbers | EXISTS for computation (step 2c). NEW rule (XS, prompt+rendering): verdict numbers render ONLY from the receipt object, never from model prose; model prose keeps the existing `unverified-prose-badge` (`ChatView.tsx:699-718`). |
| 4. Safety note draft | Model drafts the note citing receipt IDs; final artifact is the judged-run DOCX | Draft: NEW hosted call (§B.0). Final: EXISTS — `DocxGeneratorService.generateDocx(Async)` during judged finalization → `artifacts/generated/…-turbine_safety_approval_note.docx` (`judged-run.ts:1088,1628-1633`); download via existing artifact download (`ApprovalsView.tsx:157`). |
| 5. Approval request | Human approves/rejects; approval resumes only that run | EXISTS: `POST /api/v1/approvals`, `POST /api/v1/approvals/:id/{review,resolve,decide}` (`router.ts:1782-1939`, judged kind → `decideAndResumeJudgedRunAfterApproval`), `ApprovalsView`. Ring deep-links `#/approvals` (existing hash nav, `App.tsx:61-69`). Model never approves (§F). |

## C. Refusal and verifier inside Ring

### C1. Refusal beat — component + route + copy (all EXISTS except the Ring mount)
- Component (committed): `TelemetryReviewCoordinator.prepareReview` (failure branch applies
  `reviewError`, no navigation, no storage write — committed per task facts; covered by
  coordinator suites). Reference UI (W2 candidate, UNCOMMITTED): `CompletionRefusalDemo.tsx`
  — presentational, takes `analysisId` + callbacks; land it or re-implement equivalently.
- Ring placement (NEW, XS): after Ring renders a telemetry receipt, render the claim
  control inline, wired to a Ring-owned `TelemetryReviewCoordinator` instance (same
  adapter/effects pattern the panel uses; per-mount instance, no shared-state change),
  passing the receipt's `analysisId`. Hidden once a qualified agent result exists for
  that receipt (same truthfulness rule as the W2 panel gating).
- Route (committed): `POST /api/v1/industrial/judged-runs` with `{analysisId}`
  (`router.ts:422-530`) → `prepareAgentJudgedRun` gate
  (`src/industrial/judged-run.ts:449-467`).
- Exact visible copy (verbatim gate reason, existing): `Accepted agent report was not
  found inside the active project.` rendered in `role="alert"`. Button label (existing
  W2 copy, keep verbatim): `Try to claim completion without the required tool`.

### C2. Judge verifier — verify export + tamper copy
- EXISTS (CLI): `maos industrial verify telemetry --analysis-id <id>`
  (`src/cli/index.ts:819-831` → `runIndustrialVerify`, `industrial-cli.ts:629+`) and
  `maos industrial verify export <path>` (audit-export verification with PASS/FAIL,
  run/deliverable linkage). EXISTS (GUI, audit half): AuditView `Verify Cryptographic
  Chain` (`btn-verify-chain`) + `Export Audit Trail` (`AuditView.tsx:104-129,195-206`)
  via `verifyAuditChain`/`exportAuditTrail` adapter calls.
- Tamper copy (procedure, zero code — proven pattern in
  `tests/industrial/telemetry-analysis.test.ts:68-72`: append a byte → `valid:false`,
  `sourceHashMatched:false`): judge copies the receipt/export, alters one byte, re-runs
  verify, observes FAIL. Spec the exact commands in the demo script; no helper to build.
- Ring display (recommended: zero code): Ring prints the exact verify command + expected
  PASS lines as a transcript card, matching the existing TelemetryReviewPanel replay-hint
  pattern. Optional follow-up (NEW, S): read-only telemetry-verify API route (none exists
  today — verified route list) + inline result card. Default: transcript card (O-5 to confirm).

## D. What Cockpit keeps + Ring ↔ Cockpit movement

- Cockpit keeps everything it shows today — no removals: runs list + DAG/workflow
  projections, live event subscription + replay, force-stop controls, T-07 judged-run
  starter, stage detail, and the embedded `TelemetryReviewPanel` (`CockpitView.tsx:413`,
  the operational home of refusal demo + agent analysis + CLI replay hints).
- Movement (all existing): ActivityBar entries (`ActivityBar.tsx:48-53`, chat + cockpit
  entries) and hash routes `#/chat` ↔ `#/cockpit` (`App.tsx:61-69`, `VALID_VIEWS`
  `:45-59`, default view `chat` at `:103`). Ring deep-links to Cockpit sections by
  hash where useful (e.g. approvals `#/approvals`).
- Demo-mode constraint (needs PM decision, O-1): `INDUSTRIAL_DEMO_VIEWS`
  (`ActivityBar.tsx:29-35`) currently excludes `chat`; Ring is unreachable in
  industrial-demo mode until `chat` is added to that set (one-line change + demo
  script update).

## E. Baseten configuration (key never touches disk)

- Project config (exact shape; secret-free by construction):
  ```json
  { "providers": { "baseten": {
        "baseURL": "https://inference.baseten.co/v1",
        "basetenApiEnabled": true } } }
  ```
  (`apiKeyEnv` omitted, or exactly `"BASETEN_API_KEY"`; anything else → project-config
  invalid per `meta-api-policy.ts:112-113,224-225`. Model id `meta-models/muse-spark-open-1026`
  is pinned in code (`meta-api-policy.ts:4`); any other endpoint/model/credential is
  rejected: `BASETEN_API_CONFIGURATION_INVALID` / `MODEL_ENDPOINT_BLOCKED`.)
- Key delivery: `BASETEN_API_KEY` in the **launching process environment only**.
  Verified: `dotenv` loads `./.env` for CLI runs only (`src/cli/index.ts:3-4`); the
  desktop/service host does NOT load dotenv (zero references outside cli + a doc
  comment) and inherits the launcher environment (`launcher.ts:452`
  `env: {...process.env, ...options.env}`). So: `.env` placement = project root,
  honored by CLI runs; the **GUI demo requires the key exported in the shell that
  launches the app** (established pilot-launcher pattern). Never in config files,
  prompts, chat input, logs, or receipts (credential redaction + contamination
  guards already exist on the analysis path).
- `.env.example` today documents only `FREEMODEL_API_KEY`. Propose appending one
  commented placeholder line (no value): `# BASETEN_API_KEY=` + comment
  (O-6 to confirm wording).
- Judge-sees-when-missing (specified): with no local server AND no armed Baseten
  path, Ring shows the §A4 evidence-only banner and disables send; if a send is
  attempted, the surfaced error is the policy message verbatim
  (`meta-api-policy.ts:240`: "The configured environment variable BASETEN_API_KEY
  is empty…", via 503 per `router.ts:621-622` mapping for the agent path; the NEW
  Ring route must map it identically). No silent fallback to any other model, ever.

## F. Explicit exclusions (Ring will NOT, in the demo)

1. No raw 500-row telemetry in any model prompt — derived findings only (§B.2c contract).
2. No hosted call in sovereign-local mode — no opt-in means the loopback-only chat path
   is the only path; the endpoint allowlist is untouched.
3. No invented approvals — approvals exist only via the approvals API + human decision
   (`router.ts:1782-1939`); model output can draft, never decide.
4. No key material on disk, in config, prompts, logs, or receipts (§E).
5. No silent model fallback — missing/unreachable model surfaces as evidence-only mode
   + verbatim error, never a quiet substitution.
6. No accepted completion without `task_complete` + evidence binding (existing rule,
   restated; enforced by the analysis service + review gate, not by Ring prose).
7. No telemetry mutation from chat — Ring retrieves and cites; all writes stay in the
   judged/approval/audit paths.

## Open questions for the PM (decisions needed, not assumptions)

- O-1: Add `chat` to `INDUSTRIAL_DEMO_VIEWS` so Ring is reachable in judged demo mode?
  (Blocks Ring demo visibility; one line + script update.)
- O-2: Confirm Ring brand scope as spec'd (ActivityBar relabel + `RING` message
  attribution; header brand unchanged; no test pins the old label — verified).
- O-3: Confirm NEW `RingInferenceService` + explicit route over extending
  `ChatInferenceService` (recommended: keeps sovereign guarantees airtight).
- O-4: Confirm SOP/incident retrieval via direct deterministic prefetch (recommended, S)
  vs agent-tool allowlist change (policy-sensitive) vs KB seed + search (unproven corpus).
- O-5: Confirm CLI-transcript verify display in Ring (zero code) vs new read-only
  telemetry-verify route + inline card (S, follow-up).
- O-6: Approve the commented `BASETEN_API_KEY=` placeholder line in `.env.example`.
- O-7: Confirm evidence-only trigger semantics (§A4/E) as specified.

## Traceability (all paths verified readable at the cited lines)

ChatView.tsx:11-41 (state), :60-76 (model load + 5 s poll), :148-200 (send +
MODEL_SERVER_UNAVAILABLE), :529-556 (badge + selector), :560-574 (error banner),
:644-653 (empty state), :699-718 (unverified-prose badge), :868 (input);
CockpitView.tsx:60-91 (runs/judged state), :413 (TelemetryReviewPanel mount);
TelemetryReviewPanel (refusal demo + replay hint, W2 candidate uncommitted);
router.ts:422-530 (judged-runs incl. 452-470 agent path), :621-622 (credential→503),
:1022-1029/:1221-1281 (conversations/chat routes), :1782-1939 (approvals),
:2653-2659 (audit verify/export); chat-inference-service.ts:1-13,58-80,323-338;
meta-api-policy.ts:1-5,106-113,206-243; factory.ts:563-593 RuntimeFactory/createProviderDirect;
demo/industrial/{sop_turbine_vibration_monitoring.md (SOP-TURBINE-VIB-DEMO-V1),
maintenance_report.txt (MR-T07-2026-0822), turbine_vibration_log.csv (500 rows),
safety_thresholds.json}; telemetry-analysis.ts (store/verify);
judged-run.ts:411-489 (prepare gate), :1088,1628-1633 (DOCX note), :138 (verifyChain use);
industrial-cli.ts:629-708 (verify targets); AuditView.tsx:104-129,195-206 (verify+export UI);
telemetry-analysis.test.ts:68-72 (tamper pattern); App.tsx:45-69,96-103 (views/hash nav);
ActivityBar.tsx:29-53 (demo set + labels); cli/index.ts:3-4 (dotenv); launcher.ts:452
(env inherit); .env.example:1.
