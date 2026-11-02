# TASK RING-TRACE: Truthful End-to-End Map of Chat Inference & Provider Resolution

- **Base Commit**: `5cf1afe28fa514d91a62e871885a8406f40316f3`
- **Date**: 2026-11-01
- **Author**: Antigravity (Verification & Triage)
- **Status**: Completed (Trace only, no code changes)

---

## 1. Demo Profile & `sovereignLocal` Resolution

When starting the Cockpit via Electron using the RUNBOOK Option B / rehearsal recipe (`desktop/main.cjs` pointing to the disposable project):

1. **Profile Loaded**:
   - **Display Name**: `MAOS Industrial` ([`profiles/industrial/maos.config.json:6`](file:///c:/maos/profiles/industrial/maos.config.json#L6))
   - **Profile ID**: `industrial` ([`profiles/industrial/maos.config.json:5`](file:///c:/maos/profiles/industrial/maos.config.json#L5))
   - **Project Name**: `maos-industrial-demo` ([`profiles/industrial/maos.config.json:3`](file:///c:/maos/profiles/industrial/maos.config.json#L3))
   - **Path Loaded in Cockpit**: `<disposableProject>/.maos/maos.config.json` (staged by copying from [`profiles/industrial/maos.config.json`](file:///c:/maos/profiles/industrial/maos.config.json) per Task S step 9 / RUNBOOK Option B).
   - **Profile Configuration Keys**:
     ```json
     "profile": {
       "id": "industrial",
       "displayName": "MAOS Industrial",
       "mode": "sovereign-local",
       "zeroCloud": true,
       "evidenceRoot": "demo/industrial"
     }
     ```
     ([`profiles/industrial/maos.config.json:4-10`](file:///c:/maos/profiles/industrial/maos.config.json#L4-L10))

2. **Resolution of `sovereignLocal`**:
   - Evaluated in `src/core/orchestrator.ts:410`:
     ```ts
     const sovereignLocal = config.profile?.mode === 'sovereign-local' || config.profile?.zeroCloud === true;
     ```
   - Because `config.profile.mode === "sovereign-local"` and `config.profile.zeroCloud === true`, the boolean flag resolves strictly to **`true`**.

---

## 2. End-to-End Chat Completion Hop Table

The table below traces one user chat message from UI form submission to backend execution.

| Hop # | Layer | Component / Handler | File & Line Citation | Action & Description |
|:---:|---|---|---|---|
| **1** | **UI Action** | Chat Form Submit | [`src/gui/src/views/ChatView.tsx:848, 888`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L848-L888) | User clicks `<button type="submit">Send</button>`, firing `<form onSubmit={handleSendMessage}>`. |
| **2** | **UI Controller** | `handleSendMessage` | [`src/gui/src/views/ChatView.tsx:140-175`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L140-L175) | Validates input; calls `apiAdapter.addMessage(activeConvId, ...)` to persist user message; builds message history array `[{ role, content }]`; calls `apiAdapter.chatCompletion(activeConvId, history)`. |
| **3** | **GUI Adapter** | `ApiAdapter.chatCompletion` | [`src/gui/src/api/adapter.ts:350-360`](file:///c:/maos/src/gui/src/api/adapter.ts#L350-L360) | Delegates to `this.rest.chatCompletion({ conversationId, messages }, { timeoutMs: 120_000 })`. |
| **4** | **GUI REST Client** | `RestClient.chatCompletion` | [`src/gui/src/api/rest-client.ts:686-708`](file:///c:/maos/src/gui/src/api/rest-client.ts#L686-L708) | Dispatches HTTP `POST /api/v1/chat/completions` with JSON payload `{ conversationId, messages }` and authorization header. |
| **5** | **API Route Ingress** | `ApiRouter` HTTP Route Handler | [`src/api/router.ts:1221-1258`](file:///c:/maos/src/api/router.ts#L1221-L1258) | Matches `POST /api/v1/chat/completions`; validates payload structure; binds `req.on('close')` to an `AbortController`; calls `await this.services.chatInference.chatCompletion({ conversationId, messages, signal })`. |
| **6** | **Service Layer** | `ChatInferenceService.chatCompletion` | [`src/service/chat-inference-service.ts:101-180`](file:///c:/maos/src/service/chat-inference-service.ts#L101-L180) | 1. Checks endpoint via `endpointAllowlist.validateSocketTarget(...)` (lines 105-125).<br>2. Prepends `SYSTEM_PROMPT` (lines 63-70) to conversation history (line 134).<br>3. Sets `model: 'qwen2.5-3b-instruct-local'`, `temperature: 0`, `top_p: 1`, `max_tokens: 768` (lines 138-145).<br>4. Directly calls `fetch('${this.modelEndpoint}/v1/chat/completions')` (line 177). |
| **7** | **Provider Creation** | `RuntimeFactory` / `createProvider` | **ABSENT IN CHAT PATH** | **Architectural Finding**: `ChatInferenceService` does **not** call `RuntimeFactory.create()` or `createProvider()`. It issues a direct loopback `fetch()` to `http://127.0.0.1:8000`. Provider instantiation via `src/backends/factory.ts` is only invoked during agent workflow orchestration (`src/core/orchestrator.ts:411`). |

---

## 3. Four Core Architectural Questions

### 3a. Does Chat call a model today, or does it render stored conversations/deterministic content?

**Evidence & Citation**:
1. **Rendering Stored Conversations**:
   - When the Chat view is opened, historical messages are loaded from disk via `GET /api/v1/conversations`:
     - [`src/gui/src/views/ChatView.tsx:48`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L48): `const list = await apiAdapter.getConversations();`
     - [`src/gui/src/views/ChatView.tsx:112`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L112): `const conv = await apiAdapter.getConversation(activeConvId);`
   - Messages are stored as JSON files under `.maos/conversations/<convId>.json` managed by `ConversationService` ([`src/service/conversation-service.ts:104`](file:///c:/maos/src/service/conversation-service.ts#L104)).

2. **Model Call Execution**:
   - When the user sends a new message, Chat **actively attempts a real model call** via HTTP:
     - [`src/gui/src/views/ChatView.tsx:175`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L175): `const response = await apiAdapter.chatCompletion(activeConvId, history);`
     - [`src/service/chat-inference-service.ts:177-180`](file:///c:/maos/src/service/chat-inference-service.ts#L177-L180):
       ```ts
       response = await fetch(`${this.modelEndpoint}/v1/chat/completions`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(requestBody),
         signal: controller.signal,
       });
       ```
   - The endpoint target defaults to `http://127.0.0.1:8000` ([`src/service/chat-inference-service.ts:58`](file:///c:/maos/src/service/chat-inference-service.ts#L58)).

3. **Absence of Mock / Deterministic Fallback**:
   - If the local model server is not running, `ChatInferenceService` does **not** generate deterministic fake responses. It fails closed and throws:
     ```ts
     throw new ChatInferenceError(
       'MODEL_SERVER_UNAVAILABLE',
       `Local model server unreachable at ${this.modelEndpoint}: ${err.message}. ` +
         'Ensure huggingface-openai-server.py is running.',
       { endpoint: this.modelEndpoint, originalError: err.message },
     );
     ```
     ([`src/service/chat-inference-service.ts:213-217`](file:///c:/maos/src/service/chat-inference-service.ts#L213-L217))
   - `ChatView` renders the exact error banner:
     `Local model server unavailable. Ensure the model server is running at http://127.0.0.1:8000 (scripts/huggingface-openai-server.py).`
     ([`src/gui/src/views/ChatView.tsx:192-194`](file:///c:/maos/src/gui/src/views/ChatView.tsx#L192-L194)).

---

### 3b. Where would a hosted baseURL (`https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`) be read from — config, env var, or DB? Show the exact key names.

**Evidence & Citation**:
1. **From Configuration File (`maos.config.json`)**:
   - Provider definitions are read under the `providers` map:
     - **Provider Key**: `providers.baseten` (or custom provider name)
     - **Base URL Key**: `providers.<name>.baseURL`
       - Must match constant `BASETEN_API_BASE_URL = 'https://inference.baseten.co/v1'` ([`src/backends/meta-api-policy.ts:3`](file:///c:/maos/src/backends/meta-api-policy.ts#L3), [`214-222`](file:///c:/maos/src/backends/meta-api-policy.ts#L214-L222)).
     - **Opt-in Key**: `providers.<name>.basetenApiEnabled`
       - Must be explicitly set to `true` ([`src/backends/meta-api-policy.ts:36`](file:///c:/maos/src/backends/meta-api-policy.ts#L36), [`211-213`](file:///c:/maos/src/backends/meta-api-policy.ts#L211-L213)).
     - **Credential Reference Key**: `providers.<name>.apiKeyEnv`
       - Defaults to `"BASETEN_API_KEY"` ([`src/backends/meta-api-policy.ts:5`](file:///c:/maos/src/backends/meta-api-policy.ts#L5), [`224-226`](file:///c:/maos/src/backends/meta-api-policy.ts#L224-L226)).
   - Agent model definitions are read under the `agents[]` list:
     - **Agent Model Key**: `agents[i].model`
       - Must match constant `BASETEN_API_MODEL = 'meta-models/muse-spark-open-1026'` ([`src/backends/meta-api-policy.ts:4`](file:///c:/maos/src/backends/meta-api-policy.ts#L4), [`214-222`](file:///c:/maos/src/backends/meta-api-policy.ts#L214-L222)).
     - **Agent Provider Key**: `agents[i].provider` (must be `"baseten"`).

2. **From Environment Variable**:
   - **Environment Variable Name**: `BASETEN_API_KEY`
   - Defined in [`src/backends/meta-api-policy.ts:5`](file:///c:/maos/src/backends/meta-api-policy.ts#L5):
     ```ts
     export const BASETEN_API_KEY_ENV = 'BASETEN_API_KEY';
     ```
   - Resolved in [`src/backends/meta-api-policy.ts:232-234`](file:///c:/maos/src/backends/meta-api-policy.ts#L232-L234):
     ```ts
     const apiKeyEnv = isMeta ? config.apiKeyEnv! : BASETEN_API_KEY_ENV;
     const apiKey = process.env[apiKeyEnv];
     ```
   - The plaintext API token is **only** read from `process.env.BASETEN_API_KEY`. If unset or whitespace, it throws `MODEL_CREDENTIAL_MISSING` ([`src/backends/meta-api-policy.ts:234-242`](file:///c:/maos/src/backends/meta-api-policy.ts#L234-L242)).

3. **From Database**:
   - **None**. MAOS uses no SQL database or persistent database store for model provider configuration or credentials. All definitions originate from project JSON configuration files and secrets come strictly from process environment variables.

---

### 3c. What does the event submission profile (`profiles/industrial/maos.config.json`) declare for providers, and does it block a non-loopback call? Quote the lines.

**Evidence & Citation**:
1. **Provider Declaration**:
   [`profiles/industrial/maos.config.json:12-18`](file:///c:/maos/profiles/industrial/maos.config.json#L12-L18):
   ```json
   12:   "providers": {
   13:     "ollama": {
   14:       "apiKey": "",
   15:       "baseURL": "http://127.0.0.1:8000/v1",
   16:       "costPerMillionTokens": 0
   17:     }
   18:   },
   ```
   Only one provider (`"ollama"`) is declared, pointing explicitly to local loopback port 8000 (`http://127.0.0.1:8000/v1`).

2. **Profile & Agent Sovereignty Declarations**:
   [`profiles/industrial/maos.config.json:4-10`](file:///c:/maos/profiles/industrial/maos.config.json#L4-L10):
   ```json
   4:   "profile": {
   5:     "id": "industrial",
   6:     "displayName": "MAOS Industrial",
   7:     "mode": "sovereign-local",
   8:     "zeroCloud": true,
   9:     "evidenceRoot": "demo/industrial"
   10:   },
   ```
   And for all four agents (`INGEST_AGENT`, `ANALYST_AGENT`, `AUDITOR_AGENT`, `SYNTHESIZER_AGENT`):
   - `runtime`: `"local"` (lines 23, 36, 50, 62)
   - `provider`: `"ollama"` (lines 24, 37, 51, 63)
   - `model`: `"qwen2.5-3b-instruct-local"` (lines 25, 38, 52, 64)

3. **Blocking Non-Loopback Calls**:
   **YES, non-loopback calls are blocked at three distinct enforcement levels:**
   - **Level 1 (Orchestrator Mode Resolution)**:
     [`src/core/orchestrator.ts:410-411`](file:///c:/maos/src/core/orchestrator.ts#L410-L411):
     `config.profile?.mode === 'sovereign-local' || config.profile?.zeroCloud === true` sets `sovereignLocal = true`.
   - **Level 2 (RuntimeFactory / Provider Creation)**:
     [`src/backends/factory.ts:304`](file:///c:/maos/src/backends/factory.ts#L304):
     `sovereignLocal || runtimeType === 'local'` guarantees `sovereignLocal = true` is passed to `createProvider`.
     [`src/backends/factory.ts:174, 214-216`](file:///c:/maos/src/backends/factory.ts#L174):
     `if (sovereignLocal) enforceLoopbackOnly(name, baseURL);`
   - **Level 3 (Loopback Enforcement Check)**:
     [`src/backends/factory.ts:120-125`](file:///c:/maos/src/backends/factory.ts#L120-L125):
     ```ts
     if (!isLoopbackURL(baseURL)) {
       throw new Error(
         `Provider "${providerName}" has non-loopback baseURL "${baseURL}". ` +
         `In sovereign-local mode, all endpoints must be loopback (127.0.0.1, localhost, ::1).`
       );
     }
     ```

---

### 3d. In `sovereignLocal` mode, what error does a judge see if they point a provider at Baseten? Quote it.

**Evidence & Citation**:
When `sovereignLocal` is `true` (enforced by profile `mode: "sovereign-local"` or `zeroCloud: true`), pointing a provider at Baseten (`baseURL: "https://inference.baseten.co/v1"`) hits `enforceLoopbackOnly` at [`src/backends/factory.ts:174`](file:///c:/maos/src/backends/factory.ts#L174).

Inside `enforceLoopbackOnly` ([`src/backends/factory.ts:120-125`](file:///c:/maos/src/backends/factory.ts#L120-L125)):
- `isLoopbackURL("https://inference.baseten.co/v1")` extracts hostname `"inference.baseten.co"`, which is neither `localhost`, `127.0.0.1`, nor `::1`. It returns `false`.
- The following error is thrown **verbatim**:

```
Provider "baseten" has non-loopback baseURL "https://inference.baseten.co/v1". In sovereign-local mode, all endpoints must be loopback (127.0.0.1, localhost, ::1).
```
([`src/backends/factory.ts:122-124`](file:///c:/maos/src/backends/factory.ts#L122-L124))

*(Note: In the event that a cloud provider name is specified without an explicit baseURL, line 112 throws:*
`Provider "<name>" defaults to a cloud endpoint. In sovereign-local mode, all endpoints must be loopback (127.0.0.1). Set baseURL to a local server or use ollama/lmstudio.`*)*

---

## 4. Key Architectural Takeaway for PM (Ring Integration)

1. **Dual Execution Paths**:
   - **Agent Orchestrator** (`src/core/orchestrator.ts`): Uses `RuntimeFactory.create()` and `createProvider()` in `src/backends/factory.ts`, resolving credentials from `providers.*` in `maos.config.json` and checking `sovereignLocal`.
   - **Chat Inference** (`src/service/chat-inference-service.ts`): Bypasses `RuntimeFactory` entirely. It directly executes Node `fetch()` to `http://127.0.0.1:8000/v1/chat/completions`.
2. **Implication for Ring Integration**:
   - To integrate the Ring / Baseten model with Chat, the Chat endpoint path (`ChatInferenceService`) must be updated or unified with the provider routing architecture, or configured with an explicit endpoint router that respects the shared Meta/Baseten policy.
