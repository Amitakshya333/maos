"""Pinned, cache-only OpenAI-compatible runtime for the MAOS Industrial slice.

The command line is intentionally narrow because this file is part of the
release bundle.  It accepts the paths needed by Arioth to locate the user's
already-downloaded model snapshot, but it never discovers a different model,
contacts a registry, or binds outside the MAOS loopback endpoint.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any

MODEL_ID = "Qwen/Qwen2.5-3B-Instruct"
MODEL_REVISION = "aa8e72537993ba99e69dfaafa59ed015b17504d1"
MODEL_NAME = "qwen2.5-3b-instruct-local"
HOST = "127.0.0.1"
PORT = 8000
MAX_NEW_TOKENS = 1024
TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def fail(message: str, code: int = 2) -> None:
    print(f"MAOS_RUNTIME_ERROR: {message}", file=sys.stderr)
    raise SystemExit(code)


def dependency_error() -> None:
    required = ("accelerate", "fastapi", "uvicorn", "torch", "transformers")
    missing: list[str] = []
    for module in required:
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        fail("missing pinned local Python dependencies: " + ", ".join(missing))


def expected_cache_root() -> Path:
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    return hf_home / "hub" / "models--Qwen--Qwen2.5-3B-Instruct" / "snapshots"


def validate_snapshot_path(raw_path: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        fail("--model-path is required")
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute() or ".." in candidate.parts:
        fail("--model-path must be an absolute path without traversal")
    try:
        snapshot = candidate.resolve(strict=True)
        root = expected_cache_root().resolve(strict=True)
    except OSError as exc:
        fail(f"model snapshot cannot be resolved: {exc}")
    if snapshot.parent != root or snapshot.name != MODEL_REVISION:
        fail(f"model snapshot must be the pinned revision {MODEL_REVISION} under the Hugging Face cache")
    return snapshot


def verify_snapshot(snapshot: Path) -> None:
    manifest_path = Path(__file__).resolve().parent.parent / "model-snapshot-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"model snapshot manifest is unreadable: {exc}")
    if manifest.get("model") != MODEL_ID or manifest.get("revision") != MODEL_REVISION:
        fail("model snapshot manifest does not match the pinned model")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        fail("model snapshot manifest contains no files")
    for item in files:
        if not isinstance(item, dict):
            fail("model snapshot manifest contains a malformed file entry")
        relative = item.get("path")
        expected_size = item.get("size")
        expected_hash = item.get("sha256")
        if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
            fail("model snapshot manifest contains an unsafe path")
        if not isinstance(expected_size, int) or expected_size <= 0 or not isinstance(expected_hash, str):
            fail(f"model snapshot manifest entry is malformed: {relative}")
        path = (snapshot / relative).resolve()
        if path.parent != snapshot or not path.is_file():
            fail(f"model snapshot file is missing: {relative}")
        if path.stat().st_size != expected_size:
            fail(f"model snapshot size mismatch: {relative}")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest().upper() != expected_hash.upper():
            fail(f"model snapshot hash mismatch: {relative}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), required=True)
    args = parser.parse_args()
    if args.host != HOST or args.port != PORT:
        fail(f"runtime is pinned to {HOST}:{PORT}")
    return args


def build_app(snapshot: Path, device_name: str) -> Any:
    import torch
    from fastapi import FastAPI, HTTPException, Request
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if device_name == "cuda" and not torch.cuda.is_available():
        fail("CUDA was requested but is unavailable")
    device = "cuda" if device_name == "cuda" or (device_name == "auto" and torch.cuda.is_available()) else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    print(f"Loading {MODEL_ID} revision {MODEL_REVISION} from the verified local cache")
    print(f"Device: {device}; endpoint: http://{HOST}:{PORT}; offline mode: enabled")
    tokenizer = AutoTokenizer.from_pretrained(str(snapshot), local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(snapshot), local_files_only=True, torch_dtype=dtype, low_cpu_mem_usage=True
    ).to(device).eval()

    app = FastAPI(title="MAOS Local Hugging Face Runtime")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "model": MODEL_NAME, "device": device, "offline": True}

    @app.get("/v1/models")
    def list_models() -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/chat/completions")
    async def chat(request: Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except Exception as exc:
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(data, dict):
            raise HTTPException(400, "request body must be an object")
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages or any(not isinstance(item, dict) for item in messages):
            raise HTTPException(400, "messages must be a non-empty array of objects")
        if data.get("stream", False) is not False:
            raise HTTPException(400, "streaming is not supported")
        temperature = data.get("temperature", 0)
        top_p = data.get("top_p", 1)
        if temperature not in (0, 0.0) or top_p not in (1, 1.0):
            raise HTTPException(400, "MAOS requires deterministic temperature=0 and top_p=1")
        try:
            max_tokens = int(data.get("max_tokens", 768))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "max_tokens must be an integer") from exc
        if max_tokens <= 0 or max_tokens > MAX_NEW_TOKENS:
            raise HTTPException(400, f"max_tokens must be between 1 and {MAX_NEW_TOKENS}")
        tools = data.get("tools")
        if tools is not None and not isinstance(tools, list):
            raise HTTPException(400, "tools must be an array when supplied")
        try:
            prompt = tokenizer.apply_chat_template(messages, tools=tools, tokenize=False, add_generation_prompt=True)
            inputs = tokenizer(prompt, return_tensors="pt").to(device)
            with torch.inference_mode():
                output = model.generate(
                    **inputs, max_new_tokens=max_tokens, do_sample=False, top_p=1.0,
                    pad_token_id=tokenizer.eos_token_id,
                )
            generated = output[0, inputs.input_ids.shape[1]:]
            content = tokenizer.decode(generated, skip_special_tokens=False).replace("<|im_end|>", "").strip()
            tool_calls: list[dict[str, Any]] = []
            for match in TOOL_CALL_RE.finditer(content):
                parsed = json.loads(match.group(1))
                function = parsed.get("function", parsed)
                if not isinstance(function, dict) or not isinstance(function.get("name"), str):
                    raise ValueError("malformed tool call")
                arguments = function.get("arguments", {})
                tool_calls.append({
                    "id": f"call_{uuid.uuid4().hex[:12]}", "type": "function",
                    "function": {"name": function["name"], "arguments": json.dumps(arguments, separators=(",", ":"))},
                })
            if tool_calls:
                content = TOOL_CALL_RE.sub("", content).strip() or None
            prompt_tokens = int(inputs.input_ids.shape[1])
            completion_tokens = int(generated.shape[0])
            message: dict[str, Any] = {"role": "assistant", "content": content}
            if tool_calls:
                message["tool_calls"] = tool_calls
            return {
                "id": f"chatcmpl-{uuid.uuid4().hex}", "object": "chat.completion", "created": int(time.time()),
                "model": MODEL_NAME,
                "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens},
            }
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, "local generation failed") from exc

    return app


def main() -> None:
    args = parse_args()
    dependency_error()
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
    })
    snapshot = validate_snapshot_path(args.model_path)
    verify_snapshot(snapshot)
    import uvicorn
    app = build_app(snapshot, args.device)
    uvicorn.run(app, host=HOST, port=PORT, access_log=False)


if __name__ == "__main__":
    main()
