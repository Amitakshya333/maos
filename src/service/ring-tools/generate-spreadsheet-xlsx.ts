/**
 * TASK DEV-A-01 (Dev A): generate_spreadsheet_xlsx tool.
 *
 * Builds a validated OfficeXlsxInput from small structured args and runs
 * it through the existing XlsxGeneratorService (no rewrite), then writes
 * a markdown twin beside it. CONSEQUENTIAL: the registry flag gates the
 * human approval pause. Emits one artifact.created per file; both land
 * under `.maos/ring-runs/artifacts/<runId>/`.
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { buildOfficeInput, generateOfficeTwin, type RingOfficeSections } from './office';
import type { RingToolDeps } from './tool-deps';

export function createGenerateSpreadsheetXlsxTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'generate_spreadsheet_xlsx',
    description:
      'Generate a validated XLSX workbook plus a markdown twin from structured evidence via the office generator. CONSEQUENTIAL: requires approval; emits artifact.created per file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Workbook title.' },
        summary: { type: 'string', description: 'Model draft summary (rendered as segregated unverified prose).' },
        sections: { type: 'array', description: 'Sections [{ heading, content }].' },
        findings: { type: 'array', description: 'Findings [{ statement, severity, metric, observedValue, thresholdValue, unit }].' },
        measurements: { type: 'array', description: 'Measurements [{ name, numericValue, unit }].' },
        evidencePaths: { type: 'array', description: 'Evidence-root files to cite (hashed from disk).' },
      },
      required: ['title'],
    },
    consequential: true,
    execute: (toolCtx, toolArgs) => {
      const raw = toolArgs as Record<string, unknown>;
      let built: ReturnType<typeof buildOfficeInput>;
      try {
        built = buildOfficeInput(deps, toolCtx, {
          title: typeof raw.title === 'string' ? raw.title : '',
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          sections: (Array.isArray(raw.sections) ? raw.sections : []) as RingOfficeSections['sections'],
          findings: (Array.isArray(raw.findings) ? raw.findings : []) as RingOfficeSections['findings'],
          measurements: (Array.isArray(raw.measurements) ? raw.measurements : []) as RingOfficeSections['measurements'],
          evidencePaths: (Array.isArray(raw.evidencePaths) ? raw.evidencePaths : []) as string[],
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const lines = ['# ' + built.xlsxInput.title + ' (spreadsheet twin)', '', 'Synthetic demo data. Decision support only; not operating authority.', ''];
      for (const m of built.xlsxInput.measurements) {
        lines.push('- ' + m.name + ': ' + String(m.numericValue) + ' ' + m.unit);
      }
      const stamp = String(Date.now()).slice(-6);
      return generateOfficeTwin({
        deps,
        toolCtx,
        toolName: 'generate_spreadsheet_xlsx',
        kind: 'xlsx',
        input: built.xlsxInput,
        fileStem: 'spreadsheet-' + stamp,
        markdown: truncate(lines.join('\n'), 60000),
        requestId: 'ring-' + toolCtx.runId + '-spreadsheet-xlsx-' + stamp,
      }).payload;
    },
  };
}
