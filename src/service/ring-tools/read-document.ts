/**
 * TASK DEV-A-01 (Dev A): read_company_document tool module.
 *
 * Migrated verbatim from `RingAgentService.toolReadCompanyDocument`: same
 * input (`path` relative to the run evidence root), same
 * isWithin/isStrictlyWithin + realpath checks, same 256 KB limit, same CSV
 * refusal text, same truncate(content, 6000) output shape.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { isStrictlyWithin, isWithin } from './common';
import type { RingToolDeps } from './tool-deps';

export function createReadCompanyDocumentTool(_deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'read_company_document',
    description:
      'Read a text company document located under the project evidence root. Paths outside the evidence root are refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Document path relative to the evidence root (or project-relative inside it).' },
      },
      required: ['path'],
    },
    consequential: false,
    execute: (ctx, args) => {
      const requested = typeof args.path === 'string' ? (args.path as string).trim() : '';
      if (!requested) throw new Error('read_company_document requires a non-empty path.');
      const evidenceRoot = ctx.evidenceRoot;
      const evidenceRelToProject = path.relative(ctx.projectRoot, evidenceRoot);
      let candidate: string;
      if (path.isAbsolute(requested)) candidate = path.resolve(requested);
      else if (
        evidenceRelToProject &&
        (requested === evidenceRelToProject.split(path.sep).join('/') ||
          requested.startsWith(`${evidenceRelToProject.split(path.sep).join('/')}/`))
      )
        candidate = path.resolve(ctx.projectRoot, requested);
      else candidate = path.resolve(evidenceRoot, requested);
      if (!isWithin(evidenceRoot, candidate) || candidate === evidenceRoot) {
        throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
      }
      if (!fs.existsSync(candidate)) throw new Error(`Company document not found under the evidence root: ${requested}`);
      const realRoot = fs.realpathSync(evidenceRoot);
      const realCandidate = fs.realpathSync(candidate);
      if (!isStrictlyWithin(realRoot, realCandidate)) {
        throw new Error(`PATH_OUTSIDE_EVIDENCE_ROOT: refused to read outside the evidence root: ${requested}`);
      }
      const stat = fs.statSync(realCandidate);
      if (!stat.isFile()) throw new Error(`Company document is not a file: ${requested}`);
      if (stat.size > 256 * 1024) throw new Error(`Company document exceeds the 256 KB read limit: ${requested}`);
      const rel = path.relative(ctx.projectRoot, realCandidate).split(path.sep).join('/');
      if (path.extname(realCandidate).toLowerCase() === '.csv') {
        const bytes = fs.readFileSync(realCandidate);
        return {
          path: rel,
          bytes: stat.size,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          content: 'CSV content is not returned raw. Use analyze_telemetry for the deterministic telemetry summary.',
        };
      }
      const content = fs.readFileSync(realCandidate, 'utf-8');
      return { path: rel, bytes: stat.size, content: truncate(content, 6000), truncated: content.length > 6000 };
    },
  };
}
