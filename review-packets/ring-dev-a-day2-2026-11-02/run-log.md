# Run log — TASK DEV-A-02 (Ring brain Day-2: streaming tokens + context + reliability harness)

- Base: `ba451de` (`ba451de6d6c9538f35afa3d5d57a3e1ad60dc9c3`), worktree `C:/clean/ring-a-day2` (detached, own `node_modules` via `npm ci`, exit 0).
- `BASETEN_API_KEY` was UNSET for every run below. No live hosted calls were made.
- Packet: `C:/maos/review-packets/ring-dev-a-day2-2026-11-02/` (`candidate.patch`, this file, `SHA-256.txt`, `base.txt`).
- Frozen contracts read, not changed: `src/service/ring-contract.ts`, `ring-tool-registry.ts`, `src/gui/src/api/ring-run-types.ts`. `meta-api-policy.ts` untouched. Patch touches none of them (0 bytes).
- `C:/maos` itself: only the packet dir was created; no commits, pushes, or tags.

## 1. Streaming verdict: GO (implemented, evidence below)

Viability was proven BEFORE writing code with throwaway loopback probes (OpenAI SDK 6.39.0, worktree `node_modules`):

- `stream:true` against an SSE body reassembles exactly: content fragments join in order (`"Turbine T-07 is CRITICAL"`), `tool_calls[].function.arguments` split across chunks (`'{"csv' + 'Path": "demo/x.csv"}'`) concatenates then `JSON.parse` succeeds, empty heartbeats emit nothing, per-chunk `model` passes through.
- `stream:true` against a plain-JSON endpoint (non-SSE, e.g. a mock that ignores `stream`) ends the async iterator with **zero chunks** — no hang, no partial result. This is the defined fallback trigger.

What shipped (all additive; whole path behavior unchanged):

- `src/backends/provider.ts`: `ProviderStreamOptions { signal, maxTokens, onDelta }`, `ProviderResponse.streamEmpty?`, optional `IProvider.generateStream()`. Sibling providers need no change (optional member).
- `src/backends/openai-provider.ts`: extracted `buildRequestBody()` (identical body on both paths apart from `stream:true`) and `parseCompletion()` (whole + stream-assembled funnels through ONE parser, so redaction, `PROVIDER_CREDENTIAL_CONTAMINATION`, `BASETEN_EMPTY_GENERATION`, `BASETEN_INCOMPLETE_GENERATION` apply identically); extracted `mapProviderError()` so both paths map HTTP/auth/connection failures to IDENTICAL messages. New `generateStream()`: assembles content + per-index tool-call slots (slots without a function name fail closed, never executed), `onDelta` observes each non-empty fragment (redacted; a throwing observer cannot break the stream), reasoning/metadata-only chunks and empty heartbeats emit nothing, zero-chunk transport returns `streamEmpty:true`.
- `src/service/ring-agent-service.ts`: `executeHosted()` turns now go through `generateHostedTurn()` — if the provider exposes `generateStream`, each fragment is `record()`ed as `model.delta` (existing Dev-B `record()` → event-bus drain + `toWireEvent` projection, unchanged), then the redacted whole text is recorded as `model.turn` exactly as before. No `generateStream` → `generate()` once (no fabricated deltas). `streamEmpty` → `generate()` once (no fabricated deltas). Cancellation drops late deltas. Evidence-only never touches a provider, so no `model.delta` is ever fabricated there (existing test still asserts absence).
- Honest fallback, no fake typewriter: deltas are genuine transport fragments, not synthesized from whole text.
- Known limit (documented in code + here): a non-SSE endpoint costs one extra `stream:true` round trip before the single `generate()` fallback. Real OpenAI-compatible endpoints (Baseten) honor `stream:true` with SSE, so this only affects non-compliant test doubles.

## 2. Context-fix verification (regression tests)

- Existing negative test kept: unrelated question ("Draft a safety note about shift handover") sends NO `overallVibrationRms`/telemetry timestamps.
- New positive test (`ring-dev-a.test.ts`, "telemetry question DOES ride the deterministic summary along"): telemetry question DOES include `overallVibrationRms` + `Deterministic Engineering Context`, and still contains NO raw CSV rows (`timestamp,asset_id,...`, `2026-08-22T09:00:00+05:30,T-07`). Passes.
- T-07 guard: no assertion in this packet depends on a judged workflow; `package-runtime-assets` (T-07 demo inputs) untouched.

## 3. Base bug found + fixed (in-lane, reported not freelanced)

`executeEvidenceOnly()` keyword router at base had literal `0x08` BACKSPACE bytes where `\b` word-boundary escapes were intended (4 lines: `wantsMemory`, `wantsPlan`, `wantsOcr`, inner `recall`), so "remember …" / "update the plan" / "scan …" instructions silently skipped their tools (only the `turbine_inspection_scan`, `note that`, `todo`, `inspection.{0,20}scan` alternates ever fired). Found because harness instruction 3 (`memory-and-plan`) recorded only `analyze_telemetry`. Fixed by replacing the 13 stray bytes with `\b` escapes; verified: same instruction now records `analyze_telemetry,remember,update_plan`. Diff hunks limited to those 4 lines.

## 4. Live reliability harness (PREPARED ONLY — never executed live)

- `scripts/ring-tool-reliability-check.mjs` (Node, no ts-node; requires `dist/` via `npm run build:backend`).
- `--live`: 4 hosted instructions (telemetry verdict; SOP read + knowledge search; remember + plan; audit verify), each expecting 2–3 tool calls. Records per instruction: observed tools vs expected, args-shape validity, tool.call/result pairing, completion + non-empty final answer (stop), turn bound (≤20), raw-row leak check (CSV header in final answer fails the instruction), consequential-gate auto-deny with recording, per-instruction timeout → cancel → fail. Exit 1 on any failure, 2 on harness error.
- Key safety: read only from `process.env.BASETEN_API_KEY`; every console line + the JSON report pass through `scrubSecrets()`; reports land in `os.tmpdir()` (never the repo); a post-write scan refuses to keep a report containing the key.
- `--dry-run`: evidence-only self-test of the machinery (temp project, scrubber self-test, 4/4 instructions complete with no hosted calls). THIS is what ran here.
- Clean skip without key: prints exactly `BASETEN_API_KEY not set — skipping live check`, exit 0.

## 5. Keep-green results (BASETEN_API_KEY unset; exit codes)

| Command | Result |
|---|---|
| `npm run build:backend` | exit 0 |
| `npm run typecheck:gui` | exit 0 |
| `vitest run` ring-agent, ring-contract, ring-dev-a, ring-inference, ring-wire-contract, openai-provider-streaming | 40 passed / 1 failed (41) |
| harness `--dry-run` | exit 0, 4/4 recorded |
| harness `--live` (no key) | skip line, exit 0 |

- New tests: 8/8 `openai-provider-streaming.test.ts`; 2 new agent `model.delta` tests; 1 new context positive test — all pass.
- `tests/industrial/ring-agent.test.ts` mock upgraded to dual-mode (SSE for `stream:true`, whole JSON otherwise) so one request still equals one model turn; all 7 pass, including cancellation timing.
- Pre-existing failures (verified identical on clean `ba451de` via `git stash` A/B; NOT mine, NOT fixed per scope): `ring-dev-audit-proxy` helper (`engineFixturePath()` undefined) — 1 test; `analysis-agent-auth-http` (2), `meta-model-api-contract` (3) — environment/fixture issues. Full `npm test`: 762 failed / 2442 passed — dominated by missing Rust engine binary / offline-model environment gaps; ring/backends suites above are the in-scope signal and are green.
- `BASETEN_API_KEY` was unset for all runs; nothing in this packet contains a secret (only `synthetic-*` placeholders and the `KEY=...` usage hint in the harness header).

## Files changed (vs `ba451de`)

- `src/backends/provider.ts` (+33, additive streaming types)
- `src/backends/openai-provider.ts` (extract `buildRequestBody`/`parseCompletion`/`mapProviderError`; add `generateStream` + `wrapStreamError`)
- `src/service/ring-agent-service.ts` (+`generateHostedTurn`, model.delta drain; 0x08→`\b` router repair)
- `tests/industrial/ring-agent.test.ts` (dual-mode SSE mock)
- `tests/industrial/ring-dev-a.test.ts` (stale comment refresh; 2 delta tests; 1 context positive test)
- `tests/backends/openai-provider-streaming.test.ts` (NEW, 8 tests)
- `scripts/ring-tool-reliability-check.mjs` (NEW harness)

NOT verified: live `--live` path (key absent by design); full-repo suite beyond the listed gates (environment-limited); GUI rendering of deltas (Dev-B surface lane).
Nothing outside the assignment was changed.
