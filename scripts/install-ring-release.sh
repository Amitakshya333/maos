#!/usr/bin/env bash
# TASK RELEASE-CLI-01: install the Ring CLI release (Linux/macOS).
#
#   curl -fsSL <website-install-url> -o install-ring-release.sh
#   RELEASE_TARBALL_URL=<url> MAOS_ENGINE_URL=<url> bash install-ring-release.sh
#
# What it does, in order:
#   1. Checks Node.js 22+ and npm are present (fails with the exact missing piece).
#   2. npm i -g the release tarball (URL comes from RELEASE_TARBALL_URL, which
#      the website fills in; never a guessed URL).
#   3. Downloads the platform engine binary next to the installed package, at
#      the exact path the bridge expects (getDefaultEnginePath), and reports it.
#   4. SELF-CHECK: node version, engine health (engineHealth status ok), demo
#      pack present, `ring -p` brief returns CRITICAL, Python reported honestly
#      (present/missing, never fatal). Exits non-zero naming the exact failure.
set -u

RELEASE_TARBALL_URL="${RELEASE_TARBALL_URL:-__MAOS_RELEASE_TARBALL_URL__}"
MAOS_ENGINE_URL="${MAOS_ENGINE_URL:-__MAOS_ENGINE_URL__}"
# Optional: when set, the downloaded engine SHA-256 must match exactly.
MAOS_ENGINE_SHA256="${MAOS_ENGINE_SHA256:-}"
# Optional: override the demo target (default ~/maos-industrial-demo).
MAOS_DEMO_DIR="${MAOS_DEMO_DIR:-}"

fail() { echo "INSTALL FAILED: $1" >&2; exit 1; }
info() { echo "$1"; }

# --- 1. Node 22+ and npm -------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node is not on PATH (Node.js 22+ required)"
NODE_VERSION="$(node --version 2>/dev/null | tr -d 'v\r\n ')"
NODE_MAJOR="${NODE_VERSION%%.*}"
case "$NODE_MAJOR" in ''|*[!0-9]*) fail "could not parse node version from '$NODE_VERSION' (Node.js 22+ required)";; esac
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ required; found node v$NODE_VERSION"
command -v npm >/dev/null 2>&1 || fail "npm is not on PATH (required alongside Node.js 22+)"
command -v curl >/dev/null 2>&1 || fail "curl is not on PATH (required to download the tarball/engine)"
info "node v$NODE_VERSION ok; npm $(npm --version) ok"

# --- 2. Install the release tarball --------------------------------------------
case "$RELEASE_TARBALL_URL" in
  ""|*"__MAOS_RELEASE_TARBALL_URL__"*)
    fail "RELEASE_TARBALL_URL is not set (website placeholder __MAOS_RELEASE_TARBALL_URL__ was not filled in); refusing to guess a download URL" ;;
esac
npm install -g "$RELEASE_TARBALL_URL" || fail "npm install -g $RELEASE_TARBALL_URL failed"
command -v maos-industrial >/dev/null 2>&1 || fail "maos-industrial not on PATH after install (check your global npm bin dir)"

# --- 3. Place the engine where the bridge expects it -----------------------------
PKG_ROOT="$(node -p "require('path').dirname(require('path').dirname(require.resolve('maosorch/package.json')))" 2>/dev/null)" \
  || fail "could not resolve installed maosorch package root"
ENGINE_PATH="$PKG_ROOT/rust/target/release/maos-engine"
info "package root: $PKG_ROOT"
info "engine path (bridge default): $ENGINE_PATH"
case "$MAOS_ENGINE_URL" in
  ""|*"__MAOS_ENGINE_URL__"*)
    fail "MAOS_ENGINE_URL is not set (website placeholder __MAOS_ENGINE_URL__ was not filled in); refusing to guess a download URL" ;;
esac
mkdir -p "$(dirname "$ENGINE_PATH")" || fail "could not create $(dirname "$ENGINE_PATH")"
curl -fsSL "$MAOS_ENGINE_URL" -o "$ENGINE_PATH" || fail "engine download failed from MAOS_ENGINE_URL"
chmod +x "$ENGINE_PATH" || fail "could not chmod +x $ENGINE_PATH"
ENGINE_SHA="$(node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex')" "$ENGINE_PATH")"
info "engine sha256: $ENGINE_SHA"
if [ -n "$MAOS_ENGINE_SHA256" ] && [ "$ENGINE_SHA" != "$MAOS_ENGINE_SHA256" ]; then
  fail "engine SHA-256 mismatch: expected $MAOS_ENGINE_SHA256, got $ENGINE_SHA"
fi

# --- 4. SELF-CHECK ---------------------------------------------------------------
info "--- self-check ---"
CHECK_NODE="$(node --version)"
info "node version: $CHECK_NODE"

ENGINE_HEALTH="$(node -e "
const b = require(process.argv[1] + '/dist/industrial/rust-engine-bridge.js');
const m = b.verifyExecutable(b.getDefaultEnginePath(process.argv[1]));
const res = b.engineHealth(m);
if ('error' in res) { console.error('ENGINE_HEALTH_ERROR: ' + res.message); process.exit(1); }
console.log(JSON.stringify(res.data));
" "$PKG_ROOT" 2>&1)" || fail "engine health check failed: $ENGINE_HEALTH"
echo "$ENGINE_HEALTH" | grep -q '"status":"ok"' || fail "engine health not ok: $ENGINE_HEALTH"
info "engine health: $ENGINE_HEALTH"

if [ -n "$MAOS_DEMO_DIR" ]; then DEMO_ENV="MAOS_DEMO_DIR=$MAOS_DEMO_DIR "; else DEMO_ENV=""; fi
SETUP_OUT="$(sh -c "${DEMO_ENV}maos-industrial setup-demo" 2>&1)"
SETUP_RC=$?
case "$SETUP_OUT" in
  *RING_DEMO_TARGET_NOT_EMPTY*)
    info "demo pack already present (target non-empty); verifying files" ;;
  *)
    [ $SETUP_RC -eq 0 ] || fail "setup-demo failed: $SETUP_OUT"
    info "setup-demo: $SETUP_OUT" ;;
esac
DEMO_DIR="$(sh -c "${DEMO_ENV}node -e \"console.log(require('os').homedir() + '/maos-industrial-demo')\"" 2>/dev/null)"
if [ -n "$MAOS_DEMO_DIR" ]; then DEMO_DIR="$MAOS_DEMO_DIR"; fi
[ -f "$DEMO_DIR/demo/industrial/turbine_vibration_log.csv" ] \
  || fail "demo pack missing: $DEMO_DIR/demo/industrial/turbine_vibration_log.csv not found"
info "demo pack present: $DEMO_DIR"

BRIEF_OUT="$(sh -c "cd \"$DEMO_DIR\" && ${DEMO_ENV}maos-industrial ring -p \"Give me the turbine vibration brief\"" 2>&1)"
BRIEF_RC=$?
[ $BRIEF_RC -eq 0 ] || fail "ring -p brief failed (exit $BRIEF_RC): $(echo "$BRIEF_OUT" | tail -n 3)"
case "$BRIEF_OUT" in
  *CRITICAL*) info "brief verdict: CRITICAL ok" ;;
  *) fail "brief did not return CRITICAL: $(echo "$BRIEF_OUT" | tail -n 5)" ;;
esac

if command -v python3 >/dev/null 2>&1; then
  info "python: present ($(python3 --version 2>&1))"
elif command -v python >/dev/null 2>&1; then
  info "python: present ($(python --version 2>&1))"
else
  info "python: missing (optional; deterministic T-07 brief does not need it)"
fi

info "INSTALL OK: maos-industrial release installed, engine healthy, demo brief CRITICAL"
