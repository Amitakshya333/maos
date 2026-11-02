# TASK RING-INTEGRATION-REVIEW-01 — Independent Compatibility + Honesty Review

- Date: 2026-11-02
- Reviewer: independent review (read-only on sources; scratch worktree only, nothing committed/pushed)
- Base commit: `b76363a77e931c417327b7a5fe8cb3a299f125c1`
- Deadline context: MAOS hackathon, Nov 4

## VERDICT: BLOCK — do not integrate as-is. Integrate only with the adapter in §4 (adapter A1–A4 required, A5–A7 recommended; XS–S, server-side single file preferred).

The two patches apply cleanly in sequence to the same scratch tree (service first, then UI; no file conflicts — service touches `src/service/*,src/api/router.ts`, UI touches `src/gui/*`), and each suite passes **in isolation** (28/28 combined run, §6). They are **not wire-compatible**: the UI's fail-closed validator rejects the service's actual `GET` response on the first poll, on every run, in both modes. This is not a corner case — it is the primary polling path. The mismatch count is **9 contract mismatches (2 fatal, 4 semantic-render, 2 silent-ignore, 1 naming collision)** plus **2 latent honesty/safety-adjacent nits** (§5). No dishonesty was found in either patch (§2): no invented served-model id, no fake streaming, no model text in evidence-only mode, no raw telemetry to the model. The approval gate is sound on all requested attack paths (§3).

## Patch identity (SHA-256 read by this reviewer)

| Patch | Path | SHA-256 (verified this review) |
|---|---|---|
| Service (RING-AGENT-LOOP-01) | `C:\maos\review-packets\ring-agent-01-2026-11-02\candidate.patch` | `b683629e0cfa81408a2b5de5632a6c21eda83971b2d71d797d2d031c0f56e516` |
| UI (RING-UI-01) | `C:\maos\review-packets\ring-ui-01-2026-11-02\candidate.patch` | `6f88a18e7f13d80711958b3c589f2d1fe85d9fdde924ee40f1d6f16852a3b91e` |

Both match the PM-supplied hashes. Scratch: `C:\clean\ring-integration-review` (detached `b76363a`, both patches applied, `npm ci` exit 0, disposable). `C:\maos` itself was not modified except this review packet.

### Evidence method

Every claim below cites the applied scratch tree, whose files are byte-identical to the patches. Line refs are `path:line` in that tree (= patch content). The fatal mismatch was also demonstrated dynamically (§6, probe): the UI's own `validateRingRunState` was executed against a faithful service snapshot and threw.

---

## 1. CONTRACT

Service wire shape (truth): `GET` returns `{ data: snapshot }`; snapshot is `RingAgentRunSnapshot` (`src/service/ring-agent-service.ts:40-52`, emitted by `snapshot()` at `ring-agent-service.ts:253-254`):

```
{ runId, instruction, status, mode, createdAt, updatedAt, finalAnswer?, error?, pendingApproval?, transcriptPath, transcript[], turns }
```

UI expected shape: `GET` → `RingRunState { status, mode, events[], finalAnswer?, servedModelId? }` (`src/gui/src/api/ring-run-types.ts:62-69`), events as `RingRunEvent { type, ts, text?, tool?, argsSummary?: string, resultSummary?: string, verdict?, overallRms?, sources?, approvalId?, action?, reason?, decision?, message? }` (`ring-run-types.ts:33-60`), fetched via `getRingRun` → `validateRingRunState` (`src/gui/src/api/rest-client.ts:747-750`). The `{data}` envelope itself is fine: `BrowserRestClient.request` unwraps it via `validateEnvelope` (`rest-client.ts:410`) before validation, same convention the service router uses (`src/api/router.ts:1366`, `sendJson(res,200,{data:snapshot})`).

### Contract table

| # | UI reads | Service sends | Verdict | Evidence |
|---|---|---|---|---|
| C1 | `events: RingRunEvent[]` — `validateRingRunState` throws `RING_RUN_INVALID: events must be an array` if absent/not array (`ring-run-types.ts:158`, `:162`) | Field is named `transcript`, not `events` (`ring-agent-service.ts:51`, `:253-254`); router passes snapshot through verbatim (`router.ts:1366`) | **MISMATCH — FATAL** | Probe (§6): validator throws `RING_RUN_INVALID: events must be an array.` on a faithful snapshot. Every poll fails; workspace shows only `Could not refresh the run: RING_RUN_INVALID…` forever (`RingWorkspace.tsx:678`). |
| C2 | Event `type` closed enum of 9 (`ring-run-types.ts:82-92`); unknown type throws (`:112-113`) | Emits `mode.evidence-only` (`ring-agent-service.ts:361`) — **not** in UI enum. All other service types (`run.started` `:181`, `model.turn` `:405`, `tool.call` `:470`, `tool.result` `:466`, `approval.pending` `:449`, `approval.resolved` `:229`, `run.completed` `:348`, `run.failed` `:340`, `run.cancelled` `:247`) **do** match the enum strings exactly | **MISMATCH — FATAL in evidence-only mode** | Probe: `mode.evidence-only` → `RING_RUN_INVALID: event.type is not a known run event type.` So even after fixing C1, every evidence-only run (the default demo path without a key) still throws on its 2nd transcript entry. Hosted mode never emits it. |
| C3 | `status` enum `running/awaiting_approval/completed/failed/cancelled` (`ring-run-types.ts:18,80`) | Identical strings (`ring-agent-service.ts:14`) | **MATCH** | `RingAgentRunStatus` = same 5 literals. |
| C4 | `mode` enum `hosted/evidence-only` (`ring-run-types.ts:80`) | Identical (`ring-agent-service.ts:15`; set at `:312` / hosted path) | **MATCH** | — |
| C5 | `finalAnswer?: string` (`ring-run-types.ts:67,164-168`) | `finalAnswer?: string`, set only in `complete()` (`ring-agent-service.ts:47`, `:345-348`) | **MATCH** | — |
| C6 | `servedModelId` optional, never defaulted (`ring-run-types.ts:69,170-175`) | Never sent (no such field) | **MATCH (absent)** | UI badge `ringRunBadgeText` (`RingWorkspace.tsx:76-79`) never appends `· reported`; see §2. |
| C7 | Event `text` — model turn body (`ring-run-types.ts:37`); rendered iff non-empty (`RingWorkspace.tsx:818`) | `model.turn` carries `contentSummary` (truncated 500), plus `turn`, `toolCalls[]`, `finishReason` (`ring-agent-service.ts:405`) | **MISMATCH (semantic)** | After C1 fix, `text` is always `undefined` → no model turn ever renders, even in hosted mode where the server did send model prose. Transcript shows tool chips + final answer only. Not a throw (`optionalString` passes on `undefined`, `ring-run-types.ts:99-103`). |
| C8 | Event `tool` — pairing key (`ring-run-types.ts:39`); pairing = first later `tool.result` with same `tool` (`RingWorkspace.tsx:806`), unpaired `tool.result` suppressed if an earlier same-`tool` call exists (`:812`) | Field is `toolName`, plus `toolCallId` on both call and result (`ring-agent-service.ts:466,470`) | **MISMATCH (semantic)** | After C1 fix, `tool` is `undefined` on both sides → chips render labelled bare `tool`, and pairing degrades to "first later result with `tool===undefined`" = any result pairs with any call. With repeated same-tool calls (or 2 tools interleaved) results attach to the wrong chip. `toolCallId` — the correct pairing key the service already provides — is never read by the UI. |
| C9 | `argsSummary` **must be a string** when present (`ring-run-types.ts:121`; `optionalString` throws `:101`) | `argsSummary` is an **object** `Record<string,unknown>` (`ring-agent-service.ts:29`, `summarizeArgs()` `:455-463`, emitted `:449,466,470`) | **MISMATCH — FATAL at first tool/approval event** | Probe: `tool.call`/`tool.result` with object `argsSummary` → `RING_RUN_INVALID: argsSummary must be a string when present.` Even after C1+C2, the first tool call throws. (Name collision, incompatible types.) |
| C10 | `resultSummary` + structured `verdict`/`overallRms`/`sources[]` (`ring-run-types.ts:42-48`); chip expansion renders them (`RingToolChip`, `RingWorkspace.tsx`) | `tool.result` carries `summary` = JSON string of the full result (<=1000 chars, `ring-agent-service.ts:466`), `ok`, `error`; no `resultSummary`/`verdict`/`overallRms`/`sources` | **MISMATCH (semantic)** | Chip expansion shows nothing; verdict/RMS/sources buried in the unparsed `summary` JSON. Also breaks `latestAnalysisId()` (`RingWorkspace.tsx:524-532`, regexes `resultSummary` for `telemetry-...`) so CompletionRefusalDemo silently never appears in Ring (works only via injected `prepareReview` in tests). |
| C11 | Approval pending derived from **events**: `approval.pending { approvalId, action, reason }` (`ring-run-types.ts:25,50-54`); card renders `event.action`/`event.reason` (`RingWorkspace.tsx:350,401`); resolved-set from `approval.resolved` events (`:504-511`) | Two sources: (a) snapshot `pendingApproval { approvalId, toolName, summary, reason, argsSummary, createdAt }` (`ring-agent-service.ts:22-30,254`) — **UI never reads it**; (b) event `approval.pending { approvalId, toolName, summary, reason, argsSummary }` (`:449`) — UI reads `action`, service sends `summary` | **ADAPTER-NEEDED** | `action` always undefined → approval card renders an **empty action line** (reason does render; `approvalId`+`reason` names match). Decidable (Allow/Deny posts id correctly) but the human approves a blank description. UI mocks use `action:` (`ring-workspace.test.ts` `AWAITING_APPROVAL`) so UI tests cannot see this. |
| C12 | POST start `{ instruction, agentId? }` (`ring-run-types.ts:75-78`); `agentId` sent when a non-lead agent is selected (`RingWorkspace.tsx:720-722`) | Router validates `instruction` + optional csv/export/evidence/analysis/document paths; **unknown fields incl. `agentId` silently ignored**, never rejected (`router.ts:1322-1351`) | **MISMATCH (silent-ignore)** | Run starts (201) but is not scoped to the selected agent; service has no per-agent concept. Roster presence dots claim the selected agent is "working" (`RingWorkspace.tsx:696-699`) while the Ring lead executes. Cosmetic for demo; must be wired or documented (A6). |
| C13 | POST response `{ runId }` (`ring-run-types.ts:72,181-183`) | 201 `{ data: snapshot }` incl. `runId` (`router.ts:1352-1353`) | **MATCH** | Validator reads only `runId`, ignores extras. |
| C14 | Cancel `POST .../cancel` body `{}`, response ignored (`rest-client.ts:753-755`) | JSON body parse (`{}` OK), 404 unknown, terminal-safe (`router.ts:1371-1383`; `cancelRun` `ring-agent-service.ts:240-251`) | **MATCH** | — |
| C15 | Approval `POST .../approvals/:approvalId { decision }`, response ignored (`rest-client.ts:757-768`) | Same path/body; decision enum validated; 404 unknown run/approval; 400 `APPROVAL_NOT_PENDING` if not pending (`router.ts:1386-1412`; `resolveApproval` `:222-237`) | **MATCH** | Double-resolve → second post gets verbatim 400 → UI surfaces error. Safe (§3). |
| C16 | `run.failed` event `message` rendered verbatim (`RingWorkspace.tsx:841`) | Event carries `error` (`ring-agent-service.ts:340`); snapshot top-level `error` (`:47`) — UI reads neither | **MISMATCH (minor semantic)** | Failed runs show generic "Run failed without a message." — honesty regression vs UI test expectation (mocks use `message:`). |
| C17 | Poll GET 1s until terminal (`RingWorkspace.tsx:661-690`) | Cheap in-memory `getRun` (`:186-189`); full transcript re-sent each poll | **MATCH** (perf note) | O(n^2) bytes on long runs; acceptable for demo, not blocking. |

**Direct answers:** (1) *Validator vs real GET?* **Throws `RING_RUN_INVALID` on the first poll of every run** (C1; +C2 evidence-only; +C9 at first tool event) — proven dynamically (§6). (2) *`agentId`?* **Ignored**, not rejected (C12). (3) *Event type strings?* 8/9 UI strings match service exactly; service additionally emits `mode.evidence-only`, which the UI rejects (C2). Everything else diverges at field-name/type level (C7–C11, C16).

---

## 2. HONESTY

**UI — clean on all three probes. No model text in evidence-only mode, no invented served id, no fake streaming.**

- *Model text in evidence-only:* `model.turn` renders only if the server sent one with non-empty `text` (`RingWorkspace.tsx:817-818`); the service never emits `model.turn` in evidence-only mode (`executeEvidenceOnly`, `ring-agent-service.ts:360-390` — deterministic assembly only, ends "No model prose was generated in evidence-only mode."). Banner + no-model note are exact and mode-gated (`RingEvidenceOnlyBanner`, `RingFinalAnswer`).
- *Invented served model id:* none. `ringRunBadgeText` returns the two verbatim badges, never appends `reported` (`RingWorkspace.tsx:76-79`); `servedModelId` is pass-through-only, never defaulted (`ring-run-types.ts:170-175`); service never sends one (C6). The badge names the configured model (`HOSTED · meta-models/muse-spark-open-1026 via Baseten`, pre-existing RING-IMPL-01 verbatim copy, test-asserted) — not a per-run served echo; acceptable per prior spec, noted.
- *Fake streaming:* none. 1s polling disclosed in comments/run-log; events render exactly as polled. NIT: the optimistic pre-poll state hardcodes `mode:'hosted'` (`RingWorkspace.tsx:727`) so the hosted banner can flash for <1 poll interval on an evidence-only backend (badge uses local fallback until first `onRunState`). Fix in A7.

**Service — clean on both probes.**

- *Raw telemetry to the model:* No. Prompt (`executeHosted` `:392-395`) embeds only `telemetrySummaryText()` — verdict/RMS/peak/warnings/findings-summary/source from `analyzeTelemetryCsv` metrics (`:350-357`) — plus a system instruction forbidding raw rows (`:394`). Tool feedback is the same summary object (findings = <=20 threshold-breach records {row,field,value,threshold}, not raw rows). `read_company_document` refuses raw CSV (returns bytes+sha256+pointer). Service test (e) asserts the captured request body lacks the CSV header and sample raw rows.
- *Secrets in JSONL:* `record()` writes JSONL (`:283-289`) containing summaries only; `model.turn`/`tool.result` payloads pass `redact()` which strips the exact `BASETEN_API_KEY` env value (`:276-280`, applied `:405,466,473`); no key is placed in any entry by construction. LIMIT: `redact` strips only the literal current key — another secret echoed in a tool error would persist; draft `contentPreview` (<=200 chars in `argsSummary`, `:459`) appears in approval events by design (approver must see it). No violation found; noted.

---

## 3. SAFETY

**Approval gate — no bypass path found.**

- *Only write path:* `draft_safety_note → toolDraftSafetyNote` (`:550-562`, `writeFileSync` flag `wx`) reachable only via `executeTool` (`:483`) ← `executeToolLogged` (`:470-475`) ← hosted loop **after** the `CONSEQUENTIAL_TOOLS` gate (`:108`, `:425-437`): `awaitApproval` suspends on a promise stored in `run.pending` (`:442-451`); `denied` → run completes with explicit denial, no write (`:430-434`); `cancelled` → abort (`:428`). Test (b) verifies drafts dir empty on deny, exactly 1 file on approve.
- *Evidence-only cannot draft:* `executeEvidenceOnly` invokes only the 4 read tools by keyword routing (`:372-376`); consequential tools unreachable there.
- *Resume-after-restart:* **no resume path exists** — runs are in-memory (`runs` Map `:143`); after restart `getRun` → undefined → router 404. JSONL persists as audit; `getTranscript` can re-read a file (`:191-197`) but no route rehydrates a run, and `resolveApproval` on a missing run throws `RING_RUN_NOT_FOUND` (`:225`). Safe by absence: a pending approval across restart can never auto-approve; the write never happens. (Product note: such a run is lost, not resumed — document it.)
- *Double-resolve:* first resolve clears `run.pending` before invoking the resolver (`:228-237`); second throws `APPROVAL_NOT_PENDING` (400), cannot re-run the tool; single promise resolution continues the loop once. `wx` flag makes even a hypothetical duplicate write fail loudly (`:561`).
- *Cancel-during-approval:* `cancelRun` captures+clears pending, records `run.cancelled`, aborts, resolves pending as `'cancelled'` (`:240-251`); loop checks immediately after the await and exits via `ensureCancelled` without executing the tool (`:428`). Status is set `cancelled` before resolver invocation, so a racing `resolveApproval` sees `status !== 'awaiting_approval'` and throws. No approve+cancel write window.
- *Residual race (LOW, cosmetic):* `resolveApproval` records `approval.resolved` and resolves **before** flipping status to `running` (`:229-236`); its synchronous POST response may briefly show `awaiting_approval` with no `pendingApproval`. UI ignores decision bodies (C15). Not a gate issue.

**Path confinement (`read_company_document`) — sound.** Lexical `isWithin(evidenceRoot)`, then `realpathSync` on root + candidate with `isStrictlyWithin(realRoot, realCandidate)` re-check (symlink-safe), file check, 256 KB cap (`:505-524` region). Test (f) proves `../maos.config.json` refused (`PATH_OUTSIDE_EVIDENCE_ROOT`). Adjacent: `analyze_telemetry`/`verify_export` require strict `projectRoot` containment; drafts confined to `.maos/ring-runs/drafts/<runId>-<sanitized>.md` via `path.basename` + sanitisation (`:552-561`). Note (LOW/informational): `POST /ring/runs` accepts `evidenceRoot` in the body (`router.ts:1335-1346`) and `resolveEvidenceRoot` honours absolute paths (`:256-259`) — a local API caller could aim reads outside the project; loopback/local-trust API, CSV raw still withheld. Not a blocker.

**Max-turns — enforced.** `for (turn=1; turn<=maxTurns; turn++)` (`:397`), default 12 (`:106`), constructor-validated (`:152`); exhaustion throws `RING_AGENT_MAX_TURNS` → `failed` (`:438`). Cancel re-checked after every await (provider `:398,404,406`; each tool `:436`). Caveat: bounds turns, not wall-clock; single provider call has no service-side timeout beyond cancel-abort. Informational.

---

## 4. MINIMAL ADAPTER / CHANGE SET

**Zero changes needed: NO — explicitly.** C1 alone breaks every real run end-to-end.

Recommended shape: **server-side adapter at the snapshot boundary** (one mapper in `ring-agent-service.ts`), JSONL transcript stays the untouched system of record, UI validator stays fail-closed. A1–A4 required; A5–A7 recommended. Total ≈ **S** (half a day incl. tests).

| ID | Change | File / lines | Size | Fixes |
|---|---|---|---|---|
| A1 | `snapshot()` emits `events` = mapped transcript (keep `transcript` for compat): per-entry rename `transcript→events`; eliminate the `mode.evidence-only` event (fold mode into `run.started`, which already carries it) — or UI adds the type + renders null. Prefer server (a). | `ring-agent-service.ts:253-254` (new mapper), `:361` | XS | C1, C2 |
| A2 | Mapper renames: `toolName→tool`; `contentSummary→text` (only when non-empty); `summary→resultSummary` + structured `verdict`/`overallRms`(from `overallVibrationRms`)/`sources`([source]) projected from the result object (carry it on the entry internally rather than re-parsing the JSON string); `error→message` on `run.failed`; `summary→action` on `approval.pending`; pass `toolCallId` through (see A5). | mapper; emit sites `:340,405,449,466` | S | C7, C8(part), C10, C11, C16 |
| A3 | Wire `argsSummary` must be a **string**: render `summarizeArgs()` as compact `k=v` text in wire events (object stays in JSONL). | mapper | XS | C9 |
| A4 | Approval pending: A2's `summary→action` makes the UI's existing event-scan sufficient; snapshot `pendingApproval` remains as harmless extra (UI may adopt it later as authoritative). No UI change required. | server-only (A2) | XS | C11 |
| A5 | Pair by `toolCallId` (service already emits it on call+result) instead of tool name: add `toolCallId?: string` to `RingRunEvent` + validator pass-through + pairing change. Prevents wrong-chip results with repeated/interleaved tools. | `ring-run-types.ts:33-60,110-148`; `RingWorkspace.tsx:800-814` | XS | C8 |
| A6 | `agentId`: pick one, document it. Minimal honest: router explicitly accepts-and-ignores **or** UI drops `agentId` + per-agent presence claims. Real per-agent execution is out of scope pre-deadline (M+). | `router.ts:1323` or `RingWorkspace.tsx:696-699,720-722` | XS | C12 |
| A7 | Optimistic honesty: don't hardcode `mode:'hosted'` pre-poll; hold `null` until first GET. | `RingWorkspace.tsx:727` | XS | §2 nit |

With A1–A4 (+A6 choice) the demo path works end-to-end: start → poll renders tool chips with verdict/RMS → approval card shows action+reason → Allow writes draft / Deny writes nothing → final answer; evidence-only renders banners, chips, final answer, zero model turns. **Do not** fix by loosening the UI validator — its fail-closed posture caught this; adapt the wire.

---

## 5. Mismatch count

- Fatal (validator throws): **3** — C1, C2, C9.
- Semantic-render (empty/wrong render, no throw): **4** — C7, C8, C10, C16.
- Silent-ignore: **1** — C12. Adapter-needed: **1** — C11.
- **Total: 9.** Matches: status, mode, finalAnswer, servedModelId-absent, start `{runId}`, cancel, approval decision, `{data}` envelope.
- Latent nits (non-blocking): optimistic `hosted` (A7); `resolveApproval` snapshot ordering (§3); `evidenceRoot` via body (LOW); O(n²) poll payload (C17).

---

## 6. Validation actually run (scratch C:\clean\ring-integration-review, both patches applied; disposable, nothing committed/pushed)

| Command | Exit | Result |
|---|---|---|
| `git apply --check` + apply, service then UI | 0 | Both clean; no overlapping files |
| `npm ci --no-audit --no-fund` | 0 | 242 packages |
| `vitest run tests/industrial/ring-agent.test.ts tests/gui/ring-workspace.test.ts tests/gui/ring-impl-01.test.ts` | 0 | **28 passed (7+9+12)** — suites green against own mocks: isolation-passing, integration-failing |
| `npm run build:backend` | 0 | clean |
| Node probe: UI `validateRingRunState` vs faithful service snapshot | — | **Throws `RING_RUN_INVALID: events must be an array.`**; `mode.evidence-only` → unknown type; object `argsSummary` → must be a string (C1/C2/C9) |

PM's `git apply --check = 0` against `C:\maos` is consistent with the scratch result (not re-run against `C:\maos` itself). Candidate run-logs report 46 (service packet) and 24/24 (UI packet); this review re-ran the 28 covering the two new surfaces.

## NOT verified

- Live Baseten network behaviour; real long-run polling cadence; Electron/browser rendering (happy-dom + source only).
- OCC/docx generation (service deliberately writes approved markdown drafts instead — its own flagged scope call).
- Post-restart JSONL audit completeness beyond code inspection of record().
- Full tests/gui regression comparison (documented in UI run-log; not re-run).
- Legacy /api/v1/ring/ask interplay (untouched by both patches; ringAsk retained UI-side).

## Handoff

TASK RING-INTEGRATION-REVIEW-01 - STATUS: complete (read-only; scratch C:\clean\ring-integration-review disposable) - Verdict: BLOCK - integrate only with adapter A1-A4 (A5-A7 recommended) - Mismatch count: 9 (3 fatal / 4 semantic / 1 silent-ignore / 1 adapter-needed) - REVIEW.md: this file (SHA-256 recorded by PM on receipt) - NOT verified: items above.
