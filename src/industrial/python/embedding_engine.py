#!/usr/bin/env python3
"""
MAOS Industrial Embedding Engine (F5-03)

Runs the pinned sentence-transformers/all-MiniLM-L6-v2 CPU embedding model
strictly from a verified local snapshot.

Invariants:
1. Air-Gapped: local_files_only=True is mandatory; runtime downloads are prohibited.
2. Verified Assets: if weights, tokenizer, or configuration cannot be loaded locally,
   it exits non-zero and the TypeScript service fails closed.
3. Strict Output: returns normalized 384-dimensional finite float vectors.
"""

import argparse
import json
import math
import os
import sys
from typing import List, NoReturn


def fail(message: str, code: int = 1) -> NoReturn:
    sys.stderr.write(message.replace("\n", " ")[:4000] + "\n")
    raise SystemExit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description="MAOS offline CPU embedding inference")
    parser.add_argument("--input", required=True, help="Path to input JSON file containing texts")
    parser.add_argument("--output", required=True, help="Path to output JSON file for embeddings")
    parser.add_argument("--model-path", required=True, help="Path to local snapshot directory")
    parser.add_argument("--revision", required=True, help="Expected model revision")
    parser.add_argument("--dimension", type=int, default=384, help="Expected embedding dimension")
    parser.add_argument("--device", default="cpu", choices=["cpu"])
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        fail(f"Input file not found: {args.input}")
    if not os.path.isdir(args.model_path):
        fail(f"Verified model snapshot is unavailable: {args.model_path}")

    # Read input texts
    try:
        with open(args.input, "r", encoding="utf-8") as f:
            input_data = json.load(f)
    except Exception as exc:
        fail(f"Failed to read input JSON: {exc}")

    if not isinstance(input_data, list) or len(input_data) == 0:
        fail("Input JSON must be a non-empty array of strings or objects with 'text' property")

    texts: List[str] = []
    for item in input_data:
        if isinstance(item, str):
            texts.append(item)
        elif isinstance(item, dict) and "text" in item and isinstance(item["text"], str):
            texts.append(item["text"])
        else:
            fail("Invalid input item: must be string or object with 'text'")

    # Load offline transformer / sentence-transformers
    try:
        import torch
        from transformers import AutoTokenizer, AutoModel
    except Exception as exc:
        fail(f"Offline embedding runtime unavailable: {exc}")

    try:
        tokenizer = AutoTokenizer.from_pretrained(
            args.model_path,
            revision=args.revision,
            local_files_only=True,
        )
        model = AutoModel.from_pretrained(
            args.model_path,
            revision=args.revision,
            local_files_only=True,
        )
        model.to("cpu")
        model.eval()
    except Exception as exc:
        fail(f"Pinned embedding snapshot could not be loaded locally: {exc}")

    # Tokenize and compute mean-pooled normalized embeddings
    try:
        encoded_input = tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=256,
            return_tensors="pt",
        )
        with torch.no_grad():
            model_output = model(**encoded_input)
            # Mean pooling with attention mask
            token_embeddings = model_output[0]  # First element of model_output contains all token embeddings
            input_mask_expanded = encoded_input["attention_mask"].unsqueeze(-1).expand(token_embeddings.size()).float()
            sum_embeddings = torch.sum(token_embeddings * input_mask_expanded, 1)
            sum_mask = torch.clamp(input_mask_expanded.sum(1), min=1e-9)
            pooled = sum_embeddings / sum_mask
            # Normalize embeddings to unit length
            normalized = torch.nn.functional.normalize(pooled, p=2, dim=1)
            vectors = normalized.tolist()
    except Exception as exc:
        fail(f"Inference failed during embedding generation: {exc}")

    # Validate vectors
    for idx, vec in enumerate(vectors):
        if len(vec) != args.dimension:
            fail(f"Vector at index {idx} dimension mismatch: expected {args.dimension}, got {len(vec)}")
        for val in vec:
            if math.isnan(val) or math.isinf(val):
                fail(f"Vector at index {idx} contains non-finite value: {val}")

    # Write output JSON atomically
    output_obj = {
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": args.revision,
        "dimension": args.dimension,
        "count": len(vectors),
        "vectors": vectors,
    }

    try:
        temp_output = f"{args.output}.tmp_{os.getpid()}"
        with open(temp_output, "w", encoding="utf-8") as f:
            json.dump(output_obj, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_output, args.output)
    except Exception as exc:
        fail(f"Failed to write output JSON: {exc}")


if __name__ == "__main__":
    main()
