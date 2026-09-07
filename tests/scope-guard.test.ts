import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isPathInScope, validateCommand } from '../src/core/scope-guard';

describe('Scope Guard Module', () => {
  const projectRoot = path.resolve('C:/workspace/my-app');

  describe('isPathInScope', () => {
    it('should allow paths within exact scope directory', () => {
      const scope = ['src/'];
      expect(isPathInScope('src/index.ts', scope, projectRoot)).toBe(true);
      expect(isPathInScope('src/components/Button.tsx', scope, projectRoot)).toBe(true);
    });

    it('should block paths outside scope directory', () => {
      const scope = ['src/'];
      expect(isPathInScope('docs/readme.md', scope, projectRoot)).toBe(false);
      expect(isPathInScope('package.json', scope, projectRoot)).toBe(false);
    });

    it('should block path traversal attempts (../ escapes)', () => {
      const scope = ['src/'];
      expect(isPathInScope('src/../../windows/system32/cmd.exe', scope, projectRoot)).toBe(false);
      expect(isPathInScope('../outside.txt', scope, projectRoot)).toBe(false);
    });

    it('should block Windows Alternate Data Streams', () => {
      const scope = ['/'];
      expect(isPathInScope('src/index.ts:hidden', scope, projectRoot)).toBe(false);
    });

    it('should allow unrestricted scopes like "/" or "*"', () => {
      expect(isPathInScope('package.json', ['/'], projectRoot)).toBe(true);
      expect(isPathInScope('src/deep/nested/file.ts', ['*'], projectRoot)).toBe(true);
    });
  });

  describe('validateCommand', () => {
    it('should block dangerous destructive commands', () => {
      const blocked1 = validateCommand('rm -rf /', 'TEST_AGENT', projectRoot);
      expect(blocked1?.type).toBe('COMMAND_BLOCKED');

      const blocked2 = validateCommand('format C:', 'TEST_AGENT', projectRoot);
      expect(blocked2?.type).toBe('COMMAND_BLOCKED');

      const blocked3 = validateCommand('shutdown /r', 'TEST_AGENT', projectRoot);
      expect(blocked3?.type).toBe('COMMAND_BLOCKED');
    });

    it('should block credential reading attempts', () => {
      const blocked = validateCommand('cat .env', 'TEST_AGENT', projectRoot);
      expect(blocked?.type).toBe('COMMAND_BLOCKED');
    });

    it('should allow safe development commands', () => {
      expect(validateCommand('npm test', 'TEST_AGENT', projectRoot)).toBeNull();
      expect(validateCommand('npm run build', 'TEST_AGENT', projectRoot)).toBeNull();
      expect(validateCommand('git status', 'TEST_AGENT', projectRoot)).toBeNull();
    });

    it('should issue warnings on sensitive operations like git push or npm publish', () => {
      const warn = validateCommand('npm publish', 'TEST_AGENT', projectRoot);
      expect(warn?.type).toBe('COMMAND_WARNING');
    });
  });
});
