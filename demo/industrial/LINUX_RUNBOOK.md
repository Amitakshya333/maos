# Ring on Linux — Runbook (Dev B lane, `ring/linux`)

Proven on: **Debian GNU/Linux 13 (trixie)** · `node v22.23.3` · `npm 10.9.9` ·
`rustc/cargo 1.99.0`. Branch: `ring/linux` @ `cb93995` + Dev B commits.
No API key is needed for anything below (evidence-only). Never commit keys.

> Status 2026-11-02: the interactive `maos-industrial ring` REPL is
> **Dev A lane work and does not exist on this branch yet** — running
> `maos-industrial ring` today exits 1 with
> `error: too many arguments. Expected 0 arguments but got 1.`
> Everything else below is verified working on this VM. The exact
> first-`ring`-prompt command for after Dev A lands is in step 7.

## 1. Clean VM to source

```bash
git clone <repo-url> maos && cd maos
git checkout ring/linux
node --version   # >= 20 required (VM: v22.23.3)
npm --version
cat /etc/os-release | head -3   # expect Debian GNU/Linux 13 (trixie)
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
```

`getDefaultEnginePath()` resolves `rust/target/release/maos-engine` on Linux
(`.exe` only when `process.platform === 'win32'`). Health check:

```bash
node -e "
const b = require('./dist/industrial/rust-engine-bridge.js');
const m = b.verifyExecutable(b.getDefaultEnginePath(process.cwd()));
console.log(JSON.stringify(b.engineHealth(m).data));"
# expect {"engine":"maos-industrial-engine",...,"status":"ok",...}
```

## 4. Packed-tarball install (what ships)

```bash
npm pack --pack-destination /tmp/ring-pack
rm -rf /tmp/ring-install && mkdir -p /tmp/ring-install
npm install --prefix /tmp/ring-install /tmp/ring-pack/maosorch-0.3.0.tgz
export PATH="/tmp/ring-install/node_modules/.bin:$PATH"
maos-industrial --help   # lists repl/bundle/rehearsal/evidence/kb/.../verify/run/open (no `ring` yet)
```

## 5. Audit verify passes on Linux (packed build, evidence-only)

```bash
maos-industrial verify audit -p /path/to/maos
# expect exit 0:
#   Chain Integrity: VERIFIED
#   Record Count:    0
#   Executable Hash: <sha256 of rust/target/release/maos-engine>
```

If the engine binary is missing, verification fails closed with
`Engine executable not found: <path> ... build it with: cargo build
--release --locked --manifest-path rust/Cargo.toml` — never a false pass.

## 6. Evidence-only Ring proof (no key, closest to `ring` on this branch)

```bash
unset BASETEN_API_KEY
node -e "
const { RingAgentService } = require('./dist/service/ring-agent-service.js');
const { AuditService } = require('./dist/service/audit-service.js');
(async () => {
  const svc = new RingAgentService({ projectRoot: process.cwd(), auditService: new AuditService(process.cwd()) });
  const id = svc.startRun('Analyze turbine T-07 vibration telemetry, read the turbine_inspection_scan PDF, and verify the audit export');
  const s = await svc.waitForCompletion(id, 60000);
  console.log(s.status, s.mode);
  console.log((s.finalAnswer || '').slice(0, 300));
})();"
# expect: completed evidence-only
# Telemetry verdict: CRITICAL; Overall Vibration RMS: 2.637 mm/s; ... Rows analyzed: 500
# verify_export: Live audit trail verified (0 records).
# ocr_document: TURBINE INSPECTION LOG: BEARING CLEARANCE 0.050 mm  (text-layer, no OCR engine)
```

T-07 scan text layer is extracted deterministically from the embedded PDF
text (stdlib + zlib only) — proven on Linux, no Python/OCR needed for it.
True scans without a text layer fall through to the real OCR engine and
report honestly when it is unavailable.

## 7. First `ring` prompt (after Dev A lands)

```bash
unset BASETEN_API_KEY
maos-industrial ring
# expect mode badge: EVIDENCE-ONLY
# /handover -> plan streams, tools stream, approval [y/N] defaults No, artifacts land
# under .maos/ring-runs/artifacts/<runId>/, /verify checks the chain
```

Headless (Dev A): `maos-industrial ring -p "<instruction>" [--json]`.
Headless never auto-approves: consequential steps end `awaiting_approval`, exit 3.

## 8. Linux platform checks (this lane's tests)

```bash
npx vitest run tests/industrial/ring-linux-platform.test.ts
# 8 passed: Windows firewall/socket adapters reject honestly
# ("not available on linux", FIREWALL_PLATFORM_UNSUPPORTED /
# OBSERVER_ADAPTER_ERROR), factories auto-select linux, engine path has no
# .exe, T-07 scan text layer extracts.
npx vitest run tests/industrial/ring-* tests/gui/ring-*
npm run typecheck:gui
```

## 9. Windows-only modules: expected behavior on Linux

`WindowsFirewallAdapter` and `WindowsSocketObserver` throw a structured
`not available on linux` error on every live-host method (never ENOENT crash,
never empty-list false success). Pure helpers (`generatePowerShellScript`,
construction, `platformName`) stay side-effect free. Production code already
selects adapters via `createPlatformFirewallAdapter()` /
`createPlatformSocketObserver()`, which resolve to the Linux adapters here.

## 10. Path / CRLF / case notes (observed on this VM)

- No CRLF or case-sensitivity failures in the Ring suites on Linux.
- Fixtures and artifact paths use forward slashes; evidence-root checks reuse
  the `isWithin`/`isStrictlyWithin` pattern (Windows backslash receipts such as
  `C:\t` in GUI tests are test doubles, not host paths).
- `rust/test.txt` canary: **absent from the `ring/linux` branch**
  (never committed in this repo). The canary assertions in
  `f9-03` / `f9-04` / `f10-06` fail with ENOENT on a clean checkout —
  pre-existing, unrelated to this lane (see handoff summary).

## 11. Out of scope for this lane

Electron on Linux, systemd units, `.deb`/`.rpm` packaging. GUI remains
Windows-tested; `tests/gui/ring-*` pass on this VM via happy-dom.
