const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const evidenceDir = __dirname;
const packetDir = path.resolve(evidenceDir, '..');
const manifestPath = path.join(packetDir, 'shared-boundaries-source-hashes.json');
const patchPath = path.join(packetDir, 'shared-boundaries-canonical.patch');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(`git ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readStatus(fileName) {
  const raw = fs.readFileSync(path.join(evidenceDir, fileName), 'utf8');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(start, end + 1));
}

function readTestCounts(fileName) {
  const text = fs.readFileSync(path.join(evidenceDir, fileName), 'utf8');
  const fileMatch = text.match(/Test Files\s+(\d+) passed \((\d+)\)/);
  const testMatch = text.match(/Tests\s+(\d+) passed \((\d+)\)/);
  if (!fileMatch || !testMatch) throw new Error(`Could not parse test counts from ${fileName}`);
  return { files: Number(fileMatch[1]), tests: Number(testMatch[1]), skipped: 0, exitCode: /EXIT_CODE=0/.test(text) ? 0 : 1 };
}

const broad = readTestCounts('affected-regressions-final.txt');
const provider = readTestCounts('provider-identity-regression-final.txt');
const sourceCheck = readStatus('current-source-hash-check-final.txt');
const reproduction = readStatus('packet-reproduction-final.txt');
const preserved = readStatus('preserved-evidence-check-final.txt');
const archiveRelative = 'artifacts/verification/preserved-rc-2026-10-27/maosorch-0.3.0-70a476151e72dabd8f8a8e11faea6fa3bb9337abbbb2f652336c08a990fed360.tgz';
const indexCheck = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root, encoding: 'utf8' });
if (indexCheck.error || ![0, 1].includes(indexCheck.status)) throw indexCheck.error || new Error('Could not inspect index state.');

const result = {
  capturedAt: new Date().toISOString(),
  repositoryRoot: root.replace(/\\/g, '/'),
  branch: git(['branch', '--show-current']),
  head: git(['rev-parse', 'HEAD']),
  declaredBase: manifest.baseRevision,
  indexEmpty: indexCheck.status === 0,
  workingTreeHasOtherChanges: git(['status', '--porcelain']).length > 0,
  patch: { path: path.relative(root, patchPath).replace(/\\/g, '/'), sha256: sha256(patchPath) },
  sourceManifest: { path: path.relative(root, manifestPath).replace(/\\/g, '/'), sha256: sha256(manifestPath), scopeCount: manifest.scopeCount, trackedCount: manifest.trackedCount, addedCount: manifest.addedCount },
  sourceHashCheck: { status: sourceCheck.status, rawEqual: sourceCheck.rawEqual, lfEqual: sourceCheck.lfEqual, mismatches: sourceCheck.mismatches.length },
  isolatedReproduction: { status: reproduction.status, applyCheck: reproduction.gitApplyCheck, apply: reproduction.gitApply, reverseCheck: reproduction.reverseCheck, rawEqual: reproduction.rawEqualCount, lfEqual: reproduction.lfEqualCount, contentMismatches: reproduction.contentMismatches.length },
  tests: { broad, providerIdentity: provider, distinctFiles: broad.files + provider.files, distinctTests: broad.tests + provider.tests },
  protectedEvidence: { status: preserved.failed.length === 0 ? 'PASS' : 'FAIL', checked: preserved.checked, passed: preserved.passed, failed: preserved.failed.length, snapshotAt: preserved.snapshotAt },
  frozenRc: { path: archiveRelative, sha256: sha256(path.join(root, archiveRelative)), bytes: fs.statSync(path.join(root, archiveRelative)).size },
};

const outputPath = path.join(evidenceDir, 'FINAL_STATUS.json');
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, ...result }, null, 2));
