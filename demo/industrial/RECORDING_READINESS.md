# MAOS Industrial — Recording Readiness

Last reviewed: 2026-10-27 11:59 IST

**State:** The supported Windows Electron test-shell path passed three
consecutive installed-package browser rehearsals on one runtime build. A final
submission-text-only repack passed clean install and CLI verification; it was
not opened in Electron. The local/synthetic recording script is prepared. No
video has been recorded, and
the hackathon submission remains on hold until the owner can review the
participant-accessible rules/form and resolve the Meta-use gate.

## Verified evidence

- Full browser-gate package `maosorch-0.3.0.tgz`: 946 entries, 12,994,081 unpacked
  bytes, SHA-256
  `156e8b93dd99d975d07d4c6890ba43a86378f24383e6083330d4ad11eabc0553`.
  The archive contains four synthetic fixtures, four Python sources, three GUI
  assets, five desktop runtime/tooling assets, and the Industrial profile. It
  does not contain the Rust engine.
- Full browser-gate CLI run `judged-run-1793082059836-b70aa1` completed with a
  persisted manifest, expected engineering verdict `FAIL`, DOCX and audit
  export, and exact-returned-run-ID verification `valid=true`. Successful
  workflow execution and the engineering `FAIL` result are separate facts.
- The final documentation repack had 946 entries / 12,994,514 unpacked
  bytes and SHA-256
  `4819e703d6687a76c8d97ad6de814d672ac84a81dae17d059843816a0d9cc58a`. It was
  clean-installed, then CLI run `judged-run-1793082585055-f415a6` completed
  with a valid manifest, expected engineering `FAIL`, DOCX/audit exports, and
  exact-ID verification `valid=true`. The two packaged text files updated after
  the three browser rehearsals were `HACKATHON_SUBMISSION.md` and
  `PRESENTATION_SCRIPT.md`; GUI interaction was not repeated on this
  documentation-only archive.
- Three consecutive browser rehearsals on that tarball:

  | Scenario | Completed run | Negative case | Result |
  |---|---|---|---|
  | Source change | `judged-run-1793082068886-159c1b` | `judged-run-1793082067932-b720c0` | Stale approval failed closed |
  | Rules change | `judged-run-1793082081352-576737` | `judged-run-1793082080423-bbbe12` | Stale approval failed closed |
  | Rejection | `judged-run-1793082093074-61cfaf` | `judged-run-1793082092138-46400e` | Rejection persisted; no report |

- Each completed run has a `completed` manifest with verdict `FAIL`, an
  authenticated DOCX download whose hash matches the manifest, same-run audit
  linkage, a verified audit chain, and installed CLI verification of the exact
  browser-returned run ID. Refresh/reconnect while awaiting review resumed the
  same pending run. Failed download did not trigger a native download.
- The security checks rejected missing/invalid sessions, wrong project and
  missing/wrong origin. The session token was absent from URL, browser storage,
  and cookies. The supported launch is the Electron main process →
  `ProjectHostLauncher` → private IPC → isolated renderer path. REST and events
  use the runtime project and exact renderer origin.
- Sanitized latest rehearsal evidence is retained under
  `%TEMP%\maos-desktop-release-35394b7bbbc34984b6a93badc722b9ea\evidence\rehearsal-1.json`
  through `rehearsal-3.json`. The earlier Computer Use URL-identification
  limitation was an automation issue before navigation; the Playwright
  rehearsals supersede it.
- The separate Rust binary answered `maos-industrial-engine` 0.1.0, protocol
  1.0, Rust 1.95.0, status `ok`; its staged SHA-256 matched the source-built
  binary. This is copy-integrity evidence, not a signed publisher attestation.
  The tested missing-engine error gives the expected path, build command, and
  copy instructions. Evaluator acceptance of the separate prerequisite is
  unknown. T-07 analysis does not invoke Python.

## Remaining gates

- The official [Meta event page](https://dev.meta.ai/events/global-hackathon)
  lists the Indie and Startup tracks, the manufacturing theme, and project
  submissions due Nov 4, 2026 at 9:00 PM ET (Nov 5 at 07:30 IST). It says
  Official Rules were to be published before Oct 26. The public waiver link at
  `https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver` currently
  renders only “Loading”; both public `/submit` URL variants returned HTTP 404.
  Selected-participant access, current final fields, existing-code disclosure,
  license terms, video specifications, and whether live Meta runtime use is
  mandatory remain unconfirmed.
- No hosted Meta request was made. The user reports that the additional credit
  has not arrived. Before any hosted request, the intended account must show an
  active, unexpired hackathon credit balance and provider-side protection
  against paid overage. A client estimate or API key alone is not that
  protection. Do not request or expose an API key.
- No video was captured and nothing was submitted or published. Confirm the
  selected-participant account can access the actual rules and form, whether a
  local/non-Meta demonstration is eligible, and acceptance of the separate
  unsigned Rust prerequisite before final submission.

## Recording go/no-go

The exact local recording script is in
[`PRESENTATION_SCRIPT.md`](PRESENTATION_SCRIPT.md). It labels the demo as
synthetic/local, keeps the engineering `FAIL` visible, uses separate run IDs
for approval, stale-input failure, and rejection, and verifies the completed
run by its returned ID. The script is suitable for a truthful local capture.
Use it for a hackathon entry only after reviewing the current participant
rules and confirming that the demonstrated Meta use satisfies them.

The supported launch requires the separately installed Electron runtime and
Rust engine; the npm tarball is not a signed desktop installer and does not
bundle Rust. Use the exact package path and launch instructions in
[`RUNBOOK.md`](RUNBOOK.md) and [`../../desktop/README.md`](../../desktop/README.md).

## Claims and limits

- Inputs are synthetic T-07 fixtures. Thresholds are demo rules, not a certified
  standard or operating authorization.
- TypeScript performs the T-07 RMS/threshold analysis. Rust backs audit-chain
  hashing and verification.
- The verified workflow makes no hosted Meta call. Do not describe it as a live
  Meta integration.
- Loopback binding does not establish that the entire workstation is offline.
- A pending manual-review run has no completed report until approval and resume.
  CLI `--auto-approve --yes` is an explicit synthetic approval path, not human
  review.
- The legacy direct CLI dashboard path is not the supported authenticated GUI
  topology and is not used as release-rehearsal evidence.
