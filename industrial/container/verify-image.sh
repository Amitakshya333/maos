#!/usr/bin/env bash
# MAOS Industrial — Pinned Sandbox Container Verification Script (F8-01)
# Executes the smoke-test.py script within the loaded container with strict sandbox flags.

set -euo pipefail

IMAGE_NAME="maos-sandbox-runner:0.3.0-industrial"
ARCHIVE_PATH="offline-stores/sandbox-image/image.tar"

if [ -f "${ARCHIVE_PATH}" ]; then
  echo "=== Loading Offline Container Archive ==="
  docker load -i "${ARCHIVE_PATH}"
fi

echo "=== Executing Hardened Smoke Test ==="
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 1024m \
  --cpus 1.0 \
  --pids-limit 32 \
  --tmpfs /sandbox/tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$(pwd)/industrial/container/smoke-test.py:/sandbox/workspace/smoke-test.py:ro" \
  "${IMAGE_NAME}" \
  /sandbox/workspace/smoke-test.py

echo "=== Verification Succeeded ==="
