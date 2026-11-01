# MAOS Core and Industrial Repository Separation Plan (PROPOSED)

**Status:** PROPOSED. No repository split, package publication, history rewrite, or licensing conclusion is authorized or represented by this document.

## Target boundary

Package a stable, versioned MAOS Core API for shared orchestration, providers, project/session services, policy, approvals, artifacts, and audit. Move Industrial workflows and the `maos-industrial` product surface into a separate repository that consumes a pinned Core version. Core must not depend on Industrial; Industrial-specific rules and data stay outside Core unless they prove broadly reusable and are reviewed separately.

Candidate package identity such as `@maos/core` is illustrative and must be checked for ownership, naming, and publication policy before adoption. This plan does not publish a package or create a repository.

## History and provenance options

| Option | History behavior | Advantages | Costs and risks |
|---|---|---|---|
| Curated subtree split | Retain ancestry for selected paths where commits can be cleanly separated | Useful provenance for separable shared modules; familiar Git history | Existing commits mix Core and Industrial changes, so extraction boundaries may be incomplete or noisy. |
| History rewrite/filter | Rewrite commits to retain selected paths and remove unrelated files | More focused destination history | Commit IDs change; review, signatures, references, and author attribution need mapping and explanation. |
| Fresh repository plus provenance manifest | Start a new history at the reviewed snapshot; record source repository, revision, path/blob hashes, and license notices | Simplest boundary and reproducible origin record | Does not preserve per-file commit history in the destination; source references must remain accessible. |

Before selecting an option, capture the source remote/revision, dirty-tree state, relevant file list, and authorship/ownership records. Never include `.maos` state, credentials, machine-local files, generated outputs, or unreviewed fixtures in the split. Preserve source snapshots read-only until the new repository passes migration checks.

## Licence and disclosure review

The current root `LICENSE` is MIT. Before extraction, inventory all source files, copied snippets, fixtures, documentation, desktop assets, generated artifacts, and transitive dependencies. Preserve required notices and attribution; confirm inbound contribution terms and outbound license choice with the project owner. A repository-root license alone does not prove that every included asset or dependency has the same terms.

Hackathon disclosure obligations are **unverified**. Public event materials did not expose the selected-participant rules or final form. Before any submission, inspect the participant-accessible official rules and form for prior-code disclosure, third-party code/assets, AI-assisted work, licensing, ownership, and required provenance links. Do not claim that disclosure is or is not required until the actual rule text is available.

## Migration sequence

1. Freeze the RC evidence and record a source revision plus a clean, reviewed file inventory.
2. Define Core's public exports and dependency direction. Keep private implementation modules private; remove accidental Industrial imports from Core.
3. Create the versioned package build and compatibility policy. Do not publish yet; consume it through a temporary local package/tarball.
4. Move Industrial CLI, judged-run workflow, product profile, fixtures, and GUI integration into a consumer test repository or isolated migration branch.
5. Run Core unit/contract tests from its own package; then install the package into a clean Industrial consumer and verify imports, types, runtime assets, audit engine prerequisite, and platform behavior.
6. Replay synthetic run → approval/rejection → report/download → exact-run audit verification; confirm stale source/rules/policy changes invalidate approvals.
7. Run authenticated GUI flows against the consumer package, including reload/resume, failure honesty, artifact linkage, wrong project/session/origin rejection, and navigation regression.
8. Validate supported Node/OS versions, lockfiles, dependency licenses, provenance manifest, SBOM, notices, and reproducible build hashes.
9. Compare old and migrated behavior and inspect the entire diff. Only after owner approval should a repository be created, a package published, or a migration declared complete.

## Migration test plan

- **API compatibility:** TypeScript/public export tests, supported-version matrix, semver break tests, and clean consumer compile.
- **Runtime packaging:** Clean install from a generated package; verify assets and actionable failures for the separately installed Rust engine; do not imply that the Rust executable is bundled.
- **Workflow parity:** Same synthetic fixture, run identity, status, expected engineering verdict, artifacts, audit export, and exact-ID verification before and after migration.
- **Security:** Session/project/origin boundaries, data-policy enforcement, credential redaction, path containment, and no cross-project resume.
- **GUI:** Installed consumer app with the supported private-IPC launcher, navigation inventory, refresh/resume, stale approval rejection, and truthful failure/download states.
- **Provenance/licensing:** Source revision and content hashes reconcile to the selected history strategy; license/notice scan is clean; no private `.maos` state or credentials enter either repository.

## Current code to reuse

Core candidates include `src/core/`, `src/domain/`, `src/backends/`, `src/api/`, `src/service/`, and the shared portions of `src/cli/`. Industrial candidates include `src/industrial/`, `profiles/industrial/`, `demo/industrial/`, Industrial API routes, `src/gui/src/views/`, `desktop/`, and their tests. Several files currently mix concerns, particularly `src/cli/index.ts`, `src/api/router.ts`, and shared GUI routes; extraction boundaries must be decided from import/dependency evidence rather than folder names alone.
