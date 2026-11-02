# PM Handoff #3 — Ring CLI on Linux, GUI "feel", and the repo plan

**From:** Head of Product · **To:** PM · **Written:** 2026-11-02 20:30 IST
**Base:** `main` = `d3f0f23`. **Feature freeze stays Nov 4 18:00 IST. Submission Nov 5 07:30 IST.**
About 45 build hours remain. That is enough for **one** new headline feature, done properly. This is it.

---

## 0. Accepting your Checkpoint 2 decisions

All four are approved:
- Re-package from current `main` before any rehearsal.
- Never rehearse on `074e1f8`.
- Do the eye-check yourself.
- Run **one** live hosted confirmation on the hybrid router **first thing tomorrow (Nov 3)**, before any new code is judged. The 4-of-5 rule applies.

That live run matters more than anything below. **Without a real Meta model call on camera, nothing else here is wow.**

---

## 1. Why the direction changes

The GUI Ring works, but it reads as "a nice chat panel." Judges have seen many of those. What they haven't seen:

> **The same industrial agent, in a terminal, on a Linux plant box, doing Claude-Code-style work: it plans, calls tools, streams, asks y/N before writing, produces a work order, and refuses to authorize a restart.**

Industrial edge gateways, historians and SCADA-adjacent servers are mostly **headless Linux reached over SSH**. A terminal-native agent is the honest "Claude Code / Codex for industrial people" story, and it shows the agent is an engine, not just a UI.

**The new demo spine:**
1. Linux (SSH)
2. → `maos-industrial ring` handles the shift brief and work order
3. → the Windows desktop `Ctrl+Shift+Space` overlay continues on the same machine's thread
4. → refusal
5. → audit verify

---

## 2. Build plan (3 lanes, Nov 3 09:00 → Nov 4 18:00)

### Dev A: Ring CLI (the headline)

New subcommand on the existing bin `maos-industrial` (`src/industrial/entrypoint.ts` / `industrial-cli.ts`). **Do not add a new agent engine.** Call `RingAgentService` (threads, skills, registry, approvals, streaming events) **in-process**, using the same `.maos/ring-runs` store as the GUI.

- `maos-industrial ring` is an interactive REPL (plain `readline` + `chalk`; **no Ink/TUI framework**, no time for it):
  - streamed model text as it arrives (real `model.delta` only; whole text when the provider doesn't stream, labelled)
  - plan checklist that redraws as `[x]` / `[ ]` lines
  - tool lines, e.g. `▸ analyze_telemetry … ✓ CRITICAL · RMS 2.637`
  - **approval prompt `Approve "Create work order WO-…"? [y/N]`**. Default is **No**, and that's recorded in the audit.
  - artifact lines with absolute paths
  - mode badge on start: `HOSTED · meta-models/muse-spark-open-1026 via Baseten` or `EVIDENCE-ONLY`
  - `Ctrl+C` once cancels the run (existing cancel); twice exits
- Slash commands map to the existing 6 skills: `/handover /rca /permit /loto /sop /report`, plus `/threads`, `/new`, `/resume <id>`, `/role <r>`, `/verify`, `/help`.
- **Headless mode** (like `claude -p`): `maos-industrial ring -p "<instruction>" [--json] [--thread <id>] [--yes-to none]`.
  - `--json` prints the wire events as JSONL, so it can be scripted or run from cron/systemd. For example, a 06:00 shift brief written to a file.
  - **Headless can never auto-approve.** Consequential steps end the run as `awaiting_approval`, with exit code 3 and a resume hint. No `--yes` flag exists for consequential tools. Say this on camera; it's a trust feature.
- Exit codes: 0 completed, 1 failed, 2 refused/cancelled, 3 awaiting approval.
- Text sanitising: reuse `safeTerminalText` from `industrial-repl.ts`. Model output must never inject terminal control sequences.
- Tests: REPL driven by injected stdin/stdout (the existing `IndustrialReplOptions` pattern), headless JSON contract, approval default-No, exit codes, control-char stripping, evidence-only path, mocked hosted streaming.

**Done when:** on Linux over SSH, the user types `/handover` and sees the plan + tools stream, answers `y`, gets a DOCX/MD path, asks a follow-up, is refused on "approve the restart," and runs `/verify`. All without the GUI.

### Dev B: Linux enablement + packaging

- Fresh Linux VM (Ubuntu LTS; note the exact version): `npm ci && npm run build:backend`, install the packed tarball, and run `maos-industrial ring` evidence-only, then hosted.
- **Rust engine for Linux:** `cargo build --release` in `rust/` on the VM. `rust-engine-bridge.ts` already resolves `maos-engine` without `.exe`. Audit verify must pass on Linux. If the engine can't build, `/verify` must say so honestly, and the demo verifies on Windows.
- Windows-only modules (`firewall/windows-firewall-adapter.ts`, `network/windows-socket-observer.ts`) must **degrade with an honest "not available on linux" message**, never crash or report false success. Add a Linux platform test.
- Scan text-layer extraction (T-07 inspection PDF) proven on Linux, or honestly unavailable.
- Path/CRLF/case-sensitivity bugs: run the Ring suites on the VM (`npx vitest run tests/industrial/ring-* tests/gui/ring-*`).
- Write `demo/industrial/LINUX_RUNBOOK.md`: exact commands from a clean VM to the first `ring` prompt.
- **Not in scope:** Electron on Linux, systemd packaging, .deb/.rpm.

### Dev C: GUI "feel" pass + demo/docs

The GUI gets **polish only**; no new features. Aim for "feels like Grok/ChatGPT":
- Overlay is keyboard-first: focus lands in the input on summon, `Enter` sends, `Esc` hides, `↑` recalls the last prompt.
- The first visible output arrives within ~1s: show the plan/"thinking" state immediately, then stream.
- Answer layout: a **one-line bottom line first**, then evidence and sources. Numbers with units. Collapsed tool details (click to expand).
- Ring animation states match real run state. No spinning while waiting for approval; use a distinct "needs you" state.
- Thread continuity: a thread started in the CLI on Windows appears in the overlay sidebar (same store). If that works, it's a great 10-second moment. If it isn't trivial, cut it.
- Then update `PRESENTATION_SCRIPT.md`, `RECORDING_READINESS.md` and `HACKATHON_SUBMISSION.md` for the new spine (Section 1). State truthfully: Linux CLI tested on <distro/version>, GUI on Windows, Electron not claimed on Linux.

---

## 3. Schedule

| IST | Milestone |
|---|---|
| Nov 3 09:00 | Live hosted confirmation on the hybrid router (PM). Re-package `main`. A/B/C start in parallel. |
| Nov 3 14:00 | Dev B: Linux VM builds + Ring suites pass, or a blockers list. Dev A: REPL streaming + approval working evidence-only. |
| Nov 3 21:00 | **Checkpoint 3:** CLI demo on Linux (evidence-only + 1 hosted), GUI polish, screenshots/recording to user. |
| Nov 4 12:00 | Bug fixes only. Three rehearsals of the new spine from packaged builds (Windows + Linux). |
| Nov 4 18:00 | Freeze. Docs truthful. |
| Nov 4 by 23:59 | Video. |

**Hosted budget:** 1–3 runs Nov 3 morning (confirmation), 2 runs at Checkpoint 3 (1 CLI Linux, 1 GUI), and **at least 5 kept for recording.** If Baseten is down at recording time, record evidence-only and say so.

**Cut order if behind:** CLI↔overlay thread continuity → headless `--json` → `/permit` `/loto` `/sop` in CLI → Linux Rust engine (verify on Windows instead).
**Never cut:** interactive CLI with streaming + y/N approval + refusal on Linux, live hosted run, GUI overlay demo.

---

## 4. Repo separation: MAOS vs MAOS Industrial

The user wants MAOS (the orchestrator, `github.com/Amitakshya333/maos`) left clean, with Industrial in its own repo/folder. Facts:
- All Ring/Industrial work has been pushed to **`Amitakshya333/maos` `main`**.
- **`github.com/Amitakshya333/MAOS-industrial-` already exists** (HEAD `f1e3192`, an older commit from the same history). The package metadata already points there.
- `docs/product/REPO_SEPARATION_PLAN.md` describes a proper Core/Industrial split. **That full split is 9 steps of work and is NOT to be attempted before submission.** It would break packaging during the most fragile 48 hours.

**Plan:**
1. **Before submission (Nov 4, after freeze, user approves every push):** push the frozen commit to the **MAOS-industrial-** repo as `main`, and tag it `hackathon-2026-submission` there. **This is the repo link we submit.** It contains the whole codebase, which is honest: Industrial is built on MAOS Core, and the README says so in one paragraph.
2. **Do not rewrite or force-push `maos` during judging.** Judges or graders may follow commit links. Leave `maos` as-is until results are announced.
3. **After the hackathon:** execute `REPO_SEPARATION_PLAN.md` properly. Industrial becomes a consumer of a pinned MAOS Core. Then restore `maos` to a core-only state using **new revert/removal commits plus a tag** (`pre-industrial-split`), **not** a history rewrite, unless the user explicitly chooses a force-push.
4. Local folders: after submission, clone `MAOS-industrial-` into its own folder (e.g. `C:\maos-industrial`). Stop doing Industrial work in `C:\maos`.

Every push to either GitHub repo needs the user's explicit OK. It is outward-facing.

---

## 5. Unchanged rules

Truthfulness, approval-before-writes, raw telemetry never sent, audit everything, synthetic data only, evidence-only must work, never weaken provider policy, never commit keys, tests with features, don't break the judged T-07 flow. Recording gate = Ring suites + `npm run build` + `npm run typecheck:gui` on Windows, plus the Ring suites on the Linux VM.
