# MAOS Industrial — Hackathon Submission Packet (Draft)

**Status:** Local packet prepared; **not submitted**. No video has been recorded.
Confirm selected-participant eligibility and inspect the actual participant
rules/form before using this draft. Ring is wired to the hosted Meta model
(see "Ring hosted integration" below); the demo video is not recorded, so no
submitted video claims a recorded live run yet.

## Project summary

MAOS Industrial demonstrates a human-reviewed industrial evidence workflow
using bundled synthetic turbine telemetry and demo thresholds. It computes
vibration RMS and threshold findings locally, pauses for reviewer approval,
generates a DOCX report, and verifies the completed run and audit export by the
same returned run ID. A changed source or threshold file invalidates approval;
an explicit rejection persists without generating a report.

The verified T-07 analysis is deterministic TypeScript. A separately installed
Rust engine provides audit-chain hashing and verification. The T-07
judged-run path itself makes no hosted call; Ring (the agent surface) is
separately wired to the Meta Model API — see "Ring hosted integration". Loopback service binding does not prove
that the whole workstation is offline.

## Confirmed public event information

The [official Meta event page](https://dev.meta.ai/events/global-hackathon)
describes two tracks: Indie developer for individual builders/students, judged
on creativity, technical ambition, and whether it works; and Startup for teams
and founders, judged on technical execution and production readiness. It names
manufacturing among the project themes and promotes building with Meta models.
It lists project submissions due **November 4, 2026 at 9:00 PM ET** (November 5
at 07:30 IST after the US daylight-saving change) and says dates may change.
Applications closed October 25, and participation is for selected applicants.

The public page says Official Rules were to be published before October 26 and
must be accepted by selected participants. The page's linked organizer waiver
at `https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver` currently
renders only “Loading.” Public `/submit` requests on both
`cerebralvalley.ai` and `events.cerebralvalley.ai` returned HTTP 404. This
public-page result does not show what a selected participant can see after
sign-in. The event page also lists worldwide participation subject to local
law/sanctions restrictions and excludes specified Meta/Cerebral Valley and
government-affiliated participants and certain family/household members; the
entrant's personal eligibility and acceptance are not verified here.

The public page's model-use language is promotional/theme language, not enough
to confirm a mandatory live Meta runtime call. Integration status (wired vs.
recorded) is stated under "Ring hosted integration"; the following remain
**unconfirmed** until the current participant rules/form are inspected:

- whether a live Meta model call is mandatory at runtime;
- existing-code disclosure requirements;
- required project/repository links, demo media, video length, and format;
- entrant-work license and recording/likeness terms;
- exact form fields, current eligibility details, and acceptance status.

Do not submit on the assumption that the pasted waiver or public promotional
copy is the current complete rule set. The user's approved spending/data
envelope is synthetic data only, active hackathon credits only, and no paid
overage. The two retained live reliability reports each record 4 hosted
instruction-runs (8 total; see "Ring hosted integration"); the packet
history holds no provider-side spend records, so that count is TO-FILL
against authoritative usage if available. Before any further hosted request,
confirm an active, unexpired positive credit balance in the intended account
and provider-side hard no-overage protection. No API key is needed for that
confirmation.

## Ring hosted integration

Ring (`ring-agent-service` + `ring-inference-service`) is wired to the
hosted Meta model `meta-models/muse-spark-open-1026` served via
`https://inference.baseten.co/v1`. The endpoint and model are policy-pinned
in one place (`src/backends/meta-api-policy.ts:3-5`): any other
endpoint/model is refused with `BASETEN_API_CONFIGURATION_INVALID`
(`src/backends/meta-api-policy.ts:211-224`), use requires explicit
`providers.<name>.basetenApiEnabled=true` opt-in with the exact
provider/endpoint/model triple, and the credential is read only from the
`BASETEN_API_KEY` environment variable in the launching shell — never from a
file (`src/service/ring-inference-service.ts:97-135`).

Arming and fallback (`src/service/ring-inference-service.ts:300-398`):
armed config + present key returns `mode: 'hosted'` with
`modelId: meta-models/muse-spark-open-1026` and `servedModelId` only when
the provider echoes its own model id
(`src/service/ring-inference-service.ts:360-369`); anything else returns
`mode: 'evidence-only'` with the deterministic summary and zero model
wording. Hosted inference errors fall back to evidence-only and are
recorded as `RING_HOSTED_INFERENCE_FAILED`, never thrown in a way that takes
Ring down (`src/service/ring-inference-service.ts:376-398`). On-screen
badges: `HOSTED · meta-models/muse-spark-open-1026 via Baseten` vs
`EVIDENCE-ONLY · no model configured`
(`tests/gui/ring-impl-01.test.ts:94,105`).

Loopback-proven streaming: in hosted mode each streamed model fragment is
recorded as a `model.delta` transcript entry and fanned out over the
existing event-bus/wire projection
(`src/service/ring-agent-service.ts:890-908`). A provider without
streaming completes via one non-streamed call with NO fabricated deltas
(`src/service/ring-agent-service.ts:903-908`;
`tests/industrial/ring-dev-a.test.ts:173-177`). Evidence-only mode never
touches a provider, so no `model.delta` is fabricated there
(`tests/industrial/ring-dev-a.test.ts:109`).

Live reliability result (both retained live reports agree at 3/4):
evidence tools (`analyze_telemetry`, `read_company_document`,
`search_knowledge`, `verify_export`) are called reliably, while the
`memory-and-plan` instruction fails its expectation both times — the model
calls only `analyze_telemetry` and never calls `remember`/`update_plan`
(`missingTools: ["remember", "update_plan"]`, `pass: false` in each retained
`live-report.json`). The decided hybrid routing is the consequence:
in HOSTED mode the server pre-runs the deterministic bookkeeping chain FIRST
(same registry-direct code as the evidence-only path), records an honest
server-side `skill.prefetch` marker (never a model tool call), then hands
the model established facts; the model writes prose and proposes (never
performs) the consequential step, with the approval gate unchanged
(`src/service/ring-agent-service.ts:194-230`;
`tests/industrial/ring-hybrid.test.ts:1-60`). Bookkeeping prefetch fires
iff the instruction matches one of the exact recall/remember/plan patterns
(`src/service/ring-agent-service.ts:215-220`); everything else —
telemetry/documents/search/verify/OCR AND handover/work-order/draft/report
asks — stays fully model-driven. Evidence-only mode is untouched by the
router. All automated tests are evidence-only/mocks-only with zero live
calls: `BASETEN_API_KEY` is deleted in `beforeEach`/`afterEach` and asserted
unset (`tests/industrial/ring-hybrid.test.ts:52-59`).

Day-2 surface: the six frozen slash-command skills are prompt templates
with required tool lists (`src/service/ring-skills.ts:42+`); matching
workflows run deterministically evidence-first server-side
(`src/service/ring-skill-workflows.ts:245+`). The overlay hotkey defaults to
`Ctrl+Shift+Space` (`desktop/ring-overlay-host.cjs:20`; smoke-checked in
`desktop/ring-smoke.cjs:29`) and the overlay renders inline Allow/Deny
approval cards for `approval.pending` events
(`src/gui/src/components/RingOverlay.tsx:10,366-374`).

What is NOT included: voice is stretch-only and cut
(`docs/product/RING_AGENT_PM_BRIEF.md:119,169`); the P-12 scan PNG and
equipment photo are explicitly NOT wired into Ring evidence paths in this
packet (scan needs OCR, photo needs vision weights — both unavailable, so
Ring reports them unavailable rather than fabricate text)
(`demo/industrial/DEMO_PACK_PROVENANCE.json:278,292`). This packet states
decision support, not operating authority — the shared refusal wording ends
"This is decision support, not operating authority. Synthetic demo data
only." (`src/service/ring-safety.ts:77`). T-07 numbers for camera are the
deterministic verdict `CRITICAL` with overall RMS `2.637 mm/s`
(`tests/industrial/ring-inference.test.ts:184-185,223-224`).

## Demo and evidence package

| Item | Current state | Purpose |
|---|---|---|
| [`README.md`](README.md) | Available | Product overview and CLI entrypoints |
| [`demo/industrial/RUNBOOK.md`](demo/industrial/RUNBOOK.md) | Updated | Package, engine, and supported desktop-shell setup |
| [`demo/industrial/PRESENTATION_SCRIPT.md`](demo/industrial/PRESENTATION_SCRIPT.md) | Prepared; video not captured | Timed truthful local/synthetic demo including approval, stale failures, rejection, download, and same-run verification |
| [`demo/industrial/RECORDING_READINESS.md`](demo/industrial/RECORDING_READINESS.md) | Updated | Release evidence and open gates |
| `maosorch-0.3.0.tgz` | Rehearsed locally; not published | Installed package used for CLI and Electron/browser gate |
| Sanitized rehearsal evidence | Retained in the listed `%TEMP%` evidence directory | Three installed-package browser runs and security assertions |
| Demo video link | **Not recorded** | Add only after the actual rules/form specify the required hosting/visibility |
| Public repository link | `https://github.com/Amitakshya333/MAOS-industrial-` from package metadata | Verify access, submitted revision, and disclosure expectations before use |

The full Electron/browser gate used one Windows tarball containing four
synthetic fixtures, four Python sources, three GUI assets, five desktop assets,
and the Industrial profile; the Rust engine was separate. After updating the
recording and submission documents, a documentation-only repack was
clean-installed and its CLI workflow plus exact returned-run-ID verification
passed. The UI/runtime assets were unchanged, so the three browser rehearsals
below remain evidence for the same application build; the docs-only repack did
not receive a new browser rehearsal. Exact package hashes and the latest CLI
run ID are maintained in the local execution checklist.

An installed CLI run had a persisted completed manifest, expected engineering
verdict `FAIL`, DOCX/audit exports, and exact-ID verification `valid=true`.
Three consecutive browser rehearsals on the full-gate tarball completed:

1. Source-stale case: completed `judged-run-1793082068886-159c1b`; stale
   negative `judged-run-1793082067932-b720c0` failed closed.
2. Rules-stale case: completed `judged-run-1793082081352-576737`; stale
   negative `judged-run-1793082080423-bbbe12` failed closed.
3. Rejection case: completed `judged-run-1793082093074-61cfaf`; rejected
   negative `judged-run-1793082092138-46400e` persisted without a report.

Every completed browser run remained `FAIL` as its engineering verdict while
the workflow itself completed successfully. Each has same-run artifact/audit
linkage, a DOCX download whose bytes match the manifest, a verified audit
chain, and exact returned-run-ID CLI verification. The Electron path exercised
private launcher IPC, authenticated REST/events, refresh/resume, and wrong
session/project/origin rejection. The session token did not appear in the URL,
browser storage, or cookies.

Evidence files for the full browser gate:
`%TEMP%\maos-desktop-release-35394b7bbbc34984b6a93badc722b9ea\evidence\rehearsal-1.json`
through `rehearsal-3.json`. The docs-only repack CLI evidence remains in
`%TEMP%\maos-doc-repack-05f1a09b370946a7a0361f9b003885b2`.

## Separate Rust prerequisite

The npm tarball does not bundle Rust. The tested Windows engine answered as
`maos-industrial-engine` 0.1.0, protocol 1.0, Rust 1.95.0, status `ok`; its
SHA-256 matched the source-built binary. This detects staging/copy errors, not
publisher identity or source authenticity. The missing-engine refusal gives an
actionable expected path, Cargo build command, and copy instructions. No signed
cross-platform release is provided, and evaluator acceptance of this separate
engine is unknown. T-07 does not call the packaged Python assets.

## Owner checks before submission

1. Verify that the entrant was accepted and can access the current Official
   Rules and final submission form; confirm the appropriate track and personal
   eligibility.
2. Resolve the live Meta requirement from those rules. If a hosted call is
   required, confirm active hackathon credits and provider-side no-overage
   provider-side no-overage protection are confirmed.
3. Confirm exact disclosure, repository/media fields, recording requirements,
   and entrant-work license terms; review the MIT project license together
   with the event license.
4. Confirm that the separately supplied unsigned Rust engine is acceptable to
   the evaluator.
5. Record the demo, review the complete video for truthful failure states and
   no credentials, then add the approved video link if the form requires one.

No portal was used, and nothing has been submitted or published.
