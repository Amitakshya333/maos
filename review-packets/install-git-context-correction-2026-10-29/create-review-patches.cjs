const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const repo = 'C:\\maos';
const packet = __dirname;
const taskRoot = process.argv[2];
if (!taskRoot) throw new Error('Pass the isolated validation workspace path.');
const baseCommit = '189e786ff0431b02b95ca618bb4791a5ad7b0215';
const oldPacket = path.join(repo, 'review-packets', 'install-reliability-2026-10-29');
const oldPatchPath = path.join(oldPacket, 'install-reliability.patch');
const oldManifestPath = path.join(oldPacket, 'install-reliability-source-hashes.json');
const oldManifest = JSON.parse(fs.readFileSync(oldManifestPath, 'utf8'));
const additions = ['src/utils/project-git-context.ts', 'tests/cli/project-git-context.test.ts'];
const scope = [...oldManifest.files.map((item) => item.path), ...additions].sort();
const roots = {
  base: process.env.MAOS_PATCH_BASE || path.join(taskRoot, 'base-source'),
  prior: process.env.MAOS_PATCH_PRIOR || path.join(taskRoot, 'prior-snapshot-apply'),
  candidate: path.join(taskRoot, 'candidate-source'),
};
const normalizedRoots = {
  base: path.join(taskRoot, 'base-scope-lf'),
  prior: path.join(taskRoot, 'prior-snapshot-lf'),
  candidate: path.join(taskRoot, 'candidate-scope-lf'),
};
for (const dir of Object.values(normalizedRoots)) {
  if (!dir.startsWith(`${taskRoot}${path.sep}`)) throw new Error(`Refusing to reset normalized snapshot outside the validation workspace: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lfBytes = (bytes) => Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'), 'utf8');
const hashFile = (file) => {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  return { rawSha256: sha(raw), lfSha256: sha(lfBytes(raw)) };
};
const ensureCopy = (sourceRoot, destinationRoot, relative, allowMissing) => {
  const source = path.join(sourceRoot, relative);
  if (!fs.existsSync(source)) {
    if (allowMissing) return null;
    throw new Error(`Required snapshot file missing: ${relative}`);
  }
  const destination = path.join(destinationRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const sourceBytes = fs.readFileSync(source);
  fs.writeFileSync(destination, lfBytes(sourceBytes));
  return hashFile(source);
};

const files = [];
for (const relative of scope) {
  const base = ensureCopy(roots.base, normalizedRoots.base, relative, true);
  const prior = ensureCopy(roots.prior, normalizedRoots.prior, relative, true);
  const candidate = ensureCopy(roots.candidate, normalizedRoots.candidate, relative, false);
  const current = hashFile(path.join(repo, relative));
  if (!current || current.rawSha256 !== hashFile(path.join(roots.candidate, relative))?.rawSha256) {
    throw new Error(`Isolated candidate does not match current source bytes: ${relative}`);
  }
  const changedFromPrior = !prior || prior.lfSha256 !== candidate.lfSha256;
  files.push({
    path: relative,
    status: base ? 'modified' : 'added',
    baseRawSha256: base?.rawSha256 ?? null,
    baseLfSha256: base?.lfSha256 ?? null,
    priorRawSha256: prior?.rawSha256 ?? null,
    priorLfSha256: prior?.lfSha256 ?? null,
    rawSha256: current.rawSha256,
    lfSha256: current.lfSha256,
    changedFromPreviousSnapshot: changedFromPrior,
  });
}

function writeDiff(oldDir, newDir, outputPath) {
  const oldRelative = path.relative(taskRoot, oldDir).split(path.sep).join('/');
  const newRelative = path.relative(taskRoot, newDir).split(path.sep).join('/');
  const result = spawnSync('git', [
    '-c', 'core.quotepath=false', 'diff', '--no-index', '--binary', '--unified=3', '--', oldRelative, newRelative,
  ], { cwd: taskRoot, encoding: null, windowsHide: true });
  if (result.status !== 1 && result.status !== 0) {
    throw new Error(`git diff failed (${result.status}): ${String(result.stderr || '').trim()}`);
  }
  fs.writeFileSync(outputPath, result.stdout || Buffer.alloc(0));
  return { exitCode: result.status, sha256: sha(fs.readFileSync(outputPath)) };
}

const correctionPatch = path.join(packet, 'correction-only.patch');
const completePatch = path.join(packet, 'complete-delta.patch');
const correction = writeDiff(normalizedRoots.prior, normalizedRoots.candidate, correctionPatch);
const complete = writeDiff(normalizedRoots.base, normalizedRoots.candidate, completePatch);
const correctionFiles = files.filter((file) => file.changedFromPreviousSnapshot);
const fullManifest = {
  schemaVersion: 1,
  baseCommit,
  candidateSource: 'current working-tree files copied into an isolated reconstruction of the reviewed installation snapshot',
  sourceFileCount: files.length,
  files: files.map(({ changedFromPreviousSnapshot, ...file }) => file),
};
const correctionManifest = {
  schemaVersion: 1,
  baseSnapshot: {
    baseCommit,
    patchPath: 'review-packets/install-reliability-2026-10-29/install-reliability.patch',
    patchSha256: sha(fs.readFileSync(oldPatchPath)),
    manifestPath: 'review-packets/install-reliability-2026-10-29/install-reliability-source-hashes.json',
    manifestSha256: sha(fs.readFileSync(oldManifestPath)),
  },
  sourceFileCount: correctionFiles.length,
  files: correctionFiles.map((file) => ({
    path: file.path,
    status: file.status,
    priorRawSha256: file.priorRawSha256,
    priorLfSha256: file.priorLfSha256,
    rawSha256: file.rawSha256,
    lfSha256: file.lfSha256,
  })),
};
fs.writeFileSync(path.join(packet, 'complete-source-hashes.json'), `${JSON.stringify(fullManifest, null, 2)}\n`);
fs.writeFileSync(path.join(packet, 'correction-source-hashes.json'), `${JSON.stringify(correctionManifest, null, 2)}\n`);

const hashFileSha = (file) => sha(fs.readFileSync(file));
const result = {
  baseCommit,
  sourceFileCount: files.length,
  correctionFileCount: correctionFiles.length,
  correctionPaths: correctionFiles.map((file) => file.path),
  completePatchSha256: complete.sha256,
  completeManifestSha256: hashFileSha(path.join(packet, 'complete-source-hashes.json')),
  correctionPatchSha256: correction.sha256,
  correctionManifestSha256: hashFileSha(path.join(packet, 'correction-source-hashes.json')),
  fullPatchDiffExitCode: complete.exitCode,
  correctionPatchDiffExitCode: correction.exitCode,
};
fs.writeFileSync(path.join(packet, 'patch-generation.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
