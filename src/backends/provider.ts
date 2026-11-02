/**
 * MAOS Universal Provider Interface
 * 
 * Every AI provider adapter must implement IProvider.
 * This is the ONLY abstraction between MAOS core and the model world.
 * 
 * One interface → any model → any provider.
 */

// ─── Message Types ────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ─── Tool Types ───────────────────────────────────────────────

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Response Types ───────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResponse {
  /** Text content of the response (null if only tool calls) */
  content: string | null;

  /** Tool calls requested by the model */
  toolCalls: ToolCall[];

  /** Token usage for cost tracking */
  usage: TokenUsage;

  /** Configured model identifier used for the request. */
  model: string;

  /** Model identifier explicitly reported by the provider, if present. */
  reportedModel?: string;

  /** Round-trip latency in milliseconds */
  latencyMs: number;

  /** Whether the model wants to stop or continue with tools */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';

  /**
   * TASK RING-DEV-A-DAY2: true only when a `generateStream()` call saw a
   * live transport that yielded ZERO chunks (e.g. a non-SSE endpoint
   * answering `stream: true` with plain JSON). The caller must fall back
   * to `generate()` once; the empty stream carries no model signal.
   */
  streamEmpty?: boolean;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * TASK RING-DEV-A-DAY2: incremental token-streaming options (additive).
 * `onDelta` observes transport only; it is never sent to the model and
 * never changes the assembled result. Throwing inside the callback must
 * never break the stream (providers swallow it).
 */
export interface ProviderStreamOptions extends ProviderRequestOptions {
  /** Called once per non-empty content fragment, in arrival order. */
  onDelta?: (delta: string) => void;
}

// ─── Provider Interface ───────────────────────────────────────

export interface IProvider {
  /** Display name of this provider instance (e.g., "freemodel", "deepseek") */
  readonly name: string;

  /** Model identifier (e.g., "gpt-5.4", "deepseek-coder-v3") */
  readonly model: string;

  /** Provider-owned ceiling for Core's transient request retries. */
  readonly maxApplicationRetries?: number;

  /**
   * Send a chat completion request with optional tool definitions.
   * Returns the model's response including any tool calls.
   */
  generate(
    messages: ChatMessage[],
    tools?: ToolDef[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse>;

  /**
   * TASK RING-DEV-A-DAY2: optional incremental streaming (additive; absence
   * keeps the whole-text `generate()` path). The returned response is
   * assembled EXACTLY as `generate()` would return it (same content,
   * tool calls, guards); `onDelta` additionally observes each non-empty
   * content fragment live. When the transport yields zero chunks the
   * response has `streamEmpty: true` and the caller falls back.
   */
  generateStream?(
    messages: ChatMessage[],
    tools?: ToolDef[],
    options?: ProviderStreamOptions,
  ): Promise<ProviderResponse>;
}

// ─── Provider Config ──────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  /** Meta Model API keys are read only from this explicitly named environment variable. */
  apiKeyEnv?: string;
  baseURL?: string;
  costPerMillionTokens?: number;
  metaApiEnabled?: boolean;
  /** Baseten access is opt-in and always reads BASETEN_API_KEY. */
  basetenApiEnabled?: boolean;
  temperature?: number;
}

// ─── Cost Calculation Helper ──────────────────────────────────

/**
 * Calculate the cost of a response given the provider's pricing.
 */
export function calculateCost(
  usage: TokenUsage,
  costPerMillionTokens: number,
): number {
  return (usage.totalTokens / 1_000_000) * costPerMillionTokens;
}
