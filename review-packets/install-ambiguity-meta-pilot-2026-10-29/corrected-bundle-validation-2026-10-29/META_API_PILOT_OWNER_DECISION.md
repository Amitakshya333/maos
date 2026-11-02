# Meta Muse Spark synthetic pilot — owner decision sheet

**Status: NOT AUTHORIZED; no live request was made.** Tested source commit: `d526bfe95d334ad8a0c73a25db7611c1d0fc7417`.

## Exact endpoint, model, and configuration

- Endpoint: `https://api.meta.ai/v1`
- Model ID: `muse-spark-1.3` (Standard mode; do not use the `-contributor` variant). [Meta model availability](https://dev.meta.ai/docs/models)
- Credential environment-variable name: `MODEL_API_KEY`. The value must stay out of chat, project config, URLs and logs.

Merge these fields into the existing project config, preserving other required fields:

```json
{
  "providers": {
    "meta": {
      "baseURL": "https://api.meta.ai/v1",
      "metaApiEnabled": true,
      "apiKeyEnv": "MODEL_API_KEY"
    }
  },
  "agents": [
    {
      "id": "ANALYST_AGENT",
      "provider": "meta",
      "model": "muse-spark-1.3"
    }
  ]
}
```

Leave optional `temperature` unset. Endpoint, model and explicit opt-in are exact-match guarded.

## Pilot limits already enforced

- 60-second overall analysis deadline, provider timeout and abort propagation.
- Four maximum model-generation attempts, zero application/SDK provider retries, redirects rejected. At the code ceilings this is up to 1,024 output tokens per run (4 x 256), plus variable input tokens; this is not a financial cap.
- 256-token maximum output per response; at most one `analyze_telemetry_csv` execution.
- The Industrial path uses the bounded runner directly; it does not invoke the objective coordinator.
- This REPL refuses a project switch during its active request. One analysis in flight across separate app processes is an operational rule, not a global service lock.
- Client timeout/cancel does not prove Meta stopped processing or billing.

Source references: `src/backends/meta-api-policy.ts`, `src/backends/openai-provider.ts`, `src/industrial/analysis-agent-service.ts`.

## Data sent to Meta

The API receives the operator request, bounded Industrial instructions, selected relative CSV path, and tool schema. The deterministic telemetry tool reads the CSV locally; raw CSV bytes are not attached/uploaded directly. The model then receives the tool result: analysis/receipt IDs and hashes, source/ruleset hashes, computed metrics, and up to 30 findings (timestamps, values, thresholds and severity, including CRITICAL). The model response returns to the local app and is stored/labeled as unverified prose. The API credential is request authentication, not a URL parameter. Meta documents Standard mode as not using submitted content to train its models; that does not mean the content is never processed or retained. [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions) [Pricing/modes](https://dev.meta.ai/docs/pricing-rate-limits)

## Owner decisions still open

1. **Billing/no-overage:** Meta documents token charges, charges at a payment threshold, and automatic monthly billing of remaining balance. The reviewed docs do not prove credits exhaustion or a missing payment method will hard-reject calls before charges. Confirm an enforceable account-side hard spend stop/no-overage control, or written Meta confirmation. [Billing](https://dev.meta.ai/help/billing/api-bill)
2. **AUP and event permission:** Meta's AUP covers activities presenting risks of death/serious bodily harm or serious harm to property/environment and calls out use related to operation of critical infrastructure, transportation technologies or heavy machinery. It also requires human oversight and qualified review for safety-affecting outputs. The proposed demo is synthetic and advisory with no physical control, while the intended product is industrial maintenance/safety; synthetic inputs alone do not settle applicability. Obtain Meta licensing/support clarification for the exact use, and separately confirm event eligibility with organizers. This is a technical summary, not legal clearance. [Meta Model API AUP](https://dev.meta.ai/legal/acceptable-use-policy)
3. **Pilot authorization:** only after those two gates, authorize one synthetic CSV analysis, one operator-run process, one analysis in flight, at most four generations, one telemetry tool execution, 256 output tokens per response, 60 seconds, zero retries, no objective replanning, sanitized evidence, and no real operational data.

## Is a code change needed?

No change is needed for this exact opt-in pilot in one operator-run process. Billing/AUP/event decisions are external blockers. If single-flight must be guaranteed across multiple processes, that would require a separate code change.

The Rust engine used in the REPL rehearsal remains **unapproved**. Its recorded hash/protocol health does not establish source/build provenance or publisher trust. No engine work or redistribution was done here.
