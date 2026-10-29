# MAOS Industrial desktop installation

For a reproducible Windows install, use the lockfile bootstrap bundle described in [`docs/INSTALLATION.md`](../docs/INSTALLATION.md). A plain `npm install maosorch` still follows the package's semver dependency ranges and is not the supported reproducible install path.

The bootstrap requires Windows PowerShell 5.1, Node.js 22.12 or newer, npm, and network access to the npm registry and Electron's pinned binary host. It runs `npm ci` from the application lockfile and the packaged desktop lockfile. Electron 45.0.0 is a runtime dependency; Playwright remains a development-only dependency.

The Rust Industrial engine is a separate required prerequisite for Industrial projects. It is not in the npm tarball or bootstrap bundle. It must be supplied or built for the target platform, then placed at `<project-root>\rust\target\release\maos-engine.exe` on Windows (without `.exe` on Unix). `maos doctor` checks the Industrial engine's version, protocol, identity, and unsafe-code flag before reporting readiness. It does not install or download the engine.

The renderer and API bind separate ephemeral ports on `127.0.0.1`; the API and event stream allow only the renderer's exact origin. The session is created by the launcher and handed to the isolated top-level renderer through private Electron IPC. It is held in memory and never placed in a URL or browser storage.

This bootstrap is not a signed installer. Its local SHA-256 manifest detects mismatched inputs but does not attest a publisher. Platform-specific signing and evaluator acceptance remain unverified.
