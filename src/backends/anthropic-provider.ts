import Anthropic from '@anthropic-ai/sdk';
import { IProvider, ChatMessage, ToolDef, ToolCall, ProviderResponse } from './provider';

/**
 * Native Anthropic Provider Adapter
 *
 * Uses the official @anthropic-ai/sdk instead of OpenAI-compat layer.
 * This gives proper support for:
 *  - Claude's native Messages API
 *  - Tool use with proper input schemas
 *  - Extended thinking (future)
 *  - Vision/multimodal (future)
 *
 * Supported models: Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude Opus 4, etc.
 */
export class AnthropicProvider implements IProvider {
  readonly name: string;
  readonly model: string;

  private client: Anthropic;

  constructor(opts: { name: string; apiKey: string; model: string; timeout?: number }) {
    this.name = opts.name;
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeout ?? 180_000,
    });
  }

  async generate(messages: ChatMessage[], tools?: ToolDef[]): Promise<ProviderResponse> {
    const startTime = Date.now();

    // ─── Convert MAOS messages → Anthropic format ─────────────
    // Anthropic separates system prompt from messages
    let systemPrompt: string | undefined;
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content || '';
        continue;
      }

      if (msg.role === 'assistant') {
        // Handle assistant messages with tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const contentBlocks: Anthropic.ContentBlockParam[] = [];
          if (msg.content) {
            contentBlocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(tc.function.arguments);
            } catch {
              /* keep empty */
            }

            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput,
            });
          }
          anthropicMessages.push({ role: 'assistant', content: contentBlocks });
        } else {
          anthropicMessages.push({
            role: 'assistant',
            content: msg.content || '',
          });
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: msg.content || '',
        };

        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          const hasToolResult = (lastMsg.content as any[]).some((b) => b.type === 'tool_result');
          if (hasToolResult) {
            (lastMsg.content as any[]).push(toolResultBlock);
            continue;
          }
        }

        anthropicMessages.push({
          role: 'user',
          content: [toolResultBlock],
        });
        continue;
      }

      // User messages
      anthropicMessages.push({
        role: 'user',
        content: msg.content || '',
      });
    }

    // ─── Convert MAOS tools → Anthropic tools ─────────────────
    const anthropicTools: Anthropic.Tool[] | undefined = tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));

    // ─── Call the API ─────────────────────────────────────────
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
      });

      const latencyMs = Date.now() - startTime;

      // ─── Convert Anthropic response → MAOS format ─────────
      let content: string | null = null;
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content = (content || '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      // Map stop reason
      let finishReason: ProviderResponse['finishReason'] = 'unknown';
      if (response.stop_reason === 'end_turn') finishReason = 'stop';
      else if (response.stop_reason === 'tool_use') finishReason = 'tool_calls';
      else if (response.stop_reason === 'max_tokens') finishReason = 'length';

      return {
        content,
        toolCalls,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        model: response.model,
        latencyMs,
        finishReason,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;

      // Structured error handling
      if (err.status === 401) {
        throw new Error(`Anthropic auth failed: Invalid API key. Latency: ${latencyMs}ms`);
      }
      if (err.status === 429) {
        throw new Error(`Anthropic rate limited. Latency: ${latencyMs}ms. Retry after cooldown.`);
      }
      if (err.status === 404) {
        throw new Error(`Anthropic model not found: "${this.model}". Latency: ${latencyMs}ms`);
      }
      if (err.status === 529) {
        throw new Error(`Anthropic API overloaded. Latency: ${latencyMs}ms. Retry later.`);
      }

      throw new Error(`Provider error [anthropic/${this.model}]: ${err.message || err}. Latency: ${latencyMs}ms`);
    }
  }
}
