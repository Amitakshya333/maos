import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Duplex } from 'stream';
import * as net from 'net';
import {
  HerdrHarness,
  splitPane,
  runCommand,
  readPaneBuffer,
  waitForOutput,
  listAgents,
  getAgent,
  sendPrompt,
  closePane,
  isHerdrAvailable,
  normalizeDirection,
  normalizeReadSource,
  resolveHerdrSocketPath,
  toRustRegexPattern,
  isTransportError,
  HerdrError,
  AgentInfo,
} from '../src/integrations/herdr';

/**
 * In-memory Mock Duplex Stream acting as a net.Socket
 */
class MockSocketStream extends Duplex {
  public written: string = '';
  public destroyed: boolean = false;

  constructor(private onWrite?: (data: string, socket: MockSocketStream) => void) {
    super();
  }

  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const str = chunk.toString();
    this.written += str;
    if (this.onWrite) {
      this.onWrite(str, this);
    }
    callback();
  }

  _read(_size: number) {
    // no-op
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

describe('Herdr Harness - Multi-Pane Action Harness', () => {
  // ==========================================================================
  // 1. Parameter Normalization & Path Resolution
  // ==========================================================================
  describe('Helper & Normalization Functions', () => {
    it('normalizes directions correctly', () => {
      expect(normalizeDirection('right')).toBe('right');
      expect(normalizeDirection('vertical')).toBe('right');
      expect(normalizeDirection('down')).toBe('down');
      expect(normalizeDirection('horizontal')).toBe('down');
      expect(normalizeDirection(undefined)).toBe('right');
    });

    it('normalizes read sources correctly', () => {
      expect(normalizeReadSource('recent-unwrapped')).toEqual({
        socketSource: 'recent_unwrapped',
        cliSource: 'recent-unwrapped',
      });
      expect(normalizeReadSource('recent_unwrapped')).toEqual({
        socketSource: 'recent_unwrapped',
        cliSource: 'recent-unwrapped',
      });
      expect(normalizeReadSource('visible')).toEqual({
        socketSource: 'visible',
        cliSource: 'visible',
      });
      expect(normalizeReadSource('recent')).toEqual({
        socketSource: 'recent',
        cliSource: 'recent',
      });
      expect(normalizeReadSource('detection')).toEqual({
        socketSource: 'detection',
        cliSource: 'detection',
      });
      expect(normalizeReadSource(undefined)).toEqual({
        socketSource: 'recent_unwrapped',
        cliSource: 'recent-unwrapped',
      });
    });

    it('converts JS RegExp with flags to Rust inline flag patterns', () => {
      expect(toRustRegexPattern('plain text')).toBe('plain text');
      expect(toRustRegexPattern(/case_insensitive/i)).toBe('(?i)case_insensitive');
      expect(toRustRegexPattern(/multiline\s+\d+/m)).toBe('(?m)multiline\\s+\\d+');
      expect(toRustRegexPattern(new RegExp('dotall.*test', 'is'))).toBe('(?is)dotall.*test');
      expect(toRustRegexPattern(/simple/)).toBe('simple');
    });

    it('identifies transport errors vs business-logic server errors', () => {
      expect(isTransportError(new HerdrError('fail', 'CONNECT_FAILED'))).toBe(true);
      expect(isTransportError(new HerdrError('fail', 'SOCKET_ERROR'))).toBe(true);
      expect(isTransportError(new HerdrError('fail', 'CONNECTION_CLOSED'))).toBe(true);
      expect(isTransportError(new HerdrError('herdr not found', 'CLI_ERROR'))).toBe(true);

      // Business logic errors should NOT be classified as transport errors
      expect(isTransportError(new HerdrError('not found', 'pane_not_found'))).toBe(false);
      expect(isTransportError(new HerdrError('not found', 'agent_not_found'))).toBe(false);
      expect(isTransportError(new HerdrError('timed out', 'timeout'))).toBe(false);
      expect(isTransportError(new HerdrError('stalled', 'agent_prompt_stalled'))).toBe(false);
    });

    it('resolves socket paths with pipe prefix on Windows', () => {
      const resolved = resolveHerdrSocketPath('C:\\Users\\test\\herdr.sock');
      if (process.platform === 'win32') {
        expect(resolved).toBe('\\\\.\\pipe\\C:\\Users\\test\\herdr.sock');
      } else {
        expect(resolved).toBe('C:\\Users\\test\\herdr.sock');
      }
    });

    it('preserves already prefixed Windows named pipe paths', () => {
      const path = '\\\\.\\pipe\\custom_pipe';
      expect(resolveHerdrSocketPath(path)).toBe(path);
    });

    it('creates HerdrError with code and details', () => {
      const err = new HerdrError('Test error message', 'ERR_TEST', { foo: 'bar' });
      expect(err.message).toBe('Test error message');
      expect(err.code).toBe('ERR_TEST');
      expect(err.details).toEqual({ foo: 'bar' });
      expect(err.name).toBe('HerdrError');
    });
  });

  // ==========================================================================
  // 2. Transport & Socket Protocol Handling
  // ==========================================================================
  describe('Socket Transport Protocol', () => {
    it('sends JSON-RPC payload and parses response correctly', async () => {
      const mockConnector = async () => {
        const stream = new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          expect(req.method).toBe('agent.list');
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'agent_list',
                agents: [
                  {
                    pane_id: 'wA:p1',
                    agent: 'agy',
                    agent_status: 'idle',
                  },
                ],
              },
            }) + '\n',
          );
        });
        return stream as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const result = await harness.sendSocketRequest<any>('agent.list', {});
      expect(result.type).toBe('agent_list');
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].pane_id).toBe('wA:p1');
    });

    it('rejects on server error response', async () => {
      const mockConnector = async () => {
        const stream = new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'pane_not_found',
                message: 'Pane wX:pY not found',
              },
            }) + '\n',
          );
        });
        return stream as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      await expect(harness.sendSocketRequest('pane.get', { pane_id: 'wX:pY' })).rejects.toThrow(/Pane wX:pY not found/);
    });

    it('handles socket timeout when server does not respond', async () => {
      const mockConnector = async () => {
        const stream = new MockSocketStream(() => {
          // Do not reply
        });
        return stream as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector, defaultTimeoutMs: 50 });
      await expect(harness.sendSocketRequest('ping', {}, 50)).rejects.toThrow(/timed out/);
    });

    it('assembles fragmented chunks over socket correctly', async () => {
      const mockConnector = async () => {
        const stream = new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          const fullResponse =
            JSON.stringify({
              id: req.id,
              result: {
                type: 'pane_read',
                text: 'A long fragmented message',
              },
            }) + '\n';

          // Emit in two fragments
          const half = Math.floor(fullResponse.length / 2);
          s.push(fullResponse.substring(0, half));
          setTimeout(() => {
            s.push(fullResponse.substring(half));
          }, 10);
        });
        return stream as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const result = await harness.sendSocketRequest<any>('pane.read', { pane_id: 'wA:p1' });
      expect(result.text).toBe('A long fragmented message');
    });

    it('parses remaining buffer on socket close even if trailing newline was absent', async () => {
      const mockConnector = async () => {
        const stream = new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          const jsonWithoutNewline = JSON.stringify({
            id: req.id,
            result: { type: 'pong' },
          });
          // Emit data synchronously and then close
          s.emit('data', jsonWithoutNewline);
          s.emit('close');
        });
        return stream as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const result = await harness.sendSocketRequest<any>('ping', {});
      expect(result.type).toBe('pong');
    });
  });

  // ==========================================================================
  // 3. splitPane(direction, cwd, noFocus, targetPaneId)
  // ==========================================================================
  describe('splitPane()', () => {
    it('creates new pane via socket with default arguments', async () => {
      const savedPaneId = process.env.HERDR_PANE_ID;
      delete process.env.HERDR_PANE_ID;
      try {
        let capturedParams: any = null;
        const mockConnector = async () => {
          return new MockSocketStream((data, s) => {
            const req = JSON.parse(data.trim());
            capturedParams = req.params;
            s.push(
              JSON.stringify({
                id: req.id,
                result: {
                  type: 'pane_info',
                  pane: {
                    pane_id: 'wA:p2',
                    workspace_id: 'wA',
                    tab_id: 'wA:t1',
                    focused: false,
                  },
                },
              }) + '\n',
            );
          }) as unknown as net.Socket;
        };

        const harness = new HerdrHarness({ socketConnector: mockConnector });
        const paneId = await harness.splitPane();

        expect(paneId).toBe('wA:p2');
        expect(capturedParams).toEqual({
          direction: 'right',
          cwd: null,
          focus: false,
          target_pane_id: null,
        });
      } finally {
        if (savedPaneId !== undefined) {
          process.env.HERDR_PANE_ID = savedPaneId;
        }
      }
    });

    it('inherits HERDR_PANE_ID when targetPaneId is omitted', async () => {
      const savedPaneId = process.env.HERDR_PANE_ID;
      process.env.HERDR_PANE_ID = 'wA:pEnv';
      try {
        let capturedParams: any = null;
        const mockConnector = async () => {
          return new MockSocketStream((data, s) => {
            const req = JSON.parse(data.trim());
            capturedParams = req.params;
            s.push(
              JSON.stringify({
                id: req.id,
                result: {
                  pane: { pane_id: 'wA:pNew' },
                },
              }) + '\n',
            );
          }) as unknown as net.Socket;
        };

        const harness = new HerdrHarness({ socketConnector: mockConnector });
        const paneId = await harness.splitPane();

        expect(paneId).toBe('wA:pNew');
        expect(capturedParams.target_pane_id).toBe('wA:pEnv');
      } finally {
        if (savedPaneId !== undefined) {
          process.env.HERDR_PANE_ID = savedPaneId;
        } else {
          delete process.env.HERDR_PANE_ID;
        }
      }
    });

    it('passes custom direction, cwd, focus, and explicit targetPaneId', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                pane: { pane_id: 'wA:p3' },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const paneId = await harness.splitPane('horizontal', 'C:\\worktree', false, 'wA:p1');

      expect(paneId).toBe('wA:p3');
      expect(capturedParams).toEqual({
        direction: 'down',
        cwd: 'C:\\worktree',
        focus: true,
        target_pane_id: 'wA:p1',
      });
    });

    it('falls back to CLI on transport error and formats args properly', async () => {
      const mockConnector = async () => {
        const err: any = new Error('Socket connect failed');
        err.code = 'CONNECT_FAILED';
        throw err;
      };

      let capturedArgs: string[] = [];
      const mockCli = async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return {
          stdout: JSON.stringify({
            id: 'cli:pane:split',
            result: {
              pane: { pane_id: 'wA:p4' },
            },
          }),
          stderr: '',
        };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      const paneId = await harness.splitPane('down', 'C:\\test', true, 'wA:p1');
      expect(paneId).toBe('wA:p4');
      expect(capturedArgs).toContain('split');
      expect(capturedArgs).toContain('--direction');
      expect(capturedArgs).toContain('down');
      expect(capturedArgs).toContain('--cwd');
      expect(capturedArgs).toContain('C:\\test');
      expect(capturedArgs).toContain('--pane');
      expect(capturedArgs).toContain('wA:p1');
      expect(capturedArgs).toContain('--no-focus');
    });

    it('throws server error directly without triggering CLI fallback on semantic error', async () => {
      let cliCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'invalid_split_target',
                message: 'Pane wA:p999 does not exist',
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const mockCli = async () => {
        cliCalled = true;
        return { stdout: '{}', stderr: '' };
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector, cliExecutor: mockCli });
      await expect(harness.splitPane('right', undefined, true, 'wA:p999')).rejects.toThrow(
        /Pane wA:p999 does not exist/,
      );
      expect(cliCalled).toBe(false);
    });
  });

  // ==========================================================================
  // 4. runCommand(paneId, command)
  // ==========================================================================
  describe('runCommand()', () => {
    it('executes command via socket pane.send_input with enter by default (preferSocket: true)', async () => {
      let capturedMethod = '';
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedMethod = req.method;
          capturedParams = req.params;
          s.push(JSON.stringify({ id: req.id, result: { type: 'ok' } }) + '\n');
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      await harness.runCommand('wA:p1', 'echo HELLO_SOCKET');

      expect(capturedMethod).toBe('pane.send_input');
      expect(capturedParams).toEqual({
        pane_id: 'wA:p1',
        text: 'echo HELLO_SOCKET',
        keys: ['enter'],
      });
    });

    it('falls back to CLI when socket transport fails', async () => {
      const mockConnector = async () => {
        const err: any = new Error('Socket disconnected');
        err.code = 'CONNECT_FAILED';
        throw err;
      };

      let capturedArgs: string[] = [];
      const mockCli = async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      await harness.runCommand('wA:p2', 'git status');
      expect(capturedArgs).toEqual(['pane', 'run', 'wA:p2', 'git status']);
    });

    it('uses CLI directly when preferSocket is false', async () => {
      let capturedArgs: string[] = [];
      const mockCli = async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({ cliExecutor: mockCli, preferSocket: false });
      await harness.runCommand('wA:p3', 'npm test');
      expect(capturedArgs).toEqual(['pane', 'run', 'wA:p3', 'npm test']);
    });

    it('validates required arguments', async () => {
      const harness = new HerdrHarness();
      await expect(harness.runCommand('', 'echo 1')).rejects.toThrow(/paneId is required/);
      await expect(harness.runCommand('wA:p1', null as any)).rejects.toThrow(/command is required/);
    });
  });

  // ==========================================================================
  // 5. readPaneBuffer(paneId, lines, source)
  // ==========================================================================
  describe('readPaneBuffer()', () => {
    it('reads buffer via socket with default options', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'pane_read',
                read: {
                  pane_id: 'wA:p1',
                  source: 'recent_unwrapped',
                  text: 'Line 1\nLine 2\nLine 3',
                },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const buffer = await harness.readPaneBuffer('wA:p1');

      expect(buffer).toBe('Line 1\nLine 2\nLine 3');
      expect(capturedParams).toEqual({
        pane_id: 'wA:p1',
        source: 'recent_unwrapped',
        lines: 100,
        format: 'text',
        strip_ansi: true,
      });
    });

    it('reads buffer via CLI fallback on transport failure', async () => {
      const mockConnector = async () => {
        const err: any = new Error('Socket down');
        err.code = 'CONNECT_FAILED';
        throw err;
      };

      let capturedArgs: string[] = [];
      const mockCli = async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return {
          stdout: 'Visible Output Terminal Content',
          stderr: '',
        };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      const buffer = await harness.readPaneBuffer('wA:p2', 50, 'visible');
      expect(buffer).toBe('Visible Output Terminal Content');
      expect(capturedArgs).toEqual(['pane', 'read', 'wA:p2', '--source', 'visible', '--lines', '50']);
    });

    it('throws server error directly without unnecessary CLI retry', async () => {
      let cliCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'pane_not_found',
                message: 'Pane wA:p99 not found',
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const mockCli = async () => {
        cliCalled = true;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector, cliExecutor: mockCli });
      await expect(harness.readPaneBuffer('wA:p99')).rejects.toThrow(/Pane wA:p99 not found/);
      expect(cliCalled).toBe(false);
    });

    it('validates required paneId argument', async () => {
      const harness = new HerdrHarness();
      await expect(harness.readPaneBuffer('')).rejects.toThrow(/paneId is required/);
    });
  });

  // ==========================================================================
  // 6. waitForOutput(paneId, match, timeoutMs)
  // ==========================================================================
  describe('waitForOutput()', () => {
    it('waits for literal substring match via socket', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'output_matched',
                pane_id: 'wA:p1',
                matched_line: 'Build completed successfully in 3.4s',
                read: { text: 'Compiling...\nBuild completed successfully in 3.4s' },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const matched = await harness.waitForOutput('wA:p1', 'Build completed', 5000);

      expect(matched).toBe('Build completed successfully in 3.4s');
      expect(capturedParams.match).toEqual({
        type: 'substring',
        value: 'Build completed',
      });
    });

    it('waits for RegExp with flags and preserves flags for Rust regex engine', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'output_matched',
                pane_id: 'wA:p1',
                matched_line: 'Tests: 12 passed, 12 total',
                read: { text: 'Running...\nTests: 12 passed, 12 total' },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const matched = await harness.waitForOutput('wA:p1', /tests:\s+\d+\s+passed/i, 5000);

      expect(matched).toBe('Tests: 12 passed, 12 total');
      expect(capturedParams.match).toEqual({
        type: 'regex',
        value: '(?i)tests:\\s+\\d+\\s+passed',
      });
    });

    it('throws WAIT_OUTPUT_TIMEOUT immediately when socket server times out (no fallback waste)', async () => {
      let cliCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'timeout',
                message: 'Timed out waiting for output',
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const mockCli = async () => {
        cliCalled = true;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector, cliExecutor: mockCli });
      await expect(harness.waitForOutput('wA:p1', 'PATTERN', 1000)).rejects.toThrow(/waitForOutput timed out/);
      expect(cliCalled).toBe(false);
    });

    it('polls buffer client-side when socket transport is down and CLI wait-output is unavailable', async () => {
      const mockConnector = async () => {
        const err: any = new Error('Socket unsupported');
        err.code = 'CONNECT_FAILED';
        throw err;
      };

      let readCallCount = 0;
      const mockCli = async (_cmd: string, args: string[]) => {
        if (args.includes('wait-output')) {
          const err: any = new Error('wait-output not implemented');
          err.code = 'CLI_ERROR';
          throw err;
        }
        if (args.includes('read')) {
          readCallCount++;
          if (readCallCount < 2) {
            return { stdout: 'Initializing tests...', stderr: '' };
          }
          return { stdout: 'Initializing tests...\nPASS: All test suites passed', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      const result = await harness.waitForOutput('wA:p1', 'All test suites passed', 2000, {
        pollIntervalMs: 50,
      });

      expect(result).toContain('All test suites passed');
      expect(readCallCount).toBeGreaterThanOrEqual(2);
    });

    it('validates required parameters for waitForOutput', async () => {
      const harness = new HerdrHarness();
      await expect(harness.waitForOutput('', 'marker')).rejects.toThrow(/paneId is required/);
      await expect(harness.waitForOutput('wA:p1', '')).rejects.toThrow(/match parameter is required/);
    });
  });

  // ==========================================================================
  // 7. listAgents() & getAgent(target)
  // ==========================================================================
  describe('listAgents() & getAgent()', () => {
    const mockAgents: AgentInfo[] = [
      {
        pane_id: 'wA:p1',
        agent: 'agy',
        agent_status: 'idle',
        cwd: 'C:\\HACKDAY WINNER',
      },
      {
        pane_id: 'wA:p6',
        agent: 'agy',
        agent_status: 'working',
        cwd: 'C:\\HACKDAY WINNER\\worktrees\\herdr-harness',
      },
      {
        pane_id: 'wA:p7',
        agent: 'opencode',
        agent_status: 'done',
        cwd: 'C:\\HACKDAY WINNER\\worktrees\\gemma-opencode',
      },
    ];

    it('lists agents via socket', async () => {
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'agent_list',
                agents: mockAgents,
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const agents = await harness.listAgents();

      expect(agents).toHaveLength(3);
      expect(agents[1].pane_id).toBe('wA:p6');
      expect(agents[1].agent_status).toBe('working');
      expect(agents[2].agent).toBe('opencode');
    });

    it('retrieves single agent by pane target', async () => {
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          expect(req.params.target).toBe('wA:p7');
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'agent_info',
                agent: mockAgents[2],
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const agent = await harness.getAgent('wA:p7');

      expect(agent).not.toBeNull();
      expect(agent?.agent).toBe('opencode');
      expect(agent?.agent_status).toBe('done');
    });

    it('returns null immediately when agent is not found over socket without calling CLI', async () => {
      let cliCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'agent_not_found',
                message: 'agent target wA:p99 not found',
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const mockCli = async () => {
        cliCalled = true;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      const agent = await harness.getAgent('wA:p99');
      expect(agent).toBeNull();
      expect(cliCalled).toBe(false);
    });

    it('validates target parameter for getAgent', async () => {
      const harness = new HerdrHarness();
      await expect(harness.getAgent('')).rejects.toThrow(/target is required/);
    });
  });

  // ==========================================================================
  // 8. sendPrompt(target, prompt, wait)
  // ==========================================================================
  describe('sendPrompt()', () => {
    it('sends prompt without wait via socket', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'agent_prompted',
                agent: {
                  pane_id: 'wA:p6',
                  agent: 'agy',
                  agent_status: 'working',
                },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const agent = await harness.sendPrompt('wA:p6', 'Start task 1');

      expect(agent.agent_status).toBe('working');
      expect(capturedParams).toEqual({
        target: 'wA:p6',
        text: 'Start task 1',
        wait: null,
      });
    });

    it('sends prompt with wait=true and receives settled state', async () => {
      let capturedParams: any = null;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          capturedParams = req.params;
          s.push(
            JSON.stringify({
              id: req.id,
              result: {
                type: 'agent_prompted',
                agent: {
                  pane_id: 'reviewer',
                  agent: 'codex',
                  agent_status: 'done',
                },
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const agent = await harness.sendPrompt('reviewer', 'Run audit', true, 60000);

      expect(agent.agent_status).toBe('done');
      expect(capturedParams).toEqual({
        target: 'reviewer',
        text: 'Run audit',
        wait: {
          timeout_ms: 60000,
          until: ['idle', 'done', 'blocked'],
        },
      });
    });

    it('throws server error directly without unnecessary CLI retry on non-existent agent', async () => {
      let cliCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          s.push(
            JSON.stringify({
              id: req.id,
              error: {
                code: 'agent_not_found',
                message: 'agent target unknown_agent not found',
              },
            }) + '\n',
          );
        }) as unknown as net.Socket;
      };

      const mockCli = async () => {
        cliCalled = true;
        return { stdout: '', stderr: '' };
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector, cliExecutor: mockCli });
      await expect(harness.sendPrompt('unknown_agent', 'do work')).rejects.toThrow(
        /agent target unknown_agent not found/,
      );
      expect(cliCalled).toBe(false);
    });

    it('falls back to CLI agent prompt --wait on transport failure', async () => {
      const mockConnector = async () => {
        const err: any = new Error('Socket fail');
        err.code = 'CONNECT_FAILED';
        throw err;
      };

      let capturedArgs: string[] = [];
      const mockCli = async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: 'wA:p7',
                agent: 'opencode',
                agent_status: 'idle',
              },
            },
          }),
          stderr: '',
        };
      };

      const harness = new HerdrHarness({
        socketConnector: mockConnector,
        cliExecutor: mockCli,
      });

      const agent = await harness.sendPrompt('wA:p7', 'Compile and verify', true, 45000);
      expect(agent.agent_status).toBe('idle');
      expect(capturedArgs).toContain('agent');
      expect(capturedArgs).toContain('prompt');
      expect(capturedArgs).toContain('wA:p7');
      expect(capturedArgs).toContain('Compile and verify');
      expect(capturedArgs).toContain('--wait');
      expect(capturedArgs).toContain('--timeout');
      expect(capturedArgs).toContain('45000');
    });

    it('validates required parameters for sendPrompt', async () => {
      const harness = new HerdrHarness();
      await expect(harness.sendPrompt('', 'prompt text')).rejects.toThrow(/target is required/);
      await expect(harness.sendPrompt('wA:p1', null as any)).rejects.toThrow(/prompt is required/);
    });
  });

  // ==========================================================================
  // 9. Concurrency & Stress Testing
  // ==========================================================================
  describe('Concurrency & Rapid Invocation', () => {
    it('handles 10 rapid concurrent socket queries cleanly', async () => {
      let activeConnections = 0;
      let maxConcurrentConnections = 0;

      const mockConnector = async () => {
        activeConnections++;
        if (activeConnections > maxConcurrentConnections) {
          maxConcurrentConnections = activeConnections;
        }

        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          setTimeout(() => {
            activeConnections--;
            s.push(
              JSON.stringify({
                id: req.id,
                result: {
                  type: 'agent_list',
                  agents: [{ pane_id: 'wA:p1', agent: 'agy', agent_status: 'idle' }],
                },
              }) + '\n',
            );
          }, 5);
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const tasks = Array.from({ length: 10 }, () => harness.listAgents());
      const results = await Promise.all(tasks);

      expect(results).toHaveLength(10);
      for (const res of results) {
        expect(res).toHaveLength(1);
        expect(res[0].pane_id).toBe('wA:p1');
      }
      expect(maxConcurrentConnections).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // 10. Utility Methods (closePane, isAvailable, listPanes)
  // ==========================================================================
  describe('Utilities & Top-Level Exports', () => {
    it('closes a pane cleanly via socket', async () => {
      let closedPane = '';
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          closedPane = req.params.pane_id;
          s.push(JSON.stringify({ id: req.id, result: { type: 'ok' } }) + '\n');
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      const ok = await harness.closePane('wA:p9');

      expect(ok).toBe(true);
      expect(closedPane).toBe('wA:p9');
    });

    it('checks multiplexer availability using ping over socket', async () => {
      let pingCalled = false;
      const mockConnector = async () => {
        return new MockSocketStream((data, s) => {
          const req = JSON.parse(data.trim());
          if (req.method === 'ping') {
            pingCalled = true;
            s.push(
              JSON.stringify({
                id: req.id,
                result: {
                  type: 'pong',
                  version: '0.8.0',
                  protocol: 19,
                },
              }) + '\n',
            );
          }
        }) as unknown as net.Socket;
      };

      const harness = new HerdrHarness({ socketConnector: mockConnector });
      expect(await harness.isAvailable()).toBe(true);
      expect(pingCalled).toBe(true);
    });

    it('accurately parses CLI server status without false positives from client status', async () => {
      // Offline server status
      const offlineHarness = new HerdrHarness({
        preferSocket: false,
        cliExecutor: async (_cli, args) => {
          if (args[0] === 'status') {
            return {
              stdout: 'client:\n  status: running\nserver:\n  status: not running\n',
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      });
      expect(await offlineHarness.isAvailable()).toBe(false);

      // Stopped server status
      const stoppedHarness = new HerdrHarness({
        preferSocket: false,
        cliExecutor: async (_cli, args) => {
          if (args[0] === 'status') {
            return {
              stdout: 'client:\n  status: running\nserver:\n  status: stopped\n',
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      });
      expect(await stoppedHarness.isAvailable()).toBe(false);

      // Online server status
      const onlineHarness = new HerdrHarness({
        preferSocket: false,
        cliExecutor: async (_cli, args) => {
          if (args[0] === 'status') {
            return {
              stdout: 'client:\n  status: running\nserver:\n  status: running\n',
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
      });
      expect(await onlineHarness.isAvailable()).toBe(true);
    });

    it('standalone exported functions exist and are functions', () => {
      expect(typeof splitPane).toBe('function');
      expect(typeof runCommand).toBe('function');
      expect(typeof readPaneBuffer).toBe('function');
      expect(typeof waitForOutput).toBe('function');
      expect(typeof listAgents).toBe('function');
      expect(typeof getAgent).toBe('function');
      expect(typeof sendPrompt).toBe('function');
      expect(typeof closePane).toBe('function');
      expect(typeof isHerdrAvailable).toBe('function');
      expect(typeof toRustRegexPattern).toBe('function');
      expect(typeof isTransportError).toBe('function');
    });
  });

  // ==========================================================================
  // 11. Live Integration Smoke Test (Runs against real Herdr if active)
  // ==========================================================================
  describe('Live Herdr Integration Smoke Test', () => {
    it('queries live Herdr multiplexer non-destructively', async () => {
      const harness = new HerdrHarness();
      const available = await harness.isAvailable();

      if (available) {
        // Herdr multiplexer is running live on this host!
        const agents = await harness.listAgents();
        expect(Array.isArray(agents)).toBe(true);
        expect(agents.length).toBeGreaterThan(0);

        // Verify structure of first live agent
        const first = agents[0];
        expect(first.pane_id).toMatch(/^w[A-Za-z0-9]+:p[A-Za-z0-9]+/);
        expect(first.agent_status).toBeDefined();

        // Query agent status by pane_id
        const fetched = await harness.getAgent(first.pane_id);
        expect(fetched).not.toBeNull();
        expect(fetched?.pane_id).toBe(first.pane_id);

        // Read a few lines of scrollback non-destructively
        const buffer = await harness.readPaneBuffer(first.pane_id, 3, 'recent-unwrapped');
        expect(typeof buffer).toBe('string');
      } else {
        // If Herdr is not running in CI, availability is cleanly false
        expect(available).toBe(false);
      }
    });
  });
});
