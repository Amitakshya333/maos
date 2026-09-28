import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const EXPECTED_REVISION = 'fa979fdf926cbd99430f16e4321689952542a641';
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, 'embedding-snapshot-manifest.json');

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readIfValid(filePath, entry) {
  try {
    const bytes = await readFile(filePath);
    return bytes.length === entry.size && sha256(bytes) === entry.sha256.toLowerCase();
  } catch {
    return false;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.model !== EXPECTED_MODEL ||
    manifest.revision !== EXPECTED_REVISION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Embedding snapshot manifest does not match the pinned CI model identity.');
  }

  const storeRoot = path.resolve(REPOSITORY_ROOT, 'offline-stores', 'model-snapshot');
  const snapshotRoot = path.resolve(storeRoot, manifest.snapshotRelativePath);
  if (!isWithin(snapshotRoot, storeRoot) || snapshotRoot === storeRoot) {
    throw new Error('Embedding snapshot path escapes the approved model store.');
  }

  const modelPath = EXPECTED_MODEL.split('/').map(encodeURIComponent).join('/');
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== 'string' ||
      path.isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes('..') ||
      !Number.isSafeInteger(entry.size) || entry.size <= 0 ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)
    ) {
      throw new Error('Embedding snapshot manifest contains an invalid file entry.');
    }

    const destination = path.resolve(snapshotRoot, entry.path);
    if (!isWithin(destination, snapshotRoot) || destination === snapshotRoot) {
      throw new Error(`Embedding snapshot file path escapes the pinned snapshot: ${entry.path}`);
    }
    if (await readIfValid(destination, entry)) {
      continue;
    }

    const candidateRevisions = [
      EXPECTED_REVISION,
      'c9745ed1d9f207416be6d2e6f8de32d1f16199bf',
      'fa97f6e7cb1a59073dff9e6b13e2715cf7475ac9',
      'main',
    ];

    let restored = false;
    let lastError = null;

    for (const rev of candidateRevisions) {
      const url = `https://huggingface.co/${modelPath}/resolve/${rev}/${entry.path
        .split(/[\\/]/)
        .map(encodeURIComponent)
        .join('/')}`;

      try {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'node-fetch/maos-ci' },
        });

        if (response.status === 404) {
          continue;
        }

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} from revision ${rev}`);
          continue;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        const actualHash = sha256(bytes);
        if (bytes.length !== entry.size || actualHash !== entry.sha256.toLowerCase()) {
          lastError = new Error(`Pinned embedding file failed size/hash verification from revision ${rev}`);
          continue;
        }

        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.tmp`;
        await writeFile(temporary, bytes, { flag: 'w' });
        await rename(temporary, destination);
        console.log(`Restored and verified ${entry.path} (from upstream revision ${rev})`);
        restored = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!restored) {
      throw new Error(
        `Could not restore ${entry.path}: ${lastError ? lastError.message : 'all upstream candidate revisions failed'}.`
      );
    }
  }

  // Also ensure 1_Pooling/config.json is present if needed for sentence-transformers runtime
  const poolingDestination = path.resolve(snapshotRoot, '1_Pooling', 'config.json');
  const poolingEntry = {
    path: '1_Pooling/config.json',
    size: 190,
    sha256: '4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23',
  };
  if (!(await readIfValid(poolingDestination, poolingEntry))) {
    for (const rev of ['c9745ed1d9f207416be6d2e6f8de32d1f16199bf', 'main']) {
      const url = `https://huggingface.co/${modelPath}/resolve/${rev}/1_Pooling/config.json`;
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'node-fetch/maos-ci' },
        });
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === poolingEntry.size && sha256(bytes) === poolingEntry.sha256) {
          await mkdir(path.dirname(poolingDestination), { recursive: true });
          await writeFile(poolingDestination, bytes, { flag: 'w' });
          console.log(`Restored and verified 1_Pooling/config.json (from upstream revision ${rev})`);
          break;
        }
      } catch {}
    }
  }

  console.log(`Verified ${manifest.files.length} files for ${EXPECTED_MODEL}@${EXPECTED_REVISION}.`);
}

main().catch((error) => {
  console.error(`Embedding snapshot preparation failed: ${error.message}`);
  process.exitCode = 1;
});
