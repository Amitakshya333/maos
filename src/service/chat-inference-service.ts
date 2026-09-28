/**
 * MAOS — Chat Inference Service
 *
 * Bridges the ChatView UI to the local OpenAI-compatible model server
 * (huggingface-openai-server.py at http://127.0.0.1:8000/v1).
 *
 * Design invariants:
 * 1. Only calls the loopback model endpoint — never contacts external services.
 * 2. Fails clearly with MODEL_SERVER_UNAVAILABLE when the server is unreachable.
 * 3. Enforces deterministic inference (temperature=0, top_p=1).
 * 4. Records privacy-preserving audit events (no raw content logged).
 * 5. Prepends a system prompt for sovereign industrial context.
 */

import type { AuditService } from './audit-service';
import type { EndpointAllowlistService } from './endpoint-allowlist-service';

// ── Types ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  conversationId: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface ChatCompletionResponse {
  message: {
    role: 'assistant';
    content: string;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  deterministic: boolean;
}

export class ChatInferenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChatInferenceError';
  }
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_MODEL_ENDPOINT = 'http://127.0.0.1:8000';
const DEFAULT_MAX_TOKENS = 768;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MODEL_NAME = 'qwen2.5-3b-instruct-local';

const SYSTEM_PROMPT = `You are the MAOS Sovereign Assistant — a local, offline AI running entirely on this machine. You help with industrial engineering analysis, data inspection, and sovereign workflow tasks. All your responses stay on this device and are never transmitted externally.

Key rules:
- Provide clear, factual, and concise answers.
- When analyzing data, cite specific values and rows.
- If you cannot answer confidently, say so explicitly.
- Never fabricate data or claim access to external services.
- All computation should be verifiable and deterministic.`;

// ── Service ────────────────────────────────────────────────────────

export interface ChatInferenceServiceOptions {
  readonly auditService?: AuditService;
  readonly endpointAllowlist?: EndpointAllowlistService;
  readonly modelEndpoint?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export class ChatInferenceService {
  private readonly auditService?: AuditService;
  private readonly endpointAllowlist?: EndpointAllowlistService;
  private readonly modelEndpoint: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: ChatInferenceServiceOptions = {}) {
    this.auditService = options.auditService;
    this.endpointAllowlist = options.endpointAllowlist;
    this.modelEndpoint = options.modelEndpoint || DEFAULT_MODEL_ENDPOINT;
    this.maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /**
   * Send a chat completion request to the local model server.
   * Prepends the sovereign system prompt to the conversation.
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const { conversationId, messages } = request;

    // Validate model endpoint against explicit endpoint allowlist
    if (this.endpointAllowlist) {
      try {
        const url = new URL(this.modelEndpoint);
        const port = url.port
          ? parseInt(url.port, 10)
          : url.protocol === 'https:'
            ? 443
            : 80;
        const validation = this.endpointAllowlist.validateSocketTarget({
          protocol: 'tcp',
          direction: 'connect',
          host: url.hostname,
          port,
          serviceId: 'chat_inference',
        });
        if (!validation.allowed) {
          throw new ChatInferenceError(
            validation.errorCode || 'NON_LOOPBACK_ENDPOINT',
            `Model endpoint "${this.modelEndpoint}" rejected by endpoint allowlist: ${validation.reason}`,
          );
        }
      } catch (err: any) {
        if (err instanceof ChatInferenceError) throw err;
        throw new ChatInferenceError('NON_LOOPBACK_ENDPOINT', `Invalid model endpoint URL: ${err.message}`);
      }
    }

    // Build the full message list with system prompt
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    ];

    const requestBody = {
      model: MODEL_NAME,
      messages: fullMessages,
      temperature: 0,
      top_p: 1,
      max_tokens: this.maxTokens,
      stream: false,
    };

    // Check if cancelled before starting
    if (request.signal?.aborted) {
      this.recordAudit(conversationId, 'CHAT_INFERENCE_INTERRUPTED', {
        reason: 'CLIENT_ABORTED',
      });
      throw new ChatInferenceError(
        'INTERRUPTED',
        'Chat inference was cancelled before execution.',
        { conversationId, reason: 'CLIENT_ABORTED' },
      );
    }

    const startMs = Date.now();
    let abortedByClient = false;
    let abortListener: (() => void) | undefined;

    try {
      const controller = new AbortController();
      if (request.signal) {
        abortListener = () => {
          abortedByClient = true;
          controller.abort();
        };
        request.signal.addEventListener('abort', abortListener, { once: true });
      }

      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${this.modelEndpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        if (request.signal && abortListener) {
          request.signal.removeEventListener('abort', abortListener);
        }
      }

      const latencyMs = Date.now() - startMs;

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.recordAudit(conversationId, 'CHAT_INFERENCE_FAILED', {
          status: response.status,
          latencyMs,
        });

        if (response.status === 503 || response.status === 502 || response.status === 504) {
          throw new ChatInferenceError(
            'MODEL_SERVER_UNAVAILABLE',
            `Local model server returned HTTP ${response.status}. Is the model loaded?`,
            { status: response.status, latencyMs },
          );
        }

        throw new ChatInferenceError(
          'MODEL_SERVER_ERROR',
          `Local model server error (HTTP ${response.status}): ${errorText.substring(0, 200)}`,
          { status: response.status, latencyMs },
        );
      }

      const data = await response.json();

      // Validate response structure
      const choices = data?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new ChatInferenceError(
          'INVALID_MODEL_RESPONSE',
          'Model server returned no choices.',
          { keys: Object.keys(data || {}) },
        );
      }

      const assistantMessage = choices[0]?.message;
      if (!assistantMessage || typeof assistantMessage.content !== 'string') {
        throw new ChatInferenceError(
          'INVALID_MODEL_RESPONSE',
          'Model server returned no message content.',
          { choiceKeys: Object.keys(choices[0] || {}) },
        );
      }

      const usage = data.usage || {};
      const result: ChatCompletionResponse = {
        message: {
          role: 'assistant',
          content: assistantMessage.content,
        },
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        },
        model: data.model || MODEL_NAME,
        deterministic: true,
      };

      // Privacy-preserving audit (no raw content)
      this.recordAudit(conversationId, 'CHAT_INFERENCE_COMPLETED', {
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        latencyMs,
        messageCount: messages.length,
        deterministic: true,
      });

      return result;
    } catch (err: any) {
      if (err instanceof ChatInferenceError) {
        throw err;
      }

      const latencyMs = Date.now() - startMs;

      // Connection refused = model server not running
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
        this.recordAudit(conversationId, 'CHAT_INFERENCE_FAILED', {
          error: 'MODEL_SERVER_UNAVAILABLE',
          latencyMs,
        });
        throw new ChatInferenceError(
          'MODEL_SERVER_UNAVAILABLE',
          `Cannot connect to local model server at ${this.modelEndpoint}. Ensure the model server is running.`,
          { endpoint: this.modelEndpoint, latencyMs },
        );
      }

      // Abort = client abort or timeout
      if (err.name === 'AbortError') {
        if (abortedByClient || request.signal?.aborted) {
          this.recordAudit(conversationId, 'CHAT_INFERENCE_INTERRUPTED', {
            reason: 'CLIENT_ABORTED',
            latencyMs,
          });
          throw new ChatInferenceError(
            'INTERRUPTED',
            'Chat inference cancelled by client.',
            { conversationId, latencyMs, reason: 'CLIENT_ABORTED' },
          );
        }

        this.recordAudit(conversationId, 'CHAT_INFERENCE_FAILED', {
          error: 'TIMEOUT',
          latencyMs,
          timeoutMs: this.timeoutMs,
        });
        throw new ChatInferenceError(
          'MODEL_INFERENCE_TIMEOUT',
          `Model inference timed out after ${this.timeoutMs}ms.`,
          { timeoutMs: this.timeoutMs, latencyMs },
        );
      }

      this.recordAudit(conversationId, 'CHAT_INFERENCE_FAILED', {
        error: err.message?.substring(0, 200),
        latencyMs,
      });
      throw new ChatInferenceError(
        'MODEL_SERVER_ERROR',
        `Chat inference failed: ${err.message}`,
        { latencyMs },
      );
    }
  }

  /**
   * Quick health check — can we reach the model server?
   */
  async isModelServerAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${this.modelEndpoint}/health`, {
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
  }

  private recordAudit(conversationId: string, event: string, data: Record<string, unknown>): void {
    if (!this.auditService) return;
    this.auditService.recordAuditEvent({
      category: 'stage',
      source: 'chat-inference-service',
      data: {
        event,
        conversationId,
        ...data,
      },
    });
  }
}
