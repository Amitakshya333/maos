# MAOS Industrial Operator Guide

## Start the CLI

After building or installing the package, run `maos-industrial` with no arguments to enter the bounded local REPL. `maos-industrial repl` starts it explicitly. The regular `maos industrial` command also opens the same REPL.

The REPL accepts only these commands:

| Command | Purpose |
| --- | --- |
| `project [directory]` | Show or select a project directory. |
| `analyze <relative.csv> <request>` | Analyze one CSV selected inside the active project and prepare its persisted review run. Quote paths or requests containing spaces. |
| `status <run-id>` | Show persisted status and whether the deliverable is currently accepted. |
| `approve <run-id> <reviewer> [note]` | Record a reviewer decision and finalize the approved report. |
| `reject <run-id> <reviewer> [note]` | Record rejection; no report is finalized. |
| `report <run-id>` | Print the current accepted DOCX path and registered hash. |
| `verify <run-id>` | Verify the audit chain and current run acceptance. |
| `cancel` | Cancel an in-progress analysis. |
| `help`, `exit` | Show commands or leave the REPL. |

The REPL does not execute shell commands. It calls MAOS services in the local process. Its trust boundary is the current operating-system account and its access to the selected project directory; it does not use the Electron private-IPC session. The reviewer name is recorded as supplied by the local operator and is not independently authenticated by this CLI. The existing project/run/hash approval checks still apply.

## Prepare a local project

Initialize the project with `maos init`, choosing a local provider such as an already installed Ollama runtime. Add an `ANALYST_AGENT` entry to the project's existing `.maos/maos.config.json` `agents` array and point it at the local provider:

```json
{
  "id": "ANALYST_AGENT",
  "provider": "ollama",
  "model": "<the model actually installed in Ollama>",
  "timeoutMs": 60000
}
```

The corresponding `providers.ollama.baseURL` must be a credential-free loopback endpoint, for example `http://127.0.0.1:11434/v1`. Keep the actual configured model ID. For this local configuration, the Industrial analysis service accepts only that loopback endpoint and does not fall back to another provider. The exact Meta opt-in below is the only hosted exception. MAOS does not download or start a model runtime.

## Complete a review

Example session:

```text
project C:\projects\bearing-check
analyze data\bearing-ramp.csv "Count threshold findings and summarize measured peaks"
status judged-run-agent-<analysis-id>
approve judged-run-agent-<analysis-id> "Shift Engineer" "Reviewed the replay evidence"
verify judged-run-agent-<analysis-id>
report judged-run-agent-<analysis-id>
```

Analysis reports the configured provider/model, provider-reported model identity, selected source hash, replay-verified numeric findings, receipt, and model-generated explanation labelled **UNVERIFIED**. A CRITICAL/FAIL verdict is an engineering result and may still have a successfully completed run. Approval binds the persisted run and prepared output; rejection does not produce an accepted DOCX. `report` refuses runs whose deliverable is no longer currently accepted.

The CLI prints the registered DOCX path and SHA-256; use `maos-industrial open <path> --project-root <directory>` to open the accepted report. The report is not a certification, operating authorization, or independent verification of model prose.

## Runtime and inference status

The bounded analysis path allows at most four model-generation attempts in total (including retries and completion nudges), one telemetry-analysis tool execution, 256 output tokens per model response, zero automatic provider retries, and a 60-second overall deadline. Cancellation is propagated to the configured provider. A local mock transport is used in automated contract tests; those tests do not establish compatibility or quality for a live model. Hosted Meta inference remains disabled until endpoint/model terms, data handling, account billing behavior, and owner authorization are confirmed. When Meta is selected, the runtime also disables whole-task retries in the MAOS orchestrator; an operator may start a fresh task explicitly after reviewing the failure.

### Explicit Meta Model API opt-in

The shared OpenAI-compatible provider constructor enforces the only supported hosted configuration: `https://api.meta.ai/v1` with `muse-spark-1.3`. It stays disabled unless the selected provider entry sets `metaApiEnabled` to `true`; set `apiKeyEnv` to the name of an environment variable holding the key. The key is read only from that named variable, never from project config or the credential store. Muse temperature is omitted unless explicitly set to a number from 0 through 2; each response is capped at 256 output tokens, requests have a 60-second deadline, redirects are rejected, and SDK, Core request, and orchestrator whole-task automatic retries are disabled. Exact occurrences of the configured key are redacted from completion prose and provider identity. A completion tool argument containing the key is rejected before tool execution. This protects the configured key only; MAOS does not detect arbitrary secrets or transformed encodings. Do not enable this configuration or make hosted requests until the owner confirms the terms, data handling and no-overage account gate.

This uses Meta's documented Chat Completions tool-call shape. The API currently accepts `max_tokens` as a deprecated alias for `max_completion_tokens`; MAOS keeps `max_tokens` for the bounded request. See the [Chat Completions quickstart](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions), [tool/function calling guide](https://dev.meta.ai/docs/cookbook/tool-function-calling), and [Chat Completions protocol](https://dev.meta.ai/docs/protocols/chat-completions).

Merge this provider fragment into an existing config, then set `ANALYST_AGENT` to use provider `meta` and model `muse-spark-1.3`:

```json
{
  "meta": {
    "baseURL": "https://api.meta.ai/v1",
    "metaApiEnabled": true,
    "apiKeyEnv": "MODEL_API_KEY"
  }
}
```
