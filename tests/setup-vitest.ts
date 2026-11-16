import * as os from 'os';
import * as fs from 'fs';

// On macOS (Darwin), os.tmpdir() returns /var/folders/... which is a symlink to /private/var/folders/...
// Canonicalize os.tmpdir() so that temporary directories created by tests use the canonical path,
// ensuring exact string matches with fs.realpathSync() calls across all suites.
if (process.platform === 'darwin') {
  try {
    const canonicalTmp = fs.realpathSync(os.tmpdir());
    os.tmpdir = () => canonicalTmp;
  } catch {}
}
