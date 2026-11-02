/**
 * TASK DEV-A-01 (Dev A): generate_report_docx tool.
 *
 * Builds a validated OfficeDocxInput from small structured args and runs
 * it through the existing DocxGeneratorService (no rewrite), then writes
 * a markdown twin beside it. CONSEQUENTIAL: the registry flag gates the
 * human approval pause; the generator records the real approval id.
 * Emits one artifact.created per file. Markdown/DOCX both land under
 * `.maos/ring-runs/artifacts/<runId>/`.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { buildOfficeInput, generateOfficeTwin, sanitizeOfficeText, type RingOfficeSections } from './office';
import type { RingToolDeps } from './tool-deps';

function parseSectionsArgs(toolArgs: Record<string, unknown>): RingOfficeSections {
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  return {
    title: typeof toolArgs.title === 'string' ? toolArgs.title : '',
    summary: pick(toolArgs.summary),
    sections: Array.isArray(toolArgs.sections) ? (toolArgs.sections as unknown[]).slice(0, 20).map((s) => {
      const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      return { heading: typeof r.heading === 'string' ? r.heading : '', content: typeof r.content === 'string' ? r.content : '' };
    }) : [],
    findings: (toolArgs.findings as RingOfficeSections['findings'] | undefined)?.slice(0, 50) ?? [],
    measurements: (toolArgs.measurements as RingOfficeSections['measurements'] | undefined)?.slice(0, 50) ?? [],
    evidencePaths: Array.isArray(toolArgs.evidencePaths) ? (toolArgs.evidencePaths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 20) : [],
  };
}

export function createGenerateReportDocxTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'generate_report_docx',
    description:
      'Generate a validated DOCX report plus a markdown twin from structured evidence via the office generator. CONSEQUENTIAL: requires approval; emits artifact.created per file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Report title.' },
        summary: { type: 'string', description: 'Model draft summary (rendered as segregated unverified prose).' },
        sections: { type: 'array', description: 'Report sections [{ heading, content }].' },
        findings: { type: 'array', description: 'Findings [{ statement, severity, metric, observedValue, thresholdValue, unit }].' },
        measurements: { type: 'array', description: 'Measurements [{ name, numericValue, unit }].' },
        evidencePaths: { type: 'array', description: 'Evidence-root files to cite (hashed from disk).' },
      },
      required: ['title'],
    },
    consequential: true,
    execute: (toolCtx, toolArgs) => {
      let built: ReturnType<typeof buildOfficeInput>;
      try {
        built = buildOfficeInput(deps, toolCtx, parseSectionsArgs(toolArgs as Record<string, unknown>));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const title = sanitizeOfficeText(built.docxInput.title, 'title', 256);
      const lines = ['# ' + title, '', 'Synthetic demo data. Decision support only; not operating authority.', ''];
      for (const sec of built.docxInput.sections) {
        lines.push('## ' + sec.heading, '', String(sec.content || ''), '');
      }
      const stamp = String(Date.now()).slice(-6);
      return generateOfficeTwin({
        deps,
        toolCtx,
        toolName: 'generate_report_docx',
        kind: 'docx',
        input: built.docxInput,
        fileStem: 'report-' + stamp,
        markdown: truncate(lines.join('\n'), 60000),
        requestId: 'ring-' + toolCtx.runId + '-report-docx-' + stamp,
      }).payload;
    },
  };
}
