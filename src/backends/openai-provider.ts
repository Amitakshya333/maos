import OpenAI from 'openai';
import { IProvider, ChatMessage, ToolDef, ToolCall, ProviderRequestOptions, ProviderResponse } from './provider';
import { resolveMetaApiPolicy } from './meta-api-policy';

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
    apiKeyEnv?: string;
  }) {
    const baseURL = opts.baseURL || process.env.OPENAI_BASE_URL;
    const metaPolicy = resolveMetaApiPolicy({
      providerName: opts.name,
      baseURL: opts.baseURL,
      effectiveBaseURL: baseURL,
      model: opts.model,
      metaApiEnabled: opts.metaApiEnabled,
      apiKeyEnv: opts.apiKeyEnv,
      temperature: opts.temperature,
    });
    this.name = opts.name;
    this.model = opts.model;
    this.baseURL = baseURL;
    this.isMetaApi = Boolean(metaPolicy);
    this.maxApplicationRetries = metaPolicy ? 0 : undefined;
    this.apiKey = metaPolicy?.apiKey ?? opts.apiKey;
    this.credentialForRedaction = ['local', 'local-only', 'not-needed'].includes(this.apiKey) ? '' : this.apiKey;
    if (this.credentialForRedaction && this.model.includes(this.credentialForRedaction)) {
      throw new Error('The configured model identifier must not contain the API credential.');
    }
    this.temperature = metaPolicy
      ? metaPolicy.temperature
      : Object.prototype.hasOwnProperty.call(opts, 'temperature') ? opts.temperature ?? null : 0.2;
    this.maxOutputTokens = metaPolicy ? 256 : opts.maxOutputTokens;

    const fetchImpl = opts.fetch ?? globalThis.fetch;

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL,
      timeout: metaPolicy ? 60_000 : opts.timeout || 180_000, // Meta's policy owns its fixed deadline.
      maxRetries: metaPolicy ? 0 : opts.maxRetries ?? 2,
      // SDK debug parsing can observe raw provider bodies before this adapter sanitizes them.
      logLevel: 'off',
      fetch: metaPolicy
        ? (input, init) => fetchImpl(input, { ...init, redirect: 'error' })
        : opts.fetch,
    });
  }

  async generate(messages: ChatMessage[], tools?: ToolDef[], options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const startMs = Date.now();

    try {
      // Build the request — only include tools if we have them
      const requestBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: messages.map((m) => this.toOpenAIMessage(m)),
      };
      if (this.temperature !== null) requestBody.temperature = this.temperature;
      const requestedMaxTokens = options?.maxTokens;
      const maxTokens = this.maxOutputTokens === undefined
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

      const rawResponse = await this.client.chat.completions.create(
        requestBody,
        options?.signal ? { signal: options.signal } : undefined,
      );
      const latencyMs = Date.now() - startMs;

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
    } catch (err: any) {
      const latencyMs = Date.now() - startMs;

      // Provide helpful error messages for common failures
      if (err.status === 401 || err.status === 403) {
        const rawBody = err.error ? this.redact(JSON.stringify(err.error).substring(0, 200)) : '';
        throw new Error(
          `Authentication failed for ${this.name}. Check your API key.\n` +
            `Provider: ${this.name} | Model: ${this.model}` +
            (rawBody ? `\nAPI response: ${rawBody}` : ''),
        );
      }
      if (err.status === 429) {
        throw new Error(this.redact(
          `Rate limit hit on ${this.name}. Wait and retry.\n` +
            `Provider: ${this.name} | Model: ${this.model} | Latency: ${latencyMs}ms`,
        ));
      }
      if (err.status === 503 || err.status === 502 || err.status === 504) {
        throw new Error(this.redact(
          `${this.name} is temporarily unavailable (HTTP ${err.status}).\n` +
            `Provider: ${this.name} | Model: ${this.model} | This is a provider outage, not an auth issue.`,
        ));
      }
      if (err.status === 404) {
        throw new Error(this.redact(
          `Model "${this.model}" not found on ${this.name}.\n` + `Check available models at your provider's dashboard.`,
        ));
      }
      if (err.code === 'ECONNREFUSED') {
        throw new Error(this.redact(
          `Cannot connect to ${this.name} at ${this.client.baseURL}.\n` +
            `Is the server running? (Check Ollama/LM Studio if local)`,
        ));
      }

      // Re-throw with context
      const newErr = new Error(this.redact(
        `Provider error [${this.name}/${this.model}]: ${err.message}\n` + `Latency: ${latencyMs}ms`,
      ));
      newErr.stack = this.redact(err.stack || newErr.stack || '');
      throw newErr;
    }
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
