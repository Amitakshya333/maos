# MAOS Industrial — 3–5 Minute Judged Presentation Script

This script is structured for live evaluation by judges and industrial operators. It demonstrates sovereign execution, deterministic mathematics, human-in-the-loop governance, and verifiable audit sealing.

---

## 🕒 Timing & Scene Breakdown

### Act 1: The Problem & Sovereign Architecture (0:00 – 0:45)
- **Speaker:**
  > "Welcome. Industrial operators of critical infrastructure—like power turbines, refineries, and manufacturing plants—cannot send sensor telemetry or incident logs to third-party cloud LLMs. That exposes proprietary operational data and violates sovereignty mandates.
  >
  > MAOS Industrial is a sovereign multi-agent solution running entirely on local infrastructure. It binds strictly to loopback `127.0.0.1`, operates with zero WAN calls, and enforces mathematical certainty: AI agents coordinate and explain findings, while a native Rust industrial engine guarantees decimal-accurate RMS arithmetic and tamper-evident audit sealing."

- **Screen Action:**
  - Show terminal in `C:\maos`.
  - Run preflight check:
    ```powershell
    maos industrial preflight
    ```
  - Point to `Boundary Status: VERIFIED / Ephemeral Loopback` and `Project Initialized: PASSED`.

---

### Act 2: The Data Pack & Ruleset (0:45 – 1:30)
- **Speaker:**
  > "Our demonstration pack is completely non-proprietary and licensed under CC0 / MIT. It contains 500 real-world vibration readings, a maintenance log, an inspection scan PDF, and a demonstration safety ruleset.
  >
  > Notice that we never claim this ruleset is a certified regulatory standard—it is an explicit demonstration ruleset defined in `safety_thresholds.json`. Warning threshold is 4.5 mm/s; critical is 7.1 mm/s."

- **Screen Action:**
  - Quickly show `demo/industrial/safety_thresholds.json` and `demo/industrial/turbine_vibration_log.csv`.
  - Highlight the cryptographic canary hash ensuring repository integrity:
    ```powershell
    Get-FileHash -Algorithm SHA256 rust/test.txt
    ```

---

### Act 3: The One-Command Judged Run & Approval Gate (1:30 – 2:45)
- **Speaker:**
  > "Now we execute the complete judged workflow. Watch how MAOS Industrial enforces fail-closed human governance. If an operator tries to bypass the gate without explicit confirmation, execution halts immediately."

- **Screen Action (Negative Defense Demonstration):**
  - Run unconfirmed command:
    ```powershell
    maos industrial run --auto-approve
    ```
  - Show exit code 4: `CONFIRMATION_REQUIRED: --auto-approve requires explicit confirmation flag (-y or --yes).`

- **Speaker:**
  > "Now we run the complete verified journey with explicit confirmation:"

- **Screen Action (Full Judged Run):**
  - Run:
    ```powershell
    maos industrial run --auto-approve --yes
    ```
  - Narrate the 6 stages as they complete:
    1. **PREFLIGHT:** Verified local engine binary and loopback boundary.
    2. **POLICY:** Verified thresholds against safety ruleset.
    3. **SERVICES:** Initialized typed container and genesis audit event.
    4. **DAG WORKFLOW:**
       - *Ingest:* Processed 500 CSV rows, PDF inspection, and maintenance report.
       - *Analyze:* Rust engine computed exact overall RMS of `2.63711 mm/s`. Found critical excursion of `8.3 mm/s` (row 367) and temperature `97.2 °C`.
       - *Approval Gate:* Recorded authenticated Lead Engineer sign-off.
       - *Synthesize:* Generated signed OOXML `.docx` safety note.
    5. **VERIFY:** Verified deliverable signature and audit chain.
    6. **AUDIT EXPORT:** Exported and sealed sovereign audit bundle.

---

### Act 4: Deliverable Inspection & Office Delegation (2:45 – 3:45)
- **Speaker:**
  > "MAOS Industrial does not simulate or pretend to have an embedded office editor. It delegates viewing directly to your installed desktop software—Microsoft Word or LibreOffice—while sanitizing paths and preventing shell injection."

- **Screen Action:**
  - Open the generated deliverable:
    ```powershell
    maos industrial open artifacts/generated/turbine_safety_approval_note.docx
    ```
  - (Or show `--dry-run` with launch parameters in air-gap/headless environments):
    ```powershell
    maos industrial open artifacts/generated/turbine_safety_approval_note.docx --dry-run
    ```
  - Point to the generated Word document:
    - Overall Verdict: `FAIL`
    - Cites exact row 121 (5.2 mm/s WARNING) and row 367 (8.3 mm/s CRITICAL).
    - Cites corroborating maintenance log excerpt.
    - Displays mandatory ruleset disclaimer and cryptographic SHA-256 hash.

---

### Act 5: Tamper-Evident Audit Chain & Architectural Honesty (3:45 – 4:30)
- **Speaker:**
  > "Finally, let's look at audit integrity. Every single action—ingestion, analysis, approval, synthesis, and opening—is written to an append-only log hash-linked and verified by our Rust industrial engine."

- **Screen Action:**
  - Run audit chain verification:
    ```powershell
    maos industrial verify --target audit
    ```
  - Show: `Audit Chain Valid: true (Rust engine verified)`.

- **Speaker:**
  > "To conclude with complete architectural honesty:
  > 1. **No zero-data-left claims:** Audit records and generated deliverables persist locally on disk for regulatory compliance; clean reset is performed via `maos industrial reset -y`.
  > 2. **No deferred Rust:** The native Rust binary is active and authoritative right now.
  > 3. **Single project MVP:** One service per project root, bound strictly to loopback.
  > 4. **Standard Web SPA:** Browser cockpit over HTTP/WebSocket, not Tauri.
  >
  > MAOS Industrial proves that mission-critical, confidential AI operations can be sovereign, deterministic, and auditable. Thank you."

---

## 🛠️ Recovery & Contingency Instructions

- **If live Word launch is blocked by OS permissions:**
  Execute `maos industrial open artifacts/generated/turbine_safety_approval_note.docx --dry-run --json` to demonstrate parameter validation and safe command formulation without GUI spawning.
- **If Docker sandbox is not running:**
  MAOS automatically falls back to in-process verified calculation fixtures (`fixtures/f8-05/`) with identical mathematical outputs.
- **To clean up after the presentation:**
  Run `maos industrial reset --dry-run` to inspect, then `maos industrial reset --yes` to reset test artifacts cleanly.
