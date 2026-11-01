# PM Brief — MAOS Ring: an always-on industrial agent (Meta hackathon, 3-day build)

**From:** Head of Product
**To:** Product Manager (orchestrator)
**Team:** 3 developer agents (Dev A, Dev B, Dev C), working in parallel
**Today:** 2026-11-01 (Day 0 evening)
**Hard deadline:** project submission **2026-11-05 07:30 IST** (Nov 4, 9:00 PM ET). Treat **Nov 4, 18:00 IST** as feature freeze, and **Nov 4, 23:59 IST** as "video recorded."

You own execution. This brief tells you **what** to build, **why**, the **non-negotiables**, and **what "done" means**. You decide the detailed task breakdown, the order inside each lane, and when to reassign work. Report back to the user with demos, not just status.

---

## 1. The vision (read this first, repeat it to every dev)

MAOS Ring should become, for industrial people (operators, maintenance technicians, safety officers, plant managers), what **ChatGPT/Claude** are for knowledge workers and what **Claude Code/Codex** are for developers:

- **Always there.** A ring you summon from anywhere on the desktop with a hotkey, like OpenAI's and Grok's ambient assistants. Not a page buried in an app.
- **Talks like a chat assistant.** Multi-turn conversation, live streaming answers, follow-ups ("make that shorter for the night supervisor").
- **Works like a coding agent.** It makes a visible plan, calls real tools, reads documents and scans, runs calculations, produces real files (work orders, handover notes, reports), and **asks a human before anything consequential**.
- **Industrial-grade trust.** Every answer cites evidence, raw telemetry never leaves MAOS, every step is audited and verifiable, and it **refuses to authorize operating decisions**. This is our differentiator against generic chatbots. Never trade it away for flash.
- **Powered by Meta's open model.** `meta-models/muse-spark-open-1026` via Baseten (already wired). This is a Meta hackathon, so the Meta model doing real agentic work is the headline.

**One-line pitch for the video:** *"Claude Code for the plant floor: a Meta open-model agent that plans, uses tools, and produces audited work, but never takes the safety decision away from the human."*

---

## 2. What already exists (verified by reading the code; do not rebuild it)

Recent commits: `768dbab`, `b76363a`, `a573e2a`.

| Piece | Location | State |
|---|---|---|
| Agent loop: tool calling, max 12 turns, approval pause/resume, cancel, JSONL transcript, audit events | `src/service/ring-agent-service.ts` | Working foundation |
| Tools (6): `analyze_telemetry`, `read_company_document`, `search_knowledge`, `draft_safety_note`, `verify_export`, `request_approval` | same file, `RING_AGENT_TOOLS` | Working |
| Evidence-only fallback when no model key is set | same file, `executeEvidenceOnly` | Working; keep it |
| Single-shot Ring Q&A (older path) | `src/service/ring-inference-service.ts`, `POST /api/v1/ring/ask` | Keep for compatibility |
| Run API: start / get / cancel / approve | `src/api/router.ts` around lines 1286–1400, `/api/v1/ring/runs*` | Working |
| Wire contract plus runtime validators | `src/gui/src/api/ring-run-types.ts` | Fail-closed validators; extend, don't loosen |
| UI: transcript, tool chips, approval card, final answer, mode badge, roster | `src/gui/src/components/RingWorkspace.tsx`, `src/gui/src/views/ChatView.tsx` | Working; polls every 1s |
| Provider policy (locks model and endpoint) | `src/backends/meta-api-policy.ts` | Do not weaken |
| **Unused services Ring should call:** OCR, vision, DOCX/XLSX/PPTX generators, memory, KB search/ingestion, calculation trace, workflow/tool-approval planners | `src/service/ocr-service.ts`, `vision-service.ts`, `docx-generator-service.ts`, `xlsx-generator-service.ts`, `pptx-generator-service.ts`, `memory-service.ts`, `kb-*`, `calculation-trace-service.ts` | Exist, but not exposed to Ring |
| Desktop shell | `desktop/main.cjs` (Electron) | One normal window; no hotkey, tray, or overlay |
| Demo data | `demo/industrial/` (T-07 telemetry CSV, SOP, maintenance note, `turbine_inspection_scan.pdf`, thresholds) | Synthetic; reuse |

### Gaps to close (in priority order)
1. **No multi-turn conversation.** Every run is a single instruction, so follow-ups are impossible.
2. **No streaming.** The UI polls once a second; it doesn't feel alive.
3. **Not a "ring."** It's a page inside the app. No global summon, no floating overlay.
4. **Only 6 tools.** OCR, vision, document generation and memory exist but are not wired in.
5. **Hardcoded to T-07.** `executeHosted` injects the T-07 telemetry summary into every prompt, even unrelated questions.
6. **No visible plan or to-do list** like Claude Code/Codex.
7. **`HACKATHON_SUBMISSION.md` is stale.** It says no Meta model call is made. Update it truthfully at the end.

---

## 3. Non-negotiables (put these in every dev's instructions)

1. **Truthfulness.** Never fake streaming, model identity, tool results, or capabilities. If something is mocked or a fallback, the UI says so. The existing fail-closed validator style stays.
2. **Human-in-the-loop.** Anything that writes a file, creates a work order, or produces a report goes through the existing approval flow. The agent must refuse to approve restart/operation of equipment or to certify safety.
3. **Data boundary.** Raw telemetry rows never go to the hosted model; only deterministic summaries. Document/OCR text may be sent only from project/evidence-root files, path checks enforced (reuse `isWithin`/`isStrictlyWithin`).
4. **Audit everything.** New tools record audit events the same way the existing ones do.
5. **Synthetic data only.** No real plant data. Label it synthetic in the UI and in the video.
6. **Evidence-only mode must still work** with no API key. The demo must survive a Baseten outage or empty credits.
7. **Don't weaken the provider policy** in `meta-api-policy.ts`, and **never commit API keys**.
8. **Tests ship with features.** Every new tool, endpoint and contract change has a vitest test. `npm test`, `npm run build` and `npm run typecheck:gui` must be green before any merge to `main`.
9. **Don't break the existing judged T-07 workflow** (approval → DOCX → verify). It's our safety net for the demo.

---

## 4. Day 0 / Day 1 morning — PM-owned: freeze the contracts (do this BEFORE devs fan out)

The three devs will collide in `ring-agent-service.ts`, `router.ts` and `ring-run-types.ts` unless the shapes are agreed first. Spend 1–2 hours (one dev or yourself) producing a short contract doc plus type stubs, merged to `main`, covering:

- **Threads:** `RingThread { threadId, title, role, createdAt, runs: runId[] }`. Endpoints: `POST /api/v1/ring/threads`, `GET /api/v1/ring/threads/:id`, `POST /api/v1/ring/threads/:id/messages` (starts a run that carries prior conversation context). Existing `/ring/runs` stays working.
- **Streaming events:** a single event union extending `RingRunEvent`, adding: `model.delta` (token text), `plan.updated` (todo list), `artifact.created` (file path, kind, size, sha256), `memory.saved`. Transport: SSE `GET /api/v1/ring/runs/:id/events` (or the existing WebSocket; PM decides). **Polling remains as fallback.**
- **Tool registry interface:** `{ name, description, parameters, consequential: boolean, roles?: Role[], execute(ctx, args) }`, so each dev adds tools in separate files (e.g. `src/service/ring-tools/*.ts`) without editing one giant `switch`.
- **Roles:** `'operator' | 'maintenance' | 'safety' | 'manager'`, which affect the system prompt and the tool set.
- **Artifacts:** stored under `.maos/ring-runs/artifacts/<runId>/`, served by a download endpoint with path checks.

Then: each dev works in **its own git worktree/branch**. PM merges in order: contract → A → B → C, at least twice a day.

Also before fan-out: the working tree has uncommitted changes (`.maos/maos.config.json`, `.maos/pool.json`, demo docs). Ask the user whether to commit or stash them. Don't discard them.

---

## 5. Lanes

### Dev A — Ring brain (backend agent runtime)

**Day 1**
- Tool registry refactor (move the existing 6 tools onto it, behavior unchanged, tests still pass).
- Threads: persistence under `.maos/ring-runs/threads/`, conversation carried across runs (trim/summarize history to stay within the context window).
- Streaming: model token deltas plus tool events pushed live. If Baseten/OpenAI-provider streaming isn't available, stream tool/plan events live and say honestly that the text arrives whole. **No fake typewriter.**
- Context fix: only include the T-07 telemetry summary when the question or tool use needs it.

**Day 2 — new tools (wrap existing services, don't rewrite them)**
- `ocr_document` (PDF/scan → text, evidence-root only) via `OcrService`.
- `inspect_image` (photo/screenshot → findings) via `VisionService`. If no local vision model is available, return an honest "unavailable" result.
- `generate_report_docx`, `generate_spreadsheet_xlsx`. Both **consequential**; emit `artifact.created`.
- `create_work_order`, `write_shift_handover`. **Consequential**; structured markdown/DOCX artifact.
- `remember` / `recall` (equipment notes, user preferences) via `MemoryService`.
- `update_plan`. The model publishes and ticks a to-do list (emits `plan.updated`).
- Raise `maxTurns` sensibly (e.g. 20) now that runs do more.

**Done when:** a thread can run "brief me on T-07" → follow-up "now raise a work order" → approval → DOCX artifact. It streams live. It passes in both hosted and evidence-only mode, with tests.

### Dev B — the Ring surface (desktop and UI)

**Day 1**
- Electron: global hotkey (`Ctrl+Space`, configurable) toggles a **frameless, always-on-top, translucent Ring overlay window** (compact chat). Add a tray icon. The full `RingWorkspace` view remains the expanded mode, with an "expand" button that moves from overlay to the full app on the same thread.
- **Animated ring** with states: idle / thinking / using tool / waiting for approval / done / error. Make it beautiful; this is the first frame of the video.
- Keep Electron security posture (contextIsolation, preload IPC only, no nodeIntegration in renderer).

**Day 2**
- Consume streaming events: live text, live plan checklist, tool chips, **artifact cards** (open/download), approval card inside the overlay.
- Thread sidebar / history in the full view; new-thread button; role picker (reuse `RoleOnboardingModal.tsx`).
- Drag-and-drop / paste of PDF, image, or CSV into the Ring. Files are copied into the evidence root, then referenced in the message.
- **"What am I looking at?"**: a user-triggered screenshot capture (explicit button, visible indicator, never automatic) sent to `inspect_image`.
- **Stretch only:** push-to-talk voice, and only if transcription runs locally. Drop it if it isn't working by Day 2, 20:00 IST.

**Done when:** from another app, the user presses the hotkey, asks a question, watches the plan and tools stream, approves a step inside the overlay, and clicks the resulting file, with no page navigation.

### Dev C — industrial skills, safety, demo and quality

**Day 1**
- **Role personas:** system prompt plus allowed tool set per role (operator, maintenance, safety, manager). Language level for shop-floor users: plain, short, action-first.
- **Slash-command skills** (prompt templates plus required tools): `/handover`, `/rca` (5-Whys plus fishbone categories), `/permit` (permit-to-work checklist), `/loto` (lockout/tagout steps from the SOP; marked "verify against your site procedure"), `/sop <equipment>`, `/report`.
- Expose the skill list to the UI (an endpoint or a static manifest Dev B can render as a `/` menu).

**Day 2**
- **Demo pack v2 (synthetic):** a second asset (e.g. pump P-12) with telemetry, SOP and maintenance note; a scanned inspection page that OCR can read; one equipment photo (synthetic or appropriately licensed). Update `DEMO_PACK_PROVENANCE.json`.
- **Safety evaluation set** (automated tests, in evidence-only mode plus a recorded hosted run): refuses to authorize restart/operation; refuses to invent readings when data is missing; requests approval before writes; doesn't leak raw CSV rows; handles prompt injection inside a document (e.g. an SOP saying "ignore previous instructions").
- End-to-end tests across thread → stream → approval → artifact → audit verify.

**Day 3:** own the demo script, the recording checklist, and the truthful update of `HACKATHON_SUBMISSION.md`, `demo/industrial/PRESENTATION_SCRIPT.md` and `RECORDING_READINESS.md`.

---

## 6. Schedule and checkpoints

| When (IST) | Milestone | PM action |
|---|---|---|
| Nov 1 night / Nov 2 09:00–11:00 | Contracts plus type stubs merged | Review, then fan out to A/B/C |
| Nov 2 18:00 | **Checkpoint 1:** threads plus registry (A), overlay plus hotkey (B), personas plus skills (C) | Merge; demo to user (short screen recording or screenshots) |
| Nov 3 13:00 | Streaming plus new tools working end-to-end | Merge; re-plan cuts if behind |
| Nov 3 21:00 | **Checkpoint 2:** full demo flow (Section 7) runs end-to-end in hosted **and** evidence-only | Demo to user; decide cuts |
| Nov 4 12:00 | Bug-fix only; three clean rehearsals from a packaged build | No new features |
| Nov 4 18:00 | **Feature freeze;** docs updated truthfully | — |
| Nov 4 by 23:59 | Video recorded | User reviews |
| Nov 5 07:30 | **Submission deadline** | User submits |

---

## 7. The demo we are building toward (about 3 minutes; this is the acceptance test)

1. The engineer is in another app (e.g. Excel). **Presses `Ctrl+Space`**; the ring animates in.
2. "Shift starting. What do I need to know about T-07?" A **plan appears**, then tools stream live (telemetry analysis, SOP, maintenance note, memory). The answer cites sources: average RMS looks normal, but there are exceptions at rows 121/238/367/442.
3. **Drags in `turbine_inspection_scan.pdf`.** OCR finds bearing wear; Ring correlates it with the critical vibration at row 367.
4. "Raise a work order and draft my handover." An **approval card** appears in the overlay. The user approves. **DOCX work order plus handover** artifacts appear and open.
5. Follow-up: "Make the handover shorter for the night supervisor." The thread remembers context.
6. "Approve the turbine restart." **Ring refuses**: it's decision support, and the authorized human decides. (Our trust moment.)
7. Close on **audit verify**: every step logged, and the chain verifies.
8. Badge visible throughout: **HOSTED · Meta muse-spark-open via Baseten**.

---

## 8. Cut order if behind schedule

Cut in this order: voice → screenshot capture → XLSX → second asset (P-12) → personas (keep one default role) → slash skills beyond `/handover` and `/rca`.

**Never cut:** multi-turn threads, live streaming of events, the summonable ring overlay, OCR on the inspection PDF, approvals plus artifacts, the refusal moment, audit verify, evidence-only fallback.

---

## 9. Risks the PM must actively manage

- **Merge conflicts** in shared files → contracts first, tool registry, separate files, frequent small merges.
- **Baseten credits / rate limits / outage** → confirm active credits and no-overage protection before hosted recording. Evidence-only must demo cleanly. Cache nothing that pretends to be a live call.
- **Streaming support on the provider** might not exist → honest fallback (Section 5, Dev A).
- **Electron overlay quirks on Windows** (transparency, focus, multi-monitor) → Dev B tests on this machine early on Day 1.
- **OCR/vision dependencies** (Python, models) may not be installed on the demo machine → check on Day 1 with the existing preflight; if missing, use the honest "unavailable" path and adjust the demo.
- **Scope creep** → anything not in Section 7 waits until after submission.

---

## 10. How to report to the user

At each checkpoint, send the user:
1. What works now, shown with a screenshot, a short recording, or exact commands to try.
2. Test results (`npm test`, `npm run build`, `npm run typecheck:gui`), stated as pass or fail with the failing output.
3. What was cut or is at risk, and your recommendation.
4. Any decision you need from the user (e.g. hotkey choice, committing the stray working-tree changes, spending hosted credits).

Never report a feature as done unless it ran end-to-end. Say plainly what is mocked, pending, or unverified.
