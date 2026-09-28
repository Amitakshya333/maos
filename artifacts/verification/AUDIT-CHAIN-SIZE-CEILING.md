# Audit Chain Size Ceiling — Verification Finding

> **Status:** Request-size failure fixed with bounded verification windows; storage growth and test isolation remain open
> **Date:** 2026-09-27 IST
> **Severity:** High — audit verification previously failed above one request's byte limit
> **Related:** [F9-11](F9-11.md) (append lock), [F3-06](../../tests/f3-06-audit-events.test.ts) (audit events)

---

## Symptom

The interrupted handoff reported a full test-suite run with 35 failures across 18 files. The dominant cluster
was every audit-dependent surface at once:

```
cryptographically verifies hash chain integrity of the audit log
exports complete audit trail containing sealed cryptographic records
verifies audit chain via application services
POST /api/v1/audit/verify cryptographically verifies the audit chain
GET /api/v1/audit/export exports entire audit trail with verification bundle
GET /api/v1/sovereignty/panel returns aggregated boundary, processes, and allowlist
apiAdapter delegates verifyAuditChain correctly
...plus every judged run, because its VERIFY stage validates the chain
```

At that time, the audit-dependent failures traced to this throw:

```
EngineError: Request exceeds 1 MB size limit
```

## Root cause

Before the fix, `engineChainVerify` submitted the **entire** audit chain in one
engine request:

```ts
// src/industrial/rust-engine-bridge.ts
export function engineChainVerify(manifest, chain) { // historical implementation
  return invokeEngine(manifest, {
    version: EXPECTED_PROTOCOL_VERSION,
    operation: 'chain-verify',
    data: { chain },        // ← whole chain, one request
  });
}
```

Each engine request is bounded at 1 MiB in **two** places, deliberately kept in sync:

| Side | Location | Bound |
| --- | --- | --- |
| TypeScript | `src/industrial/rust-engine-bridge.ts` | `MAX_ENGINE_REQUEST_BYTES = 1_048_576` |
| Rust | `rust/crates/maos-industrial-engine/src/main.rs` | `MAX_REQUEST_BYTES = 1_048_576`, enforced by the bounded line reader |

At roughly **570 bytes per record**, 1 MiB capped the verifiable chain at about
**1,800 records**. A larger chain caused `verifyChain()` to throw for every
caller, and the append path also validated the existing chain before writing.
That made the failure persistent until the request path was fixed.

This repository's chain was at **2,057 records / 1.12 MB** when it crossed.

## Why it crossed

The handoff observed that the audit chain lives in the real project root
(`.maos/audit/audit-chain.jsonl`) and that multiple suites instantiate services
against the repository itself rather than a temporary directory. It measured
roughly **800 records per full run** being appended to the project chain. That
test-hygiene issue remains to be addressed; tests should not mutate operator data.

There is **no rotation or archival mechanism**. The handoff found no producer for
the `audit-chain-history.jsonl` or `audit-chain-archive.jsonl` files in `src/`,
`scripts/`, or the Rust crates.

## Fix applied

The temporary 16 MiB ceiling increase was replaced with **byte-bounded,
windowed verification**. `AuditService.verifyChain()` packs records into Rust
requests no larger than the existing 1 MiB limit. Each window carries its
absolute starting sequence and the preceding record hash; Rust checks both the
window anchor and every record's sequence, previous-hash link, and canonical
SHA-256. This preserves detection across window boundaries without weakening
the input bound.

The TypeScript/Rust limits are back in sync at 1 MiB. The Rust bounded-reader
error now reports the correct 1 MiB limit. An integration regression test builds
a valid 2,100-record chain larger than one request, verifies it across windows,
then tampers with a record in a later window and confirms Rust rejects it.

Verified in this worktree:

- `cargo test --locked -p maos-industrial-engine` — 43 passed.
- `npm run build:backend` — passed.
- `npx vitest run tests/f3-06-audit-events.test.ts tests/r1-rust-engine.test.ts` — 47 passed.

The release engine was rebuilt from this source (`cargo build --release --locked`)
and the existing project audit chain was verified locally at 2,526 records. The
release-freeze manifest was not regenerated as part of this fix.

## What this does NOT fix

**Chain storage and verification time still grow with the log.** Windowing removes
the single-request ceiling, but `AuditService` currently reads the full JSONL
file into memory and verifies every record. An individual record that cannot fit
in a bounded request still fails closed with a clear error. A separate
retention/rotation design may be needed at larger scale; it must preserve a
verifiable commitment to archived history rather than silently truncate it.

Separately, suites should not append to the project's real audit chain. Pointing
suite fixtures at temporary project roots would prevent routine test runs from
mutating operator data.

Chain rotation remains a possible later design, but it requires deciding how the
head commits to archived history and what happens to the claimed single continuous
chain property.

## Remaining workspace/release concerns

The release freeze manifest was not updated because doing so explicitly blesses a
new set of pinned assets. The handoff identified stale entries before this fix,
including the rebuilt engine and other already-modified release assets. Re-freeze
only after reviewing the complete release pack and confirming it is intended.

The original size finding proposed chain rotation as a way to bound on-disk
growth. The windowed protocol keeps engine requests bounded without changing the
on-disk chain format.

## Reproduce

```powershell
# Verify a chain larger than one engine request; Rust verifies it in windows.
node .\dist\cli\index.js industrial verify audit

# The regression test exercises >1 MiB valid data and later-window tampering.
npx vitest run tests/f3-06-audit-events.test.ts tests/r1-rust-engine.test.ts

# Observe chain growth without modifying it.
(Get-Content .maos\audit\audit-chain.jsonl).Count
```
