# MAOS Production-Readiness Audit

Date: 2026-09-19
Scope: Independent audit of the implemented F0, F1, R1, F2, F3, UI1-A, and F4 work.

## Executive conclusion

The implementation is substantially hardened and the executable test/build paths are green, but the repository is **not yet a fully deployable offline production release**. The code now fails closed when required offline assets are absent or invalid. Production acceptance remains conditional on completing the offline stores, live VLM benchmark, governance evidence, and release reproducibility work listed below.

This report is independent of the milestone reports. Historical verification reports were not rewritten to hide contract changes or limitations.

## Verification performed

| Check | Result |
|---|---|
| `npm test` | **44 test files, 1,053 tests passed** |
| `npm run build:backend` | **Passed** |
| `npm run typecheck:gui` | **Passed** |
| `npm run build` | **Passed**; Vite transformed 55 modules and emitted `dist/gui` |
| `cargo fmt --manifest-path rust/Cargo.toml --all -- --check` | **Passed** |
| `cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --locked -- -D warnings` | **Passed** |
| `cargo test --manifest-path rust/Cargo.toml --workspace --all-targets --locked` | **40 passed, 0 failed** |
| `sha256sum rust/test.txt` | **Unchanged**: `1392245502333919f23e58b8f544f12470db3829aabd5336a011e58d2b733435` |
| Cross-process residency regression | **2/2 passed** |
| Lifecycle suite after strict-install change | **43/43 passed** |
| Artifact store focused suite after cleanup fix | **25/25 passed** |

## Fixes made during this audit

### 1. Audit-chain diagnostics

`AuditService.verifyChain()` now always runs the Rust verifier for non-empty logs and merges external-head diagnostics with engine diagnostics. Sequence gaps, broken `previous_hash` links, reordering, and head-anchor mismatches are no longer masked by an early return.

### 2. Session bootstrap security

Unauthenticated HTTP `POST /api/v1/auth/handshake` no longer mints a privileged session. Initial sessions must come from the trusted launcher/Node IPC path. HTTP handshake is now an authenticated rotation operation only. The GUI clients and tests use launcher-issued in-memory sessions.

The session token remains RAM-only and is never written to identity files, URLs, logs, audit records, or browser storage.

### 3. Bounded child-process execution

Windows process termination now observes `taskkill`, bounds kill completion, falls back to child termination, and prevents hung promises after timeout/output-limit termination.

### 4. Artifact rollback and orphan recovery

Post-rename metadata/event failures restore the prior artifact state or remove the new artifact. Orphan cleanup now treats `maxAgeMs <= 0` as an unconditional recovery sweep, avoiding filesystem timestamp-resolution races for freshly-created temporary files.

Residual event transaction limitations are documented below.

### 5. Bundle command and manifest hardening

Dynamic npm/pip commands use argument arrays rather than shell interpolation. Option-like requirement lines are rejected. Bundle manifest validation now checks schema, identity, hashes, confinement, duplicate entries, totals, symlink/junctions, regular-file status, and uncached file hashes. Archive staging verifies package entries and the manifest.

`bundlePrepare --skip-tests` now skips only test execution; the TypeScript/GUI build always runs so a release cannot intentionally package stale or missing runtime output.

### 6. Cross-process model-residency guard

A file-backed, lock-protected global residency registry now rejects competing live project-host ownership, recovers dead PID ownership, and releases claims on lease release/unload/process exit. Regression coverage verifies claim conflict, unload handoff, and dead-owner recovery.

This is a fail-closed ownership guard, not a dedicated model-manager process; that limitation remains explicit below.

### 7. Strict lifecycle installation semantics

Default `lifecycleInstall()` now validates all six offline stores before writing `installed` state. Incomplete stores return `INSTALL_FAILED` with per-store diagnostics. The explicit `stateOnly` option exists only for state-machine test fixtures and is not enabled by the production dispatcher.

## New authenticated-session contract

The supported startup sequence is:

1. The launcher validates the project and starts the child host.
2. The host creates a session over private Node IPC.
3. The launcher passes the token to the GUI in memory.
4. The GUI may call authenticated HTTP handshake to rotate that session.
5. REST and WebSocket requests use the active in-memory token.

Public HTTP handshake minting is intentionally rejected with `401`. This prevents any loopback HTTP caller that can reach the port from bootstrapping privileged access without launcher authorization.

## Offline-store inventory

The actual repository readiness check returned `ready: false`:

| Store | Status | Finding |
|---|---|---|
| npm | Invalid | Cache manifest SHA-256 does not match the current `package-lock.json`; the package inventory is not trustworthy for this checkout |
| Rust vendor | Valid | 1,337 vendor files and vendor Cargo configuration validated |
| Python wheels | Valid by current validator | 44 wheel/archive files; all 42 locked distributions present; full wheel hash/ABI/installability validation remains open |
| Tesseract | Invalid | Required version, relative path, and 64-character SHA-256 manifest fields are absent/invalid |
| Sandbox image | Invalid | `image.tar` is empty or too small to be a Docker save archive |
| Text-model snapshot | Valid | Qwen2.5-3B-Instruct, 9 files, hashes verified |
| Pinned VLM snapshot | **Absent** | Qwen2-VL-2B-Instruct revision `aa70c964147048705c93c4e16ff2bc55255470d0` is declared in the manifest, but its snapshot directory is absent |

Consequences:

- Offline readiness and default production lifecycle install correctly fail closed.
- Real `analyze_image`/VLM execution fails closed when the pinned snapshot is unavailable.
- F4-04 is a pin/harness implementation, not a verified live benchmark on this checkout.
- F4-07 contains useful deterministic/simulation and negative-guard coverage, but it is not a substitute for measured hardware acceptance.

## Remaining production blockers and limitations

### Release packaging

- Archive timestamps, mtimes, and compression metadata are not normalized; reproducibility claims are not independently established.
- Python wheel validation does not yet verify every wheel hash, ABI/platform compatibility, or actual offline installation in a clean target.
- Sandbox validation does not fully validate all archive members/digests or execute a controlled `docker load` verification.
- Tesseract validation still needs canonical symlink handling and execution of the declared binary/version.
- The npm store and the pinned VLM store must be rebuilt from authoritative payloads, not marker files.

### Model ownership

The file-backed global registry serializes claims across project-host processes and fails closed, but actual model loading is still performed by the host-side manager. A dedicated model-manager process/service is still required if the final architecture demands process-level weight ownership rather than a cross-process guard.

### Artifact/event transaction boundary

If `EventService.recordEvent()` durably appends an event and then throws afterward, the append-only event cannot be removed during artifact rollback. The current code restores artifact and metadata files and reports rollback failure when restoration fails, but it cannot provide an atomic cross-store transaction. A durable two-phase finalization/event protocol is the follow-up for stronger transactional guarantees.

### Audit-chain external anchor

The `.maos/audit/audit-head.json` anchor detects head replacement/truncation relative to the stored anchor, while the Rust chain verifier detects internal record modification, deletion, insertion, and reordering. The anchor itself still requires protection by the deployment filesystem/OS trust boundary; it is not an external append-only notarization service.

### Governance and acceptance evidence

The following plan-level items remain open or conditional and were not falsely marked complete:

- F0-01: official SIH requirement capture is incomplete.
- F0-03: coder/embedding freeze evidence is incomplete.
- F0-06: resource budgets are largely estimated rather than measured.
- G0: no valid independent gate artifact.
- R1-11: required fuzz/property corpus is absent.
- R1-12: measured deterministic benchmark evidence is absent.
- R1-13: SBOM/license/release evidence is absent.
- GR: open/contradictory governance status.
- G2: conditional/disputed while offline stores are invalid.
- G3: implementation tests pass, but governance acceptance is conditional.
- F4-04: no live measured VLM benchmark with the pinned snapshot.
- F4-07: simulation coverage exists; measured acceptance is incomplete.
- G4: remains open pending independent closure evidence.

## Safety invariants verified

- `rust/test.txt` was not modified.
- REST and WebSocket access remain loopback-confined.
- URL/query token rejection remains enforced.
- Session tokens remain in memory only.
- CSP and non-wildcard origin rules remain enforced.
- Project-root and symlink/junction confinement remain enforced.
- Artifact reads require finalized metadata and content-hash verification.
- Unknown model IDs are not dynamically registered.
- VLM/OCR/PDF paths do not use canned or synthetic production output.
- Safety-critical OCR/VLM observations remain human-review gated.
- Audit persistence failures propagate rather than becoming phantom success.

## Release decision

**Engineering implementation status:** hardened and regression-green.

**Offline production release status:** blocked. Do not claim a completed air-gapped production release until the invalid/missing stores, live VLM benchmark, reproducible archive evidence, and governance gates above are completed and independently verified.
