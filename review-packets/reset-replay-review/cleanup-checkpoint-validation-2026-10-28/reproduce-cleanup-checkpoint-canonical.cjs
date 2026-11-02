const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const packetDir = path.resolve(__dirname, '..');
const baseRevision = 'f9525055c56a7f7771dd2fa029c147c2960a98a3';
const patchPath = path.join(packetDir, 'cleanup-checkpoint-canonical.patch');
const manifestPath = path.join(packetDir, 'cleanup-checkpoint-canonical-source-hashes.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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

function normalizeLf(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

const patchBytes = fs.readFileSync(patchPath);
const tempParent = path.resolve(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'maos-cleanup-canonical-repro-'));
const result = {
  repositoryRoot: root.replace(/\\/g, '/'),
  baseRevision,
  patchPath,
  patchSha256: sha256(patchBytes),
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
  tempRoot,
  gitApplyCheck: 'NOT_RUN',
  gitApply: 'NOT_RUN',
  reverseCheck: 'NOT_RUN',
  scopedFileCount: manifest.files.length,
  rawEqualCount: 0,
  lfEqualCount: 0,
  rawMismatches: [],
  contentMismatches: [],
  extraPaths: [],
};

try {
  if (manifest.baseRevision !== baseRevision) throw new Error(`Manifest base mismatch: ${manifest.baseRevision}`);
  if (result.patchSha256 !== manifest.patchSha256) throw new Error('Patch hash does not match the source manifest.');
  fs.mkdirSync(path.join(tempRoot, '.git'), { recursive: true });
  git(['init', '--quiet'], tempRoot);
  git(['-C', tempRoot, 'config', 'core.autocrlf', 'false'], root);

  for (const file of manifest.files.filter((entry) => entry.kind === 'tracked')) {
    const destination = path.join(tempRoot, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, git(['show', `${baseRevision}:${file.path}`], root));
  }

  git(['-C', tempRoot, 'apply', '--check', patchPath], root);
  result.gitApplyCheck = 'PASS';
  git(['-C', tempRoot, 'apply', patchPath], root);
  result.gitApply = 'PASS';
  git(['-C', tempRoot, 'apply', '--reverse', '--check', patchPath], root);
  result.reverseCheck = 'PASS';

  const actualPaths = [];
  const visit = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory)) {
      if (!relative && name === '.git') continue;
      const absolute = path.join(directory, name);
      const rel = relative ? `${relative}/${name}` : name;
      if (fs.statSync(absolute).isDirectory()) visit(absolute, rel);
      else actualPaths.push(rel);
    }
  };
  visit(tempRoot);
  const expectedPaths = manifest.files.map((entry) => entry.path).sort();
  result.extraPaths = actualPaths.filter((file) => !expectedPaths.includes(file)).sort();
  const missingPaths = expectedPaths.filter((file) => !actualPaths.includes(file));
  if (result.extraPaths.length || missingPaths.length) {
    result.contentMismatches.push({ kind: 'path-set', extra: result.extraPaths, missing: missingPaths });
  }

  for (const entry of manifest.files) {
    const actual = fs.readFileSync(path.join(tempRoot, entry.path));
    const normalized = normalizeLf(actual);
    const rawEqual = sha256(actual) === entry.rawSha256;
    const lfEqual = sha256(normalized) === entry.lfSha256;
    if (rawEqual) result.rawEqualCount++;
    if (lfEqual) result.lfEqualCount++;
    if (!rawEqual) result.rawMismatches.push({
      path: entry.path,
      expectedRawSha256: entry.rawSha256,
      actualRawSha256: sha256(actual),
      normalizedContentEqual: lfEqual,
    });
    if (!lfEqual) result.contentMismatches.push({
      path: entry.path,
      expectedLfSha256: entry.lfSha256,
      actualLfSha256: sha256(normalized),
    });
  }
  result.status = result.contentMismatches.length === 0 && result.lfEqualCount === result.scopedFileCount ? 'PASS' : 'FAIL';
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
