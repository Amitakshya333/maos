const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const packetDir = path.resolve(__dirname, '..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const parentPatch = path.join(packetDir, 'shared-boundaries-canonical.patch');
const parentManifestPath = path.join(packetDir, 'shared-boundaries-source-hashes.json');
const deltaPatch = path.join(packetDir, 'cleanup-checkpoint-delta.patch');
const deltaManifestPath = path.join(packetDir, 'cleanup-checkpoint-delta-source-hashes.json');
const expectedParentPatchSha = '96fdbeb470c3862248021602707b6f657ec77893e9d76f7d948d4f2d77501e01';
const expectedParentManifestSha = 'f15af24c01a5c3cdff3ff911c6bb0381df553c15e43617174ac4e6ecdddb3fc2';

function git(args, cwd, allowedStatuses = [0]) {
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

function normalizeLf(value) {
  return Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

function writeScopedFiles(sourceRoot, destinationRoot, files, normalize = false) {
  for (const entry of files) {
    const destination = path.join(destinationRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const content = fs.readFileSync(path.join(sourceRoot, entry.path));
    fs.writeFileSync(destination, normalize ? normalizeLf(content) : content);
  }
}

const parentPatchBytes = fs.readFileSync(parentPatch);
const parentManifestBytes = fs.readFileSync(parentManifestPath);
const parent = JSON.parse(parentManifestBytes.toString('utf8'));
if (sha256(parentPatchBytes) !== expectedParentPatchSha) throw new Error('Reviewed parent patch hash changed.');
if (sha256(parentManifestBytes) !== expectedParentManifestSha) throw new Error('Reviewed parent manifest hash changed.');
if (parent.baseRevision !== baseRevision || parent.patchSha256 !== expectedParentPatchSha) throw new Error('Reviewed parent metadata mismatch.');

const tempParent = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'maos-cleanup-delta-'));
const fromRoot = path.join(tempRoot, 'from');
const toRoot = path.join(tempRoot, 'to');
const result = {
  repositoryRoot: root.replace(/\\/g, '/'),
  parentBaseRevision: baseRevision,
  parentPatchSha256: expectedParentPatchSha,
  parentManifestSha256: expectedParentManifestSha,
  parentScopeCount: parent.files.length,
  deltaApply: 'NOT_RUN',
  reverseCheck: 'NOT_RUN',
  rawEqualCount: 0,
  lfEqualCount: 0,
  rawOnlyLineEndingDifferences: [],
  contentMismatches: [],
};

try {
  fs.mkdirSync(path.join(tempRoot, '.git'), { recursive: true });
  git(['init', '--quiet'], tempRoot);
  git(['-C', tempRoot, 'config', 'core.autocrlf', 'false'], root);
  for (const entry of parent.files.filter((item) => item.kind === 'tracked')) {
    const destination = path.join(tempRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, git(['show', `${baseRevision}:${entry.path}`], root));
  }
  git(['-C', tempRoot, 'apply', '--check', parentPatch], root);
  git(['-C', tempRoot, 'apply', parentPatch], root);

  const parentLfMismatches = parent.files.filter((entry) =>
    sha256(normalizeLf(fs.readFileSync(path.join(tempRoot, entry.path)))) !== entry.lfSha256);
  if (parentLfMismatches.length) throw new Error(`Parent reconstruction mismatch: ${parentLfMismatches.map((x) => x.path).join(', ')}`);
  const parentPaths = new Set(parent.files.map((entry) => entry.path));
  const deltaFiles = parent.files.filter((entry) => {
    const current = path.join(root, entry.path);
    if (!fs.existsSync(current)) throw new Error(`Scoped source is missing: ${entry.path}`);
    return sha256(normalizeLf(fs.readFileSync(current))) !== entry.lfSha256;
  }).map((entry) => entry.path).sort();
  const excludedTracked = new Set([
    '.maos/maos.config.json',
    '.maos/pool.json',
    'demo/industrial/MASTER_DEMO_PLAN.md',
    'demo/industrial/RECORDING_READINESS.md',
  ]);
  const trackedChanges = git(['diff', '--name-only', baseRevision, '--'], root).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  const extraTrackedFiles = trackedChanges.filter((file) => !parentPaths.has(file) && !excludedTracked.has(file)).sort();
  for (const file of extraTrackedFiles) {
    const destination = path.join(tempRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, git(['show', `${baseRevision}:${file}`], root));
    const baseline = normalizeLf(git(['show', `${baseRevision}:${file}`], root));
    const current = normalizeLf(fs.readFileSync(path.join(root, file)));
    if (baseline.equals(current)) throw new Error(`Unexpected unchanged file outside parent scope: ${file}`);
    deltaFiles.push(file);
  }
  deltaFiles.sort();

  const expectedDeltaFiles = [
    'src/cli/dashboard.ts',
    'src/cli/dashboard-template.ts',
    'src/cli/index.ts',
    'src/core/checkpoint.ts',
    'src/industrial/atomic-cleanup-coordinator.ts',
    'src/industrial/deterministic-reset.ts',
    'src/industrial/lifecycle.ts',
    'src/industrial/service-startup.ts',
    'src/service/task-service.ts',
    'tests/f2-08-lifecycle.test.ts',
    'tests/industrial/f10-02-dashboard-trigger.test.ts',
    'tests/industrial/f10-05-deterministic-reset.test.ts',
    'tests/industrial/f9-08-interruption-atomic-cleanup.test.ts',
  ].sort();
  if (JSON.stringify(deltaFiles) !== JSON.stringify(expectedDeltaFiles)) {
    throw new Error(`Delta scope differs from reviewed change: ${JSON.stringify(deltaFiles)}`);
  }

  const deltaEntries = deltaFiles.map((file) => ({ path: file, kind: 'modified' }));
  writeScopedFiles(tempRoot, fromRoot, deltaEntries);
  writeScopedFiles(root, toRoot, deltaEntries, true);
  const chunks = [];
  for (const file of deltaFiles) {
    const diff = git(['diff', '--no-index', '--binary', '--no-ext-diff', '--unified=3', '--', `from/${file}`, `to/${file}`], tempRoot, [1]);
    let text = diff.toString('utf8');
    text = text.replaceAll(`a/from/${file}`, `a/${file}`).replaceAll(`b/to/${file}`, `b/${file}`);
    chunks.push(Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8'));
  }
  const patchBytes = Buffer.concat(chunks);
  if (!patchBytes.length || patchBytes[patchBytes.length - 1] !== 0x0a) throw new Error('Delta patch must be nonempty and LF-terminated.');
  fs.writeFileSync(deltaPatch, patchBytes);

  const deltaFilesManifest = deltaFiles.map((file) => {
    const raw = fs.readFileSync(path.join(root, file));
    const lf = normalizeLf(raw);
    return {
      path: file,
      kind: 'modified',
      rawBytes: raw.length,
      rawSha256: sha256(raw),
      lfBytes: lf.length,
      lfSha256: sha256(lf),
      rawEqualsLfNormalized: raw.equals(lf),
    };
  });
  const deltaManifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    repositoryRoot: root.replace(/\\/g, '/'),
    baseRevision,
    baseSnapshot: {
      patch: path.basename(parentPatch),
      patchSha256: expectedParentPatchSha,
      manifest: path.basename(parentManifestPath),
      manifestSha256: expectedParentManifestSha,
    },
    patch: path.basename(deltaPatch),
    patchFormat: 'canonical UTF-8 with LF line endings; applies after baseSnapshot patch',
    patchBytes: patchBytes.length,
    patchSha256: sha256(patchBytes),
    scopeCount: deltaFilesManifest.length,
    files: deltaFilesManifest,
    scopeNotes: [
      'This delta is based on the exact 94-file shared-boundaries candidate identified by baseSnapshot hashes.',
      'It contains only lifecycle cleanup, queue checkpoint/reset, and legacy dashboard contention corrections.',
      'The delta does not include checklist or evidence files; those are retained beside this packet.',
    ],
  };
  const deltaManifestBytes = Buffer.from(`${JSON.stringify(deltaManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(deltaManifestPath, deltaManifestBytes);

  git(['-C', tempRoot, 'apply', '--check', deltaPatch], root);
  git(['-C', tempRoot, 'apply', deltaPatch], root);
  result.deltaApply = 'PASS';
  git(['-C', tempRoot, 'apply', '--reverse', '--check', deltaPatch], root);
  result.reverseCheck = 'PASS';
  const allScopedFiles = [...new Set([...parent.files.map((entry) => entry.path), ...deltaFiles])].sort();
  for (const file of allScopedFiles) {
    const actual = fs.readFileSync(path.join(tempRoot, file));
    const current = fs.readFileSync(path.join(root, file));
    const rawEqual = actual.equals(current);
    const lfEqual = sha256(normalizeLf(actual)) === sha256(normalizeLf(current));
    if (rawEqual) result.rawEqualCount++;
    if (lfEqual) result.lfEqualCount++;
    if (rawEqual && !lfEqual) throw new Error(`Impossible normalized mismatch after raw equality: ${file}`);
    if (!lfEqual) result.contentMismatches.push(file);
    else if (!rawEqual) result.rawOnlyLineEndingDifferences.push(file);
  }
  result.reconstructedScopeCount = allScopedFiles.length;
  if (result.lfEqualCount !== allScopedFiles.length || result.contentMismatches.length) throw new Error('Delta application did not reproduce the complete current candidate scope.');
  result.deltaFiles = deltaFiles;
  result.deltaPatchSha256 = deltaManifest.patchSha256;
  result.deltaManifestSha256 = sha256(deltaManifestBytes);
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.error = String(error);
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  if (!resolvedTemp.startsWith(`${tempParent}${path.sep}`)) throw new Error(`Refusing to remove out-of-temp path: ${resolvedTemp}`);
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
