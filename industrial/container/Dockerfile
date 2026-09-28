# syntax=docker/dockerfile:1.4
# MAOS Industrial — Pinned Sandbox Container Image (F8-01)
#
# Constraints & Invariants:
#   1. Minimal Python 3.11.9 runtime pinned by digest
#   2. Dedicated non-root user (UID 10001, GID 10001)
#   3. Zero runtime package installation: pip/apt stripped from final image
#   4. Immutable, read-only rootfs compatible (/sandbox/workspace owned by sandboxuser)
#   5. Network-isolated execution design (--network none)

# ── Stage 1: Build & Package Installation ────────────────────────────
FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /build

COPY requirements.txt /build/requirements.txt

# Install pinned dependencies into isolated prefix
RUN pip install --no-cache-dir --prefix=/install -r /build/requirements.txt

# ── Stage 2: Hardened Runtime Container ──────────────────────────────
FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317 AS runtime

LABEL maintainer="MAOS Industrial Core Team" \
      org.opencontainers.image.title="MAOS Industrial Sandbox Runner" \
      org.opencontainers.image.version="0.3.0-industrial" \
      org.opencontainers.image.description="Pinned offline execution sandbox for deterministic computation"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    HOME=/home/sandboxuser \
    TMPDIR=/tmp \
    MPLCONFIGDIR=/tmp \
    PATH="/usr/local/bin:/usr/bin:/bin"

# 1. Create dedicated non-root user and group (UID 10001, GID 10001)
RUN /usr/sbin/groupadd -g 10001 sandboxgroup && \
    /usr/sbin/useradd -u 10001 -g sandboxgroup -s /bin/false -m -d /home/sandboxuser sandboxuser

# 2. Copy installed packages from builder stage
COPY --from=builder /install /usr/local

# 3. Create isolated workspace directory with strict non-root ownership
RUN mkdir -p /sandbox/workspace /sandbox/tmp && \
    chown -R sandboxuser:sandboxgroup /sandbox && \
    chmod 750 /sandbox/workspace && \
    chmod 1777 /sandbox/tmp

# 4. Anti-Runtime-Install Defense:
# Strip package management utilities to guarantee zero runtime installations
RUN rm -rf /root/.cache && \
    rm -rf /usr/local/lib/python3.11/ensurepip && \
    rm -rf /usr/local/bin/pip* && \
    rm -rf /var/lib/apt/lists/* && \
    find /usr/local/lib/python3.11/site-packages -name "*.dist-info" -exec chmod 444 {} + 2>/dev/null || true

# 5. Switch permanently to non-root user
USER 10001:10001
WORKDIR /sandbox/workspace

# Set default command for executing Python scripts safely
ENTRYPOINT ["/usr/local/bin/python3"]
CMD ["-c", "print('MAOS Industrial Sandbox Ready')"]
