# JS desktop unresolved license texts (staging, 2026-10-31)

All 15 desktop-graph packages are unresolved: no `desktop/node_modules`
exists locally and fetching is out of scope, so no text could be verified
against the locked versions. SPDX ids below are lockfile fields only.

| Package | Lock version | Lock license |
|---|---|---|
| @electron-internal/extract-zip | 1.0.6 | MIT |
| @electron/get | 5.1.0 | MIT |
| @types/node | 24.19.2 | MIT |
| debug | 4.4.3 | MIT |
| electron | 45.0.0 | MIT |
| env-paths | 3.0.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| ms | 2.1.3 | MIT |
| playwright | 1.64.1 | Apache-2.0 |
| playwright-core | 1.64.1 | Apache-2.0 |
| progress | 2.0.3 | MIT |
| semver | 7.8.5 | ISC |
| sumchecker | 3.0.1 | Apache-2.0 |
| undici | 7.30.1 | MIT |
| undici-types | 7.24.6 | MIT |

Close in clean room via `npm ci --prefix desktop` from the patched lockfile
followed by a license-text export (owner action).
