# MAOS Industrial — Operator Runbook

This runbook guides operators, judges, and evaluators through the complete end-to-end setup, execution, verification, and recovery of **MAOS Industrial (Sovereign Solution Pack)**.

---

## 1. Prerequisites & Environment Checklist

The verified T-07 judged-run path uses local code and bundled synthetic fixtures, and makes no hosted-model call. Loopback service binding does not prove that the whole workstation is offline. For the packaged T-07 workflow, verify these dependencies:

| Component | Minimum Version | Verification Command | Purpose |
|---|---|---|---|
| **Node.js** | `>= 20.0.0` (LTS recommended) | `node --version` | Runtime for MAOS application services and CLI |
| **npm** | `>= 9.0.0` | `npm --version` | Package dependency management |
| **Python** | `>= 3.10` (workflow-dependent) | `python --version` | Required only for OCR, embedding, data-script, and selected sandbox workflows; not invoked by T-07 |
| **Docker** | `>= 24.0.0` (optional) | `docker info` | Container sandbox workflows |
| **Rust Engine** | Platform-matched release binary | `Test-Path .\rust\target\release\maos-engine.exe` (Windows project root) | Required for audit-chain hashing and verification; installed separately from the npm package |
| **Office Suite** | Optional desktop app | MS Word / LibreOffice (`soffice`) | Opens generated deliverables locally; not needed to generate or verify them |

### Canary Integrity Invariant
MAOS maintains a cryptographic canary file at `rust/test.txt`. Its SHA-256 hash must remain strictly unchanged:
```powershell
Get-FileHash -Algorithm SHA256 rust/test.txt
# Expected Hash: 1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435
```

---

## 2. Local Installation & Setup

1. **Clone or Navigate to Repository Root:**
   ```powershell
   cd c:\maos
   ```

2. **Install Dependencies:**
   ```powershell
   npm ci
   ```
   `npm ci` needs registry access or dependencies already present in the npm cache.

3. **Build the CLI and dashboard:**
   ```powershell
   npm run build
   ```

4. **Build the Rust audit engine if the release binary is missing:**
   ```powershell
   cargo build --release --locked --manifest-path rust/Cargo.toml
   ```
   On Windows, the binary is written to `rust/target/release/maos-engine.exe`.

### Runtime assets when using the npm package

The package contains the compiled CLI, GUI bundle (`dist/gui/`), Python scripts
(`dist/industrial/python/`), the Industrial starter profile, and four synthetic
T-07 inputs. It does not contain the platform-specific Rust audit engine. The
T-07 judged run does not invoke the Python scripts; OCR and embedding workflows
require a compatible Python runtime and their Python dependencies.

When using an installed package from a separate project, stage the packaged
fixtures under that project's root (the CLI reads project inputs there):

```powershell
$packageRoot = (Resolve-Path .\node_modules\maosorch).Path
$projectRoot = (Get-Location).Path
$demoRoot = Join-Path $projectRoot 'demo/industrial'
New-Item -ItemType Directory -Path $demoRoot -Force | Out-Null
Copy-Item (Join-Path $packageRoot 'demo/industrial/safety_thresholds.json') $demoRoot
Copy-Item (Join-Path $packageRoot 'demo/industrial/turbine_vibration_log.csv') $demoRoot
Copy-Item (Join-Path $packageRoot 'demo/industrial/maintenance_report.txt') $demoRoot
Copy-Item (Join-Path $packageRoot 'demo/industrial/turbine_inspection_scan.pdf') $demoRoot
$maosDir = Join-Path $projectRoot '.maos'
New-Item -ItemType Directory -Path $maosDir -Force | Out-Null
if (-not (Test-Path (Join-Path $maosDir 'maos.config.json'))) {
  Copy-Item (Join-Path $packageRoot 'profiles/industrial/maos.config.json') (Join-Path $maosDir 'maos.config.json')
}
```

For an existing config, merge the profile section instead of replacing project settings.

The dashboard and GUI bundle are included in the package. The demonstrated T-07 browser path does not need a local model server; only Chat requires one.

The npm package does **not** include the Rust engine. The checked source tree
pins Rust `1.95.0` in `rust/rust-toolchain.toml`; build the matching engine from
that checkout and copy it into the active project. Do not use a binary from an
unknown source.

```powershell
# Run from the MAOS source checkout after installing its pinned Rust toolchain.
cargo build --release --locked --manifest-path .\rust\Cargo.toml
$sourceEngine = (Resolve-Path .\rust\target\release\maos-engine.exe).Path
$targetEngine = Join-Path $projectRoot 'rust\target\release\maos-engine.exe'
New-Item -ItemType Directory -Path (Split-Path $targetEngine) -Force | Out-Null
Copy-Item -LiteralPath $sourceEngine -Destination $targetEngine
$sourceHash = (Get-FileHash -LiteralPath $sourceEngine -Algorithm SHA256).Hash
$targetHash = (Get-FileHash -LiteralPath $targetEngine -Algorithm SHA256).Hash
if ($sourceHash -ne $targetHash) { throw 'Staged Rust engine checksum differs from the source-built binary.' }
$health = '{"version":"1.0","operation":"health"}' | & $targetEngine | ConvertFrom-Json
if ($health.version -ne '1.0' -or $health.data.version -ne '0.1.0' -or $health.data.protocol_version -ne '1.0' -or $health.data.status -ne 'ok') {
  throw 'Rust engine health/version/protocol check failed.'
}
$health.data | Select-Object engine,version,protocol_version,status
```

The package-run-5 Windows binary responded as engine `maos-industrial-engine`,
version `0.1.0`, protocol `1.0`, status `ok`; its SHA-256 was
`b62c128a0101558662c8972df1e867b8f5c5537e7d84003ba6e804fc4efcc605` (472,064
bytes). This checksum is rehearsal evidence for that build, not a signed,
publisher-authenticated release checksum. Comparing the source-built and staged
files detects copy errors; it does not prove the source checkout or compiler is
trusted. The runtime bridge also checks protocol `1.0` and computes the binary
hash. No signed cross-platform engine release is currently distributed.

The CLI fails closed when the engine is missing. Its JSON error names
`<project-root>/rust/target/release/maos-engine[.exe]`, the Cargo build command,
and the copy step. The npm package does not bundle this prerequisite; whether
the hackathon evaluator accepts a separately built engine remains unconfirmed.

---

## 3. Host Preflight Verification

Run the unified industrial preflight diagnostic to check the process-scoped boundary, configuration integrity, and service identities:

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

The local CLI journey is available via `maos industrial` or the dedicated `maos-industrial` command. From a source checkout, build first with `npm run build` and invoke the dedicated entrypoint as `node .\dist\industrial\entrypoint.js`. The authenticated Browser Cockpit is launched through the separate Electron desktop-shell prerequisite below; the npm package supplies the shell and GUI assets, but not Electron or the Rust engine.

### Option A: The One-Command Judged Run (CLI)

The one-command run executes the full 6-stage judged workflow with cryptographic audit trail:
`PREFLIGHT → POLICY → SERVICES → DAG (Ingest → Analyze → Approval → Synthesize) → VERIFY → AUDIT EXPORT`

With `--enforce-firewall`, the run establishes a process-scoped boundary for its
own duration and executes **inside** it, then tears it down and persists the
observation trace. This is stronger than a one-time state check: the workflow is
observed while it runs.

#### 1. Headless Demo Run (With Explicit Confirmation)
```powershell
maos-industrial run --auto-approve --yes --json
```

This uses the explicitly confirmed demo auto-approval path; it is not a human
review. The JSON result includes the run ID. For a real reviewer decision, start
without auto-approval and complete the pending approval through the Cockpit.

**Pipeline Stages Executed:**
1. **Stage 1 (PREFLIGHT):** Checks process-scoped boundary and application diagnostics.
2. **Stage 2 (POLICY):** Loads `demo/industrial/safety_thresholds.json` (vibration warning 4.5 mm/s, critical 7.1 mm/s; temperature warning 85°C, critical 95°C).
3. **Stage 3 (SERVICES):** Initializes typed project services and logs genesis audit event.
4. **Stage 4 (DAG WORKFLOW):**
   - *Ingest:* Reads `turbine_vibration_log.csv` (500 rows), `maintenance_report.txt`, `turbine_inspection_scan.pdf`.
   - *Analyze:* Computes overall RMS (`2.63711 mm/s`) and evaluates excursions (Peak: 8.3 mm/s, Temp: 97.2°C → Verdict: `FAIL`).
   - *Approval Gate:* In the headless demo command, records the explicit synthetic `judge-evaluator` auto-approval. The Cockpit path is required for a real reviewer decision.
   - *Synthesize:* Generates verified OOXML deliverable at `artifacts/generated/turbine_safety_approval_note.docx`.
5. **Stage 5 (VERIFY):** Verifies the Rust-backed audit chain after report generation.
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

### Option B: Authenticated Cockpit through the Electron desktop shell — VERIFIED for the Windows test build

Use the installed package in a temporary project with the synthetic fixtures,
Industrial profile, and separately staged Rust engine from Sections 1–2. Install
the pinned shell runtime and launch from the project root:

```powershell
# Run in the isolated project after staging its fixtures, profile, and Rust engine.
npm install --save-exact electron@45.0.0 C:\path\to\maosorch-0.3.0.tgz
npx install-electron --no
$projectRoot = (Get-Location).Path
npx electron .\node_modules\maosorch\desktop\main.cjs --project-root $projectRoot --allow-temp
```

Node.js 22.12 or newer is required for the pinned Electron tooling; Node.js 20
or newer must be on `PATH` for the authenticated service child process. For a
non-temporary project, omit `--allow-temp`. The shell starts the
`ProjectHostLauncher`, selects runtime project root and ephemeral ports, and
passes a bound session to the top-level renderer over private Electron IPC.
REST and WebSocket requests are scoped to the configured project and exact
renderer origin. The session stays in memory and is not placed in a URL or
browser storage. The API and renderer bind loopback interfaces; this is not a
claim that the full workstation is offline.

The supported Windows test topology passed three consecutive installed-package
Electron/Playwright rehearsals on one tarball. They exercised pending-review
refresh/resume, approval, explicit rejection, source/rule stale-approval
failure, authenticated artifact download, matching audit linkage, and exact
returned-run-ID verification. Missing/invalid session, wrong project/origin,
and failed download cases were rejected. Each approved completed run remained
`FAIL` as its engineering verdict despite successful workflow execution. The
sanitized evidence is listed in `docs/MAOS_INDUSTRIAL_EXECUTION_CHECKLIST.md`.

This is the verified Windows test-shell path, not a signed installer. The old
direct CLI dashboard is a different loopback-only path and is not supported
release evidence. The Rust engine remains a separate prerequisite; publisher
signature and evaluator acceptance are unknown. Do not claim live Meta use: no
hosted request was made.

---

## 5. Opening & Inspecting Deliverables

MAOS Industrial generates a DOCX report, records its hash in the completed judged-run manifest, and delegates viewing to your installed desktop office application (Microsoft Word or LibreOffice):

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
# Verify the audit chain and one completed judged run
maos-industrial verify audit --run-id <run-id> --json
```
The command checks the Rust-backed audit chain and the run manifest, report, and
audit-export hashes for that run ID.

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
   - Only coordinated task queues and generated run outputs are pruned. Index, sandbox, and conversation reset categories fail closed because their active writers do not share the reset guard; stop the owning service and use its cleanup path.

---

## 8. Architectural Limits & Boundary Disclaimers

1. **Single-Project Boundary (MVP):**
   MAOS Industrial operates one service instance per canonical project root. Multi-project concurrent leasing is a post-MVP enhancement.
2. **Loopback Default:**
   The service defaults to `127.0.0.1` and an ephemeral port. Keep the default host for a local demo; `--host` can change the bind address.
3. **Local Persistence (No "Zero-Data-Left" Claim):**
   Audit chains (`.maos/audit/`), local caches, and generated deliverables persist on disk for auditability. This is not a regulatory compliance certification. Use `maos industrial reset -y` to clean test runs.
4. **Analysis and Audit:**
   The judged-run RMS and threshold calculations are implemented in TypeScript.
   The Rust engine backs audit-chain hashing and verification; it is not the
   arithmetic engine for this workflow.
5. **Web Browser Interface (No Tauri Claim):**
   The Cockpit GUI is a React Single Page Application (SPA) communicating over local REST and WebSocket protocols.
6. **Desktop Application Delegation:**
   Deliverables are viewed using native installed office suites (MS Office / LibreOffice). No embedded editor is simulated or claimed.
