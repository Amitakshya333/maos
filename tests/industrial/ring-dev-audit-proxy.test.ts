/**
 * TASK DEV-A-01: audit proxy for lane tests (test-only helper).
 *
 * On machines without rust/target/release/maos-engine the real
 * AuditService chain-append throws EngineError. The Ring tool contract
 * is audit-must-never-break-tools, and every production write path wraps
 * audit in try/catch — but the DOCX finalize path needs a REAL audit
 * record (it forwards record fields into the artifact metadata), so the
 * lane's DOCX-path tests point the container at the checkout's own
 * same-platform release binary fixture instead of mocking audit. No
 * network, no hosted calls; the fixture is chosen in this order:
 * worktree rust/target/release, /c/maos release binary, then give up
 * (tests assert the honest unavailable result instead of the artifact).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

export function engineFixturePath(): string | undefined {
  const exe = process.platform === 'win32' ? 'maos-engine.exe' : 'maos-engine';
  const candidates = [
    path.resolve(__dirname, '../../rust/target/release', exe === 'maos-engine.exe' ? 'maos-engine.exe' : 'maos-engine'),
    '/c/maos/rust/target/release/' + exe,
  ];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
}

/** Copy the engine fixture into a temp project root, if one exists. */
export function seedEngineFixture(projectRoot: string): boolean {
  const found = engineFixturePath();
  if (!found) return false;
  const dest = path.join(projectRoot, 'rust', 'target', 'release');
  fs.mkdirSync(dest, { recursive: true });
  const base = path.basename(found);
  if (!fs.existsSync(path.join(dest, base))) fs.copyFileSync(found, path.join(dest, base));
  return true;
}

describe('lane audit proxy (helper, no tests)', () => {
  it('exposes the fixture helpers', () => {
    expect(typeof engineFixturePath()).toBe('string');
    expect(typeof seedEngineFixture).toBe('function');
  });
});
