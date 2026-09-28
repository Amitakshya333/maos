# MAOS Industrial — Operator Runbook

This runbook guides operators, judges, and evaluators through the complete end-to-end setup, execution, verification, and recovery of **MAOS Industrial (Sovereign Solution Pack)**.

---

## 1. Prerequisites & Environment Checklist

MAOS Industrial operates entirely offline on local compute. Before beginning, verify host dependencies:

| Component | Minimum Version | Verification Command | Purpose |
|---|---|---|---|
| **Node.js** | `>= 18.0.0` (LTS recommended) | `node --version` | Runtime for MAOS application services and CLI |
| **npm** | `>= 9.0.0` | `npm --version` | Package dependency management |
| **Python** | `>= 3.10` | `python --version` | Local OCR, data scripts, and fallback sandbox |
| **Docker** | `>= 24.0.0` (Optional/Airgap) | `docker info` | Container sandbox isolation for untrusted code execution |
| **Rust Engine** | Pre-compiled binary | `.\bin\maos-industrial-engine.exe --version` | Authoritative parsing, decimal math, canonical SHA-256, and audit chain verification |
| **Office Suite** | Installed Desktop App | MS Word / LibreOffice (`soffice`) | Local viewer for verified deliverables (.docx, .xlsx, .pptx, .pdf) |

### Canary Integrity Invariant
MAOS maintains a cryptographic canary file at `rust/test.txt`. Its SHA-256 hash must remain strictly unchanged:
```powershell
Get-FileHash -Algorithm SHA256 rust/test.txt
# Expected Hash: 1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435
```

---

## 2. Offline Installation & Setup

1. **Clone or Navigate to Repository Root:**
   ```powershell
   cd c:\maos
   ```

2. **Install Local Dependencies (Offline / Cached):**
   ```powershell
   npm install
   ```

3. **Build Backend & Industrial Modules:**
   ```powershell
   npm run build:backend
   ```

4. **Verify Rust Industrial Engine Binary:**
   Ensure `bin/maos-industrial-engine.exe` is present and verified:
   ```powershell
   npm run test:rust
   ```

---

## 3. Host Preflight Verification

Run the unified industrial preflight diagnostic to verify boundary isolation, configuration integrity, and service identities:

```powershell
maos industrial preflight
```
*Expected Output:*
- Project Initialized: `PASSED`
- Config File Present: `PASSED`
- Retry & Dead Letter Queues Clean: `PASSED`
- `Scope: process` — the boundary constrains the MAOS process tree and its declared loopback endpoints
- `Host Firewall: NOT MODIFIED` — process scope writes no host packet filter rules
- `Boundary Self-Test: PASSED` — the boundary was established, measured, and torn down within the preflight process

To inspect in JSON format:
```powershell
maos industrial preflight --json
```

> **Do not enable Administrator privileges for this step, and do not add Windows
> Firewall rules.** The Industrial boundary is process-scoped: it needs no
> elevation and never touches host packet filter state. Preflight passes or fails
> on the boundary mechanism itself, not on your machine's firewall configuration.
> See [docs/BOUNDARY_SCOPE.md](../../docs/BOUNDARY_SCOPE.md).

### 3a. Boundary lifecycle (optional)

Preflight performs a self-test and leaves no boundary behind — a process-scoped
boundary only exists for the lifetime of the process that holds it. To inspect or
hold a boundary explicitly:

```powershell
maos industrial boundary status      # re-measured live; writes nothing
maos industrial boundary enable --yes   # hold a boundary for this host
maos industrial boundary disable --yes  # tear down and persist the observation trace
```

`disable` writes the passive observation trace to `.maos/network-evidence/` as
durable evidence of what the boundary observed.

---

## 4. Judged D7 Journey: Execution Options

You can execute the complete industrial journey via the **One-Command CLI** or interactively through the **Browser Cockpit**.

### Option A: The One-Command Judged Run (CLI)

The one-command run executes the full 6-stage judged workflow with cryptographic audit trail:
`PREFLIGHT → POLICY → SERVICES → DAG (Ingest → Analyze → Approval → Synthesize) → VERIFY → AUDIT EXPORT`

With `--enforce-firewall`, the run establishes a process-scoped boundary for its
own duration and executes **inside** it, then tears it down and persists the
observation trace. This is stronger than a one-time state check: the workflow is
observed while it runs.

#### 1. Live Automated Run (With Explicit Confirmation)
```powershell
maos industrial run --auto-approve --yes
```

**Pipeline Stages Executed:**
1. **Stage 1 (PREFLIGHT):** Checks host boundaries, local binary presence, queue states.
2. **Stage 2 (POLICY):** Loads `demo/industrial/safety_thresholds.json` (vibration warning 4.5 mm/s, critical 7.1 mm/s; temperature warning 85°C, critical 95°C).
3. **Stage 3 (SERVICES):** Initializes typed project services and logs genesis audit event.
4. **Stage 4 (DAG WORKFLOW):**
   - *Ingest:* Reads `turbine_vibration_log.csv` (500 rows), `maintenance_report.txt`, `turbine_inspection_scan.pdf`.
   - *Analyze:* Computes overall RMS (`2.63711 mm/s`) and evaluates excursions (Peak: 8.3 mm/s, Temp: 97.2°C → Verdict: `FAIL`).
   - *Approval Gate:* Records human sign-off (`lead` role) authorizing generation of the safety report.
   - *Synthesize:* Generates verified OOXML deliverable at `artifacts/generated/turbine_safety_approval_note.docx`.
5. **Stage 5 (VERIFY):** Cryptographically verifies deliverable signature and audit chain.
6. **Stage 6 (AUDIT EXPORT):** Emits and seals complete audit export to `artifacts/generated/judged-run-audit-export.json`.

#### 2. Interactive Human Gate Defense (Demonstration of Fail-Closed Gate)
To demonstrate that human approval cannot be bypassed without explicit operator confirmation:
```powershell
# Attempt auto-approval without explicit confirmation flag:
maos industrial run --auto-approve
# Exits with Code 4: CONFIRMATION_REQUIRED

# Run interactive workflow without auto-approval:
maos industrial run
# Halts at Gate with Exit Code 10: GATE_REJECTED (Awaiting Human Lead Sign-off)
```

---

### Option B: The Interactive Cockpit Journey (Web GUI)

For a visual demonstration of the multi-agent DAG, live task cards, human gate approvals, and audit trail:

1. **Start the pinned local model server in its own PowerShell window:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/start-industrial-model-server.ps1
   ```
   Leave the window open. Wait for the startup message showing the local model is loaded. The launcher requires the pinned model and Python runtime to already be present; it never downloads either.

2. **Build and launch the dashboard from the repository root in another window:**
   ```powershell
   npm run build
   npm start
   ```
   Open `http://127.0.0.1:3847/#/cockpit`. To use chat, open `/#/chat`; the model service must still be running on `http://127.0.0.1:8000`.

3. **Step-by-Step UI Journey (D7 Clicks):**
   - **Click 1 (Navigation):** Click on **Cockpit / Industrial** in the left sidebar.
   - **Click 2 (Workflow Inspection):** View the 4-stage pipeline graph:
     - `INGEST_DATA` (Ingest CSV, PDF scan, and maintenance logs)
     - `ANALYZE_TELEMETRY` (Deterministic RMS arithmetic and threshold checks)
     - `HUMAN_APPROVAL_GATE` (Mandatory human-in-the-loop review)
     - `SYNTHESIZE_DELIVERABLE` (Generate signed `.docx` safety note)
   - **Click 3 (Trigger Run):** Click **Run Industrial Workflow**.
   - **Click 4 (Review Anomaly Findings):** Inspect the anomaly cards:
     - Row 121: 5.2 mm/s (WARNING)
     - Row 367: 8.3 mm/s (CRITICAL)
     - Temperature excursion: 97.2 °C (CRITICAL)
   - **Click 5 (Approval Decision):** Under **Pending Approvals**, review the safety summary, select decision **APPROVE**, provide reviewer notes ("Authorized for field maintenance"), and click **Submit Decision**.
   - **Click 6 (Inspect Deliverable):** Once `SYNTHESIZE_DELIVERABLE` completes, view the generated artifact card displaying `turbine_safety_approval_note.docx`, file size, and SHA-256 hash.
   - **Click 7 (Verify Audit):** Navigate to the **Audit** tab and verify the green badge indicating Rust-verified chain integrity.

---

## 5. Opening & Inspecting Deliverables

MAOS Industrial generates cryptographically signed deliverables and delegates viewing to your installed desktop office application (Microsoft Word or LibreOffice):

```powershell
# Safe launch of the generated safety approval note (auto-detects Word / LibreOffice)
maos industrial open artifacts/generated/turbine_safety_approval_note.docx

# Dry-run validation (verifies confinement, hash, and launch command without spawning window)
maos industrial open artifacts/generated/turbine_safety_approval_note.docx --dry-run

# Output structured launch metadata in JSON
maos industrial open artifacts/generated/turbine_safety_approval_note.docx --dry-run --json
```

### Negative Security Invariants in `maos industrial open`
The open command enforces strict security boundaries:
- **No Remote URLs:** Rejects `http://`, `https://`, `ftp://`, `file://`, and UNC paths (`\\server\share`).
- **No Shell Injection:** Rejects control characters (`;`, `&`, `|`, `` ` ``, `$`, `>`, `<`, newlines).
- **No Path Traversal:** Rejects `..` sequences escaping project root.
- **Allowed Extensions Only:** Strictly restricts opening to `.docx`, `.xlsx`, `.pptx`, `.pdf`. Executables (`.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`) are unconditionally rejected.
- **No Embedded Editor:** Delegates directly to native desktop software; no embedded web editor is claimed.

---

## 6. Audit Trail & Cryptographic Verification

Verify that the append-only audit log has not been tampered with:

```powershell
# Verify audit chain via native Rust engine
maos industrial verify --target audit --json
```
*Expected Output:* `{"target": "audit", "verification": {"valid": true, "errors": []}}`

Inspect the sealed export from the judged run:
```powershell
Get-Content artifacts/generated/judged-run-audit-export.json | ConvertFrom-Json | Select-Object runId, status, chainLength
```

---

## 7. Fault Tolerance, Stop & Recovery

### Graceful Stop vs. Force Stop
```powershell
# Graceful stop: Finishes in-flight tasks, then halts cleanly
maos industrial stop

# Force stop: Immediately interrupts running tasks, cleans temporary files, emits audit event
maos industrial stop --force --yes
```

### Deterministic Reset of Test State
To return to a clean evaluation state without losing source code, demo inputs, or canary files:

1. **Dry-Run Inspection (Shows candidate files without deleting):**
   ```powershell
   maos industrial reset --dry-run
   ```

2. **Confirmed Live Reset:**
   ```powershell
   maos industrial reset --yes
   ```
   *Protected Invariants:*
   - `demo/industrial/` inputs (`turbine_vibration_log.csv`, `maintenance_report.txt`, etc.) are **never** removed.
   - `rust/test.txt` canary is **never** touched.
   - Only generated task queues, temporary sandbox mounts, ephemeral indices, and run outputs are pruned.

---

## 8. Architectural Limits & Boundary Disclaimers

1. **Single-Project Boundary (MVP):**
   MAOS Industrial operates one service instance per canonical project root. Multi-project concurrent leasing is a post-MVP enhancement.
2. **Loopback Only:**
   Services bind exclusively to `127.0.0.1` on ephemeral or user-designated ports. No public interfaces or WAN ports are opened.
3. **Local Persistence (No "Zero-Data-Left" Claim):**
   Audit chains (`.maos/audit/`), local caches, and generated deliverables persist locally on disk for regulatory compliance and auditability. Use `maos industrial reset -y` to clean test runs.
4. **Authoritative Rust Engine (No Deferred Rust):**
   The Rust executable (`maos-industrial-engine.exe`) is pre-compiled, verified via SHA-256 manifest, and actively authoritative for all decimal math and audit chains.
5. **Web Browser Interface (No Tauri Claim):**
   The Cockpit GUI is a React Single Page Application (SPA) communicating over local REST and WebSocket protocols.
6. **Desktop Application Delegation:**
   Deliverables are viewed using native installed office suites (MS Office / LibreOffice). No embedded editor is simulated or claimed.
