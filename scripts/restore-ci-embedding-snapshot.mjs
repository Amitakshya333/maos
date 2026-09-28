import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const EXPECTED_REVISION = 'fa979fdf926cbd99430f16e4321689952542a641';
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, 'embedding-snapshot-manifest.json');

// Retry settings for transient HTTP errors (429, 5xx)
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with automatic retry for transient errors (429, 502, 503, 504).
 * Returns the Response object. Non-retryable failures are returned as-is.
 */
async function fetchWithRetry(url, opts = {}) {
  let lastResponse = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, opts);
      if (response.status === 429 || response.status >= 500) {
        lastResponse = response;
        if (attempt < MAX_RETRIES) {
          const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`  ⏳ HTTP ${response.status} for ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delayMs);
          continue;
        }
        // exhausted retries, return the last response
        return response;
      }
      return response;
    } catch (err) {
      lastResponse = null;
      if (attempt < MAX_RETRIES) {
        const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Network error for ${url}: ${err.message} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  // Should not reach here, but just in case
  if (lastResponse) return lastResponse;
  throw new Error(`fetchWithRetry exhausted all attempts for ${url}`);
}

async function tryDownload(url, entry, destination) {
  const response = await fetchWithRetry(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'node-fetch/maos-ci' },
  });

  if (response.status === 404) {
    return { ok: false, reason: '404' };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = sha256(bytes);
  if (bytes.length !== entry.size || actualHash !== entry.sha256.toLowerCase()) {
    return {
      ok: false,
      reason: `hash/size mismatch (got ${bytes.length}b/${actualHash.slice(0, 12)}…, expected ${entry.size}b/${entry.sha256.slice(0, 12)}…)`,
    };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'w' });
  await rename(temporary, destination);
  return { ok: true };
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

  // Candidate revisions to try, in priority order
  const candidateRevisions = [
    EXPECTED_REVISION,
    'c9745ed1d9f207416be6d2e6f8de32d1f16199bf',
    'fa97f6e7cb1a59073dff9e6b13e2715cf7475ac9',
    'main',
  ];

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
      console.log(`✓ ${entry.path} — already present and verified.`);
      continue;
    }

    const encodedFilePath = entry.path
      .split(/[\\/]/)
      .map(encodeURIComponent)
      .join('/');

    // Build URL candidates: /resolve/<rev>/path for each revision
    const urlCandidates = candidateRevisions.map(
      (rev) => ({
        label: `resolve/${rev}`,
        url: `https://huggingface.co/${modelPath}/resolve/${rev}/${encodedFilePath}`,
      })
    );

    // Also try the raw download endpoint as a last resort
    urlCandidates.push({
      label: 'raw/main',
      url: `https://huggingface.co/${modelPath}/raw/main/${encodedFilePath}`,
    });

    let restored = false;
    const failures = [];

    for (const { label, url } of urlCandidates) {
      try {
        const result = await tryDownload(url, entry, destination);
        if (result.ok) {
          console.log(`✓ ${entry.path} — restored from ${label}`);
          restored = true;
          break;
        }
        failures.push(`${label}: ${result.reason}`);
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
      }
    }

    if (!restored) {
      throw new Error(
        `Could not restore ${entry.path} from any upstream source.\n  Attempted:\n    ${failures.join('\n    ')}`
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
  if (await readIfValid(poolingDestination, poolingEntry)) {
    console.log(`✓ 1_Pooling/config.json — already present and verified.`);
  } else {
    let poolingRestored = false;
    for (const rev of ['c9745ed1d9f207416be6d2e6f8de32d1f16199bf', 'main']) {
      const url = `https://huggingface.co/${modelPath}/resolve/${rev}/1_Pooling/config.json`;
      try {
        const result = await tryDownload(url, poolingEntry, poolingDestination);
        if (result.ok) {
          console.log(`✓ 1_Pooling/config.json — restored from ${rev}`);
          poolingRestored = true;
          break;
        }
      } catch {}
    }
    if (!poolingRestored) {
      console.warn('⚠ Could not restore 1_Pooling/config.json — non-fatal, may not be needed.');
    }
  }

  console.log(`\n✅ Verified ${manifest.files.length} files for ${EXPECTED_MODEL}@${EXPECTED_REVISION}.`);
}

main().catch((error) => {
  console.error(`Embedding snapshot preparation failed: ${error.message}`);
  process.exitCode = 1;
});
