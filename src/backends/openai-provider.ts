import OpenAI from 'openai';
import {
  IProvider,
  ChatMessage,
  ToolDef,
  ToolCall,
  ProviderResponse,
} from './provider';

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

  private client: OpenAI;

  constructor(opts: {
    name: string;
    apiKey: string;
    model: string;
    baseURL?: string;
    timeout?: number;
  }) {
    this.name = opts.name;
    this.model = opts.model;

    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeout || 120_000, // 2 min default timeout
      maxRetries: 2,
    });
  }

  async generate(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<ProviderResponse> {
    const startMs = Date.now();

    try {
      // Build the request — only include tools if we have them
      const requestBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: messages.map(m => this.toOpenAIMessage(m)),
        temperature: 0.2,
      };

      if (tools && tools.length > 0) {
        requestBody.tools = tools.map(t => ({
          type: t.type as 'function',
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as OpenAI.FunctionParameters,
          },
        }));
        requestBody.tool_choice = 'auto';
      }

      const response = await this.client.chat.completions.create(requestBody);
      const latencyMs = Date.now() - startMs;
      const choice = response.choices[0];

      if (!choice) {
        throw new Error(`Empty response from ${this.name}/${this.model}`);
      }

      // Extract tool calls (cast needed: SDK union type includes custom tool calls)
      const rawToolCalls: any[] = choice.message.tool_calls || [];
      const toolCalls: ToolCall[] = rawToolCalls
        .filter(tc => tc.type === 'function' && tc.function)
        .map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

      // Map finish reason
      let finishReason: ProviderResponse['finishReason'] = 'unknown';
      if (choice.finish_reason === 'stop') finishReason = 'stop';
      else if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
      else if (choice.finish_reason === 'length') finishReason = 'length';

      return {
        content: choice.message.content,
        toolCalls,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
        model: response.model || this.model,
        latencyMs,
        finishReason,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startMs;

      // Provide helpful error messages for common failures
      if (err.status === 401) {
        throw new Error(
          `Authentication failed for ${this.name}. Check your API key.\n` +
          `Provider: ${this.name} | Model: ${this.model}`
        );
      }
      if (err.status === 429) {
        throw new Error(
          `Rate limit hit on ${this.name}. Wait and retry.\n` +
          `Provider: ${this.name} | Model: ${this.model} | Latency: ${latencyMs}ms`
        );
      }
      if (err.status === 404) {
        throw new Error(
          `Model "${this.model}" not found on ${this.name}.\n` +
          `Check available models at your provider's dashboard.`
        );
      }
      if (err.code === 'ECONNREFUSED') {
        throw new Error(
          `Cannot connect to ${this.name} at ${this.client.baseURL}.\n` +
          `Is the server running? (Check Ollama/LM Studio if local)`
        );
      }

      // Re-throw with context
      const newErr = new Error(
        `Provider error [${this.name}/${this.model}]: ${err.message}\n` +
        `Latency: ${latencyMs}ms`
      );
      newErr.stack = err.stack;
      throw newErr;
    }
  }

  /**
   * Convert our ChatMessage format to OpenAI's expected format.
   */
  private toOpenAIMessage(
    msg: ChatMessage,
  ): OpenAI.Chat.ChatCompletionMessageParam {
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
        tool_calls: msg.tool_calls?.map(tc => ({
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
