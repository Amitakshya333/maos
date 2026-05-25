<div align="center">

# 🤖 MAOS — Multi-Agent Orchestrator System

### *docker-compose for AI coding agents*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

**MAOS lets you define, orchestrate, and run multiple AI coding agents on a single project — each with their own role, scope, and capabilities — using a simple config file.**

[Quick Start](#-quick-start) · [How It Works](#-how-it-works) · [Architecture](#-architecture) · [Commands](#-commands) · [Config](#-configuration)

</div>

---

## 💡 The Problem

Modern AI coding assistants are powerful but **single-threaded**. You can only use one model at a time, on one task. What if you could:

- Have a **planner agent** decompose a goal into subtasks
- Route each subtask to the **best-suited agent** based on capabilities
- Run a **backend coder**, **frontend designer**, and **test writer** in parallel
- Use **any model** — GPT-5, Claude, Gemini, Llama, Qwen, DeepSeek — through one unified interface
- Track cost, tokens, and latency across your entire AI fleet

**MAOS makes this possible.**

---

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Amitakshya333/maos.git
cd maos
npm install
npm run build

# 2. Initialize a project
cd your-project
node /path/to/maos/dist/cli/index.js init

# 3. Add your API key
echo "FREEMODEL_API_KEY=your_key_here" > .env

# 4. Decompose a goal into subtasks
node /path/to/maos/dist/cli/index.js plan "Build a REST API with auth"

# 5. Start the orchestrator
node /path/to/maos/dist/cli/index.js start
```

---

## 🧠 How It Works

MAOS follows a **Plan → Route → Execute → Report** cycle:

```
┌──────────────────────────────────────────────────────────────┐
│                    maos plan "Build X"                        │
│                         │                                    │
│                    ┌────▼────┐                               │
│                    │DECOMPOSER│  AI breaks goal into subtasks│
│                    └────┬────┘                               │
│                         │                                    │
│              ┌──────────▼──────────┐                         │
│              │   CAPABILITY ROUTER  │  Scores agents per task│
│              └──────────┬──────────┘                         │
│                         │                                    │
│         ┌───────────────┼───────────────┐                    │
│         ▼               ▼               ▼                    │
│    ┌─────────┐    ┌─────────┐    ┌─────────┐                │
│    │  DEV    │    │ DESIGNER │    │ TESTER  │  Parallel exec │
│    │(Claude) │    │ (Gemini) │    │ (GPT-5) │                │
│    └────┬────┘    └────┬────┘    └────┬────┘                │
│         │              │              │                      │
│         └──────────────┼──────────────┘                      │
│                        ▼                                     │
│              ┌─────────────────┐                             │
│              │  GIT ISOLATION   │  Each agent = own branch   │
│              │  main ← merge    │                            │
│              └─────────────────┘                             │
└──────────────────────────────────────────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Agent** | An AI model instance with a role, scope, and capabilities |
| **Task** | A unit of work in the queue (a markdown file in `.maos/queue/`) |
| **Router** | Scores agents against tasks using capability match, role affinity, cost, and complexity |
| **Decomposer** | AI-powered goal → subtask breakdown with dependency graphs |
| **Pool** | Enable/disable agents without changing config |
| **Branch Isolation** | Each agent works on its own git branch — no conflicts |

---

## 🏗️ Architecture

```
maos/
├── src/
│   ├── cli/                    # CLI commands
│   │   ├── index.ts            # Entry point — 8 commands
│   │   ├── init.ts             # maos init — scaffold .maos/
│   │   ├── task.ts             # maos task — queue a task
│   │   ├── plan.ts             # maos plan — AI decomposition
│   │   ├── start.ts            # maos start — run orchestrator
│   │   ├── status.ts           # maos status — fleet dashboard
│   │   ├── pool.ts             # maos pool — agent management
│   │   ├── logs.ts             # maos logs — view/tail logs
│   │   └── clean.ts            # maos clean — reset queue
│   │
│   ├── core/                   # Core orchestration engine
│   │   ├── orchestrator.ts     # Main event loop (poll → match → dispatch)
│   │   ├── router.ts           # Capability-based routing engine
│   │   ├── decomposer.ts       # AI task decomposition
│   │   ├── agent-runner.ts     # Agentic tool-calling loop
│   │   ├── queue.ts            # File-based task queue (pending → active → done)
│   │   └── pool-manager.ts     # Agent pool state management
│   │
│   ├── backends/               # LLM provider abstraction
│   │   ├── provider.ts         # IProvider interface
│   │   ├── openai-provider.ts  # OpenAI-compatible provider (GPT, Claude, Gemini, etc.)
│   │   └── factory.ts          # Provider factory
│   │
│   ├── integrations/           # External tool integrations
│   │   ├── tools.ts            # Agent tools (read/write/list/exec/git)
│   │   └── git.ts              # Git branch isolation
│   │
│   └── utils/                  # Utilities
│       ├── logger.ts           # Structured logger (console + file)
│       └── paths.ts            # .maos/ directory management
│
├── .maos/                      # Project-specific MAOS data (git-ignored)
│   ├── maos.config.json        # Agent fleet configuration
│   ├── pool.json               # Agent enable/disable state
│   ├── queue/                  # Task queue
│   │   ├── pending/            # Queued tasks
│   │   ├── active/             # In-progress tasks
│   │   └── done/               # Completed tasks
│   ├── status/                 # Agent status files
│   └── logs/                   # Orchestrator logs
│
├── package.json
└── tsconfig.json
```

---

## 📦 Commands

| Command | Description |
|---------|-------------|
| `maos init` | Initialize MAOS in the current directory (creates `.maos/`) |
| `maos plan <goal>` | Use AI to decompose a goal into capability-tagged subtasks |
| `maos task <desc>` | Manually queue a single task |
| `maos start` | Start the orchestrator loop |
| `maos status` | Show fleet dashboard (agents, queue, statuses) |
| `maos pool` | Enable/disable agents (`--enable DEV`, `--disable all`) |
| `maos logs` | View orchestrator logs (`-f` to follow, `-a` to filter by agent) |
| `maos clean` | Clear queue, reset statuses, truncate logs |

### Examples

```bash
# Decompose a complex goal into subtasks
maos plan "Build a todo app with auth, dark mode, and REST API" --yes

# Queue a single task targeting a specific agent
maos task "Add rate limiting to the auth middleware" --agent DEV --complexity high

# Start with a different provider
maos start --provider openai

# Follow logs in real-time, filtered by agent
maos logs -f --agent DEV

# Disable an agent temporarily
maos pool --disable DESIGNER

# Clean everything and start fresh
maos clean
```

---

## ⚙️ Configuration

MAOS is configured via `.maos/maos.config.json`:

```jsonc
{
  "projectName": "my-app",
  "routingMode": "auto",

  // Provider configurations (any OpenAI-compatible API)
  "providers": {
    "freemodel": {
      "apiKey": "env:FREEMODEL_API_KEY",
      "baseURL": "https://api.freemodel.dev/v1",
      "costPerMillionTokens": 0.50
    },
    "openai": {
      "apiKey": "env:OPENAI_API_KEY",
      "baseURL": "https://api.openai.com/v1",
      "costPerMillionTokens": 15.0
    }
  },

  // Agent definitions
  "agents": [
    {
      "id": "DEV",
      "role": "coder",
      "provider": "freemodel",
      "model": "gpt-5.4",
      "capabilities": ["coding", "apis", "database", "refactoring", "testing"],
      "scope": ["**/*"],
      "maxIterations": 20,
      "costTier": "low"
    },
    {
      "id": "DESIGNER",
      "role": "designer",
      "provider": "freemodel",
      "model": "gemini-2.5-pro",
      "capabilities": ["design", "css", "frontend", "layout", "styling"],
      "scope": ["src/components/**", "src/styles/**", "public/**"],
      "maxIterations": 15,
      "costTier": "low"
    }
  ],

  // Routing configuration
  "routing": {
    "strategy": "capability_score",  // capability_score | round_robin | cheapest_first | best_model
    "costWeight": 0.3,
    "capabilityWeight": 0.7,
    "maxParallelAgents": 3,
    "fallbackProvider": "freemodel"
  }
}
```

### Supported Providers

MAOS works with **any OpenAI-compatible API**:

| Provider | Base URL | Notes |
|----------|----------|-------|
| Freemodel | `https://api.freemodel.dev/v1` | Free tier, hackathon-friendly |
| OpenAI | `https://api.openai.com/v1` | GPT-4o, GPT-5 |
| Anthropic (via proxy) | varies | Claude 3.5, Claude 4 |
| Google (via proxy) | varies | Gemini 2.5 Pro |
| Ollama | `http://localhost:11434/v1` | Local models (Llama, Qwen) |
| LM Studio | `http://localhost:1234/v1` | Local GUI-based |
| DeepSeek | `https://api.deepseek.com/v1` | DeepSeek Coder V3 |
| Together AI | `https://api.together.xyz/v1` | Open-source models |

---

## 🧭 Routing Engine

The router scores each agent against a task using 4 dimensions:

```
SCORE = (capability_match × capabilityWeight)
      + role_bonus
      + complexity_bonus
      - (cost_penalty × costWeight)
```

| Dimension | Range | What It Measures |
|-----------|-------|------------------|
| Capability Match | 0.0 – 1.0 | % of required capabilities the agent has |
| Role Bonus | 0.0 – 0.25 | Does agent role match task category? |
| Complexity Bonus | 0.0 – 0.20 | Is the model powerful enough for hard tasks? |
| Cost Penalty | 0.0 – 0.15 | Prefer cheaper models when capable |

**Routing strategies:**
- `capability_score` — Intelligent scoring (default)
- `cheapest_first` — Use cheapest capable agent
- `best_model` — Always use the most expensive model
- `round_robin` — Simple rotation

---

## 🛡️ Safety Features

- **Git branch isolation** — Each agent works on its own branch (`maos/<agent>/<task>`)
- **Scope enforcement** — Agents can only modify files matching their `scope` globs
- **Circuit breaker** — Agents stuck for 5 iterations with no file changes are stopped
- **Max iteration limit** — Hard cap on tool calls per agent per task
- **Cost tracking** — Real-time cost tracking per agent and per task
- **Graceful shutdown** — SIGINT/SIGTERM handlers clean up agent statuses

---

## 🗺️ Roadmap

- [x] Core orchestrator loop
- [x] Capability-based routing engine (4 strategies)
- [x] AI task decomposition (`maos plan`)
- [x] Git branch isolation per agent
- [x] File-based task queue
- [x] Provider abstraction (any OpenAI-compatible API)
- [x] Agent pool management
- [x] Structured logging
- [x] Cost + token telemetry
- [ ] Web dashboard (real-time fleet visualization)
- [ ] Multi-provider routing (different models for different tasks)
- [ ] Historical performance learning
- [ ] Plugin system for custom tools
- [ ] VS Code extension

---

## 📄 License

MIT © [Amitakshya Sutar](https://github.com/Amitakshya333)

---

<div align="center">

**Built for the Freemodel Hackathon 2025** 🏆

*MAOS — because one AI agent is never enough.*

</div>
