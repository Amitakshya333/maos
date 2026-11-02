const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../../../..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const manifestPath = path.join(repoRoot, 'artifacts', 'verification', 'agent-gui-2026-10-27', 'reset-replay-source-hashes.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tracked = manifest.files.map((entry) => entry.path).filter((file) =>
  spawnSync('git', ['cat-file', '-e', `${baseRevision}:${file}`], { cwd: repoRoot }).status === 0,
);
const result = spawnSync('git', ['diff', '--check', baseRevision, '--', ...tracked], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
const safe = (value) => value.replaceAll(repoRoot, 'C:/maos').replace(/\\/g, '/');
console.log(JSON.stringify({
  command: `git diff --check ${baseRevision} -- <${tracked.length} manifest-tracked files>`,
  trackedFileCount: tracked.length,
  exitCode: result.status,
  stdout: safe(result.stdout || ''),
  stderr: safe(result.stderr || ''),
}, null, 2));
process.exit(result.status ?? 1);
