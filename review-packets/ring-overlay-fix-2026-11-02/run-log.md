# TASK OVERLAY-FIX-01 — run log (2026-11-02)

Base: `074e1f8040c1d4a37e9d07f72485cc9473d89681` (C:/maos main HEAD, includes Day-2; verified `git rev-parse HEAD`).
Scratch: `C:/clean/ring-overlay-fix` (detached worktree at base). `npm ci` in scratch root: exit 0.
`BASETEN_API_KEY` unset throughout (verified empty: 0 bytes) — evidence-only/mocks only.
Never touched `C:/maos` except the packet dir. No commits, no pushes.

## Defect 1 — overlay NOT translucent (user cannot see through it)

Root cause (code): BOTH layers were opaque-capable-broken.
- Native: `createOverlayWindow` set `transparent: true` but omitted `backgroundColor`, so
  Electron defaulted the window background to opaque white.
- Renderer: the theme paints `html/body` with `var(--bg)` (#000, opaque) and the overlay
  panel used `rgba(18,18,18,0.88)` over that opaque page — net result visually solid.

Fix:
- `desktop/ring-overlay-host.cjs`: add `backgroundColor: '#00000000'` + `hasShadow: false`
  next to `transparent: true`, with a comment block recording the Windows support matrix.
- `src/gui/src/components/RingOverlay.tsx`: while the overlay route is mounted, force
  `html/body/#root` backgrounds to `transparent` (restored on unmount so the full view is
  unaffected); panel fill `rgba(18,18,18,0.88)` -> `rgba(18,18,18,0.72)` + 12px radius +
  hairline border so translucency is visible.

What this Windows machine actually supports (honest record):
- Windows 11 build 26300, single display (1536x864 @ 1.25x per Electron screen API),
  Electron 45. `transparent: true` frameless windows composite through DWM — expected to
  show through once the renderer paints no opaque backdrop. `vibrancy`/`blur` are
  macOS-only (no-ops on Windows — deliberately NOT set). `backgroundMaterial`
  (acrylic/mica, Win11/Electron 28+) deliberately NOT used (second system blur behind
  the CSS backdrop; per-machine variance). Packaged-build see-through was NOT verified
  by eye (no packaged install launched in this task).

## Defect 2 — overlay stuck, cannot be dragged/moved

Root cause (code): frameless window (`frame: false`) with NO `-webkit-app-region: drag`
region anywhere — nothing draggable.

Fix: overlay header is now the drag handle (`WebkitAppRegion: 'drag'`, `userSelect: none`,
`data-testid="ring-overlay-drag-region"`); the Expand button inside opts out with
`no-drag` so it stays clickable. Pure CSS region — works with a single display, no
screen API. Allow/Deny approval buttons render below the header (outside the drag
region) so they stay clickable; input + Expand verified enabled in tests.

NOT verified by eye: physical dragging needs a composited window + mouse; the packaged
build was not launched here. Verified by code + GUI test (region exists, controls
enabled and inside/outside as required).

## Defect 3 — drag-drop of PDF onto the OVERLAY does nothing

Root cause (code): the full Ring view owns a `RingAttachmentBar` dropzone; the overlay
rendered NO dropzone at all — drops had nowhere to land (silently ignored by the OS).

Fix: the overlay now embeds the SAME `RingAttachmentBar` (same classify + same
`attachmentClient` evidence-root copy path as the full view: PDF/image/CSV read locally
via FileReader->base64, `storeEvidenceFile` copies into the evidence root, then the
next send appends `csvPath:`/`documentPath:` references; local-only kinds keep their
honest chip, errors surface in `ring-overlay-attach-error` — never silent). A
`hideScreenshotButton` prop hides the bar's duplicate capture button because the overlay
already owns its memory-only screenshot row. Honest boundary preserved: CSV resolves to
the deterministic summary path; PDF/image stay local-only chips naming the missing
write route (server evidence-root write route is CSV-only) — same as the full view.

Verified by test: `turbine_inspection_scan.pdf`-named PDF through the overlay ingest
path reaches `storeEvidenceFile` with non-empty base64 and renders a chip.

## Regression / must-keep behavior (verified)

- Hotkey `Ctrl+Shift+Space`: default unchanged (`CommandOrControl+Shift+Space`,
  configurable via MAOS_RING_HOTKEY, loud failure preserved) — smoke PASS. Physical
  press from ANOTHER app could NOT be tested here (no packaged app + no OS-level key
  injection in this sandbox) — carried over as proven-working per the handoff brief.
- Expand overlay->full app same thread: untouched code path (`RING_EXPAND_KEY` handoff +
  `maos:expand-ring` IPC); existing tests still green.
- Approval Allow/Deny clickable inside overlay: buttons render outside the drag region;
  existing Allow/decision test still green.

## Validation (all in scratch C:/clean/ring-overlay-fix)

| command | exit |
|---|---|
| `npx tsc -p tsconfig.gui.json --noEmit` (typecheck:gui) | 0 |
| `npm run build` (tsc + copy-industrial-python + vite) | 0 |
| `npx vitest run tests/gui/ring-devb-surface.test.ts` (38 tests incl. 4 new) | 0 |
| `npx vitest run tests/gui/ring-devb-surface.test.ts tests/gui/ring-workspace.test.ts` (50 tests) | 0 |
| electron smoke `desktop/ring-smoke.cjs` (Electron 45, this machine) | 3 (harness FAIL — see below; 5/6 checks PASS) |

Electron smoke detail (raw JSON in `electron-smoke-raw.txt`):
- PASS multi-monitor enumerated: 1 display (single-display machine confirmed).
- PASS hotkey default is Ctrl+Shift+Space.
- PASS overlay window created; PASS overlay has bounds (400x640 @ 568,112).
- PASS frameless/translucent/always-on-top options (construction flags).
- FAIL smoke harness page load: `ERR_FAILED (-2) loading 'http://127.0.0.1:<port>/#/ring-overlay'`.
  PRE-EXISTING, not caused by this patch: stashed (pristine base) tree fails identically
  with the same ERR_FAILED. Plain-HTTP loopback loads return 200 via node fetch; the
  failure occurs inside this sandbox's Electron renderer only. Page-render-dependent
  smoke checks (route render, toggle, focus, paint) therefore report through the
  harness exit code, not as passes — recorded honestly.

## Verified by eye vs code

- By eye: NOTHING in this task. No packaged build was installed/launched; no physical
  hotkey press from another app (cannot synthesize OS-level keys from this sandbox);
  no composited-window transparency/drag/drop observation.
- By code + automated tests: all three fixes (options, CSS regions, dropzone wiring),
  hotkey registration reporting, Expand handoff, approval card click path, evidence
  copy-then-reference for the named PDF.

## Files changed (4, scratch only)

- `desktop/ring-overlay-host.cjs` — zero-alpha backgroundColor + hasShadow:false + support comment.
- `src/gui/src/components/RingOverlay.tsx` — transparent page backdrop effect, translucent
  panel, draggable header w/ no-drag Expand, embedded RingAttachmentBar (hideScreenshotButton),
  attachment suffix on send.
- `src/gui/src/components/RingAttachments.tsx` — `hideScreenshotButton` opt-out prop.
- `tests/gui/ring-devb-surface.test.ts` — 4 new tests (translucency, drag-handle DOM contract,
  overlay PDF ingest, native alpha options) + hardened toggle test.
