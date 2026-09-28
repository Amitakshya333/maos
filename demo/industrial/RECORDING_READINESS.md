# MAOS Industrial — Recording Readiness (2026-09-27)

This is a live-readiness snapshot, not a release certification. It separates source/build checks from the end-to-end browser journey.

## Current implementation and checks

- The React Agent Cockpit can start the bundled T-07 judged run and preserves its run ID while moving between Cockpit and Approvals.
- The approval queue displays the prepared anomaly rows, overall vibration RMS, source-file hashes, approval payload hash, and reviewer fields.
- Approval resumes only the matching pending run. A run-specific DOCX and audit export are generated after the reviewer decision; source files are re-hashed before synthesis.
- `maos industrial verify audit --run-id <id>` verifies the audit chain and the same run's manifest, report SHA-256, and export SHA-256.
- Static host-wide air-gap, GPU, model, and latency claims were removed or replaced with measured/qualified wording.
- `npm run build` passed after this integration.
- `npm run typecheck:gui` passed after this integration.
- The running dashboard returned `HEALTHY` from `/api/v1/health` and HTTP 200 for `/#/cockpit` after startup.
- One live run is now staged at the human gate: run `judged-run-1790522936778-771054`, approval `appr-judged-run-1790522936778-771054`. The approval is `pending_approval`, the expected four findings and 2.63711 mm/s RMS are attached, and its unique DOCX does not exist yet.

## Still required before recording

- The full GUI journey has not yet been manually completed: start in Cockpit → inspect the same run's approval → approve with a reviewer note → return to Cockpit → verify the same run in the CLI. The current API-started run is waiting for a reviewer decision; it has not been approved by automation.
- The journey must be rehearsed twice from a known state before a final judged take.
- This integration pass did not run the test suite. The previous readiness snapshot noted one stale G5 GUI assertion; it has not been rechecked here.
- A build and a healthy service do not establish that the human-review and report-resume path works in a live click-through. Do not call the recording fully ready until that journey succeeds.

## Claims and limits

- Inputs are a bundled synthetic T-07 demo pack, not live plant data.
- Thresholds are hackathon demonstration rules, not a certified standard or operating authorization.
- The service binds to local loopback. This does not prove that the whole workstation is offline.
- The threshold analysis and RMS calculation are implemented in JavaScript. The Rust engine appends and verifies the audit chain; do not attribute every workflow step to Rust.
- Do not claim that the report exists before approval or that an approval from a different run ID applies to this run.

## Manual go/no-go sequence

1. Build the current production app and restart the dashboard.
2. In `/#/cockpit`, start one T-07 run and copy its run ID.
3. In Approvals, find that exact run ID. Confirm all four expected rows, RMS, source hashes, and pending status.
4. Approve with a reviewer note. Confirm the report appears only after approval and has the same run ID in its unique filename.
5. Return to Cockpit and confirm the same run is completed.
6. Run `node .\dist\cli\index.js industrial verify audit --run-id <same-run-id> --json` and confirm the report and audit-export hashes.
7. Repeat the journey once more before recording. Keep the final capture to one fresh run and narrate only records with its ID.
