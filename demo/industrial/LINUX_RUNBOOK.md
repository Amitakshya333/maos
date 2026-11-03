# Ring on Linux — Runbook (Dev B lane, `ring/linux`)

Proven on: **Debian GNU/Linux 13 (trixie)** (Kernel `6.18.54-instabox`) · `node v22.23.3` · `npm 10.9.9` · `rustc/cargo 1.99.0`.  
Branch: `ring/linux` (rebased onto `main` @ `e25badf`).  
No API key is needed for anything below (evidence-only mode). Never commit keys.

> Status 2026-11-03: The interactive `maos-industrial ring` REPL and headless `-p` mode
> are fully verified and operational on Debian Linux. The Dev A CLI integration,
> Dev C feel pass, and Dev B platform adapters are unified on this branch.

## 1. Clean VM to source

```bash
git clone https://github.com/Amitakshya333/maos.git && cd maos
git checkout ring/linux
node --version   # >= 20 required (VM: v22.23.3)
npm --version    # VM: 10.9.9
cat /etc/os-release | head -3   # Debian GNU/Linux 13 (trixie)
```

## 2. Backend build

```bash
npm ci
npm run build:backend   # tsc -p tsconfig.json + copy industrial python; must exit 0
```

## 3. Rust engine (Linux)

```bash
cargo build --release --locked --manifest-path rust/Cargo.toml
ls -la rust/target/release/maos-engine   # no .exe on Linux
sha256sum rust/target/release/maos-engine
# Verified Linux binary SHA-256:
# cf25c85192ff9ee92da5cecb11b03af0eb2c9674cdc5383c758df798db3716fc
```

`getDefaultEnginePath()` resolves `rust/target/release/maos-engine` on Linux
(`.exe` only when `process.platform === 'win32'`). Health check:

```bash
node -e "
const b = require('./dist/industrial/rust-engine-bridge.js');
const m = b.verifyExecutable(b.getDefaultEnginePath(process.cwd()));
console.log(JSON.stringify(b.engineHealth(m).data));"
# expect {"engine":"maos-industrial-engine","protocol_version":"1.0","rust_version":"1.95.0","status":"ok","unsafe_code":false,"version":"0.1.0"}
```

## 4. Packed-tarball install (what ships) & CLI link

```bash
sudo npm link   # or install from packed tarball
maos-industrial --help   # lists repl/bundle/rehearsal/evidence/kb/.../ring/verify/run/open
```

## 5. Audit verify passes on Linux (packed build, evidence-only)

```bash
maos-industrial verify audit -p /path/to/maos
# expect exit 0:
#   Chain Integrity: VERIFIED
#   Record Count:    0
#   Executable Hash: <sha256 of rust/target/release/maos-engine>
```

If the engine binary is missing, verification fails closed with:
`Engine executable not found: <path> ... build it with: cargo build --release --locked --manifest-path rust/Cargo.toml` — never a false pass.

## 6. Verified Ring CLI Runs on Linux (Evidence-Only)

All runs below executed with `unset BASETEN_API_KEY`:

### Run A: Telemetry analysis (exit 0)
```bash
maos-industrial ring -p "Give me the turbine vibration brief"
# Output:
# ▸ analyze_telemetry …
# ✓ analyze_telemetry · CRITICAL · RMS 2.637 · Verdict: CRITICAL
# Deterministic evidence-only answer: Telemetry verdict: CRITICAL; Overall Vibration RMS: 2.637 mm/s;
# Peak Vibration: 8.3 mm/s; Peak Temperature: 97.2 C; Rows analyzed: 500
# Exit code: 0
```

### Run B: Work order approval gate (exit 3)
```bash
maos-industrial ring -p "Raise a work order for the turbine vibration"
# Output:
# ▸ analyze_telemetry …
# ✓ analyze_telemetry · CRITICAL · RMS 2.637 · Verdict: CRITICAL
# Approve "create_work_order — Execute consequential tool create_work_order \"T-07 work order\""? [y/N]
# Run <id> is awaiting approval (headless never auto-approves).
# Exit code: 3 (AWAITING_APPROVAL)
```

### Run C: Equipment restart refusal (exit 2)
```bash
maos-industrial ring -p "Approve the turbine restart"
# Output:
# I cannot approve equipment restart or operation. Restarting or operating plant equipment
# requires an authorized human operator following site procedures; a Ring run approval covers
# evidence artifacts only and never authorizes operating the plant. No action was taken and no files were written.
# Exit code: 2 (REFUSED)
```

### Run D: Interactive REPL
```bash
maos-industrial ring
# Badge: [EVIDENCE-ONLY]
# /handover -> streams telemetry plan, prompts [y/N], writes artifact under .maos/ring-runs/
# /verify   -> runs live audit trail verification via Linux Rust engine
```

## 7. Linux platform checks & test suites

```bash
npx vitest run tests/industrial/ring-cli.test.ts tests/industrial/ring-linux-platform.test.ts tests/gui/ring-devb-surface.test.ts tests/gui/ring-workspace.test.ts
# 75 passed across 4 files:
#   tests/gui/ring-devb-surface.test.ts (44 passed)
#   tests/gui/ring-workspace.test.ts (13 passed)
#   tests/industrial/ring-cli.test.ts (10 passed)
#   tests/industrial/ring-linux-platform.test.ts (8 passed)
```

## 8. Windows-only modules: expected behavior on Linux

`WindowsFirewallAdapter` and `WindowsSocketObserver` throw structured
`not available on linux` errors (`FIREWALL_PLATFORM_UNSUPPORTED` / `OBSERVER_ADAPTER_ERROR`)
on live-host invocations, preventing ENOENT crashes or false-positive success.
Pure helpers (`generatePowerShellScript`, `platformName`) remain side-effect free.
Factory helpers auto-select Linux adapters.

## 9. Path / CRLF / case notes (observed on this VM)

- No CRLF or case-sensitivity failures in the Ring suites on Linux.
- Fixtures and artifact paths use forward slashes.
- T-07 scan text-layer extraction proven deterministically on Linux without external OCR.

## 10. Out of scope for this lane

Electron on Linux, systemd units, `.deb`/`.rpm` packaging. GUI remains
Windows-tested; `tests/gui/ring-*` pass on this VM via happy-dom.

