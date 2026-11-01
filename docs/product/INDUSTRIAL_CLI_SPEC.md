# Industrial CLI and REPL (PROPOSED)

**Status:** PROPOSED. This document describes a future operator experience. It does not claim that the command surface below is implemented.

## Goal and boundary

Provide a standalone `maos-industrial` command and interactive REPL for operating MAOS Industrial projects. Keep the user experience in the Industrial CLI package and reuse existing MAOS Core services for project state, providers, workflows, approvals, artifacts, policy, and audit. Do not fork service logic into a second CLI implementation.

The CLI is an operator client. It validates and formats requests, prompts for explicit choices, streams service events, and presents results. Core owns business rules, persistence, authorization, deterministic verification, and provider calls. Interactive prompts are never a substitute for Core-side policy checks.

## Command surface

All commands accept `--json`. Commands that can perform work also accept `--project <path>` to select a project explicitly. A command must not silently fall back to a different project when the requested project is missing or invalid.

| Command | Proposed operator behavior |
|---|---|
| `maos-industrial init [path]` | Initialize an empty project with a validated Industrial profile and safe synthetic example option. Refuse destructive overwrite; show every created path. |
| `doctor [--deep]` | Check package/runtime versions, project identity, required assets, Rust engine prerequisite, provider reachability, permissions, and policy readiness. Distinguish detected, tested, and unavailable facts. `--deep` may make bounded network probes only when explicitly requested. |
| `models [list\|show\|probe]` | List models advertised by configured providers, inspect declared capabilities, or run an explicitly requested capability probe. Never imply a model is available from configuration alone. |
| `providers [list\|show\|probe\|conformance]` | Inspect provider adapters and effective policy. Probes are read-only by default; conformance generation is opt-in and must display any data egress or charge risk before execution. |
| `workspace [show\|check\|set-root]` | Show the active project identity and root, validate workspace assets, or change the root through an explicit confirmation. Do not move project data implicitly. |
| `run [workflow]` | Start a named workflow; show the selected project, data class, provider/model, and policy before work begins. Support `--input`, `--session`, `--yes` only for non-approval prompts, `--stream`, and `--json`. Human approval requirements cannot be bypassed by `--yes`. |
| `sessions [list\|show\|resume\|cancel]` | List persisted sessions, inspect one, resume only after identity/input/policy checks, or request cooperative cancellation. |
| `review <run-id> [approve\|reject]` | Display evidence and provenance, then record a named reviewer decision and optional reason. Approval must be explicit and scoped to the reviewed run and input hashes. |
| `verify <run-id> [manifest\|artifact\|audit]` | Independently verify the requested run record, deliverable, and/or audit chain. Return an invalid result as a failed command, never as a successful report. |
| `reports [list\|show\|export]` | List reports by run, inspect metadata, or export an artifact after access and integrity checks. Preserve run linkage in exported metadata. |
| `audit [verify\|export]` | Verify the append-only audit chain or export a bounded range with linkage and verification status. |
| `policy [show\|check]` | Show the effective deployment/data policy or evaluate a proposed operation against it. A CLI-side policy display is advisory; Core makes the enforcement decision. |
| `service [start\|status\|stop]` | Start the project service in the foreground by default, inspect the bound project/port/session readiness, or request an orderly stop. Do not kill an unrelated process by port number alone. |

`--help` and command-specific help must work without a configured project or provider. Unknown commands and invalid options return usage errors without changing project state.

## REPL experience

`maos-industrial` with no subcommand opens a REPL only when stdin and stdout are interactive. Otherwise it prints help or requires a command. The initial screen identifies the active project, service state, policy profile, and whether model/provider availability was actually probed.

Proposed slash commands:

| Slash command | Behavior |
|---|---|
| `/help`, `/status` | Show commands and current project/session/provider readiness. |
| `/models`, `/providers`, `/workspace` | Invoke the corresponding read-only command view. |
| `/run [workflow]` | Start a workflow and stream its events. |
| `/sessions`, `/resume <session-id>` | List sessions or resume a compatible persisted session. |
| `/review <run-id>`, `/approve <run-id>`, `/reject <run-id> [reason]` | Review evidence and record a scoped human decision. Approval/rejection prompts show run and input identity before confirmation. |
| `/verify <run-id>`, `/reports`, `/audit`, `/policy` | Inspect verification, reports, audit, or effective policy. |
| `/service [status\|start\|stop]` | Inspect or control the local project service. |
| `/cancel [session-id]`, `/quit` | Request cooperative cancellation or exit after the current operation settles. |

The REPL shares the same command handlers and Core service calls as one-shot mode. It must not implement separate workflow or approval logic.

## Streaming, cancellation, approvals, and resume

- Stream structured progress events with stable event IDs, timestamps, session/run IDs, and severity. Show human-readable summaries in a TTY; `--json --stream` emits one JSON object per line (NDJSON). Do not print credentials, raw authorization headers, or unredacted provider payloads.
- `Ctrl-C` requests cooperative cancellation and waits for the service's persisted terminal state. A canceled or interrupted operation is not shown as completed. If cancellation cannot be confirmed, report the state as unknown and retain the session ID for inspection.
- Approval prompts show the immutable run ID, reviewer identity, evidence/input hashes, expected action, and current policy. Reject is a first-class decision. No response, timeout, or terminal close is not approval.
- Resume checks project identity, source/rules/report hashes, provider compatibility, and current policy before continuing. Changed inputs invalidate the prior approval and require a new review. A resume refusal is reported as stale/blocked, not silently retried.
- Noninteractive automation must use explicit flags and still pass the same service-side approval and policy gates.

## JSON envelope and exit codes

Proposed stable JSON envelope:

```json
{
  "schemaVersion": 1,
  "success": true,
  "command": "verify audit",
  "projectId": "example-project",
  "sessionId": "session-example",
  "runId": "judged-run-example",
  "result": {},
  "error": null
}
```

Omit unavailable identifiers instead of inventing values. Errors use `{ "code", "message", "retryable", "details" }`; `details` must be redacted and actionable. A successful process exit means the requested operation completed. It does not mean the engineering verdict is PASS. A validly produced `FAIL` engineering verdict can have command exit 0; a failed verification must have a nonzero exit.

| Exit code | Meaning |
|---:|---|
| `0` | Requested command completed; inspect `result` for the domain verdict. |
| `1` | Unexpected internal or I/O failure. |
| `2` | Usage, argument, or input validation error. |
| `3` | Effective policy denied the operation. |
| `4` | Required runtime, asset, or separately installed engine is missing or incompatible. |
| `5` | Provider/service unavailable or request failed. |
| `6` | User or service confirmed cancellation. |
| `7` | Verification failed or the requested evidence is invalid. |
| `8` | Approval is required, stale, rejected, or not applicable to current inputs. |

These codes are a proposal and must be finalized before the CLI is treated as a stable automation interface.

## Current code to reuse

| Current code | Reuse in the proposed CLI |
|---|---|
| `src/industrial/entrypoint.ts`, `src/industrial/industrial-cli.ts`, `src/cli/index.ts` | Existing executable wiring and shared command registrations. The current Industrial executable is a wrapper over existing registrations; this proposal extends the UX without cloning handlers. |
| `src/industrial/judged-run.ts`, `src/industrial/telemetry-analysis.ts`, `src/industrial/analysis-agent-service.ts` | Judged-run orchestration, deterministic telemetry checks, and bounded analysis tool flow. |
| `src/service/project-service/`, `src/service/audit-service.ts`, `src/service/artifact-service.ts`, `src/service/docx-generator-service.ts`, `src/service/verifier-service.ts` | Project identity/session, audit, artifact, report, and independent verification operations. |
| `src/backends/provider.ts`, `src/backends/factory.ts`, `src/backends/*-provider.ts` | Provider contract, factory, and existing adapters. Capability inventory/probes are proposed additions. |
| `src/domain/sovereignty-boundary.ts`, `src/service/sovereignty-boundary-service.ts`, `src/domain/approval.ts` | Existing policy and approval types/services; CLI output remains descriptive while Core enforces. |

## Acceptance criteria for future implementation

The command and REPL surfaces use identical Core handlers; JSON output is versioned; commands respect project/session identity; approval, policy, cancellation, and resume rules are enforced in services; output distinguishes operation success from engineering verdict; and subprocess/provider failures produce truthful persisted state and nonzero exits where required.
