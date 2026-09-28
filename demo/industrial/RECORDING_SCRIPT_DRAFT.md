# MAOS Industrial — Honest Recording Script (Draft)

**Do not record this as the final judged journey yet.** This draft shows the
parts verified on 2026-09-27. The full evidence → human approval → deliverable →
audit journey still needs a fresh live rehearsal; see
[`RECORDING_READINESS.md`](./RECORDING_READINESS.md).

## Setup before capture

Use two PowerShell terminals. Do not start `industrial start` alongside the
dashboard; both use port 3847.

**Terminal 1 — local model:**

```powershell
cd C:\maos
$modelPath = Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--Qwen--Qwen2.5-3B-Instruct\snapshots\aa8e72537993ba99e69dfaafa59ed015b17504d1"
python .\scripts\huggingface-openai-server.py --host 127.0.0.1 --port 8000 --model-path $modelPath --device cuda
```

Wait for `Uvicorn running on http://127.0.0.1:8000`.

**Terminal 2 — MAOS dashboard/API:**

```powershell
cd C:\maos
node .\dist\cli\index.js dashboard
```

Open `http://127.0.0.1:3847`. The production build must already be current:

```powershell
npm run build
```

## Draft talk track (about 2 minutes)

### 0:00 — What MAOS is

> “MAOS Industrial is a local-first workbench for handling confidential
> industrial workflows. I’ll show the local model path and the evidence
> boundary. I will distinguish model-generated suggestions from claims that
> have actually been tied to source evidence.”

### 0:20 — Verify the runtime, not just the UI

In a terminal, run:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3847/api/v1/models/active | ConvertTo-Json -Depth 5
```

> “The pinned Qwen2.5-3B-Instruct snapshot is running on CUDA from the local
> cache. This confirms the model process and identity; it is not a claim that
> every model in the application uses the GPU.”

### 0:50 — Show local chat and the citation warning

In Chat, ask a simple non-operational question. When the answer appears, point
out its unverified badge:

> “This is a local model response. MAOS does not call it verified evidence just
> because it sounds plausible. No source citation was attached to this plain
> chat turn, so it remains unverified and must not be used as an industrial
> finding.”

Do not imply that ordinary chat performs Knowledge retrieval or cryptographic
citation verification.

### 1:25 — Show service status carefully

Optionally show:

```powershell
Invoke-RestMethod http://127.0.0.1:3847/api/v1/chat/health | ConvertTo-Json
```

> “The MAOS API can reach the local model. The chat path is working; the
> complete operator-approved evidence workflow is a separate acceptance check
> and is not being claimed as passed in this recording.”

### 1:45 — Boundary wording

If showing Industrial preflight, explain its actual scope:

> “This preflight checks MAOS’s process-scoped boundary. It does not change or
> verify Windows Firewall settings, and it does not prove that the entire
> workstation is disconnected from the internet.”

### 2:00 — Close

> “Today’s verified slice is the local CUDA model, the MAOS chat API, and the
> dashboard health/data endpoints. The remaining recording gate is a fresh
> human-approved run with source citations, output verification, and audit-chain
> verification.”

## Do not show or claim yet

- Do not present Code, Terminal, Findings, or Drawing as finished GUI features;
  those screens are marked Preview.
- Do not present persisted dashboard logs or the existing report as output from a
  just-completed run.
- Do not claim zero network use by the whole computer, Windows Firewall
  enforcement, certified industrial safety, or GPU use by every model.
- Do not use `--auto-approve --yes` for an approval-gate demonstration. A human
  should review and approve the real pending item during the final rehearsal.
