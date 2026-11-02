# Findings → fixes mapping (COMPLETION-FIX-04)

## Finding 1 — effective tool classification

Delta: raw `allowedTools` + hardcoded 3 mutating names cannot see file generators
or filtered-out tools.

Fix (`src/core/agent-runner.ts`): the reminder now classifies the **effective
authorized tool definitions after filtering** — the same `getToolsForAgent(...)`
set offered to the model. Only positively known project-file-non-mutating tools
qualify (`analyze_telemetry_csv`, `check_compliance`, `ingest_document`,
`list_dir`, `read_file`, `search_code`, `task_complete` — each source-confirmed;
`analyze_telemetry_csv` writes receipts only under `.maos/`, excluded from change
snapshots). File generators (`generate_docx/xlsx/pptx`), executors, mutators,
memory/coordination tools, external services, and names dropped by filtering keep
the existing reminder; unrestricted agents always keep it. No registry redesign,
no new metadata fields; budgets, schema, and evidence checks unchanged.

How read-only classification relates to actual authorized tools: it is computed
from the post-filter definitions, so profile-filtered (`execute_python` under
industrial) and registry-dropped names never affect it, while authorized
side-effecting tools always disqualify.

Why empty `files_changed` does not weaken completion: unchanged from the prior
correction — `task_complete` still requires a summary, the service still enforces
the `analysisId` evidence-binding gate, single-tool-use, replay verification,
and accepted-report persistence; uncited prose is still rejected
(`EVIDENCE_REFERENCE_REQUIRED`).

Tests: `tests/industrial/read-only-completion.test.ts` — actual Industrial set,
file-generating tool, uncertain registry tool (`share_knowledge`), filtered-out
unknown name, industrial `execute_python` filtering (env save/restore), mutating
and unrestricted agents.

## Finding 2 — source-bound review state

Delta: changing the CSV left a prior `reviewRun` bound to the new file, and a
late async response could restore stale state.

Fix: new pure helper `src/gui/src/components/telemetryReviewState.ts`
(`buildSourceKey`, `clearedOnSourceChange`, `isCurrentResponse`,
`shouldApplyReconnect`) wired into `TelemetryReviewPanel.tsx` — every source
change (file select, clear, bundled sample) bumps a sequence and detaches all
seven review fields including `reviewRun`; async completions and the mount
reconnect apply only for the current sequence / when no source is selected.
Historical reviews remain reachable via Approvals queue/run views and the
reconnect path. The 80%-budget reminder is untouched.

Tests: `tests/gui/telemetry-review-state.test.ts` (node vitest, the established
GUI-test pattern — no component framework, no new harness): detach contract,
key distinctness/stability, stale-sequence rejection, reconnect gating.
Typecheck alone is not relied upon: behavior is asserted at runtime.
