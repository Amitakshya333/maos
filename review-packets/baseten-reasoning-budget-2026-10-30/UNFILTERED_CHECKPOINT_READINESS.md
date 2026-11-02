# Baseten reasoning-budget — unfiltered checkpoint readiness

Status: the focused validation gate is closed. This handoff records a passing
unfiltered regression run and recommends only the scoped local source
checkpoint listed below, subject to owner authorization. It grants no live-use,
billing, terms, engine-trust, packaging, or release approval.

## Repository and candidate integrity

- Repository: `C:\maos`, branch `main`.
- HEAD before and after validation: `f201cfe38bf3a741b5d8c6b37793cc3c112c43a9`.
- Index: empty before and after validation.
- Source manifest: `source-hashes.json`.
- Manifest SHA-256 before and after: `f40ddac78ad81e7d05797125e167ac8fa66357c771bf619b80fb8019b5d24476`.
- All five candidate paths in the manifest, including the owner decision
  sheet, matched their recorded raw and LF-normalized hashes before and after
  the run. No candidate source or document was changed.
- The prior filtered validation evidence was preserved. This run is a separate
  unfiltered run; its results overlap the earlier filtered tests and must not
  be added to them as distinct passes.

## Unfiltered run

Command:

```text
node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/backends/baseten-api-provider-boundary.test.ts tests/backends/openai-provider-local-tool-call.test.ts tests/industrial/meta-model-api-contract.test.ts
```

`MAOS_TEST_ENGINE_PATH` was set to the fixture below. The test process received
only `PATH`, `SYSTEMROOT`, `TEMP`, `TMP`, and `MAOS_TEST_ENGINE_PATH`; no provider
credential environment variables were forwarded. Test projects are created
under the operating-system temporary directory by the test fixture and the
suite's teardown removes them. No repository private `.maos` state was read or
targeted.

Result: **3 test files passed; 62 tests passed; 0 failed; 0 skipped; exit 0**.
The complete industrial contract file ran unfiltered, including the four
Baseten generation attempts, single telemetry execution, deadline/cancellation,
empty/truncated response, provider retry, and Meta/local compatibility cases.
All transport requests in the tests were loopback/injected mocks; no hosted
inference occurred.

Raw sanitized command, stdout, stderr, and actual exit code are retained at:

- `validation/reasoning-budget-unfiltered-current.command.txt`
- `validation/reasoning-budget-unfiltered-current.stdout.txt`
- `validation/reasoning-budget-unfiltered-current.stderr.txt`
- `validation/reasoning-budget-unfiltered-current.exit-code.txt`

The captured output was checked for the test credential markers and none remain.
The saved stdout is the full sanitized output; stderr was empty.

## External engine fixture identity and limit

- Path: `C:\Users\AMITAKSHYA SUTAR\.codex\worktrees\baseten-gate-validation-2026-10-29\rust\target\release\maos-engine.exe`
- Size: 472,064 bytes.
- SHA-256: `3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2`.
- The MAOS bridge labels its engine manifest `0.1.0` and expects protocol `1.0`;
  successful engine operation responses in this suite passed the bridge's
  protocol-version check. The version label is bridge metadata, not a signed
  binary attestation.
- This is an external fixture, unsigned/unapproved, with source/build
  provenance unavailable. Its hash identifies bytes only; it is not an
  approval or publisher-trust claim.

## Proposed local source checkpoint boundary

The reviewed five-path packet includes an owner decision sheet as review
 evidence. The source checkpoint is its four-path source/test subset only:

1. `src/backends/openai-provider.ts`
2. `tests/backends/baseten-api-provider-boundary.test.ts`
3. `tests/backends/openai-provider-local-tool-call.test.ts`
4. `tests/industrial/meta-model-api-contract.test.ts`

Exclude `review-packets/baseten-reasoning-budget-2026-10-30/BASETEN_HACKATHON_PILOT_OWNER_DECISION.md`
from the source commit; preserve it as review evidence. Exclude all other packet
files, validation artifacts, unrelated dirty work, private state, generated
outputs, and archives. The four-path source scope is a subset of the verified
five-path packet; source was not changed to create this subset.

Recommendation: suitable for an owner-authorized scoped LOCAL source
checkpoint using exactly the four paths above. No staging or commit was done.
This does not establish live Baseten compatibility, account/grant applicability,
spending protection, model-use terms, engine trust, or release readiness.
