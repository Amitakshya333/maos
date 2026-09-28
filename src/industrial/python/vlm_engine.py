#!/usr/bin/env python3
"""
MAOS Industrial VLM Engine

Runs the pinned Qwen2-VL model strictly from a verified local snapshot. This
adapter deliberately has no heuristic or canned-output fallback: if the
runtime, processor, weights, revision, or image cannot be loaded locally, it
exits non-zero and the TypeScript service fails closed.
"""

import argparse
import hashlib
import json
import os
import sys
from typing import Any


def fail(message: str, code: int = 1) -> "NoReturn":
    sys.stderr.write(message.replace("\n", " ")[:4000] + "\n")
    raise SystemExit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description="MAOS offline Qwen2-VL inference")
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--task-type", required=True, choices=[
        "measurement", "label-reading", "drawing-observation", "general-observation"
    ])
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-tokens", type=int, required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--source-artifact-id", required=True)
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        fail(f"Image not found: {args.image}")
    if not os.path.isdir(args.model_path):
        fail(f"Verified model snapshot is unavailable: {args.model_path}")
    if args.max_tokens < 1 or args.max_tokens > 2048:
        fail("max-tokens is outside the bounded range 1..2048")

    try:
        import torch
        from transformers import AutoProcessor, Qwen2VLForConditionalGeneration
    except Exception as exc:
        fail(f"Offline VLM runtime unavailable: {exc}")

    source_hash = hashlib.sha256()
    with open(args.image, "rb") as image_file:
        for chunk in iter(lambda: image_file.read(1024 * 1024), b""):
            source_hash.update(chunk)
    source_digest = source_hash.hexdigest()

    if args.device == "cuda" and not torch.cuda.is_available():
        fail("CUDA was requested but no local CUDA device is available")

    try:
        # local_files_only is mandatory: the air-gapped runtime must never
        # resolve missing files through a network or a cache miss download.
        device_map: Any = "auto" if args.device == "cuda" else {"": "cpu"}
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            args.model_path,
            revision=args.revision,
            local_files_only=True,
            device_map=device_map,
            torch_dtype="auto",
        )
        processor = AutoProcessor.from_pretrained(
            args.model_path,
            revision=args.revision,
            local_files_only=True,
        )
    except Exception as exc:
        fail(f"Pinned VLM snapshot could not be loaded locally: {exc}")

    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "image": args.image},
            {"type": "text", "text": args.prompt},
        ],
    }]

    try:
        prompt_text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = processor(
            text=[prompt_text],
            images=[args.image],
            padding=True,
            return_tensors="pt",
        )
        if args.device == "cuda":
            inputs = {key: value.to(model.device) if hasattr(value, "to") else value
                      for key, value in inputs.items()}
        with torch.inference_mode():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=args.max_tokens,
                do_sample=False,
            )
        input_token_count = inputs["input_ids"].shape[1]
        generated_trimmed = [
            output_ids[input_token_count:] for output_ids in generated_ids
        ]
        generated_text = processor.batch_decode(
            generated_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0].strip()
    except Exception as exc:
        fail(f"Pinned VLM inference failed: {exc}")

    if not generated_text:
        fail("Pinned VLM returned empty output")

    # The model emits an observation, not a safety verdict. Confidence is
    # intentionally conservative because the model does not provide a
    # calibrated probability; downstream conflict review remains mandatory.
    result = {
        "schemaVersion": 1,
        "sourceArtifactId": args.source_artifact_id,
        "sourceHash": source_digest,
        "modelId": args.model_id,
        "modelRevision": args.revision,
        "device": args.device,
        "taskType": args.task_type,
        "prompt": args.prompt,
        "observations": [{
            "schemaVersion": 1,
            "id": f"obs_{source_digest[:16]}_1",
            "sourceArtifactId": args.source_artifact_id,
            "sourceHash": source_digest,
            "modelId": args.model_id,
            "modelRevision": args.revision,
            "observationType": f"visual_{args.task_type}",
            "value": generated_text,
            "confidence": 0.5,
            "warnings": [
                "Uncalibrated VLM observation; independent human review is mandatory"
            ],
            "requiresReview": True,
        }],
        "warnings": ["VLM output is an observation and not a safety verdict"],
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    temporary_output = args.output + ".tmp"
    with open(temporary_output, "w", encoding="utf-8") as output_file:
        json.dump(result, output_file, indent=2, ensure_ascii=False)
        output_file.flush()
        os.fsync(output_file.fileno())
    os.replace(temporary_output, args.output)
    print(json.dumps({"ok": True, "observationsCount": 1}))


if __name__ == "__main__":
    main()
