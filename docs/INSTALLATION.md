# Reproducible Windows Industrial installation

## Supported install path

Use the Windows bootstrap bundle. It carries the built npm tarball, the exact application `package-lock.json`, the desktop lockfile inside the tarball, an install script, and an input-hash manifest. The script extracts the tarball and runs `npm ci` separately for the application and Electron shell. It does not resolve dependency ranges with `npm install`.

Build an install bundle from a clean source checkout after `npm ci` and `npm run build`:

```powershell
npm pack --ignore-scripts --pack-destination .\out
$deltaSha = (Get-FileHash .\out\install-reliability.patch -Algorithm SHA256).Hash.ToLowerInvariant()
.\scripts\New-MaosIndustrialInstallBundle.ps1 `
  -PackageArchive (Get-Item .\out\maosorch-*.tgz).FullName `
  -SourceRevision (git rev-parse HEAD) `
  -SourceDeltaSha256 $deltaSha `
  -OutputBundle .\out\maos-industrial-windows-x64.zip
```

Install from an empty destination directory:

```powershell
Expand-Archive .\maos-industrial-windows-x64.zip -DestinationPath .\maos-installer
.\maos-installer\Install-MaosIndustrial.ps1 `
  -BundleRoot .\maos-installer `
  -InstallRoot "$env:LOCALAPPDATA\Programs\MAOS-Industrial"
```

The install directory must be empty. The script verifies the package archive, lockfile, desktop lockfile, and installer against the bundle manifest before running install commands. Application and Electron package versions come from their committed lockfiles. After installing the pinned Electron npm package, the bootstrap explicitly runs that package's `install.js` helper to fetch Electron 45 for Windows x64. It uses the checksum data shipped in the pinned npm package by default; a configured Electron mirror is honored. The installer does not disable TLS validation. The bootstrap therefore needs network access to the npm registry and configured Electron binary host.

`npm ci` executes dependency lifecycle scripts such as `preinstall`, `install`, and `postinstall` (and applicable root lifecycle scripts). They run with the invoking user's permissions and inherited environment and may access the network. The installer separately invokes the pinned Electron package's runtime-download helper. Lockfiles pin dependency resolution and package integrity, but they do not sandbox lifecycle scripts or make those scripts inherently trustworthy. Run installation in a dedicated, least-privilege environment that does not contain unrelated credentials or secrets.

## Runtime prerequisites and use

- Windows x64, Windows PowerShell 5.1 or newer, Node.js 22.12 or newer, and npm 9 or newer are required for this bootstrap. Node.js 22.12 is required by the pinned Electron install dependency; the app's package metadata alone only requires Node.js 20.
- Node.js 20 or newer must remain available on `PATH` for the authenticated desktop service child process. Set `MAOS_NODE_EXECUTABLE` to an explicit `node.exe` if it is not discoverable.
- Python is not installed by this bootstrap. The Industrial runbook documents Python `>=3.10` for workflow-dependent OCR, embedding, data-script and selected sandbox tasks, and says the deterministic T-07 flow does not invoke Python. Current `maos industrial preflight` nevertheless requires a Python interpreter to be present; it displays a default minimum of `3.9` when none is configured but does not compare the detected version. Treat the preflight/runbook mismatch as unresolved. Docker/Podman is optional unless `requireDocker=true`; Tesseract is optional unless `requireOcr=true`.
- Run the installed CLI with `node.exe app\dist\cli\index.js ...` and the Industrial CLI with `node.exe app\dist\industrial\entrypoint.js ...`. These are the packaged npm `bin` entrypoints; `npm ci` installs the application graph in place and does not create self-package `.bin` shims. Launch Electron from `app\desktop\node_modules\electron\dist\electron.exe` with `app\desktop\main.cjs`.
- The installer checks npm archive entries, dependency paths from both pinned lockfiles, and the Electron executable path before accessing the destination. It refuses projected paths of 240 characters or more; choose a short destination such as `C:\MAOS`. Windows long-path support varies by Node, npm, native modules, and dependency scripts, so longer paths are unsupported even on systems configured for extended paths.
- The Rust Industrial engine is a separate, required project prerequisite for the Industrial profile. The npm tarball and bootstrap do not include it. Place the platform-matched release binary at `<project-root>\rust\target\release\maos-engine.exe`. From a source checkout, build with `cargo build --release --locked --manifest-path rust/Cargo.toml`, then copy `rust\target\release\maos-engine.exe` into that project path. No automatic download or engine substitution occurs.
- For an Industrial project, `maos doctor` invokes the engine's bounded `health` operation and requires engine name `maos-industrial-engine`, version `0.1.0`, protocol `1.0`, status `ok`, and `unsafe_code=false`. `maos industrial preflight` performs the supported engine readiness checks as well.

The Rust source crate declares MIT. The repository contains dependency license files, but this candidate does not include the engine binary in its npm or bootstrap package while third-party notice coverage and redistribution approval remain unresolved. A captured SHA-256 and candidate manifest establish file identity only; they do not prove publisher authenticity or trust.
The candidate engine was built with Cargo/rustc `1.95.0`; the repository does not pin that toolchain, so this build record is not a reproducible toolchain lock.

## Distribution limits

The `.zip` is a dependency bootstrap bundle, not a portable or self-contained installer. It does not bundle Node.js, the Rust engine, Python runtimes/models, signing, or publisher attestation. A regular consumer `npm install maosorch` still uses semver ranges and is not the reproducible install method. The bootstrap is the supported reproducible route for this candidate. Live Meta compatibility and submission readiness are separate gates.
