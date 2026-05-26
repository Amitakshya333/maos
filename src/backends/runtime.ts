/**
 * MAOS Universal Runtime Interface
 *
 * Every execution backend (API, CLI, local) implements IRuntime.
 * This is the abstraction that makes MAOS provider-agnostic AND
 * runtime-agnostic — one orchestrator, any execution system.
 *
 * IProvider (existing) handles "send messages, get tool calls back".
 * IRuntime handles "take a task, produce a result" — regardless of
 * whether the work is done via API tool-calling, a CLI subprocess,
 * or a local model.
 */

// ---- Task (input to any runtime) ----

export interface RuntimeTask {
  /** Unique task ID from the queue */
  id: string;

  /** Human-readable task description / prompt */
  description: string;

  /** Git branch for this agent's work */
  branch: string;

  /** Absolute path to the project root */
  projectRoot: string;

  /** Filesystem scope restrictions (e.g., ["src/", "package.json"]) */
  scope: string[];

  /** Agent ID executing this task */
  agentId: string;
}

// ---- Result (output from any runtime) ----

export interface RuntimeResult {
  /** Whether the task completed successfully (full or partial) */
  success: boolean;

  /** Human-readable summary of what was accomplished */
  summary: string;

  /** Files created or modified during execution */
  filesChanged: string[];

  /** Number of iterations (API) or estimated steps (CLI) */
  iterations: number;

  /** Total tokens used (API) or 0 (CLI/local subscription) */
  totalTokens: number;

  /** Cost in USD (API) or 0 (CLI subscription-based) */
  costUSD: number;

  /** Wall-clock time in milliseconds */
  latencyMs: number;

  /** Which runtime type produced this result */
  runtimeType: 'api' | 'cli' | 'local';

  /** Error message if failed */
  error?: string;
}

// ---- Runtime Interface ----

export interface IRuntime {
  /** Execution type: api, cli, or local */
  readonly type: 'api' | 'cli' | 'local';

  /** Display name (e.g., "freemodel", "copilot-cli", "ollama") */
  readonly name: string;

  /** Model or CLI identifier (e.g., "gpt-5.4", "copilot", "codex") */
  readonly model: string;

  /**
   * Execute a task and return the result.
   * This is the ONLY method the orchestrator calls.
   * Everything else is internal to the runtime.
   */
  execute(task: RuntimeTask): Promise<RuntimeResult>;

  /**
   * Cleanup resources (kill child process, close connection, etc.)
   */
  dispose(): Promise<void>;
}

// ---- Agent Runtime Config (from maos.config.json) ----

export interface AgentRuntimeConfig {
  /** Agent ID */
  id: string;

  /** Agent role (planner, coder, designer, reviewer) */
  role: string;

  /** Execution type. Defaults to 'api' for backward compatibility. */
  runtime?: 'api' | 'cli' | 'local';

  /** For API runtimes: provider name (openai, freemodel, anthropic, etc.) */
  provider?: string;

  /** For API runtimes: model identifier */
  model?: string;

  /** For CLI runtimes: CLI command (copilot, codex, claude, etc.) */
  cliCommand?: string;

  /** For CLI runtimes: additional CLI arguments */
  cliArgs?: string[];

  /** For CLI runtimes: credential env vars in native format */
  auth?: Record<string, string>;

  /** Agent capabilities for routing */
  capabilities: string[];

  /** Filesystem scope restrictions */
  scope: string[];

  /** For API runtimes: max tool-calling iterations */
  maxIterations?: number;

  /** For CLI runtimes: timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;

  /** For CLI runtimes: quiescence detection threshold in ms (default: 30000) */
  quiescenceMs?: number;

  /** Cost tier for routing (low, medium, high) */
  costTier?: string;
}
