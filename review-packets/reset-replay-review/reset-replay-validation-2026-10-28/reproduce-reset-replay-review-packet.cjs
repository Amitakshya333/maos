const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../../../..');
const evidenceRoot = path.resolve(__dirname, '..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const canonicalPatch = path.join(evidenceRoot, 'reset-replay-canonical.patch');
const canonicalManifestPath = path.join(evidenceRoot, 'reset-replay-source-hashes.json');
const priorPatch = path.join(evidenceRoot, 'concurrency-canonical.patch');
const priorManifestPath = path.join(evidenceRoot, 'concurrency-canonical-source-hashes.json');
const followupPatch = path.join(evidenceRoot, 'reset-replay-followup.patch');
const comparisonPath = path.join(__dirname, 'packet-source-comparison.json');
const priorManifest = JSON.parse(fs.readFileSync(priorManifestPath, 'utf8'));
const currentManifest = JSON.parse(fs.readFileSync(canonicalManifestPath, 'utf8'));
const commands = [];
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const normalizeLf = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
const sanitize = (value) => value.replaceAll(repoRoot, 'C:/maos').replaceAll(os.tmpdir(), '%TEMP%').replace(/\\/g, '/');

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || repoRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  const command = sanitize([executable, ...args].join(' '));
  commands.push({ command, exitCode: result.status, stdout: sanitize(result.stdout?.toString('utf8') || ''), stderr: sanitize(result.stderr?.toString('utf8') || '') });
  if (result.error) throw result.error;
  if (!options.allowedStatuses?.includes(result.status) && result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${result.stderr.toString('utf8')}`);
  }
  return result;
}

function git(args, cwd, allowedStatuses = [0]) {
  return run('git', args, { cwd, allowedStatuses });
}

function cloneAt(tempRoot, name) {
  const clonePath = path.join(tempRoot, name);
  git(['clone', '--shared', '--no-checkout', repoRoot, clonePath], repoRoot);
  git(['checkout', '--detach', baseRevision], clonePath);
  const status = git(['status', '--porcelain', '--untracked-files=all'], clonePath).stdout.toString('utf8').trim();
  if (status) throw new Error(`Clone ${name} was not clean at declared base: ${status}`);
  return clonePath;
}

function compareScopedFiles(clonePath) {
  const results = currentManifest.files.map((entry) => {
    const appliedPath = path.join(clonePath, entry.path);
    const sourcePath = path.join(repoRoot, entry.path);
    const actual = fs.readFileSync(appliedPath);
    const expected = fs.readFileSync(sourcePath);
    const rawEqual = actual.equals(expected);
    const lfEqual = normalizeLf(actual).equals(normalizeLf(expected));
    const manifestRawEqual = sha256(expected) === entry.rawSha256;
    const manifestLfEqual = sha256(normalizeLf(expected)) === entry.lfSha256;
    return {
      path: entry.path,
      rawEqual,
      lfEqual,
      manifestRawEqual,
      manifestLfEqual,
      appliedRawSha256: sha256(actual),
      sourceRawSha256: sha256(expected),
      appliedLfSha256: sha256(normalizeLf(actual)),
      sourceLfSha256: sha256(normalizeLf(expected)),
      mismatchCause: rawEqual ? undefined : lfEqual ? 'line endings only' : 'content mismatch',
    };
  });
  const mismatches = results.filter((item) => !item.lfEqual || !item.manifestRawEqual || !item.manifestLfEqual);
  if (mismatches.length) throw new Error(`Source/manifest mismatches: ${mismatches.map((item) => item.path).join(', ')}`);
  return {
    scopeCount: results.length,
    rawEqualCount: results.filter((item) => item.rawEqual).length,
    normalizedEqualCount: results.filter((item) => item.lfEqual).length,
    rawLineEndingOnlyMismatches: results.filter((item) => !item.rawEqual && item.lfEqual).map((item) => item.path),
    normalizedMismatches: mismatches,
    files: results,
  };
}

function createFollowupPatch(priorClone, tempRoot) {
  const beforeRoot = path.join(tempRoot, 'followup-before');
  const afterRoot = path.join(tempRoot, 'followup-after');
  fs.mkdirSync(beforeRoot, { recursive: true });
  fs.mkdirSync(afterRoot, { recursive: true });
  const changedFiles = [];
  const patchParts = [];

  for (const entry of currentManifest.files) {
    const beforePath = path.join(priorClone, entry.path);
    const afterPath = path.join(repoRoot, entry.path);
    if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) throw new Error(`Follow-up scope path missing: ${entry.path}`);
    const beforeBytes = fs.readFileSync(beforePath);
    const afterBytes = fs.readFileSync(afterPath);
    if (normalizeLf(beforeBytes).equals(normalizeLf(afterBytes))) continue;

    const stagedBeforePath = path.join(beforeRoot, entry.path);
    const stagedAfterPath = path.join(afterRoot, entry.path);
    fs.mkdirSync(path.dirname(stagedBeforePath), { recursive: true });
    fs.mkdirSync(path.dirname(stagedAfterPath), { recursive: true });
    fs.writeFileSync(stagedBeforePath, normalizeLf(beforeBytes));
    fs.writeFileSync(stagedAfterPath, normalizeLf(afterBytes));
    const relativeBefore = path.relative(tempRoot, stagedBeforePath).split(path.sep).join('/');
    const relativeAfter = path.relative(tempRoot, stagedAfterPath).split(path.sep).join('/');
    const diff = run('git', ['diff', '--no-index', '--binary', '--no-ext-diff', '--', relativeBefore, relativeAfter], {
      cwd: tempRoot,
      allowedStatuses: [0, 1],
    });
    const transformed = diff.stdout.toString('utf8')
      .replaceAll(`a/followup-before/`, 'a/')
      .replaceAll(`b/followup-after/`, 'b/');
    patchParts.push(transformed);
    changedFiles.push(entry.path);
  }

  const patch = patchParts.join('').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!patch.endsWith('\n')) throw new Error('Follow-up patch is not LF-terminated.');
  fs.writeFileSync(followupPatch, patch, 'utf8');
  return { patch, changedFiles, patchSha256: sha256(Buffer.from(patch, 'utf8')), patchBytes: Buffer.byteLength(patch) };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-reset-replay-review-'));
const allowedTempRoot = path.resolve(os.tmpdir(), 'maos-reset-replay-review-');
if (!path.resolve(tempRoot).startsWith(allowedTempRoot)) throw new Error(`Refusing unexpected temporary path: ${tempRoot}`);

let summary;
try {
  const canonicalClone = cloneAt(tempRoot, 'canonical-from-base');
  git(['apply', '--check', '--whitespace=error', canonicalPatch], canonicalClone);
  git(['apply', '--whitespace=error', canonicalPatch], canonicalClone);
  git(['apply', '--reverse', '--check', canonicalPatch], canonicalClone);
  git(['diff', '--check'], canonicalClone);
  const canonicalCompare = compareScopedFiles(canonicalClone);

  const priorClone = cloneAt(tempRoot, 'prior-candidate');
  git(['apply', '--check', '--whitespace=error', priorPatch], priorClone);
  git(['apply', '--whitespace=error', priorPatch], priorClone);
  const followup = createFollowupPatch(priorClone, tempRoot);
  git(['apply', '--check', '--whitespace=error', followupPatch], priorClone);
  git(['apply', '--whitespace=error', followupPatch], priorClone);
  git(['apply', '--reverse', '--check', followupPatch], priorClone);
  git(['diff', '--check'], priorClone);
  const followupCompare = compareScopedFiles(priorClone);

  summary = {
    schemaVersion: 1,
    declaredBase: baseRevision,
    canonicalPacket: {
      patch: path.basename(canonicalPatch),
      patchSha256: sha256(fs.readFileSync(canonicalPatch)),
      manifest: path.basename(canonicalManifestPath),
      manifestSha256: sha256(fs.readFileSync(canonicalManifestPath)),
      scopeCount: currentManifest.scopeCount,
      trackedCount: currentManifest.trackedCount,
      addedCount: currentManifest.addedCount,
      application: 'clean clone at declared base; apply-check, apply, reverse-apply-check, and diff-check passed',
      comparison: canonicalCompare,
    },
    followupPacket: {
      patch: path.basename(followupPatch),
      patchBytes: followup.patchBytes,
      patchSha256: followup.patchSha256,
      exactBase: `declared base ${baseRevision} plus prior canonical patch concurrency-canonical.patch (${sha256(fs.readFileSync(priorPatch))}) and prior source manifest (${sha256(fs.readFileSync(priorManifestPath))})`,
      changedFiles: followup.changedFiles,
      application: 'same clean base plus prior canonical patch; follow-up apply-check, apply, reverse-apply-check, and diff-check passed',
      comparison: followupCompare,
    },
    commands,
  };
  fs.writeFileSync(comparisonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  if (!resolvedTemp.startsWith(allowedTempRoot)) throw new Error(`Refusing cleanup outside temporary review root: ${resolvedTemp}`);
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  output: comparisonPath,
  canonicalScopeCount: summary.canonicalPacket.scopeCount,
  canonicalRawEqual: summary.canonicalPacket.comparison.rawEqualCount,
  canonicalNormalizedEqual: summary.canonicalPacket.comparison.normalizedEqualCount,
  canonicalLineEndingOnlyMismatches: summary.canonicalPacket.comparison.rawLineEndingOnlyMismatches.length,
  followupChangedFiles: summary.followupPacket.changedFiles,
  followupSha256: summary.followupPacket.patchSha256,
  followupRawEqual: summary.followupPacket.comparison.rawEqualCount,
  followupNormalizedEqual: summary.followupPacket.comparison.normalizedEqualCount,
  followupLineEndingOnlyMismatches: summary.followupPacket.comparison.rawLineEndingOnlyMismatches.length,
  commandCount: summary.commands.length,
}, null, 2));
