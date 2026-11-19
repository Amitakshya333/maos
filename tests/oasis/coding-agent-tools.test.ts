import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { executeTool } from '../../src/integrations/tools';
import { extractToolCallsFromContent } from '../../src/core/agent-runner';
import { resolveWorktreeTestCommand, resolveMaosPackageDir } from '../../src/cli/commands/ignite';
import { ensureWorktree, removeWorktree } from '../../src/integrations/worktree';
import { applyHotpatch, Hotpatch } from '../../src/core/autonomous-healer';

describe('Coding Agent Tools & Backend Swarm Resilience', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-tools-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('create_file tool', () => {
    it('creates file with nested parent directories safely', () => {
      const relPath = 'src/components/game/voxel-world.js';
      const content = 'export class VoxelWorld { constructor() { this.blocks = new Map(); } }';
      const res = executeTool('create_file', { path: relPath, content }, tmpDir, ['/'], 'worker-1');

      expect(res.isComplete).toBe(false);
      expect(res.result).toContain('Created: src/components/game/voxel-world.js');

      const fullPath = path.join(tmpDir, relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.readFileSync(fullPath, 'utf-8')).toBe(content);
    });

    it('blocks path traversal outside project root', () => {
      const res = executeTool('create_file', { path: '../outside.txt', content: 'hacked' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toMatch(/WRITE_BLOCKED|PATH_VIOLATION/);
      expect(fs.existsSync(path.join(tmpDir, '..', 'outside.txt'))).toBe(false);
    });

    it('enforces agent scope restrictions', () => {
      const res = executeTool(
        'create_file',
        { path: 'docs/architecture.md', content: '# Docs' },
        tmpDir,
        ['src/'],
        'worker-1',
      );
      expect(res.result).toContain('WRITE_BLOCKED');
    });

    it('refuses to write to project root directory', () => {
      const res = executeTool('create_file', { path: '.', content: 'root' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Refusing to write to project root directory');
    });

    it('refuses to create malformed JSON when path is a .json file', () => {
      const res = executeTool(
        'create_file',
        { path: 'config.json', content: '{"invalid": missing_quote}' },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('File creation rejected because JSON content is invalid');
      expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
    });
  });

  describe('list_dir tool', () => {
    it('lists files in project root with dot path safely without path violation', () => {
      fs.writeFileSync(path.join(tmpDir, 'index.js'), 'console.log(1);', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'console.log(2);', 'utf-8');

      const res = executeTool('list_dir', { path: '.' }, tmpDir, ['/'], 'worker-1');
      expect(res.isComplete).toBe(false);
      expect(res.result).toContain('Directory: .');
      expect(res.result).toContain('index.js');
      expect(res.result).toContain('src/');
    });

    it('lists files in a nested subdirectory', () => {
      fs.mkdirSync(path.join(tmpDir, 'models'));
      fs.writeFileSync(path.join(tmpDir, 'models', 'user.js'), 'export class User {}', 'utf-8');

      const res = executeTool('list_dir', { path: 'models' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Directory: models');
      expect(res.result).toContain('user.js');
    });

    it('returns error when directory does not exist', () => {
      const res = executeTool('list_dir', { path: 'nonexistent_folder' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Error: Directory not found');
    });

    it('blocks directory traversal outside project root', () => {
      const res = executeTool('list_dir', { path: '../' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('PATH_VIOLATION');
    });
  });

  describe('read_file tool with line ranges', () => {
    beforeEach(() => {
      const lines = [
        'line 1: import * as THREE from "three";',
        'line 2: export const WORLD_SIZE = 16;',
        'line 3: export function init() {',
        'line 4:   return new THREE.Scene();',
        'line 5: }',
      ];
      fs.writeFileSync(path.join(tmpDir, 'sample.ts'), lines.join('\n'), 'utf-8');
    });

    it('reads full file content when no range is specified', () => {
      const res = executeTool('read_file', { path: 'sample.ts' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('File: sample.ts (5 lines)');
      expect(res.result).toContain('export const WORLD_SIZE = 16;');
    });

    it('reads bounded line range when startLine and endLine are provided', () => {
      const res = executeTool('read_file', { path: 'sample.ts', startLine: 2, endLine: 4 }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('File: sample.ts (lines 2-4 of 5)');
      expect(res.result).toContain('line 2: export const WORLD_SIZE = 16;');
      expect(res.result).toContain('line 4:   return new THREE.Scene();');
      expect(res.result).not.toContain('line 1:');
      expect(res.result).not.toContain('line 5:');
    });

    it('reads byte slices when byteOffset and maxBytes are provided', () => {
      const res = executeTool(
        'read_file',
        { path: 'sample.ts', byteOffset: 0, maxBytes: 15 },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('File: sample.ts (bytes 0-15 of');
      expect(res.result).toContain('line 1: import');
    });

    it('returns error when file is not found', () => {
      const res = executeTool('read_file', { path: 'nonexistent.ts' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Error: File not found');
    });
  });

  describe('edit_file tool', () => {
    beforeEach(() => {
      const code = 'const count = 10;\nfunction test() {\n  return count;\n}\n';
      fs.writeFileSync(path.join(tmpDir, 'math.js'), code, 'utf-8');
    });

    it('replaces exact target string safely', () => {
      const res = executeTool(
        'edit_file',
        { path: 'math.js', target: 'const count = 10;', replacement: 'const count = 25;' },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('Successfully edited math.js');
      const edited = fs.readFileSync(path.join(tmpDir, 'math.js'), 'utf-8');
      expect(edited).toContain('const count = 25;');
      expect(edited).not.toContain('const count = 10;');
    });

    it('reports error when target string is not found without modifying file', () => {
      const before = fs.readFileSync(path.join(tmpDir, 'math.js'), 'utf-8');
      const res = executeTool(
        'edit_file',
        { path: 'math.js', target: 'nonexistent string', replacement: 'foo' },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('Error: Target string not found');
      const after = fs.readFileSync(path.join(tmpDir, 'math.js'), 'utf-8');
      expect(after).toBe(before);
    });

    it('preserves $ character sequences without regex group substitution corruption', () => {
      const code = 'const regex = /(\\w+)/;\nconst template = "val";\n';
      fs.writeFileSync(path.join(tmpDir, 'regex.js'), code, 'utf-8');

      const res = executeTool(
        'edit_file',
        { path: 'regex.js', target: '"val"', replacement: '"$1-$2-$$"' },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('Successfully edited regex.js');
      const edited = fs.readFileSync(path.join(tmpDir, 'regex.js'), 'utf-8');
      expect(edited).toContain('"$1-$2-$$"');
    });

    it('matches and edits files with Windows CRLF newlines when target has LF', () => {
      const crlfContent = 'function hello() {\r\n  console.log("world");\r\n}\r\n';
      fs.writeFileSync(path.join(tmpDir, 'crlf.js'), crlfContent, 'utf-8');

      const res = executeTool(
        'edit_file',
        {
          path: 'crlf.js',
          target: 'function hello() {\n  console.log("world");',
          replacement: 'function hello() {\n  console.log("universe");',
        },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('Successfully edited crlf.js');
      const edited = fs.readFileSync(path.join(tmpDir, 'crlf.js'), 'utf-8');
      expect(edited).toContain('universe');
    });

    it('prevents JSON corruption by validating syntax before saving', () => {
      const validJson = JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), validJson, 'utf-8');

      // Attempt invalid JSON edit (e.g. unquoted, missing comma, corrupted key)
      const res = executeTool(
        'edit_file',
        { path: 'package.json', target: '"version": "1.0.0"', replacement: '"version": 1.0.0 "corrupted"' },
        tmpDir,
        ['/'],
        'worker-1',
      );
      expect(res.result).toContain('Error: Edit rejected because resulting JSON is invalid');

      // Verify file was NOT corrupted on disk!
      const content = fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  describe('delete_file tool', () => {
    it('deletes an existing file within allowed scope', () => {
      fs.writeFileSync(path.join(tmpDir, 'temp.txt'), 'hello', 'utf-8');
      const res = executeTool('delete_file', { path: 'temp.txt' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Successfully deleted: temp.txt');
      expect(fs.existsSync(path.join(tmpDir, 'temp.txt'))).toBe(false);
    });

    it('refuses to delete project root or empty path', () => {
      const res = executeTool('delete_file', { path: '.' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Refusing to delete project root directory');
    });

    it('refuses to delete git internal metadata', () => {
      const res = executeTool('delete_file', { path: '.git/config' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Cannot delete Git internal metadata');
    });

    it('refuses to delete directories', () => {
      fs.mkdirSync(path.join(tmpDir, 'subfolder'));
      const res = executeTool('delete_file', { path: 'subfolder' }, tmpDir, ['/'], 'worker-1');
      expect(res.result).toContain('Cannot delete directory');
    });
  });

  describe('extractToolCallsFromContent (Local Model Output Parser)', () => {
    it('extracts action block from markdown code blocks', () => {
      const modelOutput = `
I will now build the Minecraft Mini game layout.

\`\`\`json
{
  "action": "create_file",
  "path": "index.html",
  "content": "<!DOCTYPE html><html><body>Minecraft</body></html>"
}
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
      const parsedArgs = JSON.parse(calls[0].function.arguments);
      expect(parsedArgs.path).toBe('index.html');
      expect(parsedArgs.content).toContain('Minecraft');
    });

    it('extracts multiple action blocks in sequence', () => {
      const modelOutput = `
\`\`\`json
{ "action": "create_file", "path": "game.js", "content": "console.log('voxel');" }
\`\`\`
Then I will run the test:
\`\`\`json
{ "action": "run_command", "command": "node --check game.js" }
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(2);
      expect(calls[0].function.name).toBe('create_file');
      expect(calls[1].function.name).toBe('run_command');
    });

    it('extracts tool calls from function call object syntax', () => {
      const modelOutput = `
\`\`\`json
{
  "name": "edit_file",
  "arguments": {
    "path": "game.js",
    "target": "v1",
    "replacement": "v2"
  }
}
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('edit_file');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.replacement).toBe('v2');
    });

    it('extracts inline raw JSON action without markdown formatting', () => {
      const modelOutput = `I'll create the file now: {"action": "create_file", "path": "style.css", "content": "body { margin: 0; }"}`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
    });

    it('extracts tool calls even when content contains raw unescaped newlines in JSON strings', () => {
      const modelOutput = `
\`\`\`json
{
  "action": "create_file",
  "path": "server.js",
  "content": "const http = require('http');
const server = http.createServer();
server.listen(3000);"
}
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.content).toContain('server.listen(3000)');
    });

    it('extracts tool calls when content includes nested markdown blocks inside a file', () => {
      const modelOutput = `
\`\`\`json
{
  "action": "create_file",
  "path": "README.md",
  "content": "# Docs\\n\`\`\`bash\\nnpm start\\n\`\`\`"
}
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.path).toBe('README.md');
      expect(args.content).toContain('npm start');
    });

    it('extracts tool calls using alternative schema aliases like call and args', () => {
      const modelOutput = `
\`\`\`json
{
  "call": "run_command",
  "args": {
    "command": "node --check index.js"
  }
}
\`\`\`
`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('run_command');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.command).toBe('node --check index.js');
    });

    it('extracts tool calls even when content has stray closing braces before the JSON block', () => {
      const modelOutput = `Here is the solution to } problem:
{"action": "create_file", "path": "app.js", "content": "console.log('fixed');"}`;
      const calls = extractToolCallsFromContent(modelOutput);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.path).toBe('app.js');
    });

    it('sanitizes Windows path backslashes in JSON strings without throwing syntax error', () => {
      const rawText =
        '```json\n{"action": "create_file", "path": "src\\components\\Button.js", "content": "export function Button() {}"}\n```';
      const calls = extractToolCallsFromContent(rawText);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('create_file');
      const args = JSON.parse(calls[0].function.arguments);
      expect(args.path).toContain('Button.js');
    });
  });

  describe('resolveWorktreeTestCommand Goal-Awareness', () => {
    it('does NOT run Canva 3D test when goal is a Minecraft game', () => {
      // Simulate repo structure with Canva 3D app present
      const canvaDir = path.join(tmpDir, 'apps', 'canva-3d', 'tests');
      fs.mkdirSync(canvaDir, { recursive: true });
      fs.writeFileSync(path.join(canvaDir, 'canva-3d.test.js'), '// canva test', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'repo' }), 'utf-8');

      // When goal is Minecraft, it should NOT return Canva test
      const cmd = resolveWorktreeTestCommand(tmpDir, 'create a mini Minecraft game');
      expect(cmd).not.toContain('canva-3d.test.js');
    });

    it('runs Canva 3D test when goal specifically asks for Canva 3D Spatial Studio', () => {
      const canvaDir = path.join(tmpDir, 'apps', 'canva-3d', 'tests');
      fs.mkdirSync(canvaDir, { recursive: true });
      fs.writeFileSync(path.join(canvaDir, 'canva-3d.test.js'), '// canva test', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'repo' }), 'utf-8');

      const cmd = resolveWorktreeTestCommand(tmpDir, 'Build and deploy Canva 3D Spatial Studio');
      expect(cmd).toBe('node --test apps/canva-3d/tests/canva-3d.test.js');
    });

    it('does NOT execute internal repository test suites for arbitrary user goals', () => {
      // Simulate repo structure with internal repo tests present (e.g. brain.test.ts)
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'brain.test.ts'), '// internal vitest test', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'repo' }), 'utf-8');

      const cmd = resolveWorktreeTestCommand(tmpDir, 'build an arbitrary weather tracker');
      expect(cmd).not.toContain('brain.test.ts');
    });

    it('dynamically adapts to created test files for any goal', () => {
      const testsDir = path.join(tmpDir, 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, 'calculator.test.js'), '// calc test', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'repo' }), 'utf-8');

      const cmd = resolveWorktreeTestCommand(tmpDir, 'build a scientific calculator');
      expect(cmd).toBe('node --test tests/calculator.test.js');
    });

    it('dynamically discovers arbitrary JS source files without hardcoded heuristics', () => {
      fs.writeFileSync(path.join(tmpDir, 'simulation_engine.js'), 'export class Engine {}', 'utf-8');
      const cmd = resolveWorktreeTestCommand(tmpDir, 'build a physics simulation');
      expect(cmd).toBe('node --check simulation_engine.js');
    });

    it('dynamically discovers Python scripts for python-based goals', () => {
      fs.writeFileSync(path.join(tmpDir, 'scraper.py'), 'print("scrape")', 'utf-8');
      const cmd = resolveWorktreeTestCommand(tmpDir, 'write a web scraper');
      expect(cmd).toBe('python -m py_compile scraper.py');
    });

    it('respects project-specific package.json test scripts', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-custom-tool', scripts: { test: 'node custom_test.js' } }),
        'utf-8',
      );
      const cmd = resolveWorktreeTestCommand(tmpDir, 'build custom tool');
      expect(cmd).toBe('npm test --silent');
    });

    it('resolves MAOS package directory reliably from cwd or subdirectories', () => {
      const pkgDir = resolveMaosPackageDir(tmpDir);
      expect(typeof pkgDir).toBe('string');
      expect(pkgDir.length).toBeGreaterThan(0);
    });
  });

  describe('AutonomousHealer JSON Integrity', () => {
    it('refuses to apply hotpatch that corrupts JSON syntax', () => {
      const initialPkg = JSON.stringify({ name: 'my-project', scripts: { test: 'node' } }, null, 2);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), initialPkg, 'utf-8');

      const corruptedPatch: Hotpatch = {
        diagnosis: 'Test missing module',
        rationale: 'Insert dependency',
        ops: [
          {
            type: 'insert-line',
            file: 'package.json',
            line: 2,
            content: '"corrupted_entry_no_comma"',
          },
        ],
        verificationCommand: 'npx tsc --noEmit',
        confidence: 0.8,
        needsLlm: false,
      };

      expect(() => applyHotpatch(corruptedPatch, tmpDir)).toThrow(/Refusing to apply patch.*malformed/);

      // Verify file was NOT corrupted
      const currentContent = fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf-8');
      expect(() => JSON.parse(currentContent)).not.toThrow();
    });
  });

  describe('Worktree Package.json Integrity & Auto-Repair', () => {
    it('restores clean package.json if worktree contains malformed JSON from prior aborted run', () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@maos.internal"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test Runner"', { cwd: tmpDir, stdio: 'ignore' });

      const cleanPkg = JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), cleanPkg, 'utf-8');
      execSync('git add package.json && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

      // Create worktree
      const wt = ensureWorktree('repair-agent', 'test-repair-branch', tmpDir);
      const wtPkgPath = path.join(wt.worktreePath, 'package.json');
      expect(fs.existsSync(wtPkgPath)).toBe(true);

      // Deliberately corrupt package.json in the worktree (simulating worker-2 failure in screenshot)
      fs.writeFileSync(wtPkgPath, '{"corrupted": "missing quote, no comma}', 'utf-8');
      expect(() => JSON.parse(fs.readFileSync(wtPkgPath, 'utf-8'))).toThrow();

      // Calling ensureWorktree on reuse must detect the malformed JSON and restore a clean copy
      const reusedWt = ensureWorktree('repair-agent', 'test-repair-branch', tmpDir);
      expect(reusedWt.worktreePath).toBe(wt.worktreePath);

      const repairedContent = fs.readFileSync(wtPkgPath, 'utf-8');
      expect(() => JSON.parse(repairedContent)).not.toThrow();
      expect(JSON.parse(repairedContent).name).toBe('test-app');

      removeWorktree('repair-agent', tmpDir);
    });
  });
});
