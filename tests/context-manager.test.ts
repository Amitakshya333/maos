import { describe, it, expect, vi } from 'vitest';
import { compressContext, snapshotFilesystem, retryOnTransient } from '../src/core/context-manager';
import type { ChatMessage } from '../src/backends/provider';

describe('compressContext', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  };

  it('does nothing when message count is small', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'Do task' },
      { role: 'assistant', content: 'OK' },
    ];
    const originalLength = msgs.length;
    compressContext(msgs, mockLogger as any, 'test-agent');
    expect(msgs.length).toBe(originalLength);
  });

  it('compresses middle messages into summary when conversation is large', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'Do task' },
    ];
    // Add 20 messages (10 assistant + 10 tool)
    for (let i = 0; i < 10; i++) {
      msgs.push({
        role: 'assistant',
        content: `thinking ${i}`,
        tool_calls: [
          {
            id: `call_${i}`,
            type: 'function' as const,
            function: { name: 'read_file', arguments: JSON.stringify({ path: `/file${i}.ts` }) },
          },
        ],
      });
      msgs.push({ role: 'tool', content: `file content ${i}`, name: 'read_file', tool_call_id: `call_${i}` });
    }

    const originalLength = msgs.length;
    expect(originalLength).toBe(22);

    compressContext(msgs, mockLogger as any, 'test-agent');

    // Should have: system + user task + compressed summary + 12 recent
    expect(msgs.length).toBeLessThan(originalLength);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('Do task'); // Original task preserved
    // Compressed summary should mention files
    expect(msgs[2].content).toContain('CONTEXT COMPRESSED');
  });

  it('preserves system prompt and initial task message', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'My important task' },
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `msg ${i}` });
    }

    compressContext(msgs, mockLogger as any, 'agent-1');

    expect(msgs[0].content).toBe('System prompt');
    expect(msgs[1].content).toBe('My important task');
  });
});

describe('snapshotFilesystem', () => {
  it('returns a number for a valid directory', () => {
    const hash = snapshotFilesystem(process.cwd());
    expect(typeof hash).toBe('number');
    expect(hash).toBeGreaterThan(0);
  });

  it('returns 0 for a non-existent directory', () => {
    const hash = snapshotFilesystem('/this/path/does/not/exist/at/all');
    expect(hash).toBe(0);
  });

  it('returns consistent hash for same directory', () => {
    const hash1 = snapshotFilesystem(process.cwd());
    const hash2 = snapshotFilesystem(process.cwd());
    expect(hash1).toBe(hash2);
  });
});

describe('retryOnTransient', () => {
  const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  };

  it('returns result on first success', async () => {
    const result = await retryOnTransient(() => Promise.resolve(42), 3, silentLogger as any, 'test');
    expect(result).toBe(42);
  });

  it('throws non-transient errors immediately', async () => {
    await expect(
      retryOnTransient(
        () => Promise.reject(new Error('SyntaxError: unexpected token')),
        3,
        silentLogger as any,
        'test',
      ),
    ).rejects.toThrow('SyntaxError');
  });

  it('retries transient errors and succeeds', async () => {
    let attempt = 0;
    const result = await retryOnTransient(
      () => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('429 rate limit exceeded'));
        return Promise.resolve('success');
      },
      3,
      silentLogger as any,
      'test',
    );
    expect(result).toBe('success');
    expect(attempt).toBe(2);
  });
});
