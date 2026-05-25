import {
  GoogleGenerativeAI,
  Content,
  Part,
  FunctionDeclaration,
  SchemaType,
  Tool as GeminiTool,
  GenerateContentResult,
} from '@google/generative-ai';
import {
  IProvider,
  ChatMessage,
  ToolDef,
  ToolCall,
  ProviderResponse,
} from './provider';

/**
 * Native Google Gemini Provider Adapter
 *
 * Uses the official @google/generative-ai SDK instead of OpenAI-compat layer.
 * This gives proper support for:
 *  - Gemini's native Content API
 *  - Function calling with structured schemas
 *  - Long context windows (1M+ tokens)
 *  - Grounding with Google Search (future)
 *
 * Supported models: gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-pro, etc.
 */
export class GeminiProvider implements IProvider {
  readonly name: string;
  readonly model: string;

  private genAI: GoogleGenerativeAI;

  constructor(opts: {
    name: string;
    apiKey: string;
    model: string;
  }) {
    this.name = opts.name;
    this.model = opts.model;
    this.genAI = new GoogleGenerativeAI(opts.apiKey);
  }

  async generate(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<ProviderResponse> {
    const startTime = Date.now();

    // ─── Convert MAOS messages → Gemini format ────────────────
    // Gemini uses: { role: 'user' | 'model', parts: Part[] }
    // System prompt goes into systemInstruction
    let systemInstruction: string | undefined;
    const geminiContents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content || '';
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        // Include tool calls as function call parts
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch { /* keep empty */ }

            parts.push({
              functionCall: {
                name: tc.function.name,
                args: parsedArgs,
              },
            });
          }
        }
        if (parts.length > 0) {
          geminiContents.push({ role: 'model', parts });
        }
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results go as function response parts
        let resultObj: Record<string, unknown>;
        try {
          resultObj = JSON.parse(msg.content || '{}');
        } catch {
          resultObj = { result: msg.content || '' };
        }

        geminiContents.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: msg.name || 'unknown',
              response: resultObj,
            },
          }],
        });
        continue;
      }

      // User messages
      geminiContents.push({
        role: 'user',
        parts: [{ text: msg.content || '' }],
      });
    }

    // ─── Convert MAOS tools → Gemini function declarations ────
    let geminiTools: GeminiTool[] | undefined;
    if (tools && tools.length > 0) {
      const functionDeclarations: FunctionDeclaration[] = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: convertJsonSchemaToGemini(t.function.parameters),
      }));
      geminiTools = [{ functionDeclarations }];
    }

    // ─── Call the API ─────────────────────────────────────────
    try {
      const model = this.genAI.getGenerativeModel({
        model: this.model,
        systemInstruction: systemInstruction,
        tools: geminiTools,
      });

      const result: GenerateContentResult = await model.generateContent({
        contents: geminiContents,
      });

      const latencyMs = Date.now() - startTime;
      const response = result.response;

      // ─── Convert Gemini response → MAOS format ─────────────
      let content: string | null = null;
      const toolCalls: ToolCall[] = [];

      const candidates = response.candidates;
      if (candidates && candidates.length > 0) {
        const parts = candidates[0].content?.parts || [];

        for (const part of parts) {
          if ('text' in part && part.text) {
            content = (content || '') + part.text;
          }
          if ('functionCall' in part && part.functionCall) {
            toolCalls.push({
              id: `gemini_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {}),
              },
            });
          }
        }
      }

      // Map finish reason
      let finishReason: ProviderResponse['finishReason'] = 'unknown';
      const geminiReason = candidates?.[0]?.finishReason;
      if (geminiReason === 'STOP') finishReason = 'stop';
      else if (geminiReason === 'MAX_TOKENS') finishReason = 'length';
      else if (toolCalls.length > 0) finishReason = 'tool_calls';

      // Token usage
      const usageMetadata = response.usageMetadata;
      const promptTokens = usageMetadata?.promptTokenCount || 0;
      const completionTokens = usageMetadata?.candidatesTokenCount || 0;

      return {
        content,
        toolCalls,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model: this.model,
        latencyMs,
        finishReason,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;

      // Structured error handling
      if (err.message?.includes('API_KEY_INVALID') || err.status === 401) {
        throw new Error(`Gemini auth failed: Invalid API key. Latency: ${latencyMs}ms`);
      }
      if (err.status === 429 || err.message?.includes('RESOURCE_EXHAUSTED')) {
        throw new Error(`Gemini rate limited. Latency: ${latencyMs}ms. Retry after cooldown.`);
      }
      if (err.message?.includes('not found') || err.status === 404) {
        throw new Error(`Gemini model not found: "${this.model}". Latency: ${latencyMs}ms`);
      }

      throw new Error(
        `Provider error [gemini/${this.model}]: ${err.message || err}. Latency: ${latencyMs}ms`
      );
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Convert a JSON Schema object to Gemini's FunctionDeclarationSchema format.
 * Gemini uses its own schema type enum instead of string types.
 */
function convertJsonSchemaToGemini(schema: Record<string, unknown>): any {
  if (!schema || typeof schema !== 'object') return undefined;

  const result: Record<string, unknown> = {};

  // Map JSON Schema type → Gemini SchemaType
  const typeStr = (schema.type as string)?.toUpperCase();
  if (typeStr === 'OBJECT') result.type = SchemaType.OBJECT;
  else if (typeStr === 'STRING') result.type = SchemaType.STRING;
  else if (typeStr === 'NUMBER' || typeStr === 'INTEGER') result.type = SchemaType.NUMBER;
  else if (typeStr === 'BOOLEAN') result.type = SchemaType.BOOLEAN;
  else if (typeStr === 'ARRAY') result.type = SchemaType.ARRAY;
  else result.type = SchemaType.STRING;

  if (schema.description) result.description = schema.description;
  if (schema.required) result.required = schema.required;

  // Recurse into properties
  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[key] = convertJsonSchemaToGemini(val as Record<string, unknown>);
    }
    result.properties = props;
  }

  // Handle array items
  if (schema.items && typeof schema.items === 'object') {
    result.items = convertJsonSchemaToGemini(schema.items as Record<string, unknown>);
  }

  if (schema.enum) result.enum = schema.enum;

  return result;
}
