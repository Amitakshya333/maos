# JS root license-text coverage (staging, 2026-10-31 — PARTIAL)

Method: snapshot `package-lock.json` (252 `node_modules/` entries) compared
against the pre-existing local `C:\maos\node_modules` — no installs, no
fetches. A text was copied only when the installed `package.json` version
exactly equalled the locked version, via byte-copy (`fs.copyFileSync`) to
`js-root/<package>__<LICENSE-FILE>` (`/` → `__`).

## Result

- 182 packages matched (version equality, zero mismatches where installed);
  **183 license texts copied**.
- Fidelity spot-check: `typescript/LICENSE.txt` staged SHA-256 equals the
  installed file's SHA-256 (`match:True`).
- 70 entries unresolved — full table in `js-root-unresolved.md`:
  - 60 `not-installed-locally`: none are nested-transitive paths; all are
    top-level packages the local install skipped (optional/platform-specific
    entries, e.g. non-Windows native bindings). No local material exists, so
    no text could be verified.
  - 10 `no-license-file-installed`: version-matched installs shipping no
    LICENSE file (`@esbuild/win32-x64`, `@rollup/rollup-win32-x64-*` (2),
    `@simple-git/*` (2), `emoji-regex`, `jsesc`, `simple-git`, `stackback`,
    `standardwebhooks`). SPDX ids (all MIT) remain in
    `js-root-lock-inventory.md`; texts need clean-room Fallsbacks (upstream
    tarballs) or owner-supplied copies.

Desktop graph (`js-desktop-lock-inventory.md`, 15 packages incl. electron
45.0.0 and playwright-core 1.64.1) has no local `desktop/node_modules` at
all — see `js-desktop-unresolved.md`. No JS notice set may be called
complete until the unresolved files are empty.
