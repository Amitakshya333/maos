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

/**
 * Inline base64-encoded copies of small config files (<1 KB each).
 * These are the EXACT bytes that match the pinned SHA-256 hashes in
 * embedding-snapshot-manifest.json.  If every upstream HuggingFace
 * candidate returns 404 / 429 / 5xx the script writes these directly
 * instead of failing the CI run.
 *
 * Large files (tokenizer.json 466 KB, vocab.txt 231 KB,
 * model.safetensors 90 MB) are NOT embedded — they rely on
 * actions/cache or a successful HuggingFace download.
 */
const INLINE_FALLBACKS = {
  'config.json': 'ewogICJfbmFtZV9vcl9wYXRoIjogIm5yZWltZXJzL01pbmlMTS1MNi1IMzg0LXVuY2FzZWQiLAogICJhcmNoaXRlY3R1cmVzIjogWwogICAgIkJlcnRNb2RlbCIKICBdLAogICJhdHRlbnRpb25fcHJvYnNfZHJvcG91dF9wcm9iIjogMC4xLAogICJncmFkaWVudF9jaGVja3BvaW50aW5nIjogZmFsc2UsCiAgImhpZGRlbl9hY3QiOiAiZ2VsdSIsCiAgImhpZGRlbl9kcm9wb3V0X3Byb2IiOiAwLjEsCiAgImhpZGRlbl9zaXplIjogMzg0LAogICJpbml0aWFsaXplcl9yYW5nZSI6IDAuMDIsCiAgImludGVybWVkaWF0ZV9zaXplIjogMTUzNiwKICAibGF5ZXJfbm9ybV9lcHMiOiAxZS0xMiwKICAibWF4X3Bvc2l0aW9uX2VtYmVkZGluZ3MiOiA1MTIsCiAgIm1vZGVsX3R5cGUiOiAiYmVydCIsCiAgIm51bV9hdHRlbnRpb25faGVhZHMiOiAxMiwKICAibnVtX2hpZGRlbl9sYXllcnMiOiA2LAogICJwYWRfdG9rZW5faWQiOiAwLAogICJwb3NpdGlvbl9lbWJlZGRpbmdfdHlwZSI6ICJhYnNvbHV0ZSIsCiAgInRyYW5zZm9ybWVyc192ZXJzaW9uIjogIjQuOC4yIiwKICAidHlwZV92b2NhYl9zaXplIjogMiwKICAidXNlX2NhY2hlIjogdHJ1ZSwKICAidm9jYWJfc2l6ZSI6IDMwNTIyCn0K',
  'tokenizer_config.json': 'eyJkb19sb3dlcl9jYXNlIjogdHJ1ZSwgInVua190b2tlbiI6ICJbVU5LXSIsICJzZXBfdG9rZW4iOiAiW1NFUF0iLCAicGFkX3Rva2VuIjogIltQQURdIiwgImNsc190b2tlbiI6ICJbQ0xTXSIsICJtYXNrX3Rva2VuIjogIltNQVNLXSIsICJ0b2tlbml6ZV9jaGluZXNlX2NoYXJzIjogdHJ1ZSwgInN0cmlwX2FjY2VudHMiOiBudWxsLCAibmFtZV9vcl9wYXRoIjogIm5yZWltZXJzL01pbmlMTS1MNi1IMzg0LXVuY2FzZWQiLCAiZG9fYmFzaWNfdG9rZW5pemUiOiB0cnVlLCAibmV2ZXJfc3BsaXQiOiBudWxsLCAidG9rZW5pemVyX2NsYXNzIjogIkJlcnRUb2tlbml6ZXIiLCAibW9kZWxfbWF4X2xlbmd0aCI6IDUxMn0=',
  'special_tokens_map.json': 'eyJ1bmtfdG9rZW4iOiAiW1VOS10iLCAic2VwX3Rva2VuIjogIltTRVBdIiwgInBhZF90b2tlbiI6ICJbUEFEXSIsICJjbHNfdG9rZW4iOiAiW0NMU10iLCAibWFza190b2tlbiI6ICJbTUFTS10ifQ==',
  'modules.json': 'WwogIHsKICAgICJpZHgiOiAwLAogICAgIm5hbWUiOiAiMCIsCiAgICAicGF0aCI6ICIiLAogICAgInR5cGUiOiAic2VudGVuY2VfdHJhbnNmb3JtZXJzLm1vZGVscy5UcmFuc2Zvcm1lciIKICB9LAogIHsKICAgICJpZHgiOiAxLAogICAgIm5hbWUiOiAiMSIsCiAgICAicGF0aCI6ICIxX1Bvb2xpbmciLAogICAgInR5cGUiOiAic2VudGVuY2VfdHJhbnNmb3JtZXJzLm1vZGVscy5Qb29saW5nIgogIH0sCiAgewogICAgImlkeCI6IDIsCiAgICAibmFtZSI6ICIyIiwKICAgICJwYXRoIjogIjJfTm9ybWFsaXplIiwKICAgICJ0eXBlIjogInNlbnRlbmNlX3RyYW5zZm9ybWVycy5tb2RlbHMuTm9ybWFsaXplIgogIH0KXQ==',
  '1_Pooling/config.json': 'ewogICJ3b3JkX2VtYmVkZGluZ19kaW1lbnNpb24iOiAzODQsCiAgInBvb2xpbmdfbW9kZV9jbHNfdG9rZW4iOiBmYWxzZSwKICAicG9vbGluZ19tb2RlX21lYW5fdG9rZW5zIjogdHJ1ZSwKICAicG9vbGluZ19tb2RlX21heF90b2tlbnMiOiBmYWxzZSwKICAicG9vbGluZ19tb2RlX21lYW5fc3FydF9sZW5fdG9rZW5zIjogZmFsc2UKfQ==',
};

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
 */
async function fetchWithRetry(url, opts = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, opts);
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`  ⏳ HTTP ${response.status} — retrying in ${delayMs}ms (${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delayMs);
          continue;
        }
      }
      return response;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  ⏳ Network error: ${err.message} — retrying in ${delayMs}ms (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Try to restore a file by downloading from a URL and verifying hash/size.
 */
async function tryDownloadAndVerify(url, entry, destination) {
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
      reason: `hash/size mismatch (${bytes.length}b/${actualHash.slice(0, 12)}… vs expected ${entry.size}b/${entry.sha256.slice(0, 12)}…)`,
    };
  }

  await writeVerified(bytes, destination);
  return { ok: true };
}

async function writeVerified(bytes, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'w' });
  await rename(temporary, destination);
}

/**
 * Try to restore a file from an inline base64-encoded fallback.
 * Returns true if the decoded bytes match the expected hash/size.
 */
async function tryInlineFallback(entryPath, entry, destination) {
  const b64 = INLINE_FALLBACKS[entryPath];
  if (!b64) return false;

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256.toLowerCase()) {
    console.log(`  ⚠ Inline fallback for ${entryPath} failed hash verification — skipping.`);
    return false;
  }

  await writeVerified(bytes, destination);
  return true;
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
      console.log(`✓ ${entry.path} — cached, verified.`);
      continue;
    }

    const encodedFilePath = entry.path.split(/[\\/]/).map(encodeURIComponent).join('/');

    // Build ordered URL candidates
    const urlCandidates = candidateRevisions.map(
      (rev) => ({ label: rev.slice(0, 8), url: `https://huggingface.co/${modelPath}/resolve/${rev}/${encodedFilePath}` })
    );
    urlCandidates.push(
      { label: 'raw/main', url: `https://huggingface.co/${modelPath}/raw/main/${encodedFilePath}` }
    );

    let restored = false;
    const failures = [];

    for (const { label, url } of urlCandidates) {
      try {
        const result = await tryDownloadAndVerify(url, entry, destination);
        if (result.ok) {
          console.log(`✓ ${entry.path} — downloaded from ${label}`);
          restored = true;
          break;
        }
        failures.push(`${label}: ${result.reason}`);
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
      }
    }

    // Last resort: use inline base64 fallback for small config files
    if (!restored) {
      if (await tryInlineFallback(entry.path, entry, destination)) {
        console.log(`✓ ${entry.path} — restored from inline fallback`);
        restored = true;
      }
    }

    if (!restored) {
      throw new Error(
        `Could not restore ${entry.path} from any source.\n  Tried: ${failures.join(', ')}\n  No inline fallback available for this file.`
      );
    }
  }

  // Ensure 1_Pooling/config.json is present (sentence-transformers runtime needs it)
  const poolingPath = '1_Pooling/config.json';
  const poolingDestination = path.resolve(snapshotRoot, poolingPath);
  const poolingEntry = {
    path: poolingPath,
    size: 190,
    sha256: '4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23',
  };
  if (await readIfValid(poolingDestination, poolingEntry)) {
    console.log(`✓ ${poolingPath} — cached, verified.`);
  } else {
    let ok = false;
    for (const rev of ['c9745ed1d9f207416be6d2e6f8de32d1f16199bf', 'main']) {
      try {
        const result = await tryDownloadAndVerify(
          `https://huggingface.co/${modelPath}/resolve/${rev}/1_Pooling/config.json`,
          poolingEntry, poolingDestination,
        );
        if (result.ok) { console.log(`✓ ${poolingPath} — downloaded from ${rev.slice(0, 8)}`); ok = true; break; }
      } catch {}
    }
    if (!ok && await tryInlineFallback(poolingPath, poolingEntry, poolingDestination)) {
      console.log(`✓ ${poolingPath} — restored from inline fallback`);
      ok = true;
    }
    if (!ok) console.warn(`⚠ Could not restore ${poolingPath} — non-fatal.`);
  }

  console.log(`\n✅ Verified ${manifest.files.length} files for ${EXPECTED_MODEL}@${EXPECTED_REVISION}.`);
}

main().catch((error) => {
  console.error(`Embedding snapshot preparation failed: ${error.message}`);
  process.exitCode = 1;
});
