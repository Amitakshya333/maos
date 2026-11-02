# Baseten Muse Spark synthetic pilot — owner decision sheet

Status: NOT AUTHORIZED; this local correction is pending focused review, and no hosted request was made. Source baseline: f201cfe38bf3a741b5d8c6b37793cc3c112c43a9.

## Owner-supplied grant and model guidance

The owner reports that the partner supplied a $100 grant, an allowance of up to 2 million tokens per minute, and a key restricted to meta-models/muse-spark-open-1026 at https://inference.baseten.co/v1. The token-per-minute allowance is a rate limit, not a spending cap. Model API credit applicability and expiry have not been independently verified.

The owner also reports a pinned partner note saying the key cannot be charged beyond the $100 grant. That note and its account applicability were not independently verified here; exhaustion behavior is untested. Local token limits do not establish a dollar cap or provider-side no-overage enforcement.

## Proposed exact configuration

Enable only the existing opt-in provider entry for the exact endpoint and model:

- Provider: baseten
- Endpoint: https://inference.baseten.co/v1
- Model: meta-models/muse-spark-open-1026
- Explicit project opt-in: basetenApiEnabled=true
- Credential name: BASETEN_API_KEY, read from the operator's environment

The provider rejects other hosted endpoints and models, does not follow redirects, and makes no SDK or application retries. No fallback provider is selected.

## Limits for one proposed pilot

- At most four model-generation attempts total; no objective-coordinator replanning.
- Each generation requests reasoning_effort=low and max_tokens=1500. The owner reports that reasoning tokens count toward max_tokens and that short tool calls may need this budget.
- The four-call ceiling therefore permits at most 6,000 output tokens across generations if all four are used. Reasoning is included in that amount; input tokens are additional. This is a token ceiling, not a dollar spending cap.
- One analyze_telemetry_csv tool execution.
- One 60-second overall deadline with cancellation propagation.
- Zero SDK, Core/application, or task retries.
- No automatic restart or limit increase after an empty or truncated response.
- Empty/no-tool responses and finish_reason=length fail without an accepted report. Reasoning metadata is not persisted; any final prose remains unverified.
- Operational bound: one operator-run process and one request in flight. The launcher mutex only gates participating launches in one Windows session; it is not a cross-session or account-wide concurrency limit.

## Data boundary

The proposed run is synthetic-only. The raw CSV bytes are read locally and are not attached to the provider request. Baseten receives the operator request, Industrial instructions, selected relative CSV path, and telemetry tool schema. After local deterministic analysis, the model also receives the tool result, including analysis and receipt identifiers/hashes, source/ruleset hashes, computed metrics, and findings such as timestamps, measured values, thresholds, and severity. These derived values can still be sensitive; do not use operational or personal data.

The API credential is supplied through BASETEN_API_KEY for request authentication; it is not a URL parameter or project-config value. The application does not persist provider reasoning fields. The generated explanation, if a complete run succeeds, is stored as unverified model prose.

## Owner decisions still open

1. Confirm whether this exact key is covered by the Model API grant, the grant's expiry, and whether the reported grant ceiling is enforced at exhaustion. No hard spending stop has been established by this code or test evidence.
2. Resolve applicable model-use terms for this synthetic maintenance/safety demonstration. This is not legal clearance.
3. Confirm event eligibility separately with the organizers; this is independent of an engineering mock test.

Only after those decisions, the owner may explicitly authorize one synthetic CSV request within the limits above. No live call or terms acceptance is authorized by this sheet.
