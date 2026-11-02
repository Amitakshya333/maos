# Staging discrepancy resolutions (2026-10-31)

Corrections apply to staging documentation only. Committed Core docs were
not edited (application-code lane owns them). Each resolution cites the
authoritative source.

## D1. Rust toolchain pin — RESOLVED in favor of the tree

- Claim (committed `docs/INSTALLATION.md`): "the repository does not pin
  that toolchain".
- Authoritative source: the committed tree. `rust/rust-toolchain.toml` exists
  at `2cfdf9b` (`channel = "1.95.0"`, rustfmt/clippy,
  `x86_64-pc-windows-msvc`) and already existed at `27dd171`, the commit
  that introduced the sentence — so the sentence was wrong when written.
  (Pin file itself added pre-event, Sep 28.)
- Precise Rust 1.95 wording (three distinct facts, do not conflate):
  (a) `rust/rust-toolchain.toml` `channel = "1.95.0"` pins the build
  toolchain used by the judge build; (b) Cargo workspace
  `rust-version = "1.95.0"` declares the minimum supported Rust version;
  (c) "candidate engine built with Cargo/rustc 1.95.0" (INSTALLATION.md) is
  a single historical build record, not a toolchain lock.
- Staging correction: judge path (README §1/§5) and notices use (a) as the
  authoritative build pin and quote (b)/(c) only with the labels above.
  Owner action: fix the INSTALLATION.md "does not pin" sentence in the
  application lane; no event-doc change beyond this file.

## D2. Python minimum (preflight 3.9 display vs runbook ≥3.10) — RESOLVED as scope split, enforcement gap remains

- Authoritative source: committed `src/industrial/preflight.ts` lines 288–311.
  Behavior: preflight fails without any interpreter (exit 41); when found it
  **passes unconditionally** and only displays
  `<detected> (requires >= <config.pythonMinVersion ?? '3.9'>)` — no version
  comparison exists. No committed config sets `pythonMinVersion`, so judges
  see the `3.9` default.
- Therefore both docs are true in their own scope: INSTALLATION.md describes
  preflight behavior accurately (presence-only + 3.9 display + no compare);
  the runbook's `≥3.10` is a workflow-task requirement (OCR/embedding/
  data-script/sandbox) that nothing enforces, and T-07 does not invoke
  Python at all.
- Staging correction: README §1 states the split; clean-room step 4 records
  the actual interpreter. Remaining owner action: decide whether `≥3.10`
  stays an operator-responsibility note (doc fix in app lane) or becomes
  enforced code (app-lane change + review) — staging cannot change code.
