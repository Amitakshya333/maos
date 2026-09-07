import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Supervisor } from '../src/core/supervisor';
import { MessageBus, createEvent } from '../src/core/message-bus';
import { AgentInbox } from '../src/core/coordinator';

describe('Supervisor Module', () => {
  let testDir: string;
  let bus: MessageBus;
  let inbox: AgentInbox;
  let supervisor: Supervisor;
  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-sup-test-'));
    bus = new MessageBus();
    inbox = new AgentInbox();
    supervisor = new Supervisor(bus, inbox, testDir, mockLogger);
  });

  afterEach(() => {
    bus.dispose();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should not mark agent as stalled if providerActive is true during heartbeat', () => {
    const agentId = 'CODER_LONG_RUN';

    // Emit 6 heartbeats with no files changed, but providerActive = true (deep reasoning)
    for (let i = 0; i < 6; i++) {
      bus.emit(
        createEvent('HEARTBEAT', agentId, {
          filesChanged: 0,
          toolCalls: 0,
          providerActive: true,
        }),
      );
    }

    // Run supervisor sweep
    supervisor.sweep();

    const velocities = supervisor.getVelocityStats();
    const vel = velocities.get(agentId);

    expect(vel).toBeDefined();
    // Stall count must be 0 because provider was actively thinking
    expect(vel?.stallCount).toBe(0);
    expect(vel?.nudged).toBe(false);
  });

  it('should mark agent as stalled and nudge when heartbeats have zero progress and provider is idle', () => {
    const agentId = 'STUCK_AGENT';

    // Emit 6 heartbeats with zero progress and idle provider
    for (let i = 0; i < 6; i++) {
      bus.emit(
        createEvent('HEARTBEAT', agentId, {
          filesChanged: 0,
          toolCalls: 0,
          providerActive: false,
        }),
      );
    }

    supervisor.sweep();

    const velocities = supervisor.getVelocityStats();
    const vel = velocities.get(agentId);

    expect(vel?.stallCount).toBe(6);
    expect(vel?.nudged).toBe(true);

    // Agent inbox should receive a nudge message
    const msgs = inbox.peek(agentId);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].type).toBe('nudge');
  });
});
