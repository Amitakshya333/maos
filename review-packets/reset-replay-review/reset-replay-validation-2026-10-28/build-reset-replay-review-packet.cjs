const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../../..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const evidenceRoot = path.resolve(__dirname, '..');
const patchPath = path.join(evidenceRoot, 'reset-replay-canonical.patch');
const manifestPath = path.join(evidenceRoot, 'reset-replay-source-hashes.json');

const tracked = [
  '.npmignore',
  'README.md',
  'package.json',
  'profiles/industrial/maos.config.json',
  'demo/industrial/PRESENTATION_SCRIPT.md',
  'demo/industrial/RUNBOOK.md',
  'src/api/middleware.ts',
  'src/api/openapi-spec.ts',
  'src/api/router.ts',
  'src/api/server.ts',
  'src/backends/anthropic-provider.ts',
  'src/backends/openai-provider.ts',
  'src/backends/provider.ts',
  'src/cli/dashboard.ts',
  'src/cli/index.ts',
  'src/core/agent-runner.ts',
  'src/domain/office-artifact.ts',
  'src/gui/src/App.tsx',
  'src/gui/src/api/adapter.ts',
  'src/gui/src/api/event-client.ts',
  'src/gui/src/api/rest-client.ts',
  'src/gui/src/components/ActivityBar.tsx',
  'src/gui/src/components/Header.tsx',
  'src/gui/src/components/NavigationSidebar.tsx',
  'src/gui/src/components/StatusBar.tsx',
  'src/gui/src/components/TelemetryReviewPanel.tsx',
  'src/gui/src/main.tsx',
  'src/gui/src/views/ApprovalsView.tsx',
  'src/gui/src/views/DocumentsView.tsx',
  'src/industrial/deterministic-reset.ts',
  'src/industrial/industrial-cli.ts',
  'src/industrial/judged-run.ts',
  'src/industrial/rust-engine-bridge.ts',
  'src/industrial/telemetry-analysis.ts',
  'src/industrial/atomic-cleanup-coordinator.ts',
  'src/integrations/tools.ts',
  'src/service/artifact-service.ts',
  'src/service/docx-generator-service.ts',
  'src/service/index.ts',
  'src/service/retention-service.ts',
  'src/service/project-service/entrypoint.ts',
  'tests/f3-05-artifact-store.test.ts',
  'tests/gui/ui1-10-evidence-retention.test.ts',
  'tests/gui/ui1-01-spa-shell.test.ts',
  'tests/gui/ui1-02-api-clients.test.ts',
  'tests/gui/ui1-04-launcher-handshake.test.ts',
  'tests/gui/ui1-24-one-project-v1-1.test.ts',
  'tests/industrial/f10-05-deterministic-reset.test.ts',
  'tests/industrial/f10-06-judged-run.test.ts',
  'tests/industrial/telemetry-analysis.test.ts',
];

const added = [
  'desktop/main.cjs',
  'desktop/package-lock.json',
  'desktop/package.json',
  'desktop/preload.cjs',
  'desktop/README.md',
  'src/domain/industrial-analysis-agent.ts',
  'src/gui/src/native.d.ts',
  'src/industrial/analysis-agent-service.ts',
  'src/industrial/entrypoint.ts',
  'src/industrial/judged-run-lock.ts',
  'tests/backends/openai-provider-local-tool-call.test.ts',
  'tests/gui/ui1-25-truthful-readiness.test.ts',
  'tests/gui/ui1-27-native-launcher-bridge.test.ts',
  'tests/industrial/analysis-agent-auth-http.test.ts',
  'tests/industrial/analysis-agent-contract.test.ts',
  'tests/industrial/analysis-agent-service.test.ts',
  'tests/industrial/judged-run-lock.test.ts',
  'tests/industrial/package-runtime-assets.test.ts',
  'tests/release/analysis-agent-browser-rehearsal.cjs',
  'tests/release/desktop-agent-deliverable-rehearsal.cjs',
  'tests/release/desktop-browser-rehearsal.cjs',
  'tests/release/run-desktop-package-rehearsals.ps1',
];

function git(args, allowedStatuses = [0]) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const chunks = [git(['diff', '--binary', '--no-ext-diff', baseRevision, '--', ...tracked])];
for (const file of added) chunks.push(git(['diff', '--no-index', '--binary', '--no-ext-diff', '--', '/dev/null', file], [1]));
const canonicalPatch = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
if (!canonicalPatch.endsWith('\n')) throw new Error('Canonical patch is not LF-terminated.');
fs.writeFileSync(patchPath, canonicalPatch, 'utf8');

const files = [...tracked, ...added].map((relativePath) => {
  const raw = fs.readFileSync(path.join(root, relativePath));
  const lf = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return {
    path: relativePath,
    rawBytes: raw.length,
    rawSha256: sha256(raw),
    lfBytes: Buffer.byteLength(lf),
    lfSha256: sha256(Buffer.from(lf, 'utf8')),
    rawEqualsLfNormalized: raw.equals(Buffer.from(lf, 'utf8')),
  };
});

const manifest = {
  schemaVersion: 1,
  baseRevision,
  patch: path.basename(patchPath),
  patchFormat: 'canonical UTF-8 with LF line endings',
  patchBytes: Buffer.byteLength(canonicalPatch),
  patchSha256: sha256(Buffer.from(canonicalPatch, 'utf8')),
  scopeCount: files.length,
  trackedCount: tracked.length,
  addedCount: added.length,
  files,
  scopeNotes: [
    'Contains the full prior candidate prerequisites plus reset/output coordination, current-acceptance idempotency replay, UNAVAILABLE contention verdict typing, and regressions.',
    'Artifact temp cleanup and retention preview purges use the shared project-output lock; the atomic cleanup coordinator no longer bypasses it for artifacts/.tmp.',
    'The reset test project now uses an isolated OS temporary directory with its own MAOS config; no test fixture depends on private repository .maos state.',
    'Excludes .maos private/local state, the checklist and evidence, product-spec proposals, submission draft, broad demo-plan/readiness prose, generated output and frozen RC archive.',
    'README and packaged RUNBOOK/PRESENTATION_SCRIPT remain included because package-runtime tests and package metadata reference them.',
  ],
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  patchPath,
  patchBytes: manifest.patchBytes,
  patchSha256: manifest.patchSha256,
  manifestPath,
  scopeCount: manifest.scopeCount,
  trackedCount: tracked.length,
  addedCount: added.length,
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
}, null, 2));
