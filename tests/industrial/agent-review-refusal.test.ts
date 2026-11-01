/**
 * Agent-review completion gate refusal (TASK W2).
 *
 * Proves, against the real gate (prepareAgentJudgedRun, the same function the
 * GUI review path calls via POST /api/v1/industrial/judged-runs), that asking
 * to accept an analysis with no qualifying agent tool work is refused — and
 * that the refusal creates no review artifacts. No provider, no hosted calls,
 * no API key: the gate throws before any engine, audit-chain, or model use.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareAgentJudgedRun } from '../../src/industrial/judged-run';
import { createServiceContainer } from '../../src/service';

const roots: string[] = [];
const ANALYSIS_ID = 'telemetry-1793000000000-abcdef12';

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-refusal-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.maos', 'maos.config.json'), JSON.stringify({ projectName: 'maos-refusal-test' }));
  return root;
}

function allFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('agent review completion gate refuses work without qualifying tool execution', () => {
  it('refuses to prepare a review when no accepted agent report exists', () => {
    const root = makeProject();
    const services = createServiceContainer(root);

    expect(() => prepareAgentJudgedRun(root, services, ANALYSIS_ID))
      .toThrow('Accepted agent report was not found inside the active project.');
  });

  it('creates no review artifacts on refusal', () => {
    const root = makeProject();
    const services = createServiceContainer(root);
    const before = allFiles(root);

    expect(() => prepareAgentJudgedRun(root, services, ANALYSIS_ID)).toThrow();

    expect(allFiles(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, '.maos', 'industrial-runs', `judged-run-agent-${ANALYSIS_ID}.json`))).toBe(false);
    expect(fs.existsSync(path.join(root, '.maos', 'industrial', 'telemetry-analyses', 'agent-reports'))).toBe(false);
  });
});
