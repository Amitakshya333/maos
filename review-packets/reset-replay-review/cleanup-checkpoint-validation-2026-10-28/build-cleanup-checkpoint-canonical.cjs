const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const packetDir = path.resolve(__dirname, '..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const patchPath = path.join(packetDir, 'cleanup-checkpoint-canonical.patch');
const manifestPath = path.join(packetDir, 'cleanup-checkpoint-canonical-source-hashes.json');
const excludedTracked = new Set([
  '.maos/maos.config.json',
  '.maos/pool.json',
  'demo/industrial/MASTER_DEMO_PLAN.md',
  'demo/industrial/RECORDING_READINESS.md',
]);

function git(args, cwd = root, allowedStatuses = [0]) {
  const result = spawnSync('git', args, { cwd, encoding: null, maxBuffer: 96 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const actualBase = git(['rev-parse', baseRevision]).toString('utf8').trim();
if (actualBase !== baseRevision) throw new Error(`Unexpected base revision: ${actualBase}`);

const changedTracked = git(['diff', '--name-only', baseRevision, '--'])
  .toString('utf8').trim().split(/\r?\n/).filter(Boolean).sort();
const tracked = changedTracked.filter((file) => !excludedTracked.has(file));
const unexpectedTracked = changedTracked.filter((file) => !tracked.includes(file) && !excludedTracked.has(file));
if (unexpectedTracked.length) throw new Error(`Unclassified tracked paths: ${unexpectedTracked.join(', ')}`);

const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .toString('utf8').trim().split(/\r?\n/).filter(Boolean).sort();
const added = untracked.filter((file) => /^(desktop|src|tests)\//.test(file));
const excludedUntracked = untracked.filter((file) => !added.includes(file));
const unexpectedUntracked = excludedUntracked.filter((file) =>
  file !== 'HACKATHON_SUBMISSION.md' && !file.startsWith('docs/') && !file.startsWith('review-packets/'));
if (unexpectedUntracked.length) throw new Error(`Unclassified untracked paths: ${unexpectedUntracked.join(', ')}`);

const chunks = [git(['diff', '--binary', '--no-ext-diff', baseRevision, '--', ...tracked])];
for (const file of added) {
  chunks.push(git(['diff', '--no-index', '--binary', '--no-ext-diff', '--', '/dev/null', file], root, [1]));
}
const patchText = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
if (!patchText.endsWith('\n')) throw new Error('Canonical patch is not LF-terminated.');
fs.writeFileSync(patchPath, patchText, 'utf8');

const files = [...tracked.map((file) => ({ file, kind: 'tracked' })), ...added.map((file) => ({ file, kind: 'added' }))]
  .sort((a, b) => a.file.localeCompare(b.file))
  .map(({ file, kind }) => {
    const raw = fs.readFileSync(path.join(root, file));
    const lf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
    return {
      path: file,
      kind,
      rawBytes: raw.length,
      rawSha256: sha256(raw),
      lfBytes: lf.length,
      lfSha256: sha256(lf),
      rawEqualsLfNormalized: raw.equals(lf),
    };
  });

const manifest = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  repositoryRoot: root.replace(/\\/g, '/'),
  baseRevision,
  patch: path.basename(patchPath),
  patchFormat: 'canonical UTF-8 with LF line endings',
  patchBytes: Buffer.byteLength(patchText),
  patchSha256: sha256(Buffer.from(patchText, 'utf8')),
  scopeCount: files.length,
  trackedCount: tracked.length,
  addedCount: added.length,
  excludedTracked: [...excludedTracked],
  excludedUntrackedPrefixes: ['HACKATHON_SUBMISSION.md', 'docs/', 'review-packets/'],
  files,
  scopeNotes: [
    'Includes the source, runtime configuration, UI, desktop bridge and regression files required to reconstruct the reviewed agent-to-deliverable candidate and shared reset/replay fixes.',
    'Excludes private .maos state, proposal/submission prose, the checklist, this evidence directory, historical packets and frozen RC artifacts.',
    'The old artifacts/verification packet was ignored by the parent artifacts/ rule; the current packet is stored under review-packets/ outside reset and retention targets.',
    'Queue reset includes .maos/checkpoints/** under the project-output lock; active and interrupted tasks block reset. Index, sandbox and conversation categories remain disabled.',
  ],
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  patchPath,
  patchBytes: manifest.patchBytes,
  patchSha256: manifest.patchSha256,
  manifestPath,
  scopeCount: files.length,
  trackedCount: tracked.length,
  addedCount: added.length,
  excludedTracked: [...excludedTracked],
  excludedUntrackedCount: excludedUntracked.length,
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
}, null, 2));
