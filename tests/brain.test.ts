import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveBrain, loadBrain, BrainData } from '../src/core/brain';

describe('Brain Module (Atomic Updates)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-brain-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save and load brain data atomically', () => {
    const mockBrain: BrainData = {
      generatedAt: new Date().toISOString(),
      projectRoot: testDir,
      totalFiles: 5,
      totalSize: 1024,
      languages: { TypeScript: 5 },
      structure: { src: ['index.ts', 'app.ts'] },
      files: [{ path: 'src/index.ts', size: 500, type: 'file', language: 'TypeScript', category: 'source' }],
    };

    saveBrain(testDir, mockBrain);

    const loaded = loadBrain(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.totalFiles).toBe(5);
    expect(loaded?.languages.TypeScript).toBe(5);
    expect(loaded?.files[0].path).toBe('src/index.ts');

    // Verify architecture.md was also generated
    const archPath = path.join(testDir, '.maos', 'brain', 'architecture.md');
    expect(fs.existsSync(archPath)).toBe(true);
    const archContent = fs.readFileSync(archPath, 'utf-8');
    expect(archContent).toContain('Project Architecture');
  });
});
