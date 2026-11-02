import OpenAI from 'openai';
import { IProvider, ChatMessage, ToolDef, ToolCall, ProviderRequestOptions, ProviderResponse, ProviderStreamOptions } from './provider';
import { assertCredentialUsePolicy, resolveHostedApiPolicy } from './meta-api-policy';

/**
 * OpenAI-Compatible Provider Adapter
 *
 * This single adapter covers 10+ providers because they all use
 * the OpenAI chat completions API format:
 *
 *  - OpenAI (api.openai.com)
 *  - Freemodel (api.freemodel.dev)
 *  - DeepSeek (api.deepseek.com)
 *  - Qwen / DashScope (compatible mode)
 *  - Together.ai
 *  - Groq
 *  - Fireworks AI
 *  - Ollama (localhost)
 *  - LM Studio (localhost)
 *  - Any OpenAI-compatible endpoint
 *
 * Just set a different baseURL and apiKey. That's it.
 */
export class OpenAIProvider implements IProvider {
  readonly name: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly isMetaApi: boolean;
  readonly isBasetenApi: boolean;
  readonly maxApplicationRetries?: number;

  private client: OpenAI;
  private readonly apiKey: string;
  private readonly credentialForRedaction: string;
  private readonly temperature: number | null;
  private readonly maxOutputTokens?: number;

  constructor(opts: {
    name: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    timeout?: number;
    maxRetries?: number;
    temperature?: number | null;
    maxOutputTokens?: number;
    fetch?: typeof globalThis.fetch;
    metaApiEnabled?: boolean;
    basetenApiEnabled?: boolean;
    apiKeyEnv?: string;
    reservedMetaApiKeyEnvVars?: readonly string[];
  }) {
    const baseURL = opts.baseURL || process.env.OPENAI_BASE_URL;
    assertCredentialUsePolicy({
      providerName: opts.name,
      baseURL: opts.baseURL,
      effectiveBaseURL: baseURL,
      model: opts.model,
      metaApiEnabled: opts.metaApiEnabled,
      basetenApiEnabled: opts.basetenApiEnabled,
      apiKeyEnv: opts.apiKeyEnv,
      apiKey: opts.apiKey,
    }, opts.reservedMetaApiKeyEnvVars);
    const hostedPolicy = resolveHostedApiPolicy({
      providerName: opts.name,
      baseURL: opts.baseURL,
      effectiveBaseURL: baseURL,
      model: opts.model,
      metaApiEnabled: opts.metaApiEnabled,
      basetenApiEnabled: opts.basetenApiEnabled,
      apiKeyEnv: opts.apiKeyEnv,
      temperature: opts.temperature,
    });
    this.name = opts.name;
    this.model = opts.model;
    this.baseURL = baseURL;
    this.isMetaApi = hostedPolicy?.provider === 'meta';
    this.isBasetenApi = hostedPolicy?.provider === 'baseten';
    this.maxApplicationRetries = hostedPolicy ? 0 : undefined;
    this.apiKey = hostedPolicy?.apiKey ?? opts.apiKey;
    this.credentialForRedaction = ['local', 'local-only', 'not-needed'].includes(this.apiKey) ? '' : this.apiKey;
    if (this.credentialForRedaction && this.model.includes(this.credentialForRedaction)) {
      throw new Error('The configured model identifier must not contain the API credential.');
    }
    this.temperature = hostedPolicy?.provider === 'meta'
      ? hostedPolicy.temperature
      : Object.prototype.hasOwnProperty.call(opts, 'temperature') ? opts.temperature ?? null : 0.2;
    this.maxOutputTokens = hostedPolicy?.provider === 'baseten' ? 1500 : hostedPolicy?.provider === 'meta' ? 256 : opts.maxOutputTokens;

    const fetchImpl = opts.fetch ?? globalThis.fetch;

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL,
      timeout: hostedPolicy?.provider === 'meta' ? 60_000 : opts.timeout || 180_000, // Meta's policy owns its fixed deadline.
      maxRetries: hostedPolicy ? 0 : opts.maxRetries ?? 2,
      // SDK debug parsing can observe raw provider bodies before this adapter sanitizes them.
      logLevel: 'off',
      fetch: hostedPolicy
        ? (input, init) => fetchImpl(input, { ...init, redirect: 'error' })
        : opts.fetch,
    });
  }

  /**
   * TASK RING-DEV-A-DAY2: shared request builder. `generate()` and
   * `generateStream()` build IDENTICAL request bodies (same model,
   * reasoning_effort, temperature, max_tokens, tools) apart from the
   * `stream` flag, so streaming never changes what the model is asked.
   */
  private buildRequestBody(messages: ChatMessage[], tools: ToolDef[] | undefined, options: ProviderRequestOptions | ProviderStreamOptions | undefined): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { reasoning_effort?: 'low' } {
    // Build the request — only include tools if we have them
    const requestBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { reasoning_effort?: 'low' } = {
      model: this.model,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
    };
    if (this.isBasetenApi) requestBody.reasoning_effort = 'low';
    if (this.temperature !== null) requestBody.temperature = this.temperature;
    const requestedMaxTokens = options?.maxTokens;
    const maxTokens = this.isBasetenApi
      ? this.maxOutputTokens
      : this.maxOutputTokens === undefined
        ? requestedMaxTokens
        : Math.min(requestedMaxTokens ?? this.maxOutputTokens, this.maxOutputTokens);
    if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0) {
      requestBody.max_tokens = maxTokens;
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools.map((t) => ({
        type: t.type as 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as OpenAI.FunctionParameters,
        },
      }));
    }
    return requestBody;
  }

  /**
   * TASK RING-DEV-A-DAY2: shared completion parser. Whole responses AND
   * stream-assembled messages funnel through this one path, so the
   * redaction, credential-contamination, and Baseten empty/length guards
   * apply identically on both paths.
   */
  private parseCompletion(rawResponse: unknown, latencyMs: number): ProviderResponse {

    // CRITICAL: Freemodel (and some other OpenAI-compatible providers) return
    // raw JSON strings instead of parsed objects when using OpenAI SDK v5+.
    // Detect and parse accordingly.
    let response: any = rawResponse;
    if (typeof response === 'string') {
      try {
        response = JSON.parse(response);
      } catch (parseErr) {
        throw new Error(
          `Failed to parse response from ${this.name}/${this.model}: ` + `${(response as string).substring(0, 200)}`,
        );
      }
    }

    // Try to get choices — handle both parsed SDK objects and raw JSON
    let choices = response?.choices;
    if (!choices && response?.data?.choices) {
      choices = response.data.choices; // Some SDKs nest under .data
    }

    if (!choices || !Array.isArray(choices) || choices.length === 0) {
      // Last resort: try parsing if response is somehow a string
      throw new Error(
        `Empty response from ${this.name}/${this.model} (no choices array). ` +
          `Keys: [${Object.keys(response || {}).join(', ')}]`,
      );
    }

    const choice = choices[0];
    const message = choice?.message;

    if (!message) {
      throw new Error(
        `No message in response from ${this.name}/${this.model}. ` +
          `Choice keys: [${Object.keys(choice || {}).join(', ')}]`,
      );
    }

    // Extract tool calls (cast needed: SDK union type includes custom tool calls)
    const rawToolCalls: any[] = message.tool_calls || [];
    const toolCalls: ToolCall[] = rawToolCalls
      .filter((tc) => tc && tc.type === 'function' && tc.function)
      .map((tc) => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        },
      }));

    // Map finish reason
    let finishReason: ProviderResponse['finishReason'] = 'unknown';
    const rawFinish = choice.finish_reason;
    if (rawFinish === 'stop') finishReason = 'stop';
    else if (rawFinish === 'tool_calls') finishReason = 'tool_calls';
    else if (rawFinish === 'length') finishReason = 'length';

    const content = this.redactOutput(message.content) as ProviderResponse['content'];
    const providerModel = typeof response.model === 'string' && response.model.trim() ? response.model : undefined;
    const safeReportedModel = providerModel && !this.containsCredential(providerModel) ? providerModel : undefined;
    if (this.containsCredential(JSON.stringify(rawToolCalls)) || rawToolCalls.some((tc) => {
      if (typeof tc?.function?.arguments !== 'string') return false;
      try {
        return this.containsCredential(JSON.stringify(JSON.parse(tc.function.arguments)));
      } catch {
        return false;
      }
    })) {
      throw new Error('PROVIDER_CREDENTIAL_CONTAMINATION: configured credential found in provider tool-call metadata; execution was blocked.');
    }
    if (this.isBasetenApi && finishReason === 'length') {
      throw new Error('BASETEN_INCOMPLETE_GENERATION: response ended at the configured output-token limit; partial output was discarded and no report was accepted.');
    }
    if (this.isBasetenApi && toolCalls.length === 0 && (typeof content !== 'string' || content.trim().length === 0)) {
      throw new Error('BASETEN_EMPTY_GENERATION: response contained no usable content or tool call; reasoning metadata was discarded and no report was accepted.');
    }

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      model: safeReportedModel || this.model,
      reportedModel: safeReportedModel,
      latencyMs,
      finishReason,
    };

  }

  async generate(messages: ChatMessage[], tools?: ToolDef[], options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const startMs = Date.now();

    try {
      const requestBody = this.buildRequestBody(messages, tools, options);

      const rawResponse = await this.client.chat.completions.create(
        requestBody,
        options?.signal ? { signal: options.signal } : undefined,
      );

      const latencyMs = Date.now() - startMs;
      return this.parseCompletion(rawResponse, latencyMs);
    } catch (err: any) {
      throw this.mapProviderError(err, Date.now() - startMs);
    }
  }

  /**
   * TASK RING-DEV-A-DAY2: shared transport-error mapping. `generate()` and
   * the `generateStream()` path map HTTP/auth/connection failures to
   * IDENTICAL messages, so the streaming loop surfaces the same errors
   * the whole path always has.
   */
  private mapProviderError(err: any, latencyMs: number): Error {

    // Provide helpful error messages for common failures
    if (err.status === 401 || err.status === 403) {
      const rawBody = err.error ? this.redact(JSON.stringify(err.error).substring(0, 200)) : '';
      return new Error(
        `Authentication failed for ${this.name}. Check your API key.\n` +
          `Provider: ${this.name} | Model: ${this.model}` +
          (rawBody ? `\nAPI response: ${rawBody}` : ''),
      );
    }
    if (err.status === 429) {
      return new Error(this.redact(
        `Rate limit hit on ${this.name}. Wait and retry.\n` +
          `Provider: ${this.name} | Model: ${this.model} | Latency: ${latencyMs}ms`,
      ));
    }
    if (err.status === 503 || err.status === 502 || err.status === 504) {
      return new Error(this.redact(
        `${this.name} is temporarily unavailable (HTTP ${err.status}).\n` +
          `Provider: ${this.name} | Model: ${this.model} | This is a provider outage, not an auth issue.`,
      ));
    }
    if (err.status === 404) {
      return new Error(this.redact(
        `Model "${this.model}" not found on ${this.name}.\n` + `Check available models at your provider's dashboard.`,
      ));
    }
    if (err.code === 'ECONNREFUSED') {
      return new Error(this.redact(
        `Cannot connect to ${this.name} at ${this.client.baseURL}.\n` +
          `Is the server running? (Check Ollama/LM Studio if local)`,
      ));
    }

    // Re-throw with context
    const newErr = new Error(this.redact(
      `Provider error [${this.name}/${this.model}]: ${err.message}\n` + `Latency: ${latencyMs}ms`,
    ));
    newErr.stack = this.redact(err.stack || newErr.stack || '');
    return newErr;
  }


  /**
   * TASK RING-DEV-A-DAY2: incremental streaming. Sends the SAME request body
   * as `generate()` plus `stream: true`, then reassembles the SSE chunks
   * into a whole completion that funnels through `parseCompletion` — so
   * every guard on the whole path (redaction, credential-contamination,
   * BASETEN_EMPTY/INCOMPLETE_GENERATION) applies unchanged.
   *
   * Fragmented `tool_calls[].function.arguments` arrive in pieces; they are
   * concatenated per-index and JOINED before any JSON.parse. No partial
   * JSON is ever parsed or executed. `onDelta` observes each non-empty
   * content fragment live; a throwing observer never breaks the stream.
   * Reasoning/metadata-only chunks and empty heartbeats emit no delta.
   * When the transport yields zero chunks (a non-SSE endpoint answering
   * `stream: true` with plain JSON), the result carries `streamEmpty: true`
   * and the caller falls back to `generate()` once.
   */
  async generateStream(messages: ChatMessage[], tools?: ToolDef[], options?: ProviderStreamOptions): Promise<ProviderResponse> {
    const startMs = Date.now();

    try {
      const requestBody = this.buildRequestBody(messages, tools, options);
      const stream = await this.client.chat.completions.create(
        { ...requestBody, stream: true },
        options?.signal ? { signal: options.signal } : undefined,
      );
      const latencyMs = Date.now() - startMs;
      const onDelta = options?.onDelta;
      let content = '';
      const slots = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null | undefined;
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let model: string | undefined;
      let sawChunk = false;
      const emit = (delta: string): void => {
        if (!delta) return;
        try { onDelta?.(delta); } catch { /* observer must not break the stream */ }
      };
      try {
        for await (const chunk of stream as unknown as AsyncIterable<{
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              role?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        }>) {
          sawChunk = true;
          if (typeof chunk?.model === 'string' && chunk.model.trim() && !this.containsCredential(chunk.model)) model = chunk.model;
          if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
          const choice = chunk?.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta || typeof delta !== 'object') continue;
          const text = typeof delta.content === 'string' ? delta.content : '';
          if (text) { content += text; emit(this.redact(text)); }
          const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const tc of calls) {
            if (!tc || typeof tc !== 'object') continue;
            const slot = slots.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
            if (typeof tc.id === 'string' && tc.id && !slot.id) slot.id = tc.id;
            const fname = tc.function?.name;
            if (typeof fname === 'string' && fname) slot.name = slot.name && slot.name !== fname ? slot.name + fname : (slot.name || fname);
            const frag = tc.function?.arguments;
            if (typeof frag === 'string' && frag) slot.args += frag;
            slots.set(tc.index ?? 0, slot);
          }
        }
      } catch (streamErr) {
        if ((streamErr as { name?: string }).name === 'AbortError' || options?.signal?.aborted) throw streamErr;
        throw this.wrapStreamError(streamErr);
      }
      if (!sawChunk) {
        return {
          content: null,
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: this.model,
          reportedModel: undefined,
          latencyMs,
          finishReason: 'unknown',
          streamEmpty: true,
        };
      }
      const toolCalls: ToolCall[] = [...slots.values()]
        .filter((slot) => slot.id || slot.name || slot.args)
        .map((slot) => ({
          id: slot.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          type: 'function' as const,
          function: { name: slot.name, arguments: slot.args || '{}' },
        }));
      if (toolCalls.some((tc) => !tc.function.name)) {
        throw new Error('STREAM_TOOL_CALL_INVALID: a streamed tool call arrived without a function name; partial tool calls are never executed.');
      }
      const assembled = {
        model,
        usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : undefined,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls.length ? toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })) : undefined,
          },
          finish_reason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        }],
      };
      return this.parseCompletion(assembled, latencyMs);
    } catch (err: any) {
      if (err instanceof Error && (
        err.message.startsWith('BASETEN_') ||
        err.message.startsWith('STREAM_TOOL_CALL_INVALID') ||
        err.message.startsWith('PROVIDER_CREDENTIAL_CONTAMINATION'))) throw err;
      if ((err as { name?: string }).name === 'AbortError' || options?.signal?.aborted) throw err;
      // SDK transport failures (HTTP status / connection code) surface with
      // the IDENTICAL friendly mapping as the whole path.
      if (err instanceof Error && typeof (err as { status?: unknown }).status === 'number') {
        throw this.mapProviderError(err, Date.now() - startMs);
      }
      if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
        throw this.mapProviderError(err, Date.now() - startMs);
      }
      throw this.wrapStreamError(err);
    }
  }

  /** Wrap a transport/stream failure with provider context (redacted). */
  private wrapStreamError(err: unknown): Error {
    const message = this.redact(err instanceof Error ? err.message : String(err));
    const wrapped = new Error(this.redact(`Provider error [${this.name}/${this.model}]: streamed response failed: ${message}`));
    if (err instanceof Error && err.stack) wrapped.stack = this.redact(err.stack);
    return wrapped;
  }

  private redact(value: string): string {
    return this.credentialForRedaction ? value.split(this.credentialForRedaction).join('[REDACTED]') : value;
  }

  private containsCredential(value: string): boolean {
    return Boolean(this.credentialForRedaction && value.includes(this.credentialForRedaction));
  }

  private redactOutput(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactOutput(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redactOutput(item)]));
    }
    return value;
  }

  /**
   * Convert our ChatMessage format to OpenAI's expected format.
   */
  private toOpenAIMessage(msg: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: msg.content ?? '',
        tool_call_id: msg.tool_call_id || '',
      };
    }

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
    }

    if (msg.role === 'system') {
      return {
        role: 'system',
        content: msg.content ?? '',
      };
    }

    // Default: user
    return {
      role: 'user',
      content: msg.content ?? '',
    };
  }
}
