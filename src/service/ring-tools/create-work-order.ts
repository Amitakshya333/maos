/**
 * TASK DEV-A-01 (Dev A): create_work_order tool.
 *
 * Builds a structured work order (asset, finding, evidence, priority,
 * requested actions) as a validated DOCX plus a markdown twin via the
 * shared office builder. CONSEQUENTIAL: the registry flag gates the human
 * approval pause. Emits one artifact.created per file; both land under
 * `.maos/ring-runs/artifacts/<runId>/`.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { buildOfficeInput, generateOfficeTwin } from './office';
import type { RingToolDeps } from './tool-deps';

const PRIORITIES = ['routine', 'urgent', 'emergency'] as const;

export function createWorkOrderTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'create_work_order',
    description:
      'Create a structured work order (asset, finding, evidence, priority, requested actions) as DOCX plus markdown. CONSEQUENTIAL: requires approval; emits artifact.created per file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Work order title.' },
        assetId: { type: 'string', description: 'Asset identifier, e.g. T-07.' },
        finding: { type: 'string', description: 'What was found.' },
        priority: { type: 'string', description: 'routine|urgent|emergency (default routine).' },
        requestedActions: { type: 'array', description: 'Requested actions.' },
        evidencePaths: { type: 'array', description: 'Evidence-root files to cite (hashed from disk).' },
      },
      required: ['title', 'finding'],
    },
    consequential: true,
    execute: (toolCtx, toolArgs) => {
      const raw = toolArgs as Record<string, unknown>;
      const finding = typeof raw.finding === 'string' ? raw.finding.trim() : '';
      if (!finding) return { ok: false, error: 'create_work_order requires a non-empty finding.' };
      const assetId = typeof raw.assetId === 'string' && raw.assetId.trim() ? raw.assetId.trim().slice(0, 60) : 'T-07';
      const priorityRaw = typeof raw.priority === 'string' ? raw.priority.trim().toLowerCase() : 'routine';
      const priority = (PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : 'routine';
      const actions = Array.isArray(raw.requestedActions)
        ? (raw.requestedActions as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 20).map((a) => a.trim())
        : [];
      const evidencePaths = Array.isArray(raw.evidencePaths)
        ? (raw.evidencePaths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 20)
        : [];
      let built: ReturnType<typeof buildOfficeInput>;
      try {
        built = buildOfficeInput(deps, toolCtx, {
          title: typeof raw.title === 'string' ? raw.title : '',
          sections: [
            { heading: 'Asset', content: assetId },
            { heading: 'Priority', content: priority.toUpperCase() + ' - pending authorized human review' },
            { heading: 'Requested actions', content: actions.length > 0 ? actions.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'To be defined by the authorized reviewer.' },
          ],
          findings: [{ statement: finding.slice(0, 2000), severity: priority === 'routine' ? 'info' : 'warning', metric: 'work-order-finding', unit: 'n/a' }],
          evidencePaths,
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const md = [
        '# Work order: ' + built.docxInput.title,
        '',
        'Asset: ' + assetId,
        'Priority: ' + priority.toUpperCase() + ' (pending authorized human review)',
        '',
        '## Finding',
        '',
        finding,
        '',
        '## Requested actions',
        '',
        actions.length > 0 ? actions.map((a, i) => String(i + 1) + '. ' + a).join('\n') : 'To be defined by the authorized reviewer.',
        '',
        'Synthetic demo data. Decision support only; not operating authority.',
        'Citations: ' + built.docxInput.citations.map((c) => c.sourcePath).join(', '),
      ].join('\n');
      const stamp = String(Date.now()).slice(-6);
      return generateOfficeTwin({
        deps,
        toolCtx,
        toolName: 'create_work_order',
        kind: 'docx',
        input: built.docxInput,
        fileStem: 'work-order-' + stamp,
        markdown: truncate(md, 60000),
        requestId: 'ring-' + toolCtx.runId + '-work-order-' + stamp,
      }).payload;
    },
  };
}
