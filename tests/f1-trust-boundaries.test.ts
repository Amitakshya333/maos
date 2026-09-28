import { describe, it, expect } from 'vitest';
import { executeTool, AGENT_TOOLS } from '../src/integrations/tools';
import * as path from 'path';

/**
 * F1-11: Foundation regression tests for trust boundary enforcement.
 *
 * These tests verify that the security invariants established in Phase F1
 * hold across future changes. Each test documents the specific threat it guards against.
 */

const PROJECT_ROOT = path.resolve('C:/workspace/test-project');
const INDUSTRIAL_SCOPE = ['demo/industrial/'];
const FULL_SCOPE = ['/'];

describe('F1 Trust Boundary Regression Tests', () => {
  // ── F1-02: Tool filtering ──────────────────────────────────────

  describe('F1-02: Tool filtering per agent', () => {
    it('should have AGENT_TOOLS defined as an array', () => {
      expect(Array.isArray(AGENT_TOOLS)).toBe(true);
      expect(AGENT_TOOLS.length).toBeGreaterThan(0);
    });

    it('should contain expected industrial tools', () => {
      const toolNames = AGENT_TOOLS.map(t => t.function.name);
      expect(toolNames).toContain('ingest_document');
      expect(toolNames).toContain('check_compliance');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('task_complete');
    });

    it('should contain dangerous tools that must be filtered for industrial agents', () => {
      const toolNames = AGENT_TOOLS.map(t => t.function.name);
      expect(toolNames).toContain('run_command');
      expect(toolNames).toContain('git_commit');
    });
  });

  // ── F1-03: Tool authorization enforcement ──────────────────────

  describe('F1-03: Tool authorization during execution', () => {
    it('should block unauthorized tool calls', () => {
      const allowedTools = ['read_file', 'task_complete'];
      const { result } = executeTool(
        'run_command',
        { command: 'echo hello' },
        PROJECT_ROOT,
        FULL_SCOPE,
        'TEST_AGENT',
        'test-task',
        allowedTools,
      );
      expect(result).toContain('TOOL_UNAUTHORIZED');
      expect(result).toContain('run_command');
    });

    it('should allow authorized tool calls (task_complete)', () => {
      const allowedTools = ['read_file', 'task_complete'];
      const { result, isComplete } = executeTool(
        'task_complete',
        { summary: 'Test done', files_changed: [] },
        PROJECT_ROOT,
        FULL_SCOPE,
        'TEST_AGENT',
        'test-task',
        allowedTools,
      );
      expect(result).toContain('Task completed');
      expect(isComplete).toBe(true);
    });

    it('should allow all tools when allowedTools is undefined (backward compat)', () => {
      const { result } = executeTool(
        'task_complete',
        { summary: 'Test done' },
        PROJECT_ROOT,
        FULL_SCOPE,
        'TEST_AGENT',
        'test-task',
        undefined,
      );
      expect(result).toContain('Task completed');
    });

    it('should allow all tools when allowedTools is empty array (backward compat)', () => {
      const { result } = executeTool(
        'task_complete',
        { summary: 'Test done' },
        PROJECT_ROOT,
        FULL_SCOPE,
        'TEST_AGENT',
        'test-task',
        [],
      );
      expect(result).toContain('Task completed');
    });
  });

  // ── F1-04: Scope enforcement on reads ──────────────────────────

  describe('F1-04: Scope enforcement on read operations', () => {
    it('should block read_file outside agent scope', () => {
      const { result } = executeTool(
        'read_file',
        { path: 'src/core/orchestrator.ts' },
        PROJECT_ROOT,
        INDUSTRIAL_SCOPE,
        'INGEST_AGENT',
        'test-task',
        ['read_file'],
      );
      // Should be blocked by scope or path enforcement
      expect(result).toMatch(/SCOPE_VIOLATION|PATH_VIOLATION/);
    });

    it('should block list_dir outside agent scope', () => {
      const { result } = executeTool(
        'list_dir',
        { path: 'src/' },
        PROJECT_ROOT,
        INDUSTRIAL_SCOPE,
        'INGEST_AGENT',
        'test-task',
        ['list_dir'],
      );
      expect(result).toMatch(/SCOPE_VIOLATION|PATH_VIOLATION/);
    });

    it('should block ingest_document outside agent scope', () => {
      const { result } = executeTool(
        'ingest_document',
        { path: 'src/index.ts' },
        PROJECT_ROOT,
        INDUSTRIAL_SCOPE,
        'INGEST_AGENT',
        'test-task',
        ['ingest_document'],
      );
      expect(result).toMatch(/SCOPE_VIOLATION|PATH_VIOLATION|error/);
    });

    it('should block path traversal attempts on read_file', () => {
      const { result } = executeTool(
        'read_file',
        { path: '../../../etc/passwd' },
        PROJECT_ROOT,
        FULL_SCOPE,
        'TEST_AGENT',
        'test-task',
        ['read_file'],
      );
      expect(result).toContain('PATH_VIOLATION');
    });
  });

  // ── F1-05: Shell/git blocked for industrial agents ─────────────

  describe('F1-05: Shell/git blocked for industrial-scoped agents', () => {
    it('should block run_command for industrial-scoped agents (defense in depth)', () => {
      const { result } = executeTool(
        'run_command',
        { command: 'echo exploit' },
        PROJECT_ROOT,
        INDUSTRIAL_SCOPE,
        'ANALYST_AGENT',
        'test-task',
        undefined, // even without allowedTools filter
      );
      expect(result).toContain('SHELL_BLOCKED');
    });

    it('should block git_commit for industrial-scoped agents (defense in depth)', () => {
      const { result } = executeTool(
        'git_commit',
        { message: 'exploit' },
        PROJECT_ROOT,
        INDUSTRIAL_SCOPE,
        'AUDITOR_AGENT',
        'test-task',
        undefined,
      );
      expect(result).toContain('GIT_BLOCKED');
    });

    it('should allow run_command for full-scope agents', () => {
      // This test just verifies the defense-in-depth block doesn't fire for non-industrial scope
      // The command itself may fail (no real project), but it should NOT be SHELL_BLOCKED
      const { result } = executeTool(
        'run_command',
        { command: 'echo hello' },
        PROJECT_ROOT,
        FULL_SCOPE,
        'CODER_AGENT',
        'test-task',
        ['run_command'],
      );
      expect(result).not.toContain('SHELL_BLOCKED');
    });
  });

  // ── F1-06: Compliance contract correctness ─────────────────────

  describe('F1-06: Compliance contract', () => {
    it('should include ruleId in compliance findings', () => {
      const { result } = executeTool(
        'check_compliance',
        {
          measurements: { vibration_rms: 7.5 },
          thresholds: {
            vibration_rms: {
              warning: 4.5,
              critical: 7.1,
              unit: 'mm/s',
            },
          },
        },
        PROJECT_ROOT,
        FULL_SCOPE,
        'AUDITOR_AGENT',
        'test-task',
      );
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe('FAIL');
      expect(parsed.findings[0].ruleId).toBe('vibration_rms');
      expect(parsed.findings[0].unit).toBe('mm/s');
      expect(parsed.findings[0].observedNumeric).toBe(7.5);
      // Value should be preserved as string
      expect(typeof parsed.findings[0].value).toBe('string');
    });
  });

  // ── F1-10: No unsupported claims ────────────────────────────────

  describe('F1-10: No unsupported claims in AGENT_TOOLS', () => {
    it('should not reference ISO standards in tool descriptions', () => {
      for (const tool of AGENT_TOOLS) {
        const desc = tool.function.description || '';
        expect(desc).not.toContain('ISO 10816');
        expect(desc).not.toContain('tamper-proof');
        expect(desc).not.toContain('certified');
      }
    });
  });
});
