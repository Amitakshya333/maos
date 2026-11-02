/**
 * TASK DEV-A-01 (Dev A): write_shift_handover tool.
 *
 * Builds a structured shift handover note (outgoing/incoming shifts, open
 * items, watch-outs) as a validated DOCX plus a markdown twin via the
 * shared office builder. CONSEQUENTIAL: the registry flag gates the human
 * approval pause. Emits one artifact.created per file; both land under
 * `.maos/ring-runs/artifacts/<runId>/`.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { buildOfficeInput, generateOfficeTwin } from './office';
import type { RingToolDeps } from './tool-deps';

export function createWriteShiftHandoverTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'write_shift_handover',
    description:
      'Write a structured shift handover note (shifts, open items, watch-outs) as DOCX plus markdown. CONSEQUENTIAL: requires approval; emits artifact.created per file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Handover title.' },
        outgoingShift: { type: 'string', description: 'Outgoing shift label.' },
        incomingShift: { type: 'string', description: 'Incoming shift label.' },
        openItems: { type: 'array', description: 'Open items for the next shift.' },
        watchOuts: { type: 'array', description: 'Watch-outs and cautions.' },
        evidencePaths: { type: 'array', description: 'Evidence-root files to cite (hashed from disk).' },
      },
      required: ['title'],
    },
    consequential: true,
    execute: (toolCtx, toolArgs) => {
      const raw = toolArgs as Record<string, unknown>;
      const pick = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : '');
      const list = (v: unknown): string[] =>
        Array.isArray(v) ? (v as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 20).map((a) => a.trim()) : [];
      const outgoing = pick(raw.outgoingShift) || 'Day shift';
      const incoming = pick(raw.incomingShift) || 'Night shift';
      const openItems = list(raw.openItems);
      const watchOuts = list(raw.watchOuts);
      const evidencePaths = list(raw.evidencePaths);
      let built: ReturnType<typeof buildOfficeInput>;
      try {
        built = buildOfficeInput(deps, toolCtx, {
          title: typeof raw.title === 'string' ? raw.title : '',
          sections: [
            { heading: 'Outgoing shift', content: outgoing },
            { heading: 'Incoming shift', content: incoming },
            { heading: 'Open items', content: openItems.length > 0 ? openItems.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'None recorded.' },
            { heading: 'Watch-outs', content: watchOuts.length > 0 ? watchOuts.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'None recorded.' },
          ],
          evidencePaths,
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const md = [
        '# Shift handover: ' + built.docxInput.title,
        '',
        'Outgoing: ' + outgoing + '  |  Incoming: ' + incoming,
        '',
        '## Open items',
        '',
        openItems.length > 0 ? openItems.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'None recorded.',
        '',
        '## Watch-outs',
        '',
        watchOuts.length > 0 ? watchOuts.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'None recorded.',
        '',
        'Synthetic demo data. Decision support only; not operating authority.',
      ].join('\n');
      const stamp = String(Date.now()).slice(-6);
      return generateOfficeTwin({
        deps,
        toolCtx,
        toolName: 'write_shift_handover',
        kind: 'docx',
        input: built.docxInput,
        fileStem: 'handover-' + stamp,
        markdown: truncate(md, 60000),
        requestId: 'ring-' + toolCtx.runId + '-handover-' + stamp,
      }).payload;
    },
  };
}
