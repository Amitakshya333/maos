#!/usr/bin/env bash
# MAOS Industrial — Pinned Sandbox Container Build Script (F8-01)
# Enforces reproducible build flags and saves the offline archive.

set -euo pipefail

IMAGE_NAME="maos-sandbox-runner:0.3.0-industrial"
ARCHIVE_PATH="offline-stores/sandbox-image/image.tar"

echo "=== Building MAOS Industrial Sandbox Container ==="
DOCKER_BUILDKIT=1 docker build \
  --tag "${IMAGE_NAME}" \
  --file industrial/container/Dockerfile \
  industrial/container/

echo "=== Exporting Offline Container Archive ==="
mkdir -p offline-stores/sandbox-image
docker save "${IMAGE_NAME}" -o "${ARCHIVE_PATH}"

echo "=== Inspecting Pinned Digest ==="
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}" 2>/dev/null || docker inspect --format='{{.Id}}' "${IMAGE_NAME}")
echo "Image Digest: ${IMAGE_DIGEST}"

PINNED_DIGEST=$(grep -o '"imageDigest": *"[^"]*"' industrial/container/sandbox-manifest.json | cut -d'"' -f4)
if [ -z "${PINNED_DIGEST}" ]; then
  echo "ERROR: Unable to extract imageDigest from industrial/container/sandbox-manifest.json" >&2
  exit 1
fi

echo "Pinned Manifest Digest: ${PINNED_DIGEST}"
if [ "${IMAGE_DIGEST}" != "${PINNED_DIGEST}" ]; then
  echo "ERROR: Built image digest '${IMAGE_DIGEST}' does not match pinned manifest digest '${PINNED_DIGEST}'" >&2
  exit 1
fi

echo "Digest verification passed: ${IMAGE_DIGEST}"
echo "Archive saved to ${ARCHIVE_PATH}"
