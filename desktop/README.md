# MAOS desktop shell

The desktop shell is a separate Electron prerequisite for the authenticated GUI. The npm package supplies its main/preload scripts and GUI assets; install Electron alongside the package, then launch the packaged shell:

```powershell
npm install --save-exact electron@45.0.0 maosorch
npx install-electron --no
npx electron node_modules/maosorch/desktop/main.cjs --project-root "C:\path\to\project"
```

For an isolated synthetic project under the system temp directory, add `--allow-temp` explicitly. Without `--project-root`, the shell opens a native folder picker.

Node.js 22.12 or newer is required to install the pinned Electron tooling; Node.js 20 or newer must be on `PATH` for the authenticated service child process. Set `MAOS_NODE_EXECUTABLE` to an explicit `node.exe` path when it is not. The shell does not enable Electron's `ELECTRON_RUN_AS_NODE` mode.

The renderer and API bind separate ephemeral ports on `127.0.0.1`; the API and event stream allow only the renderer's exact origin. The session is created by the launcher and handed to the isolated top-level renderer through private Electron IPC. It is held in memory and never placed in a URL or browser storage. The renderer requires this bridge before mounting.

This is a source/runtime shell package, not a signed desktop installer. Platform-specific installer generation, signing, and evaluator acceptance are unverified.
