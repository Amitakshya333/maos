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
  content: string;
  name?: string;
  tool_call_id?: string;
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

  /** Actual model name returned by the API */
  model: string;

  /** Round-trip latency in milliseconds */
  latencyMs: number;

  /** Whether the model wants to stop or continue with tools */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';
}

// ─── Provider Interface ───────────────────────────────────────

export interface IProvider {
  /** Display name of this provider instance (e.g., "freemodel", "deepseek") */
  readonly name: string;

  /** Model identifier (e.g., "gpt-5.4", "deepseek-coder-v3") */
  readonly model: string;

  /**
   * Send a chat completion request with optional tool definitions.
   * Returns the model's response including any tool calls.
   */
  generate(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<ProviderResponse>;
}

// ─── Provider Config ──────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  costPerMillionTokens?: number;
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
