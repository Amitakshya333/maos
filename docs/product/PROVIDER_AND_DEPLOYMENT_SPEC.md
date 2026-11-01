# Provider and Deployment Specification (PROPOSED)

**Status:** PROPOSED. This document defines a future registry, adapters, and policy profiles. Current adapters and local test results do not establish that every capability or deployment profile below exists.

## Provider registry

Each registered provider has a stable ID, adapter/version, transport, endpoint class, auth method, supported model IDs, and an explicit capability record. Capabilities are facts with provenance (`declared`, `probed`, or `conformance-tested`), timestamp, adapter version, and result. Configuration alone never means a capability was verified.

Proposed capability fields:

- Text input/output, streaming, structured output, tool calls, vision, embeddings, context limit, output limit, cancellation, and usage reporting.
- Authentication mode and secret reference (never the secret value), TLS/origin requirements, request timeout, and retry behavior.
- Data residency/egress classification, retention terms, and whether a test can incur charges.
- Supported deployment profiles and known limitations.

## Capability probing and conformance

- `list` and static inspection do not send requests. A health probe is bounded, non-generative, and sends no project data where the provider permits it.
- Generation, tool-call, vision, and embedding checks require explicit operator initiation, synthetic fixtures, and policy approval. Before an externally hosted call, show the provider, model, data class, estimated request, billing basis, and whether a hard no-overage control is confirmed.
- A probe result records which property it established. Do not translate a successful health endpoint into “tool calls work” or “model is ready.”
- Conformance suites cover valid and malformed requests, streaming order, tool-call round trips, schema errors, timeout/cancellation, auth failure, rate limiting, retry safety, redaction, and deterministic handling of partial responses.
- Hosted conformance tests remain blocked unless active credits and a provider-side or otherwise enforceable no-overage boundary are established. A client-side token estimate is not that boundary. Meta's currently documented lack of a hard spend cap is an open release constraint, not a reason to bypass policy.

## Adapter families

| Adapter | Intended use | Proposed boundary |
|---|---|---|
| Local process/API | Local model server or embedded runtime | Loopback or explicitly configured local endpoint; offline operation when model assets are present; no network fallback. |
| Team server | Organization-operated inference service | Explicit internal endpoint allowlist, team identity, TLS, server-side policy, and shared audit attribution. |
| Hosted API | External provider API | Explicit opt-in per project/profile, egress disclosure, secret-manager reference, bounded requests, provider-side billing guard, and policy-approved data classes. |
| Cloud platform | Customer cloud account/VPC managed model service | Customer tenancy and IAM, region pinning, private endpoint where available, cloud-side quotas, and deployment-specific audit. |

The existing OpenAI-compatible, Anthropic, and Gemini adapters are reusable provider implementations. A team-server adapter may reuse compatible transports only after endpoint/auth differences are modeled explicitly. A cloud-platform adapter is a proposed family, not an existing integration claim. Meta remains a hosted adapter gate until its active credit and no-overage conditions are confirmed.

## GPU and hardware detection

Detection is read-only and reports hardware separately from model availability. Record OS/architecture, CPU, available memory, GPU model, VRAM, driver/runtime versions, and whether the selected model is compatible. Show confidence and detection source; never claim acceleration based solely on a configured device string.

Do not download models, run benchmarks, or initialize large runtimes during a passive readiness check. An explicit benchmark uses a small synthetic workload, displays resource impact, and records the exact model/runtime/device. Unsupported or permission-denied probes return `unknown`, not `CPU-only` or `GPU-ready`.

Current code provides `ModelDevice = cuda | cpu | none` in `src/domain/model-manifest.ts` and model residency/switching services. It does not establish a complete cross-platform hardware inventory.

## Deployment profiles enforced by data policy

Profiles are policy inputs, not GUI roles. Core evaluates every operation against the profile at the service boundary; hiding a button or checking a client-side estimate is insufficient.

| Profile | Network and provider rule | Data rule | Required enforcement |
|---|---|---|---|
| `air_gapped` | No external or team network calls | Project data remains within the isolated host | Deny egress at policy and runtime boundary; no automatic model download or telemetry. |
| `local_workstation` | Local process/API providers only by default | Local project files; outbound data requires an explicit policy change | Bind local services safely, disclose any non-loopback endpoint, and keep credentials in OS-backed storage. |
| `team_server` | Allowlisted organization endpoints | Team-managed storage and identity | Enforce tenant/project scope, server-side data policy, TLS, and attributable audit events. |
| `hosted_api` | Explicitly enabled hosted providers only | Only policy-approved/redacted data classes | Require active account credit, enforceable provider-side no-overage control, bounded request, explicit consent, and egress audit. |
| `cloud_platform` | Customer-selected cloud endpoint/region | Customer tenancy and configured retention | Enforce IAM, region/endpoint allowlist, cloud quota, private connectivity where available, and cloud audit linkage. |

Profiles must define allowed data classes, retention, egress, telemetry, artifact storage, secret handling, approval scope, and recovery behavior. Missing policy fields fail closed for sensitive operations. Policy changes invalidate approvals created under the prior policy version.

## Current code to reuse

`src/backends/provider.ts`, `factory.ts`, and the existing provider adapters define the current provider contract. `src/domain/model-manifest.ts` and model residency/switch services provide the device and lease foundation. `src/domain/sovereignty-boundary.ts`, `src/service/sovereignty-boundary-service.ts`, `src/domain/endpoint-allowlist.ts`, `src/service/project-service/`, and `src/api/middleware.ts` provide policy, endpoint, project, and request-boundary enforcement. The provider registry, conformance metadata, hardware inventory, additional adapters, and five-profile policy matrix in this document are PROPOSED work.
