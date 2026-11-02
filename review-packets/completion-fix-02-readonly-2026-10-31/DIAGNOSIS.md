# Evidence-backed diagnosis — first live Baseten pilot failure (COMPLETION-FIX-02)

> Implementing-agent analysis. Not independently reviewed.
> No live MAOS calls, key retrieval, or credential output occurred or is contained here.
> Source: AntiGravity pilot evidence (`pilot-evidence.md` + 2 screenshots) correlated with
> authorized synthetic pilot artifacts in TEMP (`maos-baseten-synthetic-pilot-c4015…`)
> and baseline `2cfdf9b` sources. Private project state beyond that was not inspected.

## 1. Correlated analysis IDs (distinct — not the same analysis)

- Screenshot/upload receipt: `telemetry-1793433790872-68793ce4` (device upload, 08:03:10.874Z).
- Reported agent receipt: `telemetry-1793433792506-21af6699` (tool execution, 08:03:12.508Z, 1.63 s later).
- Both receipts verified locally; same source SHA-256 `68bf1fd8…` and ruleset `c09fd492…`.

## 2. Verified trace (source-confirmed)

- HTTP generation count and finish reasons: **[INFERENCE, tightly constrained]** exactly three
  generations over two loop iterations — gen#1 tool call `analyze_telemetry_csv`
  (confirmed by tool receipt + checkpoint `lastToolCalls`), gen#2 plain text with
  `finishReason: 'stop'` (the only path that reaches the stop-nudge; `length`/empty
  would have thrown `BASETEN_*` and any tool call would have saved an iteration-2
  checkpoint — neither observed), gen#3 after the nudge again text without
  `task_complete`, then break at iteration 2 with `MAX_ITERATIONS`
  (`src/core/agent-runner.ts:245-372`). The 80%-budget nudge (iteration ≥ 3) never fired.
- `task_complete`: offered (in `ALLOWED_TOOLS`, in the tool schema sent) but **omitted** —
  never called, never rejected (`TOOL_UNAUTHORIZED` result or a throw would have produced
  a different error than `MAX_ITERATIONS`).
- 1,059 tokens = **one response, not the run**: the iteration-1 checkpoint total covers
  gen#1's reported usage only; pass 2 exits via nudge-break before re-saving, so the
  3-generation total was never persisted. The pilot report's "consumed 1,059 tokens"
  understates the run.
- Completion availability: `task_complete` requires only `summary`
  (`src/integrations/tools.ts:661-681,2731-2737`); empty/omitted `files_changed` was
  already accepted. The blocker was the reminder demanding "the list of files you
  changed" from a read-only agent whose real progress (receipts under `.maos/`,
  skipped by `snapshotFilesystem`) reads as "no file changes", forcing `MAX_ITERATIONS`
  under `allowPartialSuccess: false`.

## 3. Fixes and why they are minimal

- Runner: read-only-aware stop-nudge (agents whose allow-list has no mutating tool).
  Mutating agents, allow-list-less agents, budgets, deadline, schema, and evidence checks
  unchanged. The unchanged 80%-budget `git_commit` reminder cannot affect this path:
  the observed run breaks at iteration 2 of 4, before that nudge arms (iteration ≥ 3).
- GUI: failure now reads `Agent completion: failed · report not accepted`; tool execution
  shows `completed` only with an accepted `agentResult`. The deterministic RESULT panel is
  labeled as local upload-receipt evidence with CLI replay, never as an accepted report;
  no model prose renders on failure. Stale results cannot persist as accepted: a new
  request clears `agentResult`/`analysis` first, and `agentResult` only exists alongside
  an accepted report; source changes invalidate receipts via replay verification.
- Empty `files_changed` does not weaken completion: the evidence-binding gate
  (`analysis-agent-service.ts:250`, summary must cite `analysisId`), single-tool-use,
  receipt replay verification, and accepted-report persistence are all preserved and
  covered by tests (including rejection of uncited prose via `EVIDENCE_REFERENCE_REQUIRED`).

## 4. Tests demonstrating the exact observed sequence

`tests/industrial/read-only-completion.test.ts` (mock-only, loopback/injected transport):
tool success → plain-text omission → read-only completion in 3 generations (verbose log
shows Iteration 2/4 → nudge → `Task completed (after nudge)`); continued omission ends
`MAX_ITERATIONS` within budget with 1 receipt, no report, no completion audit; uncited
`task_complete` rejected; separate receipt-success/agent-failure states asserted.
RunAgent-level tests pin the new read-only nudge and the verbatim mutating nudge.
