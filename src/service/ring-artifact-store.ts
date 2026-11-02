/**
 * TASK DEV-C-01 (Day 2): artifact store implementation.
 *
 * Implements the frozen `RingArtifactStore` interface declared in
 * `ring-artifacts.ts`:
 *  - Artifacts are stored under `.maos/ring-runs/artifacts/<runId>/`.
 *  - `resolveArtifactPath` reuses the `isWithin`/`isStrictlyWithin` pattern
 *    (never serves outside the run dir).
 *  - `artifact.created` streaming events carry `{ path, kind, size, sha256 }`
 *    (the frozen `RingArtifactDescriptor` shape).
 *
 * This class only writes files; the agent loop / router decide WHAT to
 * write and record the `artifact.created` event. Nothing here calls the
 * network; nothing fabricates hashes (sha256 is computed from bytes).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RingArtifactDescriptor } from './ring-contract';

export interface RingArtifactStore {
  artifactDir(runId: string): string;
  saveArtifact(runId: string, filename: string, content: string | Buffer, kind: string): RingArtifactDescriptor;
  resolveArtifactPath(runId: string, filename: string): string;
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export class RingArtifactService implements RingArtifactStore {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  artifactDir(runId: string): string {
    return path.join(this.projectRoot, '.maos', 'ring-runs', 'artifacts', runId);
  }

  saveArtifact(runId: string, filename: string, content: string | Buffer, kind: string): RingArtifactDescriptor {
    const safe =
      path
        .basename(filename)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '') || 'artifact.bin';
    const dir = this.artifactDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, safe);
    if (!isWithin(dir, abs) || abs === dir) {
      throw new Error(`ARTIFACT_PATH_ESCAPE: refused to write outside the run artifact dir: ${filename}`);
    }
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    fs.writeFileSync(abs, buf);
    const rel = path.relative(this.projectRoot, abs).split(path.sep).join('/');
    return { path: rel, kind, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }

  resolveArtifactPath(runId: string, filename: string): string {
    const dir = path.resolve(this.artifactDir(runId));
    if (typeof filename !== 'string' || !filename.trim() || filename.includes(String.fromCharCode(0))) {
      throw new Error(`ARTIFACT_PATH_ESCAPE: refused to serve outside the run artifact dir: ${filename}`);
    }
    // Nested separators are rejected outright (flat run dir) rather than
    // collapsed: collapsing `a/../../b` to `b` would hide a traversal probe.
    if (/[/\\]/.test(filename) || filename === '.' || filename === '..') {
      throw new Error(`ARTIFACT_PATH_ESCAPE: refused to serve outside the run artifact dir: ${filename}`);
    }
    const abs = path.resolve(dir, filename);
    if (!isWithin(dir, abs) || abs === dir) {
      throw new Error(`ARTIFACT_PATH_ESCAPE: refused to serve outside the run artifact dir: ${filename}`);
    }
    return abs;
  }
}
