# TASK HYBRID-ROUTER-01 — run log (2026-11-02)

Hybrid: model-driven evidence tools, deterministic server-side bookkeeping.
Base: `64471c61f9fc063537f7fd8fe453218955cb9abb` (C:/maos main HEAD, verified
via `git -C C:/maos rev-parse HEAD`).
Scratch: `C:/clean/ring-hybrid-01` (detached worktree at base, `npm ci` clean).
No commits, no pushes. `BASETEN_API_KEY` unset for all tests (asserted unset
in the new suite; `node -e` check confirms unset in shell).

## Decision implemented

In HOSTED mode, when the instruction needs bookkeeping
(remember/recall/update_plan), the SERVER runs the deterministic skill chain
FIRST (same registry-direct `executeToolLogged` code as the evidence-only
path), records an honest server-side `skill.prefetch` transcript event (never
a model tool call), then gives the model the results as established facts to
write prose and propose (not perform) the consequential step. Evidence tools
(analyze_telemetry, read_company_document, search_knowledge, verify_export,
ocr_document) stay fully model-driven. Approval gate unchanged (bookkeeping
tools are non-consequential, so prefetch never pauses; consequential tools
still go through `awaitApproval` with the human decision arriving as an
approval resolution).

## Routing rule (exact)

Bookkeeping prefetch iff the instruction matches one of (case-insensitive):

- recall:    /\brecall\b|\bwhat do you remember\b|\blook up\b.{0,20}\bnotes?\b|\bsearch\b.{0,20}\b(stored|my)\b.{0,20}\bnotes?\b/i
- remember:  /\bremember\b|\bnote that\b|\bdon'?t forget\b|\bkeep in mind\b|\bfile\b.{0,20}\bfor later\b/i
- plan:      /\bupdate[ _-]?plan\b|\bupdate the plan\b|\brefresh the plan\b|\bplan status\b|\bcurrent plan\b|\bshow\b.{0,20}\bplan\b|\bnext steps\b|\btodo\b|\bto-?do list\b/i

(recall wins over remember so a recall ask never stores a duplicate.)

Evidence path (fully model-driven, tools + approval as today): everything
else — telemetry/documents/search/verify/ocr AND handover / work-order /
draft / report asks (consequential evidence tools the model demonstrably
calls: draft_safety_note, create_work_order, write_shift_handover, ...).
Rationale for handover/work-order staying model-driven: the live result proved
the model calls consequential evidence tools reliably (3/3); only
memory/plan tools were flaky (0 calls), so only those are pre-run.
Raw CSV rows never ride along on either path. Evidence-only mode untouched.

## Changes (see candidate.patch)

- `src/service/ring-agent-service.ts`: hybrid regexes + `classifyHybridPrefetch`
  + `runBookkeepingPrefetch` (registry-direct remember/recall/update_plan via
  `executeToolLogged`, then `skill.prefetch` marker); `executeHosted` runs the
  prefetch first, narrows the model tool list (`run.toolDefs`, bookkeeping
  tools removed), and injects established-facts + propose-don't-perform
  prompt; `generateHostedTurn` honors `run.toolDefs`; `toWireEvent` projects
  `skill.prefetch` honestly (skills + summary, never a model call).
- `src/service/ring-contract.ts`: `skill.prefetch` added to
  `RingStreamEventType` + `RING_STREAM_EVENT_TYPES` (existing union style).
- `src/gui/src/api/ring-run-types.ts`: `skill.prefetch` added to
  `RingRunEventType` + `EVENT_TYPES` + `skills?: string[]` passthrough (GUI
  renderers ignore it via existing `default: return null`; no UI change).
- `tests/industrial/ring-hybrid.test.ts` (NEW):
  (a) bookkeeping instruction in hosted-mock mode completes with skill
  results + model prose, ZERO remember/recall/update_plan model tool calls
  (also asserted absent from the offered tool list), `skill.prefetch`
  present with skills `['remember','update_plan']`, validated snapshot keeps
  the prefetch on the wire; (b) evidence instruction fully model-driven
  (`analyze_telemetry` via model tool call `call_tel_1`, no prefetch);
  (c) evidence-only unchanged (no prefetch, mode marker, deterministic
  telemetry/remember/plan results, no model turns).

## Validation (all in C:/clean/ring-hybrid-01, BASETEN_API_KEY unset)

| Command | Exit | Result |
|---|---|---|
| `vitest run tests/industrial/ring-hybrid.test.ts` | 0 | 3/3 pass |
| `vitest run ring-hybrid + ring-agent + ring-contract + ring-dev-a + ring-dev-c-safety` | 1 attributable | 35/36; sole failure `ring-dev-audit-proxy > exposes the fixture helpers` (missing Rust engine fixture) — fails identically on pristine base (verified via `git stash -u` + rerun: 12/13 same single failure), NOT caused by this change |
| `vitest run ring-dev-c-day2 + ring-wire-contract + ring-inference` | 0 | 16/16 pass |
| `vitest run tests/gui/ring-devb-surface + ring-impl-01 + ring-workspace` | 0 | 59/59 pass |
| `npm run build:backend` (`tsc -p tsconfig.json`) | 0 | clean |
| `npm run typecheck:gui` (`tsc -p tsconfig.gui.json --noEmit`) | 0 | clean |

Live/hosted calls: zero (loopback-mock providers + evidence-only only).

## Deliverable

- Packet: `C:/maos/review-packets/ring-hybrid-01-2026-11-02/`
- `candidate.patch` (416 lines, `git diff HEAD` of the 4 files, new test via `add -N`)
- SHA-256 (`candidate.sha256`): `674df4088d4edcef9aafe9d579352c99b90623d9937b95f7c298a673e9ed3666`
- Base: `64471c61f9fc063537f7fd8fe453218955cb9abb`

## Handoff

- TASK HYBRID-ROUTER-01 STATUS: implemented + validated, NOT verified (no live
  hosted run; mocks only per assignment constraints).
- Anything outside the assignment: none. `C:/maos` untouched except the packet
  dir; scratch index reset (`git reset` after patch capture); no commits/pushes.
- Follow-up the PM may want: live hosted rehearsal with `BASETEN_API_KEY` set
  to confirm the model respects the established-facts prompt on a real model.
