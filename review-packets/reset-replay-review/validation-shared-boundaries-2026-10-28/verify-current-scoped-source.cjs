const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const packetDir = path.resolve(__dirname, '..');
const patchPath = path.join(packetDir, 'shared-boundaries-canonical.patch');
const manifestPath = path.join(packetDir, 'shared-boundaries-source-hashes.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalizeLf = (value) => Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
const mismatches = [];
let rawEqual = 0;
let lfEqual = 0;

for (const entry of manifest.files) {
  const source = fs.readFileSync(path.join(root, entry.path));
  const lf = normalizeLf(source);
  const rawMatches = sha256(source) === entry.rawSha256;
  const lfMatches = sha256(lf) === entry.lfSha256;
  if (rawMatches) rawEqual++;
  if (lfMatches) lfEqual++;
  if (!rawMatches || !lfMatches) mismatches.push({ path: entry.path, rawMatches, lfMatches });
}

const result = {
  repositoryRoot: root.replace(/\\/g, '/'),
  baseRevision: manifest.baseRevision,
  patchSha256: sha256(fs.readFileSync(patchPath)),
  manifestSha256: sha256(fs.readFileSync(manifestPath)),
  scopeCount: manifest.files.length,
  rawEqual,
  lfEqual,
  mismatches,
  status: mismatches.length === 0 ? 'PASS' : 'FAIL',
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
