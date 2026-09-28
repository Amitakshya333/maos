# MAOS Industrial — SIH26117 Implementation Plan

> **Status:** Approved architecture plan; implementation not approved until Gate G0 is signed off  
> **Last audited:** 2026-09-10  
> **Project root:** `C:\maos`  
> **Primary target:** Windows 11 x64, one mid-range NVIDIA GPU, fully disconnected operation  
> **Technology spine:** TypeScript orchestration + Rust deterministic safety/evidence engine + Python OCR/ML + container sandbox  
> **Plan owner:** Lead/Coordinator  
> **Implementing model:** Claude Opus 4.6 Thinking or delegated agents following the execution contract below

---

## 0. Verdict on the previous plan

**Do not implement the previous plan as written.** Its product direction was broadly aligned with SIH26117, but its sequencing, completion status, architecture, estimates, and security claims were not reliable enough for implementation.

The previous plan incorrectly or unsafely assumed that:

- a Rust workspace and private submodule layout already existed; `rust/` currently contains only the untracked user file `rust/test.txt`;
- the router infers vision/code intent from task text; it currently uses exact capability-string overlap;
- `allowedTools` and industrial `systemPrompt` are enforced; they are declared in config but not propagated to `ApiRuntime`, and every API agent receives all tools;
- `execute_python` is a security sandbox; it is only a temporary working directory with a timeout and retains host filesystem, environment, process, and network access;
- the provider message contract supports images; `ChatMessage.content` is text-only;
- the dashboard proves zero egress; it currently requests Google Fonts and displays unmeasured claims such as `Cloud Data Leak: 0 Bytes`;
- the industrial runbook and preflight are executable; the server command omits required arguments and preflight requires a missing `manifest.json`;
- a four-stage workflow exists; the dashboard currently enqueues one task assigned directly to `INGEST_AGENT`;
- the existing threshold tool returns its promised rule identifier and configured recommendations; it does neither correctly for the current threshold-file shape;
- four role -specific screens or a dashboard calling CLI commands would be an acceptable GUI architecture;
- all planned Rust, GUI, OCR, vision, document generation, RAG, network monitoring, and sandbox work could be completed credibly in 9–10 days.

This replacement plan uses the existing single repository, fixes trust boundaries first, establishes Rust as the mandatory judged authority for deterministic safety/evidence operations, exposes one typed application-service boundary to both CLI and GUI, delivers one verified end-to-end slice, and expands only after each gate passes.

---

## 1. Source requirement and product objective

### 1.1 SIH26117 source requirement

The source snapshot identifies the problem as:

> **Sovereign On-Premise Agentic AI Workbench using Open-Weight Multimodal LLMs for Confidential Industrial Work** — Mangalore Refinery and Petrochemicals Limited (MRPL).

The implementation must demonstrate all of the following:

1. self-hosted, air-gapped operation on an organization-controlled workstation/server;
2. multiple open-weight models, with automatic model selection for at least two task types;
3. extensibility so a new local model can be added without redesigning the system;
4. multi-step agent behavior with local file tools and iteration;
5. code execution and verification in a genuine sandbox;
6. spreadsheet work and real deliverables, including Word, PowerPoint, and Excel;
7. internal document search through a local knowledge-base connector;
8. on-device handling of scanned PDFs and images through OCR and a vision model;
9. an end-to-end example such as scanned inspection report → findings → Word approval note;
10. a coding task run and verified in the sandbox;
11. visible logs or network monitoring showing that no external calls occurred during the run.

**G0 must compare this plan with the current official SIH portal wording before implementation.** The repository snapshot used for this audit is a secondary copy dated 2026-08-22, not the authoritative portal.

### 1.2 Product objective

Build **MAOS Industrial** as an optional solution pack on MAOS Core with one adaptive, VS Code-like local workspace shell. The shell contains chat, task feed, agent cockpit, evidence workbench, sandbox results, knowledge search, document generator, audit trail, model switcher, sovereign panel, settings, and project launcher. Developer, Inspector/Analyst, Architect, and Manager/Reviewer presets change only the pinned layout; every preset uses the same MAOS Core/Industrial engine.

A user must be able to place confidential industrial evidence into an ordinary project marked by `.maos/`, ask or promote work through chat, observe a typed agent DAG, review evidence and approvals, and receive traceable editable artifacts. All model inference, OCR, retrieval, Rust safety evaluation, calculations, code execution, and document generation remain local. The React GUI is a presentation client, not a second engine: GUI and CLI both call the same typed application service, and the GUI never shells out to the CLI.

### 1.3 Required final demonstration

The frozen final demo will execute these scenarios from fresh output directories through both typed clients where applicable:

| Demo | Input | Automatic route | Required output | Judge-visible proof |
|---|---|---|---|---|
| D1 Model selection | text summary, coding request, scanned/image request | text model, coder model, vision path | route records | eligibility, score, selected actual model ID/revision, endpoint |
| D2 Agentic document task | printed scanned inspection PDF + local SOP | OCR/vision → retrieval → Rust analysis → approval | `.docx` approval note | original page, confidence, thresholds, page/chunk citations, source hashes |
| D3 Coding sandbox | CSV + RMS calculation request | coder model → sandbox | script, stdout, test result | network denial and filesystem denial tests |
| D4 Multimodal | public sample P&ID/nameplate/photo | vision path | structured extraction/report | image hash, model ID, confidence/limitations |
| D5 Office artifacts | approved structured report data | artifact tools | `.docx`, `.xlsx`, `.pptx` | files reopen and contain required data |
| D6 Sovereign evidence | full D1–D5 rehearsal | all local components | audit bundle | firewall state, endpoint identity, process/model leases, observed connections |
| D7 GUI judged journey | scanned inspection report + local model | project launcher → chat/task → cockpit → evidence approval → document download | cited DOCX and complete run view | within 15 minutes, a new user sees active model identity, complete audit trail, and no observed non-loopback application traffic within the defined monitored boundary |

**Primary GUI acceptance:** A new user opens MAOS Industrial GUI and, within 15 minutes, can submit a scanned inspection report, watch agents analyze it through the DAG, review OCR findings with confidence scores, approve the safety verdict, and download a DOCX approval note with citations using a local model while seeing the complete audit trail, active model identity, and sovereign evidence that no non-loopback application traffic was observed within the defined monitored boundary.

---

## 2. Scope, claims, and non-goals

### 2.1 MVP support boundary

The judged MVP supports:

- Windows 11 x64 and one explicitly recorded NVIDIA GPU/driver/CUDA combination;
- English printed scanned PDFs up to frozen page/size/pixel limits and PNG/JPEG for one bounded extraction scenario;
- one local text model, one local coder model, and one local vision model or vision service;
- one shared GPU Model Manager and one VRAM pool; project services never load model weights directly;
- one read-only local knowledge corpus;
- DOCX approval-note output first, then XLSX and PPTX;
- generated Python code executed in an offline Linux container;
- bounded streaming sensor CSV parsing, decimal/unit-safe threshold/policy evaluation, canonical SHA-256 hashing, and hash-linked chain verification in the mandatory Rust engine;
- a local React SPA served with no remote assets, typed OpenAPI REST, typed JSON-Schema WebSocket events, and REST event history/replay;
- one local operator without accounts, RBAC, or multi-tenancy; launcher-issued bootstrap/session credentials still protect local REST and WebSocket access;
- one project open in the judged GUI, while launcher/service/API design is ready for v1.1 parallel project windows;
- existing folders as projects, `.maos/` as marker/settings/data root, and no proprietary workspace file format.

### 2.2 Mandatory claim language

Use these phrases in GUI, CLI, docs, and presentation:

- **Allowed:** “All configured model and tool endpoints are loopback-only.”
- **Allowed after G9:** “No non-loopback application traffic was observed during this recorded run while outbound policy was active, within the documented monitored boundary.”
- **Allowed:** “Hash-linked, tamper-evident evidence records.”
- **Allowed:** “Deterministic evaluation against demonstration rules.”
- **Allowed:** “Container-isolated code execution with no container network.”
- **Allowed:** “Rust improves memory safety and performance potential for the bounded engine; this does not constitute safety certification.”
- **Forbidden:** “Tamper-proof.”
- **Forbidden:** “Certified compliance” or an ISO claim unless licensed source rules, asset class, edition, mapping, and review are implemented.
- **Forbidden:** “Zero data leak,” “zero data left,” or equivalent based only on configuration or bounded observation.
- **Forbidden:** “Hardened production sandbox” for a demo container.
- **Forbidden:** “Handwriting supported” unless a fixed handwriting benchmark passes.
- **Forbidden:** “Engineering drawing understanding” based only on OCR; the vision-model path must be shown.
- **Forbidden:** “Production-ready” without a production readiness review.

### 2.3 Explicit non-goals for the judged MVP

- safety certification or replacement of a qualified engineer;
- arbitrary hostile-code execution on the host;
- SCADA/PLC connectivity;
- enterprise RBAC, SSO, accounts, multi-tenancy, HA, centralized SIEM, or collaboration;
- training or fine-tuning models;
- broad handwriting support, unlimited document types, or unlimited corpus size;
- cryptographic non-repudiation with enterprise key custody;
- Monaco/code editor, full IDE, branch/worktree UI, sandbox terminal, visual DAG editing, drag/drop, custom role presets, direct Office editing, cross-project search, voice, plugins, or Tauri;
- opening multiple projects in the judged GUI. The runtime/API architecture must support isolated project services now; v1.1 enables parallel windows without changing APIs.

Rust is on the critical path. Only a future daemon or N-API transport optimization is deferred, and only if measured subprocess benchmarks justify it.

---

## 3. Audited current state

| Area | Current state | Decision |
|---|---|---|
| MAOS Core | TypeScript CLI/orchestrator, file queue, retry/dependency support, exact-capability router, API/CLI runtimes | Reuse; extract typed application services; do not fork |
| Industrial profile | Four role configs under `profiles/industrial`, all using the same text model | Keep as engine inputs; GUI role presets affect layout only |
| Industrial tools | Text/CSV/JSON/text-PDF ingest, temporary Python execution, TypeScript threshold check | Fix authorization/contracts; replace judged deterministic path with Rust; retain TS evaluator only as parity oracle |
| Local model runtime | Cache-only Qwen2.5-3B text server with pinned snapshot and loopback endpoint | Repair packaging; place weight ownership behind shared GPU Model Manager |
| Dashboard | Loopback UI with turbine-specific static sections and upload endpoint | Treat as migration source only; build React workspace over typed service; remove remote assets/false claims |
| Demo evidence | Valid 500-row turbine CSV, expected anomalies, thresholds, maintenance text, pre-generated Markdown report | Reuse for deterministic tests; add genuine scanned/image fixtures |
| Workflow | One dashboard task assigned to INGEST; no four-stage DAG | Build explicit dependency DAG using existing queue/dependency gate |
| Multimodal | None; shared provider contract is text-only | Add local `analyze_image(path)` tool; avoid global provider-contract migration for MVP |
| Knowledge base | No embeddings/vector index | Build bounded local connector with citations |
| Office output | Markdown only | Add DOCX, XLSX, PPTX artifact tools and mandatory approval boundary |
| Sandbox | Host Python subprocess | Replace judged path with preloaded `--network none` container |
| Sovereign evidence | Offline flags/config display only; dashboard loads Google Fonts | Add prevention, measured evidence, and sovereign GUI panel |
| GUI/service | No React SPA, launcher, authenticated project service, OpenAPI, WS replay, or shared app-service boundary | Build the locked project-scoped architecture; CLI remains a first-class client |
| Rust | No workspace; only untracked `rust/test.txt` | Preserve `rust/test.txt`; create mandatory safe Rust workspace beside it after G1 |

Known baseline validation as of 2026-09-10:

- `npm run build` passed.
- `npm test` passed: 10 files, 63 tests.
- `node scripts/verify-industrial-tools.js` passed its current demo-grade checks.
- `scripts/industrial-preflight.ps1` fails because `manifest.json` is missing.
- The documented model-server command fails because required arguments are omitted.

These baseline passes do **not** validate the planned Rust engine, GUI/service authentication, multimodal, authorization, sandbox, RAG, DOCX, packaging, or sovereign behavior.

---

## 4. Target architecture

```text
Project launcher
  |-- validates ordinary folder + .maos marker/settings
  |-- recent-project registry (global; unavailable/relocate state retained)
  |-- starts/reattaches integrity-verified project service on 127.0.0.1:<ephemeral>
  `-- issues single-use bootstrap token -> per-window session

React SPA (one project in judged MVP)             MAOS CLI
             |                                        |
             `----------- typed clients --------------'
                              |
          OpenAPI REST + JSON-Schema WebSocket events
        (Origin validation, sequence, replay, no anonymous API/WS)
                              |
             Project-scoped application service
             canonical project root + project ID
                              |
     Typed application service layer (only application boundary)
      |-- task/DAG + approvals + conversation/task promotion
      |-- per-agent tool authorization + project path guard
      |-- evidence/artifact/audit contracts + atomic writes
      |-- event history/reconnect/replay
      |-- endpoint/process/model lease identity
      |
      |-- Rust release executable (absolute verified path)
      |     bounded JSON stdin/stdout protocol
      |     CSV + decimal/units + policy + canonical hashes/chain
      |-- Python OCR/embedding service on approved loopback endpoint
      |-- Container runner: no network, bounded mounts/resources
      |-- DOCX/XLSX/PPTX generators: local TypeScript libraries
      `-- Shared GPU Model Manager
            one VRAM pool; project services request leases, never weights
            priority/fair queue -> text/coder/vision local endpoints

All stage outputs -> versioned typed contracts -> SHA-256 links
Full run -> audit bundle + firewall state + process/network observations
```

The GUI never invokes CLI commands. CLI and GUI are adapters over the same application services and therefore share DAG, tool, provenance, sandbox, approval, interruption, and output semantics.

### 4.1 Runtime and lifecycle model

- The long-term topology is one launcher plus one service per canonical project root. Multiple windows may share a project service. Project identity is derived from canonical root and stored metadata, not display name.
- Each project service binds only `127.0.0.1` on an OS-assigned ephemeral port. Its startup handshake contains protocol version, project ID, canonical-root hash, PID, assigned port, executable hash/identity, and runtime-manifest identity.
- A launcher-issued single-use bootstrap token is exchanged for a per-window session. Tokens are never persisted in localStorage or URL/query logs. REST and WebSocket reject unauthenticated clients and invalid Origin.
- Services survive browser and launcher crash. A hashed runtime manifest permits launcher reattachment; the orphan reaper rejects stale or identity-mismatched records. Clear hijack terminates; ordinary mismatch loses trust and restarts.
- Default process idle grace is 10 minutes; shared GPU model unload is 3 minutes. Both are configurable. Active tasks keep the service alive.
- Stop controls are **Stop after current tasks** and **Force stop**. Force stop requires approval, marks tasks `INTERRUPTED`, atomically cleans temporary artifacts, emits an audit event, and cannot create phantom success. Pause/resume is not in MVP.
- Browser disconnect cancels an in-flight interactive chat request; background workflows continue. After service crash, F3/F7 idempotency enables restart/recovery of safe tasks; unsafe tasks become `INTERRUPTED`.
- Artifact success order is temp write → flush/close → validate → hash → atomic rename → success event. Interruption removes temp data or records actionable cleanup failure.

### 4.2 Shared GPU Model Manager

- Only the shared manager loads model weights. Project services obtain audited leases against one GPU/VRAM pool.
- Inference is serialized by default. Concurrency is enabled only by a frozen hardware manifest proving it safe.
- Queue priority is interactive chat, user-requested task, active workflow stage, automatic workflow stage, then background indexing. Fair aging/reservations must prevent workflow starvation.
- Queued requests are cancellable. Manual reordering is post-MVP.
- Automatic routing is default; manual override is available and audited. Chat model may change between turns; a workflow model is fixed for a run.
- On VRAM pressure, queue first; then offer an explicitly configurable CPU fallback. Never silently switch device/model.

### 4.3 Rust deterministic engine boundary

- `maos-industrial-engine` is the mandatory MVP authority for bounded streaming sensor CSV parsing, decimal/unit-safe threshold and policy evaluation, canonical SHA-256 hashing, and hash-linked tamper-evident chain verification.
- The crate root uses `#![forbid(unsafe_code)]`. This improves memory-safety assurance and performance potential but does not imply certification.
- Initial integration is a versioned JSON subprocess protocol to a hashed Windows release executable, not N-API. Rust reads bounded JSON/stdin and declared bytes; it receives no arbitrary project paths.
- The TypeScript bridge resolves an absolute manifest-approved binary, uses a minimal environment, imposes time/output limits, validates request/response schemas, and verifies executable identity. Missing/tampered binary, malformed output, timeout, or version mismatch fails closed.
- The corrected TypeScript evaluator is a parity oracle only. There is no judged runtime fallback to TypeScript.

### 4.4 Repository layout target

Keep one repository. Do not create a `core/` submodule or another top-level product repository. Do not move existing files merely to match this tree. **Never modify or delete the pre-existing untracked `rust/test.txt`.**

```text
C:\maos
├── src/
│   ├── core/                            existing generic orchestration
│   ├── service/                         typed application services; only app boundary
│   │   ├── contracts/                   generated/aligned API application types
│   │   ├── project-service/             project-scoped REST/WS host and replay
│   │   ├── launcher/                    project registry, spawn/attach, bootstrap
│   │   └── model-manager/               shared GPU leases, priority/fair queue
│   ├── gui/                             React SPA source and local build
│   │   ├── modules/                     chat, tasks, cockpit, evidence, etc.
│   │   ├── layouts/                     four built-in role presets
│   │   └── tests/                       component/accessibility tests
│   ├── integrations/                    generic tool entry/dispatch
│   └── industrial/
│       ├── contracts.ts                 industrial TS contract types
│       ├── rust-engine-bridge.ts        verified bounded subprocess adapter
│       ├── artifact-store.ts            safe atomic outputs + SHA-256 metadata
│       ├── task-requirements.ts         deterministic classification
│       ├── workflow.ts                  industrial DAG builder
│       ├── endpoint-policy.ts           endpoint/process identity policy
│       ├── audit.ts                     structured run/audit events
│       ├── kb/                          local KB client/index logic
│       └── tools/                       OCR, vision, sandbox, office tools
├── api/
│   ├── openapi/                         versioned REST source and generated checks
│   └── events/                          versioned WS/event JSON Schemas
├── rust/
│   ├── Cargo.toml                       workspace
│   ├── Cargo.lock                       committed lockfile
│   ├── crates/maos-industrial-engine/   safe deterministic engine + CLI
│   ├── vendor/                          offline source set/manifest as approved
│   └── test.txt                         existing untracked user file; preserve untouched
├── industrial/
│   ├── schemas/                         cross-language domain/protocol schemas
│   ├── python/maos_industrial_service/  OCR/embedding local service
│   ├── python/tests/
│   ├── python/requirements.in
│   ├── python/requirements.lock
│   ├── container/                       sandbox image and locked manifest
│   └── models/                          manifests only; weights external/bundled
├── profiles/industrial/                 executable industrial profile
├── demo/industrial/                     inputs, KB, truth, templates, generated output
├── scripts/industrial/                  setup/start/preflight/firewall/monitor/demo
├── tests/industrial/                    TS integration/e2e/service tests
├── tests/gui/                           Playwright/e2e/reconnect/security tests
└── artifacts/verification/              gate evidence; no confidential inputs
```

### 4.5 Locked architecture decisions

1. **One adaptive shell:** one VS Code-like workspace, not four applications. Role presets only alter pinned layout; ask role once and allow later change. Custom presets are post-MVP.
2. **Presentation-only GUI:** application services are the only boundary. React and CLI are clients; GUI never shells out to CLI or duplicates workflow/business logic.
3. **Web-first MVP:** local React SPA, OpenAPI REST, JSON-Schema WS events, REST history and sequence replay. Tauri is post-MVP.
4. **Ordinary projects:** `.maos/` is a marker/settings/data location, not a proprietary workspace. Recent-project metadata is global. Missing/moved projects remain listed as unavailable and support explicit relocate.
5. **Architecture-ready isolation:** one service per canonical root and one-project judged UI. v1.1 may open parallel project windows without API changes.
6. **Authenticated loopback:** ephemeral loopback binding does not remove auth requirements. Single-use bootstrap, per-window session, Origin validation, CSP, no third-party assets, and no anonymous REST/WS are mandatory.
7. **Persistent safe lifecycle:** services can outlive UI/launcher; identity-verified reattach, orphan reaping, idle grace, model unload, stop/force-stop, and interruption semantics are mandatory.
8. **Shared model ownership:** project services request leases from a fair priority manager and never load weights. Auto route plus audited override; workflow model fixed per run.
9. **Chat/task distinction:** exploration stays chat until promotion or attachment to trackable work. Conversations and project settings live under `.maos`; recent metadata is global. Retention is configurable and follows redaction policy.
10. **Evidence modes:** brainstorm output is clearly unverified. Industrial/evidence mode marks or blocks uncited claims.
11. **Read-only cockpit:** MVP DAG visualization shows stages, agent, actual model, tool call, input/output artifacts, retries, tokens, latency, approvals, failure, cancel/force stop, live events, and reconnect/replay. Editing is deferred.
12. **Approval boundary:** official DOCX/XLSX/PPTX generation, applying a safety verdict, overwriting artifacts, force stop, and workflow final sign-off require approval. Per-inference and sandbox execution do not. Scoped project writes are auto-allowed; external/system actions require approval.
13. **Code surface:** MVP shows sandbox results, not Monaco. Long-term design allows a temporary task workspace, diff/apply, and sandbox-only terminal; full IDE and branch/worktree UI are post-MVP.
14. **Evidence-first UI:** prioritize original page/image, extracted measurements/confidence, threshold result/citations, structured correction, and conflict review. Open outputs in installed Office/LibreOffice; no embedded Office editing. MVP uses file picker; drag/drop is deferred.
15. **Sovereign visibility:** show local endpoints, model revisions, firewall, allowlist, non-loopback observations, blocked attempts, process tree, audit status, model manager, service/PID/project mapping, descendants, executable hashes, and model leases.
16. **Industrial endpoint enforcement:** non-loopback endpoints are blocked and firewall policy is required. Identity mismatch loses trust/restarts; clear hijack terminates.
17. **Safe recovery:** disconnect, crash, cancellation, force stop, idempotency, and atomic artifact rules are part of application semantics, not UI-only behavior.
18. **Hard eligibility before scoring:** modality/model/tool requirements remove ineligible agents before adaptive scoring. No eligible agent fails closed.
19. **Mandatory Rust authority:** Rust owns judged deterministic safety/evidence operations; TypeScript is parity oracle only. Future daemon/N-API transport requires benchmark evidence and ADR.
20. **Office artifacts in TypeScript:** use mature local libraries (`docx`, `exceljs`, `pptxgenjs`) unless G0 records a contrary packaging benchmark.
21. **Bounded local KB:** use a pinned CPU embedding model and simple local index suitable for the demo corpus; no separate vector database without measured need.
22. **Container sandbox:** judged code runs in a preloaded no-network Linux container. Host subprocess execution remains development-only.
23. **Evidence-first contracts:** every stage records source/artifact hash, stage/tool/model identity, timestamps, citations, sequence, approvals, and warnings.

---

## 5. Checklist and execution rules

### 5.1 Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` implemented **and independently verified**
- `[!]` blocked; append blocker, owner, and next action
- `[D]` deliberately deferred by the lead
- `[R]` rejected after review; append rationale

A checkbox is not evidence. Every `[x]` item must link to a command result under `artifacts/verification/<TASK-ID>.*` or a reviewer-approved CI run.

### 5.2 Atomic task contract

Each task line has four mandatory fields:

- **Scope:** only the behavior and phase paths named by the item; no unrelated cleanup.
- **Accept:** positive completion criteria.
- **Negative:** fail-closed, boundary, interruption, or regression cases that must be tested; “N/A” requires lead approval in evidence.
- **Evidence:** default `artifacts/verification/<TASK-ID>.md` plus machine-readable outputs where useful.

An implementing agent must read the whole plan, assigned files, and Git status; work on one ID unless grouped by the coordinator; preserve unrelated work (especially `rust/test.txt`); add tests with behavior; never weaken controls or add cloud/runtime-download fallback; and never self-approve a security/release gate. Mark `[~]` when starting; only the reviewer marks `[x]`.

Required completion report:

```text
Task ID:
Files changed:
Behavior delivered:
Commands run and exit codes:
Evidence file:
Negative cases tested:
Known limitations:
Checklist status requested:
```

### 5.3 Global commands

Run applicable checks from `C:\maos`; package-specific checks may add stricter commands.

```powershell
npm run build
npm test
npm run format:check
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked
node scripts/verify-industrial-tools.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/industrial/industrial-preflight.ps1
npm pack --dry-run --json
```

After GR, the three locked Cargo checks are mandatory global checks. No phase may claim completion while a regression caused by that phase remains failing.

---

# 6. Build phases

## Phase F0 — Freeze requirements, machine, fixtures, GUI journey, and claims

**Goal:** remove ambiguity before implementation.  
**Allowed writes:** this plan, `docs/`, `demo/industrial/ground-truth/`, `artifacts/verification/F0-*`.  
**Gate:** G0.

- [x] **F0-01 — Verify authoritative SIH wording.** **Scope:** immutable official requirement capture and Section 1 mapping. **Accept:** every requirement maps to a demo/gate; discrepancies update the plan. **Negative:** stale secondary wording cannot be labeled authoritative. **Evidence:** `artifacts/verification/F0-01.md` plus source hash.
- [x] **F0-02 — Freeze target machine/toolchain matrix.** **Scope:** OS, CPU/RAM, GPU/VRAM/driver/CUDA, Node/npm, Rust/rustup target, Python, container runtime, Tesseract, Office/LibreOffice. **Accept:** exact primary and fallback profiles. **Negative:** generic hardware ranges are rejected. **Evidence:** `F0-02.md`.
- [x] **F0-03 — Freeze models and licenses.** **Scope:** text/code/vision/embedding IDs, revisions, quantization, hashes, licenses, context, roles. **Accept:** distribution rights and storage known. **Negative:** mutable/latest revisions and unclear licenses fail. **Evidence:** `F0-03.md`.
- [x] **F0-04 — Freeze model residency/queue strategy.** **Scope:** shared manager cold/warm load, VRAM, default serialization, allowed concurrency manifest, CPU fallback. **Accept:** three cold starts without OOM and recorded latency/VRAM. **Negative:** unmeasured concurrent residency is disabled. **Evidence:** `F0-04.md`.
- [x] **F0-05 — Freeze inputs and ground truth.** **Scope:** extensions, MIME, byte/page/pixel/CSV limits, units, expected scan/image fields. **Accept:** public/licensed non-MRPL fixtures. **Negative:** proprietary, oversized, malformed, and unsupported handwriting fixtures are labeled. **Evidence:** `F0-05.md`.
- [x] **F0-06 — Freeze latency/resource budgets.** **Scope:** launcher, service, model load, Rust, OCR, retrieval, inference, sandbox, artifacts, GUI first-use and total run. **Accept:** budgets reflect measurements. **Negative:** aspirational numbers are not accepted. **Evidence:** `F0-06.md`.
- [x] **F0-07 — Approve claim register.** **Scope:** GUI/CLI/docs/presentation language. **Accept:** every claim has evidence or is removed. **Negative:** zero-leak, certification, tamper-proof, and unsupported-standard text fails. **Evidence:** `F0-07.md`.
- [x] **F0-08 — Freeze GUI journey and accessibility target.** **Scope:** D7 storyboard, four presets, one-project MVP, keyboard/screen-reader baseline, monitored-boundary wording. **Accept:** independent novice can follow prototype script within 15 minutes. **Negative:** four separate apps, CLI shell-out, remote assets, multi-project MVP, or hidden approvals are rejected. **Evidence:** `F0-08.md`.

### Gate G0 — Scope and architecture approval

- [x] Official requirements map one-to-one to demonstrations and gates.
- [x] Target machine, Rust toolchain, dependencies, model strategy, fixtures, budgets, and claims are frozen.
- [x] GUI D7 journey, one-shell decision, one-project MVP, and v1.1 architecture boundary are approved.
- [x] Rust authority and subprocess boundary are approved; `rust/test.txt` preservation is recorded.
- [x] Lead authorizes F1 only.

---

## Phase F1 — Repair trust boundaries and industrial correctness

**Goal:** do not add powerful tools until least privilege, paths, endpoint policy, and truthful presentation are enforced.  
**Primary files:** `src/backends/**`, `src/core/**`, `src/integrations/**`, `src/industrial/**`, relevant tests.  
**Gate:** G1.

- [x] **F1-01 — Propagate agent policy.** **Scope:** pass `systemPrompt`, `allowedTools`, and scope through runtime to `runAgent`. **Accept:** runtime observes exact values. **Negative:** omitted/forged policy cannot broaden industrial access. **Evidence:** `F1-01.md`.
- [x] **F1-02 — Filter advertised tools.** **Scope:** per-agent allowlisted registry view. **Accept:** agents see only configured schemas; generic omitted-list behavior remains compatible. **Negative:** unknown/unauthorized tools are absent. **Evidence:** `F1-02.md`.
- [x] **F1-03 — Enforce tool authorization.** **Scope:** execution boundary. **Accept:** authorization checked before executor. **Negative:** fabricated call for each industrial agent and unknown tool fails. **Evidence:** `F1-03.md`.
- [x] **F1-04 — Centralize safe path resolution.** **Scope:** reads, lists, ingest, evaluator inputs, outputs, command working roots. **Accept:** canonical project containment and scoped writes. **Negative:** traversal, external absolute path, junction/reparse escape, separators, case variants fail. **Evidence:** `F1-04.md`.
- [x] **F1-05 — Remove shell from industrial agents.** **Scope:** profile and runtime. **Accept:** only sandbox tool executes judged code. **Negative:** `run_command`, `git_commit`, and host Python fabricated calls fail. **Evidence:** `F1-05.md`.
- [x] **F1-06 — Correct TypeScript parity oracle.** **Scope:** existing threshold evaluator contract before Rust parity work. **Accept:** rule ID, decimal string/units, threshold, observed value, deviation, status, recommendation. **Negative:** missing/NaN/float ambiguity/unit mismatch fails. **Evidence:** `F1-06.md`.
- [x] **F1-07 — Add industrial endpoint policy.** **Scope:** provider/tool URLs and redirects in `zeroCloud`. **Accept:** explicit IPv4/IPv6 loopback only. **Negative:** public IP, DNS name, rebinding/redirect, malformed/missing declaration, cloud runtime fails closed. **Evidence:** `F1-07.md`.
- [x] **F1-08 — Support keyless local providers safely.** **Scope:** explicit `auth: "none"` for validated loopback only. **Accept:** local runtime constructs. **Negative:** empty-key cloud/non-loopback endpoint fails. **Evidence:** `F1-08.md`.
- [x] **F1-09 — Remove remote presentation assets.** **Scope:** current dashboard/static assets pending React replacement. **Accept:** disconnected render uses local/system assets. **Negative:** generated markup/CSS contains no remote resource URL. **Evidence:** `F1-09.md`.
- [x] **F1-10 — Remove unsupported claims.** **Scope:** current UI/docs runtime labels. **Accept:** measured/config-derived state or `Not measured`. **Negative:** hard-coded ISO, byte leak, sandbox, latency, zero-egress claims fail snapshots. **Evidence:** `F1-10.md`.
- [x] **F1-11 — Add foundation regression suite.** **Scope:** policy, authz, paths, endpoints, parity oracle, generic compatibility. **Accept:** focused suite deterministic. **Negative:** each bypass fixture demonstrably fails. **Evidence:** `F1-11.md`.

### Gate G1 — Foundation security/correctness

- [x] TypeScript build/test/format checks pass.
- [x] Unauthorized tools, out-of-scope paths, and non-loopback endpoints fail before side effects.
- [x] TypeScript parity oracle is decimal/unit explicit and correct on frozen fixtures.
- [x] Presentation has no remote assets or unsupported claims.
- [x] Independent reviewer approves G1 before Rust workspace creation or feature registration.

---

## Phase R1 — Mandatory Rust deterministic safety/evidence engine

**Goal:** establish the fail-closed Rust authority before offline packaging and later feature registration.  
**Primary files:** `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/crates/maos-industrial-engine/**`, `industrial/schemas/rust-engine/**`, `src/industrial/rust-engine-bridge.ts`, tests/manifests.  
**Protected path:** `rust/test.txt` must remain byte-identical and untracked.  
**Dependencies:** G1. **Gate:** GR; GR blocks F2 and all later feature registration.

- [x] **R1-01 — Create workspace and pin toolchain.** **Scope:** Cargo workspace/crate, edition/MSRV/toolchain record, `#![forbid(unsafe_code)]`; do not touch `rust/test.txt`. **Accept:** locked hello/version build. **Negative:** unsafe block/dependency policy violation and changed protected file fail. **Evidence:** `R1-01.md` plus before/after `rust/test.txt` hash.
- [x] **R1-02 — Lock and vendor offline dependencies.** **Scope:** committed `Cargo.lock`, approved source/vendor config and manifest. **Accept:** clean offline locked build. **Negative:** network access, unlocked resolution, missing vendor file, checksum mismatch fails. **Evidence:** `R1-02.md`.
- [x] **R1-03 — Define versioned JSON protocol.** **Scope:** operation envelope, schema version, request ID, bounded input, structured errors for parse/evaluate/hash/verify/version. **Accept:** TS/Rust fixtures validate. **Negative:** unknown version/operation/field overflow/trailing output fails. **Evidence:** `R1-03.md` plus schemas.
- [x] **R1-04 — Implement fixed precision and units.** **Scope:** decimal parsing/rounding and closed unit registry/conversions. **Accept:** no binary-float policy comparison; canonical output. **Negative:** overflow, excessive precision, locale commas, incompatible/unknown units fail. **Evidence:** `R1-04.md`.
- [x] **R1-05 — Implement bounded streaming CSV parser.** **Scope:** stdin/declared byte stream, row/column/field/total/time bounds, typed sensor records. **Accept:** frozen CSV parses without whole-file loading. **Negative:** malformed quoting/UTF-8, bombs, duplicate headers, oversize, non-finite values fail. **Evidence:** `R1-05.md`.
- [x] **R1-06 — Implement threshold engine.** **Scope:** deterministic rule lookup, boundary comparison, deviation, recommendation. **Accept:** exact parity on frozen oracle fixtures and rule IDs. **Negative:** missing rule/value, unit mismatch, overflow, ambiguous boundary fails. **Evidence:** `R1-06.md`.
- [x] **R1-07 — Implement policy evaluation.** **Scope:** versioned policy set, deterministic aggregate verdict and reasons. **Accept:** order-independent canonical result with explicit review state. **Negative:** conflicting/unknown policy, uncited input, unsupported schema fails. **Evidence:** `R1-07.md`.
- [x] **R1-08 — Implement canonical hashes and evidence-chain verification.** **Scope:** canonical JSON rules, SHA-256 source/artifact records, previous-link sequence verifier. **Accept:** cross-language golden hashes match. **Negative:** deletion, reorder, mutation, duplicate sequence, invalid canonical form, hash mismatch fails. **Evidence:** `R1-08.md`.
- [x] **R1-09 — Expose bounded CLI operations.** **Scope:** release binary stdin/stdout commands only; no arbitrary path operands. **Accept:** one JSON response per request with stable exit/error taxonomy. **Negative:** path injection, extra stdout, huge stdin/output, broken pipe fails safely. **Evidence:** `R1-09.md`.
- [x] **R1-10 — Implement verified TypeScript bridge.** **Scope:** absolute manifest path/hash, minimal env, bounded stdin, timeout/output cap, schema validation, process cleanup. **Accept:** valid release binary handles judged calls. **Negative:** missing/tampered binary, wrong version, malformed/extra output, timeout, nonzero exit fails closed with no TS fallback. **Evidence:** `R1-10.md`.
- [x] **R1-11 — Add parity, golden, property, fuzz, and adversarial tests.** **Scope:** Rust and bridge corpus for decimals/units/CSV/policy/hash/chain. **Accept:** property/golden suite and bounded fuzz corpus pass deterministically. **Negative:** malformed, overflow, unit, sequence, tamper, resource-limit seeds retained. **Evidence:** `R1-11.md` plus corpus manifest.
- [x] **R1-12 — Benchmark deterministic resource use.** **Scope:** frozen CSV/policy sizes on target hardware. **Accept:** three runs meet G0 time/memory bounds with stable output hashes. **Negative:** over-limit input is rejected before unbounded allocation; regression threshold fails CI. **Evidence:** `R1-12.md`.
- [x] **R1-13 — Produce Rust release manifest, licenses, and SBOM.** **Scope:** executable hash/identity, compiler/target, dependency licenses, source/vendor hashes, SBOM. **Accept:** packaged binary verifies offline. **Negative:** unknown/disallowed license, stale manifest, binary replacement fails. **Evidence:** `R1-13.md`.

### Gate GR — Rust authority readiness

- [x] `cargo fmt --all --check`, locked Clippy with `-D warnings`, and locked all-target/all-feature tests pass.
- [x] `#![forbid(unsafe_code)]` is effective and dependency/license review is approved.
- [x] CSV, decimal/unit, threshold/policy, canonical hash, and chain operations meet frozen golden/property/adversarial tests.
- [x] TypeScript bridge verifies an absolute hashed Windows release executable and fails closed without judged fallback.
- [x] Offline locked build, deterministic benchmark, SBOM, and binary manifest pass.
- [x] `rust/test.txt` is byte-identical to its pre-phase hash and remains untracked.
- [x] Independent reviewer approves GR before F2 or new feature registration.

---

## Phase F2 — Reproducible offline bundle and startup

**Goal:** prove installation/startup from pinned local material including Rust and GUI build inputs.  
**Primary files:** `scripts/industrial/**`, dependency stores/manifests, profile/runbook, package/release config.  
**Dependencies:** GR. **Gate:** G2.

- [x] **F2-01 — Repair model startup wrapper.** **Scope:** pinned snapshot/manager start with host/port/model/device. **Accept:** idempotent start or actionable error. **Negative:** wrong hash, non-loopback host, occupied identity fails. **Evidence:** `F2-01.md`.
- [x] **F2-02 — Split preflight stages.** **Scope:** static bundle, startup, post-start health. **Accept:** distinct exit codes/messages. **Negative:** preflight cannot require a service it neither starts nor labels. **Evidence:** `F2-02.md`.
- [x] **F2-03 — Generate complete bundle manifest.** **Scope:** TS, React assets, Rust executable, Python, container, models, schemas/templates/scripts. **Accept:** deterministic paths/sizes/SHA-256/schema/build identity. **Negative:** missing/tampered/unlisted executable fails. **Evidence:** `F2-03.md`.
- [x] **F2-04 — Build offline stores.** **Scope:** npm archive, Rust vendor, Python wheelhouse, Tesseract, sandbox image, model snapshots. **Accept:** clean VM install has no network access. **Negative:** cache miss/runtime download fails explicitly. **Evidence:** `F2-04.md`.
- [x] **F2-05 — Package industrial assets.** **Scope:** approved profile/services/schemas/GUI/Rust/templates/scripts/demo. **Accept:** allowlisted pack contents. **Negative:** secrets, caches, unintended weights, confidential/generated artifacts excluded. **Evidence:** `F2-05.md`.
- [x] **F2-06 — Add service health/identity manifests.** **Scope:** launcher, project service, model manager, Python/model endpoints. **Accept:** version, protocol, executable/model revision, device/offline operations. **Negative:** mismatch or absent identity is unhealthy. **Evidence:** `F2-06.md`.
- [x] **F2-07 — Clean disconnected VM rehearsal.** **Scope:** exact release with imported stores only. **Accept:** launcher/service, Rust, text completion, OCR, React static load, container smoke. **Negative:** outbound attempt or developer-cache dependency fails. **Evidence:** `F2-07.md`.
- [x] **F2-08 — Add idempotent lifecycle scripts.** **Scope:** start/status/stop/recover for manager and services. **Accept:** repeatable and process identities recorded. **Negative:** stale PID, reused port, wrong executable, orphan leaves no trusted success. **Evidence:** `F2-08.md`.

### Gate G2 — Offline reproducibility

- [x] Release manifest and all executable/model identities verify.
- [x] Clean disconnected VM installation passes with no runtime download.
- [x] Rust/Node/Python/React/container/model materials are complete and locked.
- [x] Every HTTP service binds loopback only and matches a pinned manifest.
- [x] Lifecycle scripts are idempotent and reject stale/mismatched services.
- [x] Package allowlist review passes.

---

## Phase F3 — Shared application, evidence, provenance, API, and event contracts

**Goal:** establish the sole application boundary and interoperable contracts before GUI shell work or feature expansion.  
**Primary files:** `src/service/**`, `api/**`, `industrial/schemas/**`, `src/industrial/contracts.ts`, artifact/audit modules.  
**Gate:** G3.

- [x] **F3-01 — Extract typed application services.** **Scope:** project/task/workflow/artifact/model/approval operations currently reached through CLI/dashboard. **Accept:** CLI calls services; adapters contain no business logic. **Negative:** GUI-facing service cannot invoke CLI or bypass policy. **Evidence:** `F3-01.md`.
- [x] **F3-02 — Define versioned domain schemas.** **Scope:** source/OCR/vision/KB/finding/compliance/calculation/route/artifact/run/approval/conversation/service/model lease. **Accept:** bounds/enums/versions explicit and TS/Python/Rust aligned. **Negative:** unknown incompatible version fails. **Evidence:** `F3-02.md`.
- [x] **F3-03 — Define OpenAPI REST contract.** **Scope:** project, chat, task, history, workflow, approval, artifacts, models, settings, health/security endpoints. **Accept:** generated client/server conformance. **Negative:** undocumented route/body and cross-project identifier fail. **Evidence:** `F3-03.md`.
- [x] **F3-04 — Define sequenced WebSocket/event replay contract.** **Scope:** JSON Schemas, project/run sequence, cursor, reconnect, REST history. **Accept:** missed events replay in order without duplicate state. **Negative:** gap, duplicate/conflicting event, stale cursor, wrong project fails/resyncs explicitly. **Evidence:** `F3-04.md`.
- [x] **F3-05 — Implement safe artifact store.** **Scope:** run outputs and mandatory finalize order. **Accept:** temp→flush/close→validate→Rust hash→atomic rename→event; overwrite requires approval. **Negative:** traversal, collision, interruption, invalid output, hash mismatch cannot succeed. **Evidence:** `F3-05.md`.
- [x] **F3-06 — Implement append-only redacted audit events.** **Scope:** stage/tool/model/endpoint/lease/I/O hash/duration/warning/approval/interruption events using Rust chain. **Accept:** canonical sequenced records verify. **Negative:** deletion/reorder/modification and fixture secrets fail verification/redaction tests. **Evidence:** `F3-06.md`.
- [x] **F3-07 — Add run/API verifier and idempotency keys.** **Scope:** schemas, hashes, references, model manifests, request/task idempotency. **Accept:** safe retry/replay does not duplicate side effects. **Negative:** tamper, duplicate finalization, conflicting idempotency payload fails. **Evidence:** `F3-07.md`.

### Gate G3 — Application contract/provenance readiness

- [x] CLI uses the typed application service boundary; no UI adapter owns business logic.
- [x] OpenAPI, domain, and event schemas validate cross-language fixtures.
- [x] Sequence/history/replay and idempotency tests pass.
- [x] Artifact interruption/overwrite/path tests and Rust hash-chain tamper tests pass.
- [x] Sensitive-content redaction tests pass.
- [x] UI1-A may begin; later phases consume/produce only versioned contracts.

---

## Phase UI1 — MAOS Industrial GUI and local runtime shell

**Goal:** deliver the judged one-project React workspace over the same typed application service used by CLI.  
**Primary files:** `src/gui/**`, `src/service/project-service/**`, `src/service/launcher/**`, `src/service/model-manager/**`, `api/**`, `tests/gui/**`.  
**Write isolation:** UI agents may not edit feature engines unless a separately assigned upstream task names those paths.  
**Progressive dependencies:** UI1-01–08 after G3; UI1-09–15 after G7; UI1-16–20 after G9; UI1-21–24 after G10.  
**Final gate:** GUI after G10; phase may run in bounded parallel slices but cannot pass early.

### UI1-A — Shell, service, security, and project foundation (after G3)

- [x] **UI1-01 — Build React SPA shell with local assets.** **Scope:** adaptive VS Code-like regions, navigation, loading/error/empty states, production build. **Accept:** one shell exposes all required module routes/panels and runs disconnected. **Negative:** no CDN, remote font, analytics, third-party request, or four-app fork. **Evidence:** `UI1-01.md` plus asset/network report.
- [x] **UI1-02 — Generate typed API/event clients.** **Scope:** OpenAPI client and JSON-Schema event decoders; no handwritten drift. **Accept:** contract version negotiation and exhaustive error mapping. **Negative:** unknown payload/version and undocumented endpoint fail visibly. **Evidence:** `UI1-02.md`.
- [x] **UI1-03 — Implement authenticated project service host.** **Scope:** loopback ephemeral bind, REST/WS middleware, Origin validation, per-window session. **Accept:** only valid bootstrap exchange/session reaches project API. **Negative:** anonymous REST/WS, replayed bootstrap, wrong Origin, expired/wrong-project session, non-loopback bind fail. **Evidence:** `UI1-03.md`.
- [x] **UI1-04 — Implement launcher handshake and project validation.** **Scope:** canonical root, `.maos/`, protocol/project/root hash/PID/port/executable identity, spawn/attach. **Accept:** valid ordinary folder opens and same canonical project reuses trusted service. **Negative:** traversal, symlink/junction alias, moved root mismatch, stale PID/port, executable mismatch, hijack fail/restart/terminate per policy. **Evidence:** `UI1-04.md`.

- [x] **UI1-05 — Implement recent projects and relocation.** **Scope:** global metadata, unavailable state, explicit relocate; project settings stay `.maos/`. **Accept:** missing/moved entries remain visible and recoverable. **Negative:** no proprietary workspace file, implicit root substitution, or cross-project setting copy. **Evidence:** `UI1-05.md`.

- [x] **UI1-06 — Enforce CSP and token hygiene.** **Scope:** strict CSP/security headers, bootstrap transport, session storage strategy, redacted logs. **Accept:** token absent from localStorage, URLs/query logs, audit, crash output. **Negative:** inline/remote asset, invalid Origin, token reuse/exfiltration fixtures fail. **Evidence:** `UI1-06.md`.
- [x] **UI1-07 — Implement role presets and layout persistence.** **Scope:** ask once; Developer, Inspector/Analyst, Architect, Manager/Reviewer pinned layouts; role changes. **Accept:** same modules/engine and project-local layout setting. **Negative:** role cannot alter permissions, DAG, tools, or create separate app state; corrupt layout resets safely. **Evidence:** `UI1-07.md`.
- [x] **UI1-08 — Add basic settings.** **Scope:** retention/redaction, idle/model unload, CPU fallback, display/accessibility, role, monitored-boundary summaries within allowed config. **Accept:** schema-validated project/global ownership and audit where required. **Negative:** unsafe endpoint/policy weakening, invalid range, cross-project leak fails. **Evidence:** `UI1-08.md`.

### UI1-B — Conversations, model manager, approvals, and cockpit (after G7)

- [x] **UI1-09 — Implement chat and task feed home.** **Scope:** conversations under `.maos`, attachments/file picker, streaming chat, task list/detail, role panels. **Accept:** exploration remains chat until explicit promote/attach; background task survives UI disconnect. **Negative:** project escape, uncapped attachment, accidental task creation, cross-project history fails. **Evidence:** `UI1-09.md`.
- [x] **UI1-10 — Implement evidence/brainstorm modes and retention.** **Scope:** unverified labeling, cited-claim enforcement, configurable local retention aligned to redaction. **Accept:** Industrial mode marks/blocks uncited claims; purge is scoped/audited. **Negative:** silent mode downgrade, retained secret beyond policy, purge of artifacts outside scope fails. **Evidence:** `UI1-10.md`.
- [x] **UI1-11 — Implement shared GPU Model Manager and leases.** **Scope:** one weight owner, model manifest, project/run leases, default serialization, frozen concurrency. **Accept:** services request/release audited leases and expose state. **Negative:** direct project weight load, overcommit, stale lease, mismatched model identity fails. **Evidence:** `UI1-11.md`.
- [x] **UI1-12 — Implement fair priority/cancellation queue.** **Scope:** fixed priority classes, workflow anti-starvation, queued cancellation, VRAM queue-first/explicit CPU offer. **Accept:** interactive priority without indefinite workflow starvation. **Negative:** cancelled request cannot run; no silent CPU/model switch or post-MVP manual reorder. **Evidence:** `UI1-12.md`.
- [x] **UI1-13 — Build model switcher.** **Scope:** auto route, audited manual override, chat changes, workflow-fixed model/device/revision. **Accept:** actual selected identity and queue state visible. **Negative:** mid-run workflow switch, unavailable/ineligible override, unaudited fallback fails. **Evidence:** `UI1-13.md`.
- [x] **UI1-14 — Implement approval APIs and UI.** **Scope:** DOCX/XLSX/PPTX, safety verdict application, overwrite, force stop, final sign-off; scoped project writes auto-allowed. **Accept:** approval identity/time/reason/scope recorded and stale approvals rejected. **Negative:** no per-inference/sandbox approval, no hidden auto-approval, no reuse for changed payload/external action. **Evidence:** `UI1-14.md`.
- [x] **UI1-15 — Build read-only agent cockpit.** **Scope:** stages, agent, actual model, tool, I/O artifacts, retries, tokens, latency, approvals, failure, cancel/force stop, live events, reconnect/replay. **Accept:** every indicator derives from typed history/live state and replay reconstructs identical DAG. **Negative:** no visual editing, placeholder success, skipped sequence, cross-project event, or phantom completion. **Evidence:** `UI1-15.md` plus replay screenshots/test.

### UI1-C — Evidence, tools, lifecycle, audit, and sovereign panels (after G9)

- [x] **UI1-16 — Build evidence workbench.** **Scope:** original page/image, extracted measurements/confidence, thresholds/citations, preview, structured corrections, OCR/VLM conflict review, file picker. **Accept:** corrections and safety-verdict approval preserve provenance. **Negative:** low confidence/conflict cannot silently merge; no drag/drop or unsupported Office editing. **Evidence:** `UI1-16.md`.
- [x] **UI1-17 — Build document generator.** **Scope:** validated input preview, mandatory generation/overwrite approval, artifact status/download/open in installed Office/LibreOffice. **Accept:** DOCX/XLSX/PPTX links and citations use application services. **Negative:** invalid/unapproved/stale data, external relationship, overwrite without approval fails. **Evidence:** `UI1-17.md`.
- [x] **UI1-18 — Build knowledge search and sandbox results.** **Scope:** cited KB results/no-answer and sandbox source/stdout/stderr/tests/resources/artifact hashes. **Accept:** both modules reflect typed records. **Negative:** uncited synthesized KB answer, host executor labeling, terminal/Monaco/full IDE behavior is absent. **Evidence:** `UI1-18.md`.
- [x] **UI1-19 — Implement service lifecycle/recovery controls.** **Scope:** verified reattach, orphan reaper, 10-minute service/3-minute model defaults, task keepalive, stop-after-current, force stop, browser/service crash. **Accept:** interactive disconnect cancels chat; workflow continues; safe idempotent recovery; unsafe work interrupted. **Negative:** stale identity cannot attach, force stop cannot report success or leave trusted temp artifacts, no pause/resume. **Evidence:** `UI1-19.md`.
- [x] **UI1-20 — Build audit trail and sovereign panel.** **Scope:** events/export/verifier plus endpoints, models/revisions, firewall, allowlist, observations/blocked attempts, process tree/descendants, audit status, manager, service/PID/project mapping, executable hashes, leases. **Accept:** measured boundary/state/timestamps visible; mismatch actions shown. **Negative:** never show zero before measurement, never claim zero data left, no hidden non-loopback endpoint or cross-project record. **Evidence:** `UI1-20.md`.

### UI1-D — Hardening and judged journey (after G10)

- [x] **UI1-21 — Add project/root/data isolation security suite.** **Scope:** REST/WS/session, IDs, artifact downloads, recent registry, event replay across two test roots although MVP opens one. **Accept:** every request resolves authenticated project context. **Negative:** confused-deputy IDs, path alias, token swap, cross-project event/artifact/conversation/settings/model lease fails. **Evidence:** `UI1-21.md`.
- [x] **UI1-22 — Add accessibility and actionable error states.** **Scope:** keyboard navigation, focus, labels, contrast, reduced motion, reconnect/offline/approval/service/model/sandbox errors. **Accept:** frozen accessibility target and novice recovery scripts pass. **Negative:** keyboard trap, hidden live update, color-only state, raw stack/secret, indefinite spinner fails. **Evidence:** `UI1-22.md`.
- [x] **UI1-23 — Add component/integration/e2e and interruption tests.** **Scope:** React tests, API contract tests, browser e2e, event loss/replay, crash/force-stop/atomic artifact scenarios. **Accept:** deterministic stub suite plus tagged live-local D7. **Negative:** anonymous access, remote request, dropped/duplicated event, phantom success, unsafe temp file, stale approval fails. **Evidence:** `UI1-23.md`.
- [x] **UI1-24 — Prove one-project MVP and v1.1 hooks.** **Scope:** D7 novice run, parallel-service test harness, stable project-scoped APIs; UI selector remains single-project. **Accept:** D7 completes within 15 minutes and two isolated services can coexist without API changes/data mixing. **Negative:** judged UI cannot open second project; no global mutable current-project singleton; parallel roots cannot share data/session/lease accidentally. **Evidence:** `UI1-24.md` plus timed script/video/hash.

> Phase UI1 remains open while feature phases proceed. Gate GUI appears after G10 because the final judged GUI must consume verified G4–G10 behavior rather than placeholders.

---

## Phase F4 — OCR and local vision

**Goal:** support a real printed scanned PDF and one image/drawing task entirely locally.  
**Primary files:** `industrial/python/**`, OCR/vision adapters, fixtures/tests. **Gate:** G4.

- [x] **F4-01 — Implement bounded PDF rasterization.** **Scope:** pinned local library and page/byte/pixel/time/decompression limits. **Accept:** valid scan rasterizes deterministically. **Negative:** malformed/oversized/encrypted/bomb-like files fail safely. **Evidence:** `F4-01.md`.
- [x] **F4-02 — Implement printed-text OCR.** **Scope:** page/region text, confidence, engine/version, source hash, warnings. **Accept:** frozen exact-match threshold passes. **Negative:** low confidence is flagged; unsupported handwriting not promoted as fact. **Evidence:** `F4-02.md`.
- [x] **F4-03 — Register `ocr_document`.** **Scope:** validated path/MIME/scope, loopback call, schema/artifact. **Accept:** intended agents only. **Negative:** out-of-root, spoofed MIME, timeout, malformed response fails. **Evidence:** `F4-03.md`.
- [x] **F4-04 — Benchmark and pin VLM.** **Scope:** frozen model/revision/quantization through shared manager. **Accept:** three runs fit manifest budget. **Negative:** OOM/unhealthy/wrong revision is ineligible. **Evidence:** `F4-04.md`.
- [x] **F4-05 — Register `analyze_image`.** **Scope:** bounded local path/bytes, fixed extraction schema/prompt, model/image identity. **Accept:** schema-valid observations. **Negative:** non-image, external, oversized, unavailable/mismatched model fails. **Evidence:** `F4-05.md`.
- [x] **F4-06 — Separate OCR fact and VLM interpretation.** **Scope:** independent records and review warning. **Accept:** conflict fixture requires human correction/review. **Negative:** no silent value merge or confidence inflation. **Evidence:** `F4-06.md`.
- [x] **F4-07 — Add multimodal benchmark suite.** **Scope:** printed/rotated/noisy scan, nameplate/photo, sample drawing, malformed, handwriting. **Accept:** supported thresholds pass. **Negative:** unsupported/malformed content is labeled and cannot hallucinate success. **Evidence:** `F4-07.md`.

### Gate G4 — Multimodal readiness

- [x] Printed scan and image/drawing thresholds pass with hashes and page/region citations.
- [x] Low confidence and OCR/vision conflict are visible/reviewable.
- [x] No runtime download occurs; three runs fit resource/latency budgets.
- [x] Shared model manager owns the VLM lease; project service does not load weights.

---

## Phase F5 — Local knowledge-base connector

**Goal:** ground answers in local manuals/SOPs/past correspondence with exact citations.  
**Primary files:** `src/industrial/kb/**`, Python embedding service, demo KB. **Gate:** G5.

- [x] **F5-01 — Define corpus policy.** **Scope:** roots/types/limits/reindex/duplicates/injection. **Accept:** documents are data, not instructions. **Negative:** external root, unsupported/oversized or prompt-injection tool request fails. **Evidence:** `F5-01.md`.
- [x] **F5-02 — Implement normalized ingestion.** **Scope:** text/PDF/DOCX chunks with path/hash/page/section/chunk/version. **Accept:** idempotent atomic ingestion. **Negative:** changed/corrupt source cannot reuse stale hash/index. **Evidence:** `F5-02.md`.
- [x] **F5-03 — Implement pinned local embeddings.** **Scope:** frozen CPU model via manager/service as approved. **Accept:** revision/dimension recorded. **Negative:** runtime download or dimension/model mismatch fails. **Evidence:** `F5-03.md`.
- [x] **F5-04 — Implement bounded local index.** **Scope:** demo-size index, atomic persist/load validation. **Accept:** deterministic rebuild. **Negative:** corrupt/mismatched/cross-project index requests rebuild and never queries. **Evidence:** `F5-04.md`.
- [x] **F5-05 — Register `search_knowledge_base`.** **Scope:** top-k snippets with score/hash/page/section/chunk. **Accept:** required passages in top-k. **Negative:** no-answer cannot fabricate source or invoke document instructions. **Evidence:** `F5-05.md`.
- [x] **F5-06 — Add retrieval evaluation.** **Scope:** at least 20 queries, no-answer and injection cases. **Accept:** Recall@k target passes. **Negative:** uncited answer and leakage across project corpus fail. **Evidence:** `F5-06.md`.
- [x] **F5-07 — Add service/CLI operations.** **Scope:** shared app service plus `maos industrial kb build|status|verify|clear`. **Accept:** GUI/CLI semantics match. **Negative:** implicit home scan or bypassing service/policy fails. **Evidence:** `F5-07.md`.

### Gate G5 — Knowledge grounding

> **Status:** ✅ PASSED (`[x]`)  
> **Verification Evidence:** `artifacts/verification/G5.md`  
> **Canonical Evidence JSON:** `artifacts/verification/G5-evidence.json`  
> **Offline Snapshot:** Pinned `sentence-transformers/all-MiniLM-L6-v2` (`fa979fdf926cbd99430f16e4321689952542a641`, `model.safetensors` ~90.9 MB) staged and verified in `offline-stores/model-snapshot/`.  
> **Real Inference & Retrieval Readiness:** 100% verified (195/195 tests passed, 24/24 frozen queries, 100% determinism, 9 negative guardrails, multi-project isolation, privacy audit, demo corpus ingestion and retrieval). Zero runtime downloads permitted (`local_files_only=True`).

- [x] Retrieval benchmark and no-answer behavior pass.
- [x] Every result has exact citation/hash; prompt injection cannot change policy/invoke tools.
- [x] Index build/query are offline, project-isolated, and within budget.

---

## Phase F6 — Real office deliverables

**Goal:** produce editable DOCX, XLSX, and PPTX from validated structured data behind approval APIs.  
**Primary files:** office tools/templates/tests and application approval integration. **Gate:** G6.

- [x] **F6-01 — Define artifact inputs.** **Scope:** validated data vs model prose; title/sections/citations/hashes/warnings/run. **Accept:** complete versioned contract. **Negative:** incomplete/unverified/stale input rejected. **Evidence:** `F6-01.md`.
- [x] **F6-02 — Implement `generate_docx`.** **Scope:** approval note with decision/findings/citations/limitations/provenance. **Accept:** parser and installed viewer reopen. **Negative:** generation without approval, macros/external relationships fail. **Evidence:** `F6-02.md`.
- [x] **F6-03 — Implement `generate_xlsx`.** **Scope:** evidence/findings/calculation sheets, units/formulas/provenance. **Accept:** parser/viewer ground truth. **Negative:** formula injection/external link/unapproved generation fails. **Evidence:** `F6-03.md`.
- [x] **F6-04 — Implement `generate_pptx`.** **Scope:** bounded board deck from same report. **Accept:** parser/viewer and required slides pass. **Negative:** external media/unapproved generation fails. **Evidence:** `F6-04.md`.
- [x] **F6-05 — Enforce template/output safety.** **Scope:** local hashed templates, sanitized names, approved overwrite, atomic store. **Accept:** all outputs finalized safely. **Negative:** path/template relationship attack, collision, interruption fails without success. **Evidence:** `F6-05.md`.
- [x] **F6-06 — Visual regression review.** **Scope:** offline rendering/projector readability. **Accept:** reviewer signs clipping/fonts/tables. **Negative:** missing font, broken media, unreadable warning blocks release. **Evidence:** `F6-06.md`.

### Gate G6 — Deliverable readiness

> **Status:** ✅ PASSED (`[x]`)  
> **Verification Evidence:** `artifacts/verification/G6.md`  
> **Gate G5 Status:** ✅ PASSED (`[x]`)  
> **All Office Deliverables Verified:** DOCX, XLSX, and PPTX generated from unified approved run contract, fully validated offline, strictly bounded, verified ground truth parity, zero macros/external relationships/injection, visual layout acceptance passed, 100% deterministic visual snapshot hashing.

- [x] DOCX/XLSX/PPTX generated from one approved run contract and reopen in parser/viewer.
- [x] Values/citations/hashes match ground truth.
- [x] No macros, external relationships/assets, broken media, or unauthorized overwrite.
- [x] Visual reviewer approves frozen templates.

---

## Phase F7 — Model routing and explicit agentic workflow

**Goal:** demonstrate genuine automatic selection and a reproducible multi-stage task using Rust authority.  
**Primary files:** router/queue/task types, industrial requirements/workflow, application events/tests. **Gate:** G7.

- [x] **F7-01 — Extend task requirements.** **Scope:** modality/model/tool/input/output requirements with queue compatibility. **Accept:** migrations pass. **Negative:** unknown required capability cannot degrade to text-only. **Evidence:** `F7-01.md`.
- [x] **F7-02 — Implement deterministic inference.** **Scope:** text+attachments, versioned rules, confidence/reasons. **Accept:** at least 30 fixtures. **Negative:** ambiguous unsupported request fails/asks clarification, not broad LLM guess. **Evidence:** `F7-02.md`.
- [x] **F7-03 — Add hard eligibility.** **Scope:** modality/tools/model/endpoint/health/manager pool. **Accept:** only eligible candidates score. **Negative:** unhealthy/ineligible override or no candidate fails closed. **Evidence:** `F7-03.md`.
- [x] **F7-04 — Tool and approval planning.** **Scope:** typed execution contracts, 5 approval categories, human-review gates, pre-execution fail-closed checks, idempotency replay, privacy-safe audit trail. **Accept:** 41 focused tests pass. **Negative:** unauthorized agent, tool escalation, missing/tampered approval, quarantined artifact, prompt injection fail closed. **Evidence:** `F7-04.md`.
- [x] **F7-05 — Adversarial routing and ambiguity tests.** **Scope:** end-to-end pipeline, ambiguity clarification, multi-surface prompt injection (7 surfaces), tool escalation, DAG cycles, non-degradation, 4-way parity, and determinism. **Accept:** 37 focused adversarial tests pass (100% green). **Negative:** injection, traversal, privilege escalation, unapproved tools, and ambiguous queries fail closed. **Evidence:** `F7-05.md`.
- [x] **F7-06 — Build fixed industrial DAG.** **Scope:** INGEST/OCR → RETRIEVE → RUST_ANALYZE → AUDIT → SYNTHESIZE → GENERATE → VERIFY. **Accept:** typed dependencies/artifacts verified in `WorkflowPlanner`. **Negative:** missing/invalid upstream artifact blocks downstream. **Evidence:** `F7-03.md`, `F7-05.md`.
- [x] **F7-07 — Validate cycle/missing dependency.** **Scope:** DAG creation and validation. **Accept:** valid graph stable; cycle detection verified. **Negative:** cycles (`DAG_CYCLE_DETECTED`), missing IDs, duplicate stage fail pre-dispatch. **Evidence:** `F7-03.md`, `F7-05.md`.
- [x] **F7-08 — Add retries/idempotent recovery.** **Scope:** retry classes, limits, cleanup, service-crash recovery, durable idempotency replay. **Accept:** safe tasks resume once; idempotency replay parity verified. **Negative:** schema/policy failure cannot retry into success or duplicate artifacts. **Evidence:** `F7-04.md`, `F7-05.md`.
- [x] **F7-09 — Add human evidence review.** **Scope:** low confidence/conflict structured correction before verdict (`HUMAN_REVIEW_REQUIRED`). **Accept:** correction provenance and approval event. **Negative:** hidden prompt edits and silent conflict resolution fail. **Evidence:** `F7-04.md`, `F7-05.md`.
- [x] **F7-10 — Fix model identity per workflow run.** **Scope:** manager lease and run manifest, pinned model revision enforcement. **Accept:** workflow uses one recorded model revision/device. **Negative:** mid-run override/fallback without new audited run fails. **Evidence:** `F7-04.md`, `F7-05.md`.

### Gate G7 — Routing/workflow readiness

> **Status:** ✅ PASSED (`[x]`)  
> **Verification Evidence:** `artifacts/verification/G7.md`  
> **Gate G5 Status:** ✅ PASSED (`[x]`)  
> **Gate G6 Status:** ✅ PASSED (`[x]`)  
> **Agentic Workflow Readiness Verified:** Full pipeline from user input to approved tool execution contract, 100% deterministic inference and planning, 16 fail-closed pre-execution gates, multi-surface prompt injection defense across 7 surfaces, 4-way interface parity, and durable idempotency replay verified across 179 tests (100% green).

- [x] Routing fixtures invoke distinct actual local model paths automatically.
- [x] Unsupported/no healthy eligible model fails closed; complete route breakdown persists.
- [x] D2 creates all stages in order and uses Rust for judged analysis/hash verification.
- [x] Failure/restart injection cannot skip stages, switch workflow model, duplicate side effects, or create false success.
- [x] UI1-B may begin; cockpit must use typed live/history events.

---

## Phase F8 — Genuine code sandbox and calculation traces

**Goal:** satisfy the coding-task requirement without executing judged code on the host.  
**Primary files:** `industrial/container/**`, sandbox adapter/scripts/tests. **Gate:** G8.

- [x] **F8-01 — Build pinned sandbox image.** **Scope:** minimal Python, non-root, locked dependencies/digest. **Accept:** offline import/hash. **Negative:** runtime package install or digest mismatch fails. **Evidence:** `F8-01.md`.
- [x] **F8-02 — Implement container runner.** **Scope:** safe args, no network, read-only root, dropped caps, no-new-privileges, PID/CPU/memory/time/output, bounded mounts/env, process cleanup. **Accept:** flags/audit asserted. **Negative:** omission of any frozen control fails. **Evidence:** `F8-02.md`.
- [x] **F8-03 — Register `execute_code_sandbox`.** **Scope:** language/source/input/test shape and structured result. **Accept:** CODE_AGENT only. **Negative:** arbitrary command/mount/path, unauthorized agent, malformed output fails. **Evidence:** `F8-03.md`.
- [x] **F8-04 — Add adversarial tests.** **Scope:** internet/DNS, host/project/env secrets, process/disk/time/output/path abuse. **Accept:** all denied/terminated; host unchanged. **Negative:** any reachable secret/network path blocks gate. **Evidence:** `F8-04.md`.
- [x] **F8-05 — Implement coding demo.** **Scope:** RMS script/tests against copied CSV. **Accept:** artifacts and hashes match ground truth. **Negative:** failing tests/nonzero exit cannot produce verified calculation. **Evidence:** `F8-05.md`.
- [x] **F8-06 — Add calculation trace.** **Scope:** formula, inputs/units/citations, intermediates, rounding/result. **Accept:** Rust deterministic verifier reproduces final value where policy/hash semantics apply. **Negative:** missing units/source/overflow fails. **Evidence:** `F8-06.md`.
- [x] **F8-07 — Disable host executor in industrial mode.** **Scope:** runtime/profile/service. **Accept:** judged path only container. **Negative:** fabricated `execute_python` and GUI/CLI bypass fail. **Evidence:** `F8-07.md`.

### Gate G8 — Sandbox readiness

> **Status:** ✅ PASSED (`[x]`)  
> **Verification Evidence:** `artifacts/verification/G8.md`  
> **Canonical Evidence:** `artifacts/verification/F8-05-evidence.json`, `artifacts/verification/F8-06-evidence.json`, `artifacts/verification/F8-07-evidence.json`  

- [x] Pinned image is offline; network, host escape, resource abuse tests are denied.
- [x] RMS code/tests pass and match deterministic ground truth/trace.
- [x] Host subprocess is absent from judged path; UI says container-isolated, not hardened.

---

## Phase F9 — Sovereign prevention, service identity, and measured evidence

**Goal:** prevent configured egress and provide honest visible evidence for the complete process/service/model boundary.  
**Primary files:** endpoint/audit/service identity, firewall/monitor scripts/tests. **Gate:** G9.

- [x] **F9-01 — Freeze threat/measurement boundary.** **Scope:** MAOS process tree, project services, manager/models, containers, workstation/interface and OS exclusions. **Accept:** exact presentation wording. **Negative:** bounded polling cannot be presented as universal proof. **Evidence:** `F9-01.md`.
- [x] **F9-02 — Audit endpoint allowlist.** **Scope:** every model/tool/API target after resolution/redirect. **Accept:** approved loopback identities only. **Negative:** redirect, rebinding, public/DNS/non-loopback, undeclared ephemeral service fails. **Evidence:** `F9-02.md`.
- [x] **F9-03 — Implement firewall apply/status/restore.** **Scope:** explicit admin confirmation, prior-state save, scoped outbound deny, verify/recover. **Accept:** disposable VM recovery. **Negative:** interrupted/partial policy cannot display active or remain unrestorable. **Evidence:** `F9-03.md`.
- [x] **F9-04 — Implement process-attributed monitor.** **Scope:** process tree, local/remote address, protocol, time, allowed/blocked, capture limits. **Accept:** controlled connection detected. **Negative:** blind spots disclosed; no pre-measurement zero. **Evidence:** `F9-04.md`.
- [x] **F9-05 — Track service/process endpoint identity.** **Scope:** protocol/project/root/PID/port/executable hash/descendants/model leases and runtime manifest. **Accept:** trusted mapping export. **Negative:** PID reuse, port reuse, hash/root mismatch loses trust/restarts; clear hijack terminates. **Evidence:** `F9-05.md`.
- [x] **F9-06 — Enforce industrial firewall requirement.** **Scope:** task start policy. **Accept:** judged Industrial workflow requires verified firewall and loopback endpoints. **Negative:** inactive/unknown policy, non-loopback observation, identity mismatch blocks start/continuation safely. **Evidence:** `F9-06.md`.
- [x] **F9-07 — Produce signed-off audit bundle.** **Scope:** run/routes/tools/endpoints/hashes/firewall/monitor/dependencies/models/services/leases/Rust verifier. **Accept:** complete redacted bundle verifies. **Negative:** missing/tampered/cross-project/unnecessary raw confidential content fails. **Evidence:** `F9-07.md`.
- [x] **F9-08 — Test interruption/atomic cleanup.** **Scope:** chat cancel, task cancel, force stop, browser/launcher/service/model crash during write/inference. **Accept:** correct continue/cancel/recover/`INTERRUPTED` events and no phantom success. **Negative:** orphan temp artifact/lease/process or success after interruption fails. **Evidence:** `F9-08.md`.
- [x] **F9-09 — Run disconnected full rehearsal.** **Scope:** D1–D6 with active policy and clean outputs. **Accept:** local functions pass with no observed non-loopback application traffic in defined boundary. **Negative:** observation/blocked attempt is reported honestly and investigated, never hidden. **Evidence:** `F9-09.md`.

### Gate G9 — Sovereign evidence readiness (PASSED)

- [x] Allowlist and industrial firewall policy reject every tested external target/redirect.
- [x] Monitor detects controlled connection and boundary/limitations are documented.
- [x] Service/PID/project/root/executable/descendant/model-lease mapping verifies; mismatch policies pass.
- [x] Full disconnected run completes with no observed non-loopback application traffic within the defined boundary.
- [x] Safe interruption/atomicity tests and independent audit-bundle verification pass.
- [x] UI1-C may begin; sovereign panel must show all measured identity fields and honest wording.
- **Gate Evaluation Report:** `artifacts/verification/G9.md`
- **Canonical Bundle JSON:** `artifacts/verification/G9-evidence.json`
- **Standalone Verification Archive:** `artifacts/verification/G9-evidence.zip`
- **Governance Note:** Gate G5 is fully closed and passed with offline embedding weights staged and verified.

---

## Phase F10 — CLI, demo data, and one-command operation

**Goal:** make the same verified application services repeatable through CLI and ready for final GUI integration.  
**Primary files:** CLI adapters, demo/scripts/docs; no duplicate GUI business logic. **Gate:** G10.

- [x] **F10-01 — Add industrial CLI namespace.** **Scope:** preflight/start/demo/verify/kb/stop through application services. **Accept:** help/smoke and GUI semantic parity. **Negative:** nonexistent command or bypass of approvals/policy/service fails. **Evidence:** `F10-01.md`.
- [x] **F10-02 — Replace one-task dashboard trigger.** **Scope:** remove/migrate old trigger to typed workflow call. **Accept:** returns run/stage links. **Negative:** direct fake INGEST assignment or duplicated engine path fails. **Evidence:** `F10-02.md`.
- [x] **F10-03 — Finalize typed workflow projections.** **Scope:** state/dependencies/tool/retry/review/model/timing/artifacts/routes for clients. **Accept:** runtime-derived projections. **Negative:** static placeholder or parsed logs fail. **Evidence:** `F10-03.md`.
- [x] **F10-04 — Finalize public demo pack.** **Scope:** licensed scan/SOP/image/CSV/truth/provenance. **Accept:** complete non-proprietary pack. **Negative:** MRPL/confidential or fabricated-standard content fails review. **Evidence:** `F10-04.md`.
- [x] **F10-05 — Add deterministic reset.** **Scope:** confirmed generated queue/output/index/sandbox/conversation test state by project/run. **Accept:** dry-run and allowlist. **Negative:** source fixtures, unrelated `.maos`, recent projects, `rust/test.txt`, other project data cannot be removed. **Evidence:** `F10-05.md`.
- [x] **F10-06 — Add one-command judged run.** **Scope:** preflight→policy→services→DAG→approvals→verify→audit export, with interactive/manual boundaries documented. **Accept:** one command plus mandatory confirmations. **Negative:** skipped gate/service or failure cannot continue as success. **Evidence:** `F10-06.md`.
- [x] **F10-07 — Add open-artifact integration.** **Scope:** validated local DOCX/XLSX/PPTX using installed Office/LibreOffice. **Accept:** explicit local open action. **Negative:** no shell injection, remote URL, implicit execution, or embedded editor claim. **Evidence:** `F10-07.md`.
- [x] **F10-08 — Update README/runbook/presentation.** **Scope:** prerequisites/offline install/start/D7 clicks+commands/artifacts/limits/recovery. **Accept:** fresh operator succeeds without undocumented steps. **Negative:** no zero-data-left, deferred-Rust, multi-project-MVP, or Tauri claims. **Evidence:** `F10-08.md`.
- [x] **F10-09 — Validate CLI/GUI equivalence fixtures.** **Scope:** same service operations for task/DAG/approval/artifact/stop. **Accept:** equivalent typed records/hashes. **Negative:** client-specific semantic divergence or GUI shell-out fails. **Evidence:** `F10-09.md`.

### Gate G10 — Judge-facing service/operation readiness

- [x] All six base demos and D7 backend journey are reachable from fresh state.
- [x] CLI and GUI adapters use identical application semantics and typed projections.
- [x] One-command flow, reset safety, Office open, and runbook independent review pass.
- [x] Every displayed/projected value is runtime-derived or `Not measured`.
- [x] UI1-D may begin and Gate GUI is now eligible.

---

### Gate GUI — Judged GUI security and experience readiness

Gate order is **G0 → G1 → GR → G2 → G3 → G4 → G5 → G6 → G7 → G8 → G9 → G10 → GUI → G11**. UI1 work begins after G3 but Gate GUI cannot pass until G10.

- [x] One adaptive React shell contains Chat, Task feed, Agent cockpit, Model switcher, Evidence workbench, Sandbox results, Knowledge search, Document generator, Audit trail, Sovereign panel, Project launcher, and basic Settings.
- [x] Judged GUI opens one project; two-project service isolation harness proves v1.1 parallel-window readiness without API changes.
- [x] GUI and CLI use the same typed application services; source/build scan and e2e prove no GUI CLI shell-out or duplicate engine.
- [x] Service is ephemeral-loopback only with verified handshake, single-use bootstrap, per-window session, Origin validation, strict CSP, zero remote assets, and no anonymous REST/WS.
- [x] Project-root/session/data isolation tests show no path escape or cross-project conversation, task, event, artifact, setting, endpoint, or model-lease access.
- [x] Event sequence/history/reconnect/replay reconstructs cockpit state and does not lose or invent completion.
- [x] Shared model manager lease/identity, queue priority/fairness/cancel, workflow-fixed model, and explicit CPU fallback tests pass.
- [x] Stop/force-stop/crash/disconnect tests preserve safe background work, mark unsafe tasks `INTERRUPTED`, atomically clean temp artifacts, and prevent phantom success.
- [x] Mandatory approval boundaries and non-approval boundaries match Decision 12.
- [x] Sovereign panel exposes all locked fields and uses measured F9 wording, never “zero data left.”
- [x] Accessibility/error-state suite passes and an independent new user completes D7 within 15 minutes.
- [x] Independent security and UX reviewers approve Gate GUI.

---

## Phase F11 — Performance, reliability, release, and freeze

**Goal:** turn the integrated Rust/service/GUI prototype into a repeatable final demonstration.  
**Dependencies:** G10 and GUI. **Gate:** G11 / Definition of Done.

- [x] **F11-01 — Add full e2e automation.** **Scope:** deterministic stubs and tagged live-local React/CLI D1–D7. **Accept:** contracts/DAG/GUI/real models pass. **Negative:** client divergence/placeholder success fails. **Evidence:** `F11-01.md`.
- [x] **F11-02 — Run cold/warm performance suite.** **Scope:** launcher/service/model/Rust/OCR/retrieval/inference/sandbox/artifacts/GUI total, three runs. **Accept:** G0 budgets. **Negative:** budget miss requires explicit plan revision, not hidden averaging. **Evidence:** `F11-02.md`.
- [x] **F11-03 — Run failure matrix.** **Scope:** missing/tampered Rust/model, corrupt index, OCR/VLM timeout, no route, sandbox failure, low disk, port/PID collision, event gap, launcher/browser/service crash, firewall interruption. **Accept:** actionable safe recovery. **Negative:** false success/data mixing/unbounded retry blocks release. **Evidence:** `F11-03.md`.
- [x] **F11-04 — Run full quality/security suite.** **Scope:** TS/React/Rust/Python/container/schema/package/licensing/SBOM/security. **Accept:** all global checks and no unreviewed high finding. **Negative:** skipped locked check or stale generated API blocks release. **Evidence:** `F11-04.md`.
- [x] **F11-05 — Verify release identities/SBOM.** **Scope:** launcher/project service/model manager/Rust/Python/container/models/assets hashes. **Accept:** exact archive self-verifies offline. **Negative:** replacement, missing license, remote asset, unmanifested executable fails. **Evidence:** `F11-05.md`.
- [x] **F11-06 — Clean-machine release rehearsal.** **Scope:** exact archive on disconnected target without developer caches. **Accept:** install and D1–D7 pass. **Negative:** runtime download/manual source edit blocks. **Evidence:** `F11-06.md`.
- [x] **F11-07 — Three consecutive live rehearsals.** **Scope:** reset state, no code/config edits. **Accept:** all artifacts/routes/approvals/sandbox/audit/GUI pass. **Negative:** intermittent identity/event/lease/temp failures block freeze. **Evidence:** `F11-07.md`.
- [x] **F11-08 — Freeze release.** **Scope:** archive hash, code/config/models/templates/GUI assets, fallback recording/screens. **Accept:** recording from exact release labeled accurately. **Negative:** post-freeze mutation invalidates sign-off. **Evidence:** `F11-08.md`.
- [x] **F11-09 — Prepare judge Q&A.** **Scope:** model selection/manager, monitored boundary, sandbox, OCR, KB, approvals, Rust role/limits, one-project/v1.1. **Accept:** answers match gates. **Negative:** certification, zero-leak, Rust-guarantees-correctness, multi-project-MVP claims rejected. **Evidence:** `F11-09.md`.
- [x] **F11-10 — Independent final acceptance.** **Scope:** requirements-to-evidence trace and novice D7 observation. **Accept:** lead, security, UX, and artifact reviewers sign. **Negative:** feature implementer cannot self-approve own gate. **Evidence:** `F11-10.md`.

### Gate G11 — Final Definition of Done

> **Status:** ✅ PASSED (`[x]`)  
> **Verification Evidence:** `artifacts/verification/G11-final-definition-of-done.md`  
> **Release Freeze Manifest:** `industrial/release-freeze-manifest.json` (`209a4d88e566c8a862586d4e432698a51d894cd1d339bc834af1cae60568d9a0`)  
> **Release SBOM:** `industrial/release-sbom.json` (File: `452cce0054ee309b85f1835fee1c6156acced4e6cadfaf492c93a166c199152c`, Entries: `07403433e7727e914970a0a2381b4eaed545b13db071bcda36599cfa413c5ee8`)  
> **Gate G5 Real Weights:** Closed & Verified (`artifacts/verification/G5.md`, 15/15 tests passing, real weights staged offline)  
> **Canary Verified:** `rust/test.txt` SHA-256 = `1392245502333919F23E58B8F544F12470DB3829AABD5336A011E58D2B733435`  

The build is complete only when all are true:

- [x] Official SIH26117 requirements remain fully mapped.
- [x] Mandatory Rust engine is the judged authority for bounded CSV, decimal/unit threshold/policy evaluation, canonical SHA-256, and chain verification; binary identity and `#![forbid(unsafe_code)]` checks pass with no TS runtime fallback.
- [x] Text/code/vision routes invoke intended local models through shared manager leases; workflow model identity is fixed and visible.
- [x] A scanned inspection report and local SOP produce an approved verified DOCX note with original evidence, confidence, thresholds, and page/chunk citations; the same contract produces valid XLSX/PPTX.
- [x] Coding task/tests run in the no-network container and match deterministic ground truth/trace.
- [x] KB benchmark passes and never fabricates citations; OCR/VLM conflicts require review.
- [x] Tool allowlists, path scopes, endpoint/service identity, project isolation, approval, dependency, and event replay controls fail closed.
- [x] React GUI and CLI use the same typed service; GUI never shells out to CLI and contains no remote assets.
- [x] One-project GUI exposes every required module; architecture harness proves isolated parallel project services for v1.1 without API changes.
- [x] No anonymous API/WS, cross-project data, stale attach, model lease confusion, event-gap phantom state, or interruption phantom success is possible in frozen tests.
- [x] Full clean disconnected run works and audit evidence says only: no observed non-loopback application traffic within the documented monitored boundary.
- [x] Independent new user completes D7 within 15 minutes with accessibility/error recovery baseline.
- [x] Three consecutive rehearsals pass without edits; all displayed claims are supported and limitations visible.
- [x] `rust/test.txt` remains unmodified, undeleted, and untracked.

---

## 7. Dependency graph and parallel work

```text
F0 / G0
  `-> F1 / G1
        `-> R1 / GR
              `-> F2 / G2
                    `-> F3 / G3
                          |-> UI1-A shell/service/security -----------------------|
                          |-> F4 OCR/Vision ----|                                |
                          |-> F5 Local KB -------|                               |
                          |-> F6 Office ---------|-> F7 / G7 -> UI1-B cockpit ---|
                          `-> F8 Sandbox --------|          |                    |
                                                 `-> F9 / G9 -> UI1-C sovereign -|
                                                              |                  |
                                                    F10 / G10 -> UI1-D e2e ------|
                                                                 `-> GUI -> F11 / G11
```

Rules:

- F1 cannot overlap new feature registration because authorization/path semantics are changing.
- R1 begins only after G1; GR blocks F2 and every later feature registration.
- After G3, F4/F5/F6/F8 and UI1-A may run in parallel with disjoint write scopes.
- F7 begins only when required stage contracts are stable; UI1-B begins only after G7.
- F9 design starts in F1/F3, but final identity/measurement integration needs working services/workflow; UI1-C begins only after G9.
- F10 consumes verified runtime state; UI1-D begins after G10 and may not invent placeholders.
- Gate GUI follows G10. F11 requires both G10 and GUI and owns integrated release freeze.
- Physical gate order is G0, G1, GR, G2, G3, G4, G5, G6, G7, G8, G9, G10, GUI, G11.

Suggested owners and exclusive write scopes:

| Workstream | Write scope |
|---|---|
| Core security | `src/backends/**`, named core/integration guards, security tests |
| Rust engine | `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/crates/maos-industrial-engine/**`, protocol schemas, bridge/tests; never `rust/test.txt` |
| Application/API | `src/service/contracts/**`, app services, `api/**`, contract tests |
| Launcher/project service | `src/service/launcher/**`, `src/service/project-service/**`, lifecycle/security tests |
| GPU manager | `src/service/model-manager/**`, lease/queue tests |
| GUI shell/UX | `src/gui/**`, `tests/gui/**`; no engine logic |
| Offline/release | `scripts/industrial/**`, manifests, package/release config |
| OCR/vision | `industrial/python/**`, OCR/vision adapters/fixtures |
| Knowledge | `src/industrial/kb/**`, embedding/index/KB fixtures |
| Artifacts | office tools/templates and artifact tests |
| Sandbox | `industrial/container/**`, sandbox adapter/tests |
| Workflow/routing | task requirements, router/queue integration, industrial DAG |
| Sovereign evidence | endpoint/process identity, firewall/monitor/audit integration |
| Demo/docs | demo fixtures, CLI adapters, runbook after upstream freeze |
| Independent verifier | gate evidence only; no feature implementation in reviewed gate |

The coordinator owns shared generated contracts and merges. Agents must not regenerate or edit the same OpenAPI/schema output concurrently.

---

## 8. Estimate and prioritization

The previous 9–10 day estimate was not credible. A coherent judged prototype with mandatory Rust and locked GUI is approximately **85–135 experienced developer-days** (roughly **35–60 developer-days through GR/G3 before the main GUI/feature integration**, then **50–75** for feature engines, GUI, security, and release). This assumes hardware, model weights, container runtime, and native OCR dependencies are available. Parallel agents reduce elapsed time only after G3 and only with disjoint ownership.

Priority if time is constrained:

1. F0–F1 and R1/GR: truthful scope, trust boundary, mandatory deterministic authority;
2. F2–F3: offline bundle, typed application/API/event/provenance contracts;
3. UI1-A plus F4/F6/F7: secure shell and scanned-report-to-DOCX vertical slice;
4. UI1-B plus F8/F5: cockpit/model management, sandbox, KB;
5. F9 plus UI1-C: sovereign identity/evidence and complete required modules;
6. F10 plus UI1-D/Gate GUI: one-command operation and judged 15-minute journey;
7. F11/G11: reliability, exact release, three-run freeze.

Do not save time by faking stages, preloading a report as live output, using TypeScript as a judged fallback, allowing GUI shell-out to CLI, relabeling host execution as sandbox, weakening local API auth, opening multiple projects in MVP, or displaying unmeasured zero-egress claims.

---

## 9. Post-MVP roadmap

These items are intentionally outside the judged MVP and require separate review:

- [D] **P-01 — Rust transport optimization.** Consider a long-running daemon or N-API only if frozen subprocess latency/startup benchmarks justify complexity; preserve versioned schemas, fail-closed identity, parity, and offline packaging.
- [D] **P-02 — Multi-project GUI v1.1.** Enable parallel project windows/services using existing project-scoped APIs, sessions, identity, leases, and isolation; add cross-window manager UX without global current-project state.
- [D] **P-03 — Monaco and code workspace.** Temporary task workspace, diff/apply, sandbox-only terminal, then separately reviewed full IDE/branch/worktree UI.
- [D] **P-04 — GUI extensions.** Drag/drop, custom role presets, visual DAG editing, cross-project search, collaboration, voice, plugin marketplace, and Tauri packaging.
- [D] **P-05 — Office editing integration.** Evaluate safe direct editing only with local viewer/security/provenance controls; MVP remains open-in-installed-app.
- [D] **P-06 — Validated rule lifecycle.** Rule author approvals, broader units, signatures, asset classification, standards licensing, rollback, independent verification.
- [D] **P-07 — Strong audit signing.** Protected keys, canonical signing, rotation, immutable retention/recovery, external verification.
- [D] **P-08 — Production isolation.** VM/AppContainer/orchestrator policy, restricted identity, quotas, admission, secrets, patching, incident response.
- [D] **P-09 — Enterprise KB/operations.** ACL retrieval, deletion guarantees, multilingual/index monitoring, RBAC/SSO, SIEM, backup/HA, governance.
- [D] **P-10 — Wider multimodal support.** Handwriting/languages, symbols, table extraction, drawing revision comparison, adversarial documents.
- [D] **P-11 — Native multimodal provider contract.** Only if multiple non-tool providers require shared content parts; update all adapters/serialization/retry/telemetry/tests together.

---

## 10. Lead-review checklist

- [x] G0 requirements, GUI baseline, Rust authority, scope, machine, and claims approved
- [x] G1 trust boundaries and TS parity oracle verified
- [x] GR mandatory Rust engine, offline locked release, bridge, tests, and `rust/test.txt` preservation verified
- [x] G2 clean offline bundle and service identities verified
- [x] G3 typed application/OpenAPI/event/provenance contracts verified
- [x] UI1-A secure shell, launcher, project service, role/settings foundation verified
- [x] G4 OCR/vision benchmark passed
- [x] G5 local KB benchmark passed
- [x] G6 approved DOCX/XLSX/PPTX verified
- [x] G7 automatic routing, fixed workflow model, Rust DAG, and recovery verified
- [x] UI1-B chat/task/model manager/approvals/cockpit verified
- [x] G8 no-network container sandbox verified
- [x] G9 measured sovereign identity/audit/interruption evidence verified
- [x] UI1-C evidence/documents/KB/sandbox/audit/sovereign modules verified
- [x] G10 CLI/demo/one-command/application parity verified
- [x] UI1-D isolation/accessibility/e2e/one-project-v1.1 hooks verified
- [x] Gate GUI security and 15-minute novice journey independently approved
- [x] G11 clean release and three consecutive runs passed
- [x] Final recording captured from exact frozen release
- [x] Claims use measured F9 wording; limitations reviewed immediately before presentation
