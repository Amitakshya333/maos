# Boundary Scope Decision — MAOS Industrial

> **Status:** Decided and implemented (F9-10)
> **Date:** 2026-09-27
> **Supersedes:** the implicit assumption in F9-03/F9-06 that the Industrial
> boundary is a machine-wide packet filter.

## The decision

**The Industrial boundary is process-scoped by default.**

The claim MAOS Industrial makes is:

> *"The MAOS process tree communicated only over declared loopback endpoints
> during this run, and no host firewall state was modified."*

It is **not**:

> ~~"This workstation was isolated from the network."~~

`createServiceContainer` selects the process scope explicitly. The machine-wide
packet-filter path (`FirewallService`) still exists, but it is never selected
implicitly, never required to run Industrial, and never reachable without an
operator explicitly asking for it.

## Why process scope

Three independent arguments, in order of weight.

### 1. It is the only scope that is safe on a developer machine

The synthesized host plan blocks **all** inbound and outbound traffic on all
addresses, all protocols, all profiles, with no program scoping. Applying it
disables DNS, Windows Update, the browser, package managers, git remotes, and
any remote session on the machine, and would sever RDP/SSH access outright.
Those rules also do **not** restrict loopback traffic, which is where the
boundary actually matters — so the plan delivered near-maximum collateral damage
for near-zero enforcement of its stated purpose.

### 2. It is the scope the rest of the system already implements

Every other F9 control is process- and endpoint-scoped: `EndpointAllowlistPolicy`
declares per-endpoint direction and process category, `ServiceIdentityService`
pins per-PID identities and executable hashes, and `NetworkMonitorService`
attributes observed sockets to PIDs. The process scope is the layer those
controls already speak.

### 3. It is the only scope that can be verified honestly

A machine-wide claim requires proving a negative about every process on the host,
which MAOS cannot do. A process-scoped claim is falsifiable with the tools MAOS
already has: enumerate the attributed tree's sockets and evaluate them against
the sealed policy.

## What the process scope actually does

`ProcessBoundaryService` owns the lifecycle:

| Phase | Effect | Host side effects | Evidence |
| --- | --- | --- | --- |
| `enable` | Validates the sealed endpoint policy, resolves the attribution scope, starts a passive observation session, writes a boundary record | **None** | — |
| `status` | Re-measures: record present **and** session live **and** policy hash unchanged | **None** | — |
| `disable` | Stops the session, persists the observation trace, clears the record | **None** | Trace kept |
| `selfTest` | enable → one measurement → disable, within a single process | **None** | Trace discarded |

No elevation is required at any phase. `ProcessBoundaryService` never constructs
a platform firewall adapter and never invokes `New-NetFirewallRule`, `nft`, or
any host packet-filter API. This is enforced by test: the F9-10 suite wires a
host adapter that records every invocation and asserts the call list is empty
across the full lifecycle.

### Evidence vs. mechanism checks

A boundary established for real work (`run --enforce-firewall`, an explicit
`enable`) persists its observation trace to `.maos/network-evidence/`. A
**self-test** does not: it observes a process doing no work, so its trace records
nothing meaningful, and persisting one per `preflight` invocation would grow the
evidence directory without bound and dilute a directory whose contents are
supposed to be evidence.

The audit chain distinguishes the two: boundary lifecycle events carry
`selfTest: true` for a mechanism check and `selfTest: false` for a boundary that
guarded actual work, so a reader can never mistake a preflight probe for a real
enforcement session.

## Honesty properties

These were the specific defects in the previous design and are now invariants.

1. **`ACTIVE` is measured, never inferred.** A boundary record whose observation
   session has ended reports `INACTIVE`, not `ACTIVE`. A stored file alone can
   never produce an active boundary.
2. **Verification compares content, not names.** `verifyEnabledBoundary` re-derives
   the expected plan from the sealed policy and compares canonical plan hashes and
   constraint values. A record whose constraints have been edited still contains
   every expected ID, and is still detected as invalid.
3. **Attribution scope is recorded and reported.** The status detail states how
   many processes the boundary covered and whether resolution was complete. A
   boundary that only managed to cover the root process says so.
4. **"INACTIVE" is never reported as "your firewall is off."** Status carries
   `boundaryScope` and `hostFirewallModified`, and the operator-facing detail line
   states which layer was measured and whether host state was touched.
5. **Restore is real and idempotent.** `disable` tears down the live mechanism and
   persists evidence; it never reports a restore count for state it did not hold.

## Boundary lifetime

A process-scoped boundary is only meaningful for the lifetime of the process tree
it constrains. A standalone command cannot inherit an enforcement session from a
previous invocation — the session is in-process state. Consequences:

- `maos industrial run --enforce-firewall` **establishes the boundary for the
  duration of the run**. The workflow executes *inside* an active, observed
  boundary, and the observation trace is persisted as run evidence at the end.
  This is stronger than a one-time state check. If the boundary cannot be
  established, the run halts with `PREFLIGHT_BLOCKED` rather than proceeding
  unenforced.
- `maos industrial preflight` **establishes, evaluates, and tears down** a
  boundary within its own process. Because a standalone check process holds no
  boundary, preflight would otherwise have nothing to measure. Doing it this way
  makes preflight a real test of the mechanism: an unreachable observer, an
  invalid policy, an unattributable process scope, or an observed violation
  genuinely fails it. No host packet filter state is written at any point.
- `maos industrial boundary enable|disable` manage a boundary for long-lived hosts
  (for example a service host process). **The record's lifetime is tied to the
  holding process**: an exit hook clears it, so a short-lived CLI never leaves a
  stale record behind. A boundary enabled by a one-shot command therefore ends
  when that command exits — which is the honest behaviour, and is why the run
  path, not this command, is the supported way to execute inside a boundary.
- `maos industrial boundary status` measures live. A record held by another live
  process is reported as such, and is **not** reported as `ACTIVE` in this
  process, because this process is not enforcing it.

## Remaining limitations (stated, not hidden)

- **Attribution is best-effort.** If the OS process list cannot be read, the
  scope degrades to the root process alone and reports
  `attributionComplete: false` with a reason. It never silently widens to the
  whole host.
- **Processes outside the tree are not attributed.** An externally launched model
  server is outside the boundary unless passed via `--monitor-pid`. Its traffic
  neither blocks nor blesses the boundary.
- **Process scope is not a preventive control.** It observes and reports; it does
  not stop a socket from being opened. The preventive layers are the endpoint
  allowlist (which refuses non-loopback targets before a socket is opened) and
  service identity pinning.
- **Host scope remains available and unhardened.** If a deployment genuinely needs
  machine-wide rules, the F9-03 host path still applies the broad synthesized
  plan, and its known limitations (name-only verification, empty pre-change
  snapshot) are unfixed. Host scope should be treated as unimplemented for
  production purposes until those are addressed.

## How to use it

```powershell
# Prove the boundary works, without changing host state
maos industrial preflight

# Establish a boundary for a long-lived host
maos industrial boundary enable --yes

# Inspect (re-measured live)
maos industrial boundary status

# Tear down and persist the observation trace
maos industrial boundary disable --yes

# Run the full workflow inside an active, observed boundary
maos industrial run --enforce-firewall --auto-approve --yes
```
