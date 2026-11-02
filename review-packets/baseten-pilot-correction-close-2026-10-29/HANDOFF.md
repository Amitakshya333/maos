# Focused correction handoff — Baseten pilot launcher and provider contract

Status: regression-green candidate; independent correction review requested. No transfer, staging, commit, package rebuild, or hosted request occurred.

## Checkpoint identity

- Main checkout: `C:\maos`, branch `main`, HEAD `bb871cb191184b5de1b790d42fc452a29f8f072e`.
- Parent: `d526bfe95d334ad8a0c73a25db7611c1d0fc7417`.
- Subject: `Add bounded Industrial agent and provider workflows`.
- Authorized checkpoint: yes. The committed tree has exactly the 18 manifest paths and all 18 Git blobs match the reviewed manifest. Manifest SHA-256: `46a52944eaab11a739e063d943cd95840bf92e1702f0dff381f16aeb79a08c6e`.
- Exact verification is in `checkpoint-verification.json`. C:\maos index is empty. Its existing unrelated worktree changes were preserved; private `.maos` contents were not read.

## Contract failures and correction

No production policy change was justified.

- The first failed case intended to test exact Meta without opt-in but its fixture also omitted `apiKeyEnv`. Shared configuration validation correctly returned `PROJECT_CONFIG_INVALID` before reaching opt-in policy. The fixture now retains a valid environment-variable reference while leaving the opt-in disabled; the service returns `MODEL_ENDPOINT_BLOCKED`.
- The second case configured the Meta provider/credential alias at an arbitrary remote host. The shared credential boundary correctly rejects that reserved credential destination as `PROJECT_CONFIG_INVALID`; it must not be loosened to `MODEL_ENDPOINT_BLOCKED`. The case now asserts that exact error and is labelled “remote endpoint with reserved Meta credential.”
- Validation order explains the split: `src/backends/factory.ts:141-150` checks reserved credential use before hosted policy resolution; `src/backends/meta-api-policy.ts:124-174` rejects a Meta credential reference unless it targets the exact approved destination; `src/backends/meta-api-policy.ts:211` emits the opt-in-required error only after candidate validation. `src/industrial/analysis-agent-service.ts:111-113` maps opt-in-required to `MODEL_ENDPOINT_BLOCKED`; other policy errors remain `PROJECT_CONFIG_INVALID`. `src/api/router.ts:621-622` maps those codes to 403 and 503 respectively. OpenAPI at `src/api/openapi-spec.ts:643-644` describes 403 for endpoint blocked by local-only policy and 503 for invalid/unavailable project configuration. Thus the remote Meta-credential case is a configuration rejection, not a changed endpoint-block code.
- Both cases now pass their exact error assertion and then assert zero outbound fetches and zero loopback mock requests. No key is set for either rejected configuration.

## Cancellation defect and installed-app limits

The launcher originally subscribed a PowerShell `ScriptBlock` to `Console.CancelKeyPress`. Ctrl+C invokes that callback on the console signal thread, which has no PowerShell runspace; the observed failure was `There is no Runspace available`. The launcher could not reliably signal cancellation through its owned-process-tree shutdown path.

The correction uses a small C# `MaosPilotConsoleCancellation` handler in the existing Windows process-tree helper. It sets `Cancel = true`, cancels a `CancellationToken`, and unsubscribes/disposes after the owned tree has exited. The process-tree regression checks the adapter wiring. The actual Ctrl+C mock rehearsal is retained in the historical handoff/evidence.

That installed-app rehearsal used the Electron binary/backend from the old bundle but loaded corrected loose PowerShell launcher/helper files from the temporary correction worktree. It is evidence for the cancellation correction with the installed Electron runtime, not a pass for a rebuilt corrected package. The old bundle remains unchanged at 1,265,219 bytes, SHA-256 `353a719f2708669b3f978ac6aa023f72323cb96027dc34ec2a21cbe8e7429b9c`.

The cancellation catch path and process-tree cleanup were observed, but the terminal wrapper reports nonzero PowerShell exits as `1`; it did not preserve native exit code `130`. The launcher mutex is scoped to its documented Windows session and participating launches. It does not establish an account-wide concurrency limit.

## Validation

Commands were run from the correction worktree at the confirmed base. Raw outputs, including earlier failures, are retained in `validation/` and `history/`.

| Command | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/meta-model-api-contract.test.ts` with `MAOS_TEST_ENGINE_PATH` pointing to the established external fixture | 30 passed, 0 failed, 0 skipped; exit 0. |
| `node node_modules/vitest/vitest.mjs run --root . --config vitest.config.ts tests/industrial/baseten-pilot-process-tree.test.ts` | 8 passed, 0 failed, 0 skipped; exit 0. |
| `git diff --check bb871cb191184b5de1b790d42fc452a29f8f072e -- <four scoped paths>` | Exit 0. Git emitted only CRLF-to-LF normalization warnings. |

The provider suite copied the supplied external engine into its own temporary projects through the established test fixture. Engine: 472,064 bytes, SHA-256 `3dc07f0a5b097867e5e9b150d54e6490898b7465dcfe654a6e490d9c9b6da2a2`; retained identity check reports v0.1.0 / protocol 1.0. Authenticode is `NotSigned`; source revision/build inputs and an approved artifact manifest are unavailable. The engine remains external and unapproved.

Test accounting: final distinct suites contain 30 + 8 = 38 tests, all passing. Earlier overlapping provider runs are preserved as troubleshooting records (28 passed/2 failed; then 29 passed/1 failed); they are not added to the final count.

## Correction packet provenance

- Base: `bb871cb191184b5de1b790d42fc452a29f8f072e`.
- Scope: exactly four tracked files: `scripts/Start-BasetenSyntheticPilot.ps1`, `scripts/Windows-ProcessTree.ps1`, `tests/industrial/baseten-pilot-process-tree.test.ts`, and `tests/industrial/meta-model-api-contract.test.ts`.
- Correction patch SHA-256: `dbb62ab351b474cd158071b34f47be173f890cb869391b6befa0e9ddb45b8ad1`.
- Source manifest SHA-256: `2f089126d37461c4bcb60633bfd35f3845a2b3274d99567c28984a147af64a92`.
- Source-hash verification is in `current-source-verification.json`.
- The patch applied successfully to an isolated temporary tree populated with the exact four base blobs. LF-normalized hashes match all four candidate files. Raw-byte equality holds for one file; the other three differ only by CRLF/LF representation. Details are in `reconstruction-verification.json`. The private `.maos` tree was not extracted.
- The original 28/2 failure output is copied byte-for-byte under `history/`; the original temporary evidence remains untouched. The later 29/1 output is retained under `validation/`.

## Gate status

- Correction source: pending focused independent review.
- Regression validation: green for the two requested suites.
- Corrected-package validation: not run; no package was rebuilt.
- Live Meta/Baseten inference: not run. Do not request live-pilot authorization again until the corrected candidate is independently reviewed, regression-green, and rebuilt.
