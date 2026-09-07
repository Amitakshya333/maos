# Contributing to MAOS (Multi-Agent Orchestrator System)

Thank you for your interest in contributing to MAOS! MAOS is a sovereign, local-first multi-agent orchestration workbench designed for resilient AI coding and industrial workflows.

---

## 🛠️ Development Setup

### Prerequisites
- **Node.js**: >= 18.0.0
- **npm**: >= 9.0.0
- **Git**: Installed and configured

### Installation

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/Amitakshya333/maos.git
   cd maos
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build TypeScript:**
   ```bash
   npm run build
   ```

4. **Run the automated test suite:**
   ```bash
   npm test
   ```

---

## 📁 Codebase Architecture

```
src/
├── backends/          # Provider adapters (OpenAI, Anthropic, Gemini, local) & runtimes (API, CLI, Local)
│   ├── provider.ts    # IProvider interface — universal LLM abstraction
│   └── runtime.ts     # IRuntime interface — execution environment abstraction
├── cli/               # CLI commands and dashboard
│   ├── index.ts       # Commander.js CLI entrypoint
│   └── dashboard.ts   # Web dashboard and live monitor (bound to 127.0.0.1)
├── core/              # Engine core
│   ├── orchestrator.ts# Central dispatch loop and lifecycle management
│   ├── router.ts      # 10-factor adaptive capability routing engine
│   ├── queue.ts       # Atomic file-backed task queue (pending → active → done)
│   ├── checkpoint.ts  # Crash-safe checkpoint recovery engine
│   ├── scope-guard.ts # Sandboxing, path traversal guard & file ownership locks
│   ├── supervisor.ts  # Heartbeat tracker & stall detection
│   └── agent-runner.ts# Execution loop with tool calling and context compression
├── integrations/      # Git & built-in tool definitions (write_file, run_command, etc.)
└── utils/             # Logging, paths, and process helpers
```

---

## 🧪 Testing Standards

We maintain automated unit testing with **Vitest**.

- All tests live under `tests/`.
- Every PR touching `src/core/` or `src/backends/` must include corresponding unit tests.
- Run tests locally before submitting a PR:
  ```bash
  npm test
  ```

---

## 🔌 Adding a New Provider

To add support for a new model provider (e.g., Mistral, Cohere, vLLM):

1. Implement the `IProvider` interface from `src/backends/provider.ts`:
   ```typescript
   export class CustomProvider implements IProvider {
     name = 'custom';
     model: string;
     
     constructor(config: ProviderConfig) { ... }
     
     async generate(messages: ChatMessage[], tools?: ToolDef[]): Promise<ProviderResponse> {
       // Transform messages & tools to provider payload
       // Return standard ProviderResponse
     }
   }
   ```
2. Register the provider in `src/backends/runtime-factory.ts`.
3. Add mock unit tests in `tests/`.

---

## 📝 Pull Request Checklist

Before submitting a Pull Request:

- [ ] Code compiles without errors (`npm run build`)
- [ ] All automated tests pass (`npm test`)
- [ ] New functionality has unit tests under `tests/`
- [ ] No credentials, secret keys, or absolute local machine paths are committed
- [ ] Code follows existing TypeScript conventions

---

## 📜 License
MAOS is open-source under the [MIT License](LICENSE).
