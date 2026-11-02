# Installation ambiguity and Meta pilot handoff

## Baseline and scope

- Repository baseline: `main` at `27dd1711f47e6278a1b84a6089e900dbe79f1459`.
- No source was staged or committed. The only tracked edits are `scripts/Install-MaosIndustrial.ps1` and `tests/industrial/package-runtime-assets.test.ts`.
- The frozen/current bootstrap ZIP remains `maos-industrial-bootstrap-windows-x64-commit-27dd1711-2026-10-29.zip`, SHA-256 `1f333348e92ea988e8fa9ef3be37dd362e69e6d1ab380d3e653f731240b8b61b`. Its npm tarball SHA-256 remains `b4fb03a58b6f13fdbac1f97fa7c48bdb94cb9ee37709fef6cede40bec5f9a778`.

## Installation ambiguity

The first failure was in the shipped `Install-MaosIndustrial.ps1`, not just in the validation wrapper. Under PowerShell 7.6.9, the shipped script's `$ErrorActionPreference = 'Stop'` caused `npm.cmd ci` stderr (`npm notice`) to surface as a terminating `NativeCommandError` at the first npm install, before the script reached its `$LASTEXITCODE` check. The retained stdout shows npm had already installed 77 packages; the installer itself returned exit 1. The original attempt's npm exit code was not captured, so it must not be inferred from the installer failure.

The successful retry used the same ZIP, npm package, expanded installer, Node 24.11.0 and npm 11.6.1. The expanded installer's hash was `b2dc2175b64609b8966cab4571848959f302441e481e0aa578ce086f1bcd51f5` in both attempts. The wrapper used a different isolated install/cache/user-data directory and added `NPM_CONFIG_UPDATE_NOTIFIER=false`; npm then emitted no notice and the install returned exit 0. That environment change masked the shipped stderr handling defect; it did not fix the installer.

The uncommitted correction routes both `npm ci` calls through one helper. The helper uses `Continue` only while invoking npm, forwards stderr, captures `$LASTEXITCODE` immediately, restores the prior preference, and throws on any nonzero npm exit. A focused regression extracts the production helper and tests a fake `npm.cmd` that emits synthetic stderr and exits 0, then emits stderr and exits 23. The first succeeds; the second fails with the npm exit code. Command `npm.cmd test -- tests/industrial/package-runtime-assets.test.ts` passed 1 file / 9 tests, exit 0. Raw output is in `installer-regression.stdout.log` and `installer-regression.stderr.log`.

The correction has not been rebuilt into the existing ZIP. That exact bundle still contains the old installer hash and remains affected if npm writes to stderr under a `Stop` preference. A corrected bundle requires a later reviewed build; no package was rebuilt here.

## Exact-bundle checks

- The long-path preflight used the existing ZIP and extracted bundle. For an install-root string 190 characters long, the installer calculated a maximum projected file path of 283 characters and refused with its documented message before creating the target. The target remained absent. See `exact-bundle-max-path-result.json` and `exact-bundle-max-path.log`.
- The existing successful test install is at `C:\Users\AMITAKSHYA SUTAR\AppData\Local\Temp\M27-7d2e\installed app retry with spaces`. No product uninstaller was found in the installation guide or installer. A scoped attempt to remove only this known temporary install was rejected by the command execution policy before execution (`blocked by policy`); the directory remains, and no data was changed. The known test root had zero other matching processes at the final process check. See `removal-status.json`.
- The isolated synthetic project and user-data sentinels were not created because the removal operation was blocked. No real project or user-data path was inspected or changed. Private `.maos` contents were not read.

## Meta pilot facts

The current application code already supports the opt-in provider path; no source change is required for it. Its accepted endpoint/model are exactly `https://api.meta.ai/v1` and `muse-spark-1.3`. The Industrial analysis service sets a 60-second end-to-end deadline, a 256-token output cap, four model-generation attempts, zero provider retries, and one `analyze_telemetry_csv` execution. It calls `runAgent` directly and does not invoke the general objective coordinator. Normal MAOS orchestration still has objective replanning; do not describe it as globally disabled. The app does not enforce one global in-flight request across all independent clients, so the one-request pilot boundary must be followed operationally.

The installed project's existing config must be explicitly changed to enable `providers.meta.metaApiEnabled`, set the exact endpoint and model, set `apiKeyEnv` to `MODEL_API_KEY`, and route `ANALYST_AGENT` to provider `meta` and model `muse-spark-1.3`. The credential value must be supplied only through that process environment variable; it was not read here. The installed profile defaults to local Ollama, so hosted use is not enabled by default.

On Meta Model API pay-as-you-go, the model ID selects Standard versus Contributor: `muse-spark-1.3` is Standard and `muse-spark-1.3-contributor` is Contributor. No separate `service_tier` field is configured by this app. Meta's docs say Standard content is not used to train its models, but a real request still sends the prompt, selected relative source path, and deterministic telemetry result/receipt metadata (including measurements/findings) to Meta; the CSV is read locally and its bytes are not directly included by the telemetry tool implementation. Only synthetic data is proposed. This does not establish no retention or legal/AUP clearance.

The account's current active credit balance and any provider-enforced hard stop against paid overage remain unconfirmed. Meta documents token-based charges, threshold billing, and monthly billing, but I found no documented guarantee that requests are rejected at credit exhaustion without a charge. This is a documentation gap, not proof that no account control exists. An active-credit display or absent payment method alone is not a verified no-overage control. No request was sent, no term accepted, and no billing state was changed.

Official references checked 2026-10-29: [Models and mode selection](https://dev.meta.ai/docs/models), [API overview and auth](https://dev.meta.ai/docs/overview), [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits), [billing behavior](https://dev.meta.ai/help/billing/api-bill), and [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions). AUP applicability remains unresolved; no clearance is claimed.

## External engine identity

The engine used by the latest installed GUI rehearsal is the external local candidate with SHA-256 `3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77`, size 472,064 bytes, version 0.1.0, protocol 1.0. Its manifest records source commit `189e786ff0431b02b95ca618bb4791a5ad7b0215`, `cargo build --release --locked --offline --manifest-path rust/Cargo.toml`, Cargo 1.95.0, Rust 1.95.0, and Windows x64 MSVC target.

Earlier retained independent builds have hashes `fb874225cae45d9cc4629f3cf0b038bf2680d9f36d56b6cf968b41775dfb255b` and `011dd53795d025f11c605ee62bc25b1e85fcf7d5ae69503bbcef2fb3a40129de`. The available manifests/logs also identify source commit `189e786ff0431b02b95ca618bb4791a5ad7b0215` and the same offline locked release build; the later two record the same Cargo/Rust versions and target. The Rust source diff between `189e786` and `27dd171` is empty. The recorded size for the latter two is also 472,064 bytes. The differing hashes therefore reflect distinct local build outputs, not a recorded Rust-source change, but the evidence does not establish the exact byte-level cause or bit-reproducibility. The Rust toolchain is not pinned. These hashes are captured identities only: the engine is external, unsigned, not compared with an approved artifact manifest, and not trusted or approved by its health response.

## Focused correction packet

- `installer-correction.patch` is based on the exact current HEAD and contains only the two files listed in `source-correction-manifest.json`.
- `source-correction-manifest.json` records full working-tree SHA-256 values and the patch SHA-256.
- No live inference, model download, terms acceptance, package rebuild, stage, commit or push occurred.
