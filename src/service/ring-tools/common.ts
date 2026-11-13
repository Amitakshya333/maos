/**
 * TASK DEV-A-01 (Dev A): shared helpers for the Day 2 Ring tools.
 *
 * - Evidence-root path resolution reuses the `isWithin`/`isStrictlyWithin`
 *   pattern from `ring-agent-service.ts` (same failure strings).
 * - Artifact descriptors match the frozen `RingArtifactDescriptor` shape.
 * - Office input construction maps small structured tool args onto the
 *   validated `OfficeDocxInput` / `OfficeXlsxInput` contracts without
 *   inventing citations: every citation is hashed from the file on disk by
 *   the tool itself, and freshness is verified by the generator.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RingArtifactDescriptor } from '../ring-contract';

export function isWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function isStrictlyWithin(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function truncateLocal(value: string, max = 1000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`;
}

/**
 * Resolve a tool-supplied path against the evidence root.
 * Accepts evidence-root-relative paths and project-relative paths that
 * stay inside the evidence root. Absolute paths are resolved and checked.
 * Mirrors `toolReadCompanyDocument` semantics.
 */
export function resolveEvidencePath(
  evidenceRoot: string,
  projectRoot: string,
  requested: string,
): { abs: string; rel: string } {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (!trimmed) throw new Error('PATH_OUTSIDE_EVIDENCE_ROOT: a non-empty path is required.');
  const evidenceRelToProject = path.relative(projectRoot, evidenceRoot);
  let candidate: string;
  if (path.isAbsolute(trimmed)) candidate = path.resolve(trimmed);
  else if (
    evidenceRelToProject &&
    (trimmed === evidenceRelToProject.split(path.sep).join('/') ||
      trimmed.startsWith(`${evidenceRelToProject.split(path.sep).join('/')}/`))
  )
    candidate = path.resolve(projectRoot, trimmed);
  else candidate = path.resolve(evidenceRoot, trimmed);
  if (!isWithin(evidenceRoot, candidate) || candidate === evidenceRoot) {
    throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`EVIDENCE_NOT_FOUND: no file under the evidence root at: ${requested}`);
  }
  const realRoot = fs.realpathSync(evidenceRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isStrictlyWithin(realRoot, realCandidate)) {
    throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile()) throw new Error(`EVIDENCE_NOT_FILE: not a file under the evidence root: ${requested}`);
  let realProjectRoot: string;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
  } catch {
    realProjectRoot = path.resolve(projectRoot);
  }
  return { abs: realCandidate, rel: path.relative(realProjectRoot, realCandidate).split(path.sep).join('/') };
}

/** Save a buffer/string under the run artifact dir; returns the descriptor. */
export function saveRunArtifact(
  projectRoot: string,
  runId: string,
  filename: string,
  content: string | Buffer,
  kind: string,
): RingArtifactDescriptor {
  const safe =
    path
      .basename(filename)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^\.+/, '') || 'artifact.bin';
  const dir = path.resolve(projectRoot, '.maos', 'ring-runs', 'artifacts', runId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, safe);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  fs.writeFileSync(abs, buf);
  let realProjectRoot: string;
  let realAbs: string;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
    realAbs = fs.realpathSync(abs);
  } catch {
    realProjectRoot = path.resolve(projectRoot);
    realAbs = abs;
  }
  const rel = path.relative(realProjectRoot, realAbs).split(path.sep).join('/');
  return {
    path: rel,
    kind,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** Read a small evidence text file with a byte cap; CSV bodies are refused. */
export function readEvidenceText(
  abs: string,
  rel: string,
  maxBytes = 256 * 1024,
): { text: string; bytes: number; sha256: string; refusedCsv: boolean } {
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) {
    throw new Error(`EVIDENCE_TOO_LARGE: file exceeds the ${maxBytes}-byte read limit: ${rel}`);
  }
  const bytes = fs.readFileSync(abs);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (path.extname(abs).toLowerCase() === '.csv') {
    return { text: '', bytes: stat.size, sha256, refusedCsv: true };
  }
  return { text: bytes.toString('utf-8'), bytes: stat.size, sha256, refusedCsv: false };
}

/** First non-empty lines of text for citation snippets (bounded). */
export function snippetForCitation(text: string, max = 300): string {
  return truncateLocal(text.trim(), max);
}
