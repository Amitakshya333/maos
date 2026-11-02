/**
 * TASK DEV-A-01 (Dev A): draft_safety_note tool module.
 *
 * Migrated verbatim from RingAgentService.toolDraftSafetyNote: same input
 * (content required; title/filename sanitized), same
 * `.maos/ring-runs/drafts/<runId>-<safe>.md` write with `wx` flag, same
 * sha256/bytes output. CONSEQUENTIAL: the registry flag (not the model)
 * gates the approval pause before any file is written.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RingToolDefinition } from '../ring-contract';
import type { RingToolDeps } from './tool-deps';

export function createDraftSafetyNoteTool(_deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'draft_safety_note',
    description:
      'Draft a safety note as text and write it under .maos/ring-runs/drafts after human approval. CONSEQUENTIAL: requires approval before any file is written.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' }, filename: { type: 'string' } },
      required: ['content'],
    },
    consequential: true,
    execute: (toolCtx, toolArgs) => {
      const content = typeof toolArgs.content === 'string' ? toolArgs.content : '';
      if (!content.trim()) throw new Error('draft_safety_note requires non-empty content.');
      const title = typeof toolArgs.title === 'string' && toolArgs.title.trim() ? toolArgs.title.trim() : 'Safety Note';
      const rawName = typeof toolArgs.filename === 'string' && toolArgs.filename.trim() ? path.basename(toolArgs.filename.trim()) : 'safety-note.md';
      const safeBase = rawName.replace(/\.(md|txt)$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'safety-note';
      const draftsDir = path.join(toolCtx.projectRoot, '.maos', 'ring-runs', 'drafts');
      fs.mkdirSync(draftsDir, { recursive: true });
      const filename = toolCtx.runId + '-' + safeBase + '.md';
      const filePath = path.join(draftsDir, filename);
      const body = '# ' + title + '\n\n' + content.trim() + '\n\n---\nDrafted by Ring agent run ' + toolCtx.runId + ' after human approval.\n';
      fs.writeFileSync(filePath, body, { flag: 'wx' });
      return {
        written: true,
        path: path.relative(toolCtx.projectRoot, filePath).split(path.sep).join('/'),
        bytes: Buffer.byteLength(body, 'utf-8'),
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        title,
      };
    },
  };
}
