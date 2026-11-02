# Baseten Muse Spark reasoning/output-budget correction

Status: implementation and focused local/mock verification complete. No hosted
request was made. This handoff does not authorize provider use or a live pilot.

## Baseline and packet identity

- Repository: `C:\maos`, branch `main`.
- Base: `f201cfe38bf3a741b5d8c6b37793cc3c112c43a9`.
- The index was empty at the start of this work. Unrelated existing dirty work
  was preserved; no files were staged or committed.
- Five-path patch: `f201cfe-to-baseten-reasoning-budget.patch`
  - SHA-256: `a27be14a64b11f58bed185c7b053fbe5ce677f884da8c84bcbc8ca085af5d53a`
- Source manifest: `source-hashes.json`
  - SHA-256: `f40ddac78ad81e7d05797125e167ac8fa66357c771bf619b80fb8019b5d24476`
  - The manifest's patch hash agrees with the patch file. All five patch paths
    match the manifest, and current raw and LF-normalized source hashes were
    directly checked against it.
- `git apply --stat` parsed the packet as five paths. The patch was generated
  from the declared base and current files; it was not applied this turn.
  Parsing/stat output is not a clean-base reconstruction or application test.

The patch/manifest scope is exactly:

1. `src/backends/openai-provider.ts`
2. `tests/backends/baseten-api-provider-boundary.test.ts`
3. `tests/backends/openai-provider-local-tool-call.test.ts`
4. `tests/industrial/meta-model-api-contract.test.ts`
5. `review-packets/baseten-reasoning-budget-2026-10-30/BASETEN_HACKATHON_PILOT_OWNER_DECISION.md`

Validation logs and this handoff are packet evidence, not patch/source-manifest
members.

## Correction

For the exact explicitly enabled Baseten model, the OpenAI-compatible provider
requests `reasoning_effort: "low"` and fixes `max_tokens` at 1,500 per
generation; caller token overrides cannot lower or raise this Baseten budget.
Meta remains at its prior 256-token limit without a `reasoning_effort` field;
local and unrelated providers retain their previous token behavior.

Baseten `finish_reason: "length"` responses fail as incomplete, and empty
content with no usable tool call fails as empty. The adapter discards partial
output on truncation and does not expose or persist provider reasoning fields.
No automatic restart, budget increase, fallback, or replanning was added.

The existing Industrial limits remain: at most four total generations, one
`analyze_telemetry_csv` execution, one overall 60-second deadline, and zero
SDK/Core/task retries. Four calls at 1,500 output tokens mean at most 6,000
output tokens total if all calls are used; reasoning is included and input
tokens are additional. This is a token limit, not a dollar spending cap.

## Fresh validation performed this turn

All requests used loopback/injected mocks; there were no hosted calls.

- `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/backends/baseten-api-provider-boundary.test.ts tests/backends/openai-provider-local-tool-call.test.ts`
  - 2 files, 30 passed, 0 skipped; exit 0.
- `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/meta-model-api-contract.test.ts -t "does not accept a Baseten|applies the sixty-second Industrial deadline"`
  - 3 passed; 29 other tests were intentionally filtered/skipped; exit 0.
  - Covers both truncated/empty reasoning-only responses and deadline/cancellation.
- `npm run build:backend`
  - Backend TypeScript build and Python asset-copy step exited 0.
- `git diff --check HEAD --` the four tracked source/test paths
  - Exit 0.

Raw command, stdout, stderr, and exit-code files for these runs are under
`validation/` with the `correction-` prefix. An initial wrapper attempt failed
to decode Windows output and invoke the npm command shim; those attempts are
not counted. The successful reruns use byte-preserving capture and an explicit
`cmd.exe` invocation for the build.

## Retained, not rerun

The packet retains a previous complete three-file focused run reporting 62
passed, 0 skipped, plus its command and exit code. Its command used
`MAOS_TEST_ENGINE_PATH` with an external candidate engine. The retained identity
record describes that engine as external and unsigned/unapproved. I did not
execute that binary this turn; those 62 passes are historical retained evidence,
not part of the fresh 33 passes above.

That retained run includes the full Industrial round trip and the four-generation
ceiling/one-telemetry assertion. Those particular full round-trip assertions
were not freshly rerun without the external engine. The filtered current
Industrial run did not exercise the telemetry tool path. No live inference,
installed GUI, package, or host-service validation was performed.

## Owner-reported guidance and open decisions

The owner relays that this exact alias supports `reasoning_effort: "low"`, that
reasoning tokens count toward `max_tokens`, that a small budget can yield empty
content with `finish_reason: "length"`, and that 1,500 tokens per call is
recommended for short tool-calling round trips. The change is based on that
owner-supplied guidance; it was not validated against Baseten's hosted service.

The owner also reports a pinned note saying the key cannot be charged beyond a
$100 grant. That note, account applicability, grant expiry, and exhaustion
behavior have not been independently verified or tested. Neither this local
token budget nor the code establishes a dollar cap or provider-side
no-overage enforcement. Model-use terms, account/grant applicability, and event
eligibility remain owner decisions.

The proposed pilot is synthetic-only. Raw CSV bytes stay local; the provider
receives the request/instructions, selected relative path, tool schema, and
locally derived tool results/metrics/findings, which may still be sensitive.
Do not use operational or personal data. The decision sheet contains the
proposed limits and data boundary; it is not authorization to make a hosted
request.
