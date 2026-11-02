# Focused installation correction handoff

Review only the final installation/Git-context correction. The independent review is pending; no commit or release approval is claimed.

## Findings addressed

1. **Git discovery could leak an ancestor repository into doctor/REPL output.** Added `src/utils/project-git-context.ts`, a shared resolver that uses the explicit selected project root, clears inherited `GIT_*` overrides, identifies the top-level repository before branch/status calls, and returns no repository for a nested non-repository project. It supports normal repositories and worktrees (`.git` file). Doctor, generic REPL, and their direct composition/call paths use it. Tests create only disposable synthetic repositories; no user-profile repository was used.
2. **Installation documentation understated dependency-script trust.** `docs/INSTALLATION.md` now states that `npm ci` runs lifecycle scripts with the invoking user's permissions and inherited environment, scripts may use the network, the installer explicitly downloads the pinned Electron runtime, and a lockfile does not sandbox or make scripts inherently trustworthy. It recommends a dedicated least-privilege environment without unrelated secrets.
3. **The prior review packet had conflicting candidate/reconstruction records.** Preserved all historical packets and outputs. This packet names one current authoritative complete patch/manifest and one correction-only patch/manifest with their exact bases and hashes; it records isolated reconstruction and distinguishes final6 cold- and warm-cache installations.

## Validation evidence

- Base: `189e786ff0431b02b95ca618bb4791a5ad7b0215`; current live root `C:\maos`, branch `main`; index empty.
- Complete 17-file patch SHA-256: `ea2ffa2c90cb571add1cab5d3b9f5b26ec2d44b30b0cadbfd621a852304903bb`; complete manifest SHA-256: `1d32ed58087d030a85d9e637c43bbb569f72ea4d102b02091c868aedb0a8edfd`.
- Correction-only 8-file patch SHA-256: `0cf67fa1e66338e0f1116ba392c3485f115031fb02894bb2aee84104030695f4`; correction manifest SHA-256: `632deb5cf1ea909cb28c0c3d3cf219a70e9b8eb42bddb02fc1f99002481bce7b`. Its parent is the source snapshot made from predecessor patch `f2edd4658fcdba9716050d2a377ed941498300177656f3ff91a77e45fdd4b3e5` plus manifest `771081758b5747aeabd21f040ac98d75ecaea7c18db794883acefa9570955e75`.
- Live source check: full manifest 17/17 raw and LF hashes; correction manifest 8/8 raw and LF hashes. Both patches passed isolated apply/check. Applied results match all 17 scoped files after LF normalization; raw-byte differences are limited to line endings in `README.md` and `src/cli/index.ts`.
- Focused command: `vitest run tests/cli/project-git-context.test.ts tests/cli/doctor.test.ts tests/cli/meta-provider-entrypoints.test.ts tests/industrial/package-runtime-assets.test.ts` — 4 files, 23 passed, exit 0.
- `npm run build` — exit 0 (existing Vite 515.99 kB chunk warning). `npm run typecheck:gui` — exit 0. `cargo build --release --locked --offline --manifest-path rust/Cargo.toml` — exit 0; Rust source unchanged. PowerShell installer AST parse passed.
- Exact final6 bootstrap SHA-256 `e453b0b230d4919ec181d02fa5d8f0131231a2e5530005c7259d495ee88ed785` (1,256,171 bytes), package SHA-256 `50b41f02d928404b10ef5f2a8c8f02118c8c24046db9da008356966ccc17f768` (1,224,098 bytes). Bundle contents: 497 npm entries; 19/19 required assets; no credential-pattern files, forbidden paths, or bundled Rust executable.
- The exact final6 ZIP passed installation from empty isolated npm/Electron caches into a fresh path with spaces. Its first combined smoke exposed a BOM in the synthetic test config; the application correctly rejected that fixture. After writing the same synthetic config as UTF-8 without BOM, the installed smoke passed. The same exact ZIP also passed a separate fresh install with pre-populated isolated caches. Both tested an over-limit projected path refusal before destination writes.
- Installed checks passed: CLI version, Industrial help, actionable nonzero missing-config doctor, no parent/redirect Git branch for a nested project under hostile Git environment, Electron `45.0.0` discovery/version, and generic `maos repl` in the packaged app against the synthetic child project (exit 0, no parent branch, empty stderr). Separately supplying the candidate external engine made installed doctor pass. GUI workflow was not launched; no live inference occurred.
- A candidate external engine was built offline from the declared source: `maos-industrial-engine` `0.1.0`, protocol `1.0`, binary hash `3e2ac50a676d6da67807d55544702523bac46d9656c4df43690b52515b3b7f77`. It is not bundled, signed, compared to an approved manifest, or cleared for redistribution.

Exact commands/results are listed in [`COMMANDS_AND_RESULTS.md`](COMMANDS_AND_RESULTS.md); hashes, reconstruction, package scans, cold/warm installation records, superseded candidates, and prior incident context are indexed in [`AUTHORITATIVE_EVIDENCE_INDEX.md`](AUTHORITATIVE_EVIDENCE_INDEX.md). Do not treat older `artifacts-final*` folders as current: final6 is the only bundle tied to the authoritative delta hash above. The prior `package-clean-install` handoff concerns a separate earlier package. The accidental root `npm ci` and possible default Electron user-data write remain as documented in that historical handoff; neither location was inspected or cleaned by this correction.

## Remaining limits

The installer is a lockfile-based bootstrap, not a self-contained installer. It needs Node/npm/PowerShell and network access; lifecycle scripts are not sandboxed. Rust and Python remain external prerequisites. The external engine candidate is unsigned/unapproved. This work does not establish GUI journey, live-model/Meta, signed distribution, production readiness, or submission readiness.

## Request

Please independently review the Git-context resolver and all direct doctor/REPL call paths, the deterministic parent/child/normal/worktree/environment/space tests, the installer trust documentation, and the source/patch/evidence provenance. Confirm that final6 is the only authoritative bundle and keep live-model, GUI, packaging/release, signing, licensing, and submission approvals separate.
