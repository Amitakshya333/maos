# MAOS Industrial — Hackathon Submission Packet (Draft)

**Status:** Local packet prepared; **not submitted**. No video has been recorded.
Confirm selected-participant eligibility and inspect the actual participant
rules/form before using this draft. Meta credits are not active, so no hosted
request was made and no live Meta integration is claimed.

## Project summary

MAOS Industrial demonstrates a human-reviewed industrial evidence workflow
using bundled synthetic turbine telemetry and demo thresholds. It computes
vibration RMS and threshold findings locally, pauses for reviewer approval,
generates a DOCX report, and verifies the completed run and audit export by the
same returned run ID. A changed source or threshold file invalidates approval;
an explicit rejection persists without generating a report.

The verified T-07 analysis is deterministic TypeScript. A separately installed
Rust engine provides audit-chain hashing and verification. No Meta Model API
request is part of the verified run. Loopback service binding does not prove
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
to confirm a mandatory live Meta runtime call. The following remain
**unconfirmed** until the current participant rules/form are inspected:

- whether a live Meta model call is mandatory at runtime;
- existing-code disclosure requirements;
- required project/repository links, demo media, video length, and format;
- entrant-work license and recording/likeness terms;
- exact form fields, current eligibility details, and acceptance status.

Do not submit on the assumption that the pasted waiver or public promotional
copy is the current complete rule set. The user's approved spending/data
envelope is synthetic data only, active hackathon credits only, and no paid
overage. Before any hosted request, confirm an active, unexpired positive
credit balance in the intended account and provider-side hard no-overage
protection. No API key is needed for that confirmation.

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
   required, keep this packet blocked until active hackathon credits and
   provider-side no-overage protection are confirmed.
3. Confirm exact disclosure, repository/media fields, recording requirements,
   and entrant-work license terms; review the MIT project license together
   with the event license.
4. Confirm that the separately supplied unsigned Rust engine is acceptable to
   the evaluator.
5. Record the demo, review the complete video for truthful failure states and
   no credentials, then add the approved video link if the form requires one.

No portal was used, and nothing has been submitted or published.
