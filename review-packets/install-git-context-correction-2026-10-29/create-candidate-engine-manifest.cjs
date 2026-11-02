const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const [repo, commit, baseRoot, candidateRoot, enginePath, evidenceRoot] = process.argv.slice(2);
if (![repo, commit, baseRoot, candidateRoot, enginePath, evidenceRoot].every(Boolean)) throw new Error('Pass repo, source commit, clean base root, candidate root, engine path, and evidence root.');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv });
if (head.status !== 0 || head.stdout.trim() !== commit) throw new Error('Repository HEAD does not match the declared Rust source commit.');
const listed = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', commit, '--', 'rust'], { encoding: 'utf8', env: gitEnv });
if (listed.status !== 0) throw new Error('Could not list committed Rust source paths.');
const files = listed.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const entries = files.map((relative) => {
  const baseBytes = fs.readFileSync(path.join(baseRoot, relative));
  const candidateBytes = fs.readFileSync(path.join(candidateRoot, relative));
  if (!baseBytes.equals(candidateBytes)) throw new Error('Candidate Rust source differs from declared base: ' + relative);
  return { path: relative, sha256: hash(candidateBytes) };
});
const sourceManifest = {
  schemaVersion: 1,
  sourceCommit: commit,
  sourceFileCount: entries.length,
  files: entries,
};
const sourceManifestPath = path.join(evidenceRoot, 'candidate-rust-source-hashes.json');
fs.writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest, null, 2) + '\n');
const health = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'engine-health-final.json'), 'utf8'));
const toolchain = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'engine-toolchain-final.json'), 'utf8'));
const stat = fs.statSync(enginePath);
const artifact = {
  schemaVersion: 1,
  artifactStatus: 'CANDIDATE ONLY — NOT AN APPROVED ARTIFACT MANIFEST',
  approved: false,
  sourceCommit: commit,
  sourceTree: 'rust/ files from the exact source commit; installation delta does not change Rust',
  sourceManifest: {
    path: 'review-packets/install-git-context-correction-2026-10-29/candidate-rust-source-hashes.json',
    sha256: hash(fs.readFileSync(sourceManifestPath)),
    fileCount: entries.length,
  },
  cargoManifestSha256: hash(fs.readFileSync(path.join(candidateRoot, 'rust/Cargo.toml'))),
  cargoLockSha256: hash(fs.readFileSync(path.join(candidateRoot, 'rust/Cargo.lock'))),
  build: {
    command: 'cargo build --release --locked --offline --manifest-path rust/Cargo.toml',
    exitCode: 0,
    cargo: toolchain.cargo,
    rustc: toolchain.rustc,
    targetTriple: 'x86_64-pc-windows-msvc',
    exactToolchainPinVerified: false,
  },
  binary: {
    name: path.basename(enginePath),
    sha256: hash(fs.readFileSync(enginePath)),
    bytes: stat.size,
    localPath: enginePath,
  },
  runtimeIdentity: {
    engine: health.stdout.data.engine,
    engineVersion: health.stdout.data.version,
    protocolVersion: health.stdout.data.protocol_version,
    healthOperationExitCode: health.exitCode,
    status: health.stdout.data.status,
    unsafeCode: health.stdout.data.unsafe_code,
  },
  trust: {
    publisherSignature: 'none',
    publisherAttestation: 'none',
    approvedManifestComparison: 'not performed',
    redistributionApproval: 'not established',
    meaning: 'This manifest records the locally built candidate file and its source identity only; it does not prove publisher authenticity or trusted provenance.',
  },
  distribution: {
    bundledInNpmOrBootstrap: false,
    prerequisite: 'Supply a platform-matched engine separately at <project-root>/rust/target/release/maos-engine.exe.',
  },
};
const artifactPath = path.join(evidenceRoot, 'candidate-rust-engine-artifact-manifest.json');
fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
const summary = {
  sourceCommit: commit,
  rustSourceFileCount: entries.length,
  rustSourceManifestSha256: hash(fs.readFileSync(sourceManifestPath)),
  engineSha256: artifact.binary.sha256,
  engineBytes: stat.size,
  engineManifestSha256: hash(fs.readFileSync(artifactPath)),
  engineVersion: artifact.runtimeIdentity.engineVersion,
  protocolVersion: artifact.runtimeIdentity.protocolVersion,
  healthExitCode: artifact.runtimeIdentity.healthOperationExitCode,
  approved: false,
};
fs.writeFileSync(path.join(evidenceRoot, 'candidate-engine-evidence-final.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
