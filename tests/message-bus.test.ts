import { describe, it, expect } from 'vitest';
import { MessageBus, createEvent, BusEvent } from '../src/core/message-bus';

describe('MessageBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new MessageBus();
    const received: BusEvent[] = [];
    bus.on('TASK_STARTED', (event) => received.push(event));

    const event = createEvent('TASK_STARTED', 'agent-a', { iteration: 1 }, 'task-1', 'api');
    bus.emit(event);

    expect(received.length).toBe(1);
    expect(received[0].agentId).toBe('agent-a');
    expect(received[0].type).toBe('TASK_STARTED');
  });

  it('does not deliver events to unrelated subscribers', () => {
    const bus = new MessageBus();
    const received: BusEvent[] = [];
    bus.on('TASK_COMPLETED', (event) => received.push(event));

    bus.emit(createEvent('TASK_STARTED', 'agent-a', {}, 'task-1', 'api'));

    expect(received.length).toBe(0);
  });

  it('supports wildcard (onAll) subscribers', () => {
    const bus = new MessageBus();
    const received: BusEvent[] = [];
    bus.onAll((event) => received.push(event));

    bus.emit(createEvent('TASK_STARTED', 'agent-a', {}, 'task-1', 'api'));
    bus.emit(createEvent('TASK_COMPLETED', 'agent-b', {}, 'task-2', 'api'));

    expect(received.length).toBe(2);
  });

  it('createEvent generates proper structure', () => {
    const event = createEvent('HEARTBEAT', 'agent-x', { iteration: 5 }, 'task-3', 'cli');

    expect(event.type).toBe('HEARTBEAT');
    expect(event.agentId).toBe('agent-x');
    expect(event.taskId).toBe('task-3');
    expect(event.data!.iteration).toBe(5);
    expect(event.runtimeType).toBe('cli');
    expect(typeof event.timestamp).toBe('number');
  });

  it('supports multiple subscribers for same event type', () => {
    const bus = new MessageBus();
    let count = 0;
    bus.on('TASK_FAILED', () => count++);
    bus.on('TASK_FAILED', () => count++);

    bus.emit(createEvent('TASK_FAILED', 'agent-a', {}, 'task-1', 'api'));
    expect(count).toBe(2);
  });
});
