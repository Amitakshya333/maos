# MAOS Industrial — Recording Readiness (Ring)

Last reviewed: 2026-11-02

**State:** Ring (`ring-agent-service` + `ring-inference-service`) is wired to
the hosted Meta model `meta-models/muse-spark-open-1026` via
`https://inference.baseten.co/v1` (policy-pinned:
`src/backends/meta-api-policy.ts:3-5`). The 5-minute Ring stage arc is in
[`PRESENTATION_SCRIPT.md`](PRESENTATION_SCRIPT.md). No video has been
recorded — every segment is TO-RECORD. Three clean rehearsals from the
packaged build are still required before recording.

On-screen identity (identical everywhere):
`HOSTED · meta-models/muse-spark-open-1026 via Baseten`
(`tests/gui/ring-impl-01.test.ts:94`); fallback
`EVIDENCE-ONLY · no model configured`
(`tests/gui/ring-impl-01.test.ts:105`).

## Spine and platform truth (TASK DEV-C-FEEL-01)

- Spine: Linux CLI starts the thread → Windows overlay continues the same
  thread → refusal beat → audit verify. The overlay continuation is the
  Expand handoff on the same thread id (`RING_EXPAND_KEY`); it is covered
  by GUI tests, not by a recording yet.
- Linux CLI leg: TO-RECORD. Distro/version TO-FILL — no Linux VM result
  was available for this pass, so no Linux claim is made here.
- GUI legs (full app + overlay): Windows. Electron is NOT claimed on Linux.
- CUT, not on camera: a CLI-started thread appearing in the GUI thread
  sidebar (no Ring thread command in `src/cli/`, no thread-list route).

## Verified evidence

- Hosted wiring: exact provider/endpoint/model triple plus
`basetenApiEnabled=true` opt-in enforced
(`src/service/ring-inference-service.ts:97-135`); `mode: 'hosted'` with
`servedModelId`-only-on-echo vs `mode: 'evidence-only'`, and
`RING_HOSTED_INFERENCE_FAILED` fallback
(`src/service/ring-inference-service.ts:300-398`). No other endpoint/model
is possible without tripping `BASETEN_API_CONFIGURATION_INVALID`.
- Loopback-proven streaming: streamed fragments recorded as `model.delta`
(`src/service/ring-agent-service.ts:890-908`); no-stream provider completes
with NO fabricated deltas
(`tests/industrial/ring-dev-a.test.ts:173-177`); evidence-only never
touches a provider (`tests/industrial/ring-dev-a.test.ts:109`).
- Live reliability: both retained `live-report.json` runs agree at 3/4 —
evidence tools reliable; `memory-and-plan` misses `remember`/`update_plan`
both times. Decided hybrid: server-side deterministic bookkeeping prefetch
(`skill.prefetch`) first, model writes prose and proposes
(`src/service/ring-agent-service.ts:194-230`;
`tests/industrial/ring-hybrid.test.ts:1-60`). All automated tests are
evidence-only/mocks-only (`BASETEN_API_KEY` asserted unset;
`tests/industrial/ring-hybrid.test.ts:52-59`).
- Deterministic T-07 for camera: verdict `CRITICAL`, overall RMS
`2.637 mm/s` (`tests/industrial/ring-inference.test.ts:184-185,223-224`);
refusal wording ends "This is decision support, not operating authority.
Synthetic demo data only." (`src/service/ring-safety.ts:77`).
- Overlay: hotkey defaults to `Ctrl+Shift+Space`
(`desktop/ring-overlay-host.cjs:20`; `desktop/ring-smoke.cjs:29`); inline
Allow/Deny approval cards on `approval.pending`
(`src/gui/src/components/RingOverlay.tsx:10,366-374`).
- T-07 judged-run evidence retained from the prior gate: full browser-gate
package `maosorch-0.3.0.tgz` (946 entries, 12,994,081 unpacked bytes,
SHA-256 `156e8b93dd99d975d07d4c6890ba43a86378f24383e6083330d4ad11eabc0553`);
docs-only repack (946 entries / 12,994,514 bytes, SHA-256
`4819e703d6687a76c8d97ad6de814d672ac84a81dae17d059843816a0d9cc58a`); three
consecutive browser rehearsals with same-run artifact/audit linkage and
exact returned-run-ID verification (completed runs
`judged-run-1793082068886-159c1b`, `judged-run-1793082081352-576737`,
`judged-run-1793082093074-61cfaf`; stale negatives failed closed;
rejection persisted without a report). Rehearsal evidence retained under
`%TEMP%\maos-desktop-release-35394b7bbbc34984b6a93badc722b9ea\evidence\rehearsal-1.json`
through `rehearsal-3.json`.
- The separate Rust binary answered `maos-industrial-engine` 0.1.0, protocol
1.0, Rust 1.95.0, status `ok`; its staged SHA-256 matched the source-built
binary (copy-integrity evidence, not a signed publisher attestation).
Evaluator acceptance of the separate unsigned prerequisite is unknown.

## Packaged build staging recipe (Ring recording)

1. Fresh scratch: new detached worktree at current main HEAD (never reuse a
stale tree; never touch `C:/maos` except the packet dir).
2. `npm ci`, then build (`npm run build` + backend build), on the staging
tree.
3. Stage the source-built Rust engine; record its SHA-256 and confirm the
staged binary hash matches.
4. Baseten config from the redacted template (`providers.baseten` with
`baseURL https://inference.baseten.co/v1`, model
`meta-models/muse-spark-open-1026`, `basetenApiEnabled: true`) **plus the
`schemaVersion` template rule** (config must carry the required
`schemaVersion` field) — arm at recording time only, never commit
`basetenApiEnabled: true` to main.
5. `BASETEN_API_KEY` in the launcher shell ONLY — never pasted, never in a
file, never committed.
6. Rebuild-before-record rule: the staging tree must match current main.
This rule was bitten twice before — do not record from a stale tree.

## Hosted budget

- Planning caps (not spend records):
`docs/product/RING_AGENT_PM_HANDOFF_2.md:39-41` — Day 1 (Nov 2) up to 5
hosted runs; Day 2 (Nov 3) up to 15; Day 3 (Nov 4) up to 15.
- State runs used so far: the two retained live reliability reports each
record 4 hosted instruction-runs = 8 hosted instruction-runs evidenced
here. No provider-side spend records exist in the packet history, so this
count is TO-FILL against authoritative provider usage if available.
- Before any further hosted request: the intended account must show an
active, unexpired hackathon credit balance and provider-side protection
against paid overage. A client estimate or API key alone is not that
protection. Do not request or expose an API key.

## Evidence-only fallback path

If hosted mode is unavailable on camera, run the evidence-only fallback and
label it EVIDENCE-ONLY on screen: `mode: 'evidence-only'` returns the
deterministic summary with zero model wording
(`src/service/ring-inference-service.ts:320-328`); the banner states that
no model wrote the answer and no model ran
(`tests/gui/ring-impl-01.test.ts:116-120`). Never replay a saved model
response while showing it as live. The fallback still shows the refusal
beat, the approval card, and the audit verify.

## Rehearsal and freeze gates

- Three clean rehearsals from the packaged build are required (definition
of done: 8-step demo runs from the packaged build three times in a row in
hosted mode, once in evidence-only —
`docs/product/RING_AGENT_PM_HANDOFF_2.md:133-135`). TO-RECORD: none of the
three Ring rehearsals have been recorded yet.
- Bug-fix only Nov 4 12:00; feature freeze Nov 4 18:00; video by Nov 4
23:59; submission Nov 5 07:30 IST
(`docs/product/RING_AGENT_PM_HANDOFF_2.md:103-106`).
- No video has been captured and nothing has been submitted or published.
Confirm the selected-participant account can access the actual rules/form,
that the demonstrated hosted Meta use satisfies them, and acceptance of
the separate unsigned Rust prerequisite before final submission.

## Recording go/no-go

The exact Ring recording script is in
[`PRESENTATION_SCRIPT.md`](PRESENTATION_SCRIPT.md): synthetic/local
labels, `FAIL`/`CRITICAL` verdict visible, separate run/thread IDs per
segment, same-ID verification, tamper beat on a copy, overlay hotkey +
approval card, refusal beat, and HOSTED/EVIDENCE-ONLY identity identical
everywhere. Use it for a hackathon entry only after reviewing the current
participant rules and confirming that the demonstrated hosted Meta use
satisfies them.

The supported launch requires the separately installed Electron runtime and
Rust engine; the npm tarball is not a signed desktop installer and does not
bundle Rust. Use the exact package path and launch instructions in
[`RUNBOOK.md`](RUNBOOK.md) and [`../../desktop/README.md`](../../desktop/README.md).

## Claims and limits

- Inputs are synthetic T-07 (plus P-12 triplet) fixtures. Thresholds are
demo rules, not a certified standard or operating authorization.
- TypeScript performs the T-07 RMS/threshold analysis. Rust backs
audit-chain hashing and verification.
- Voice is stretch-only and cut
(`docs/product/RING_AGENT_PM_BRIEF.md:119,169`); the P-12 scan PNG and
photo are NOT wired into Ring evidence paths in this packet
(`demo/industrial/DEMO_PACK_PROVENANCE.json:278,292`). Do not show them as
Ring vision.
- Loopback binding does not establish that the entire workstation is
offline.
- A pending manual-review run has no completed report until approval and
resume. CLI `--auto-approve --yes` is an explicit synthetic approval path,
not human review.
- The legacy direct CLI dashboard path is not the supported authenticated
GUI topology and is not used as release-rehearsal evidence.
