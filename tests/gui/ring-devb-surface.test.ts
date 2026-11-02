// @vitest-environment happy-dom
/**
 * TASK RING-DEV-B-01: Ring surface tests (streaming display, threads/roles,
 * attachments/screenshot, overlay, event-bus bridge).
 *
 * Evidence-only: no live Baseten calls (BASETEN_API_KEY unset); run payloads
 * are injected mocks against the frozen validator. Event-bus bridge test
 * runs the real RingAgentService in evidence-only mode (no key set) with a
 * fake EventService.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  allArtifacts,
  allMemories,
  latestPlan,
  RingArtifactCard,
  RingLiveText,
  RingMark,
  RingMemoryNote,
  RingPlanChecklist,
  ringVisualStateForRun,
} from '../../src/gui/src/components/RingStreamPanels';
import {
  attachmentInstructionSuffix,
  classifyAttachment,
  RingAttachmentBar,
} from '../../src/gui/src/components/RingAttachments';
import {
  DEFAULT_RING_ROLE,
  RING_ROLES,
  RingRolePicker,
  RingThreadSidebar,
  toThreadSummary,
} from '../../src/gui/src/components/RingThreads';
import { RingOverlay } from '../../src/gui/src/components/RingOverlay';
import type { RingRunState } from '../../src/gui/src/api/ring-run-types';
import type { RingRunClient } from '../../src/gui/src/components/RingWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return {
    container,
    async render() {
      await act(async () => {
        root.render(element);
      });
    },
    async flush() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const STREAMING_STATE: RingRunState = {
  status: 'running',
  mode: 'hosted',
  events: [
    { type: 'run.started', ts: '2026-11-02T00:00:00Z' },
    { type: 'model.delta', ts: '2026-11-02T00:00:01Z', delta: 'Checking turbine ' },
    { type: 'model.delta', ts: '2026-11-02T00:00:02Z', delta: 'T-07 vibration…' },
    {
      type: 'plan.updated',
      ts: '2026-11-02T00:00:03Z',
      plan: [
        { step: 'Analyze telemetry', status: 'done' },
        { step: 'Draft safety note', status: 'in_progress' },
        { step: 'Verify export', status: 'pending' },
      ],
    },
    {
      type: 'artifact.created',
      ts: '2026-11-02T00:00:04Z',
      artifact: { path: '.maos/ring-runs/artifacts/run-1/safety-note.md', kind: 'note', size: 128, sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd' },
    },
    { type: 'memory.saved', ts: '2026-11-02T00:00:05Z', memory: { noteId: 'note-1', summary: 'T-07 exceeds the demo limit.' } },
  ],
};

describe('ringVisualStateForRun', () => {
  it('maps idle/thinking/using-tool/waiting-for-approval/done/error', () => {
    expect(ringVisualStateForRun(null, [])).toBe('idle');
    expect(ringVisualStateForRun('running', [])).toBe('idle');
    expect(ringVisualStateForRun('running', [{ type: 'model.turn', ts: 't', text: 'hi' }])).toBe('thinking');
    expect(
      ringVisualStateForRun('running', [{ type: 'tool.call', ts: 't', tool: 'x', toolCallId: 'c1' }]),
    ).toBe('using-tool');
    expect(
      ringVisualStateForRun('running', [
        { type: 'tool.call', ts: 't', tool: 'x', toolCallId: 'c1' },
        { type: 'tool.result', ts: 't', tool: 'x', toolCallId: 'c1' },
      ]),
    ).toBe('thinking');
    expect(ringVisualStateForRun('awaiting_approval', [])).toBe('waiting-for-approval');
    expect(ringVisualStateForRun('completed', [])).toBe('done');
    expect(ringVisualStateForRun('failed', [])).toBe('error');
    expect(ringVisualStateForRun('cancelled', [])).toBe('error');
  });
});

describe('RingMark', () => {
  it('renders one mark per state with an honest label, no fake progress', async () => {
    for (const state of ['idle', 'thinking', 'using-tool', 'waiting-for-approval', 'done', 'error'] as const) {
      const view = mount(React.createElement(RingMark, { state }));
      await view.render();
      const mark = view.container.querySelector('[data-testid="ring-mark"]');
      expect(mark?.getAttribute('data-state')).toBe(state);
      expect(mark?.getAttribute(String("aria-label"))).toBe("Ring: " + ({idle:"Idle",thinking:"Thinking","using-tool":"Using tool","waiting-for-approval":"Waiting for approval",done:"Done",error:"Needs attention"}[state]));
      view.unmount();
    }
  });
});

describe('streaming selectors', () => {
  it('latestPlan takes the last plan.updated; artifacts/memories collect in order', () => {
    const events = [
      ...STREAMING_STATE.events,
      {
        type: 'plan.updated',
        ts: '2026-11-02T00:00:06Z',
        plan: [{ step: 'Analyze telemetry', status: 'done' as const }],
      },
    ];
    expect(latestPlan(events)).toEqual([{ step: 'Analyze telemetry', status: 'done' }]);
    expect(allArtifacts(STREAMING_STATE.events)).toHaveLength(1);
    expect(allArtifacts(STREAMING_STATE.events)[0].kind).toBe('note');
    expect(allMemories(STREAMING_STATE.events)).toEqual([{ noteId: 'note-1', summary: 'T-07 exceeds the demo limit.' }]);
  });

  it('RingLiveText concatenates deltas verbatim with a live marker only while live', async () => {
    const live = mount(React.createElement(RingLiveText, { events: STREAMING_STATE.events, live: true }));
    await live.render();
    expect(live.container.querySelector('[data-testid="ring-live-text"]')?.textContent).toContain('Checking turbine T-07 vibration…');
    expect(live.container.querySelector('[data-testid="ring-live-caret"]')).toBeTruthy();
    expect(live.container.textContent).toContain('partial text');
    live.unmount();
    const done = mount(React.createElement(RingLiveText, { events: STREAMING_STATE.events, live: false }));
    await done.render();
    expect(done.container.querySelector('[data-testid="ring-live-caret"]')).toBeNull();
    done.unmount();
  });

  it('RingPlanChecklist renders steps verbatim with counts', async () => {
    const view = mount(React.createElement(RingPlanChecklist, { plan: latestPlan(STREAMING_STATE.events) }));
    await view.render();
    const steps = view.container.querySelectorAll('[data-testid="ring-plan-step"]');
    expect(steps).toHaveLength(3);
    expect(view.container.textContent).toContain('PLAN · 1/3');
    expect(view.container.textContent).toContain('Draft safety note');
    view.unmount();
  });

  it('RingArtifactCard shows filename suffix (not the raw path) with Open', async () => {
    const onDownload = vi.fn(async () => {});
    const view = mount(
      React.createElement(RingArtifactCard, { artifact: allArtifacts(STREAMING_STATE.events)[0], runId: 'run-1', onDownload }),
    );
    await view.render();
    expect(view.container.querySelector('[data-testid="ring-artifact-name"]')?.textContent).toBe('safety-note.md');
    expect(view.container.textContent).not.toContain('.maos/ring-runs/artifacts/run-1/safety-note.md');
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-artifact-open"]')?.click();
    });
    expect(onDownload).toHaveBeenCalledWith('run-1', 'safety-note.md');
    view.unmount();
  });

  it('RingMemoryNote renders the summary verbatim', async () => {
    const view = mount(React.createElement(RingMemoryNote, { memory: { noteId: 'n', summary: 'T-07 exceeds the demo limit.' } }));
    await view.render();
    expect(view.container.textContent).toContain('T-07 exceeds the demo limit.');
    view.unmount();
  });
});

describe('threads + role picker', () => {
  it('role list mirrors the frozen contract; default is operator', () => {
    expect(RING_ROLES).toEqual(['operator', 'maintenance', 'safety', 'manager']);
    expect(DEFAULT_RING_ROLE).toBe('operator');
  });

  it('toThreadSummary validates the frozen thread shape and fails closed', () => {
    const thread = { threadId: 'thread-1730000000000-abcdef12', title: 'Turbine review', role: 'safety', createdAt: '2026-11-02T00:00:00Z', runs: ['ring-a'] };
    expect(toThreadSummary(thread)).toEqual({ ...thread });
    expect(() => toThreadSummary({ ...thread, role: 'admin' })).toThrow('RING_RUN_INVALID');
  });

  it('sidebar lists threads, marks active, and says when the service is unavailable', async () => {
    const onSelect = vi.fn();
    const onNew = vi.fn();
    const threads = [
      { threadId: 'thread-1', title: 'Turbine review', role: 'safety', createdAt: 't', runs: ['r1', 'r2'] },
    ];
    const view = mount(
      React.createElement(RingThreadSidebar, { threads, activeThreadId: 'thread-1', available: true, loading: false, onSelect, onNew }),
    );
    await view.render();
    const btn = view.container.querySelector('[data-testid="ring-thread-thread-1"]');
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(btn?.textContent).toContain('2 runs');
    await act(async () => {
      btn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('thread-1');
    view.unmount();

    const down = mount(
      React.createElement(RingThreadSidebar, { threads: [], activeThreadId: null, available: false, loading: false, onSelect, onNew }),
    );
    await down.render();
    expect(down.container.querySelector('[data-testid="ring-threads-unavailable"]')).toBeTruthy();
    expect(down.container.querySelector('[data-testid="ring-new-thread"]')?.hasAttribute('disabled')).toBe(true);
    down.unmount();
  });

  it('role picker offers the four roles and labels unscoped requests honestly', async () => {
    const onPick = vi.fn();
    const view = mount(React.createElement(RingRolePicker, { role: 'operator', threadAvailable: false, onPick }));
    await view.render();
    const select = view.container.querySelector<HTMLSelectElement>('[data-testid="ring-role-picker"]');
    expect(select?.options.length).toBe(4);
    expect(view.container.querySelector('[data-testid="ring-role-unscoped-note"]')).toBeTruthy();
    view.unmount();
  });
});

describe('attachments', () => {
  it('classifyAttachment accepts pdf/image/csv and refuses the rest', () => {
    const file = (name: string, type: string) => ({ name, type }) as File;
    expect(classifyAttachment(file('a.pdf', 'application/pdf'))).toBe('pdf');
    expect(classifyAttachment(file('a.csv', 'text/csv'))).toBe('csv');
    expect(classifyAttachment(file('a.png', 'image/png'))).toBe('image');
    expect(classifyAttachment(file('a.exe', 'application/x-msdownload'))).toBeNull();
    expect(classifyAttachment(file('a.txt', 'text/plain'))).toBeNull();
  });

  it('instruction suffix references stored paths only (csvPath/documentPath)', () => {
    expect(attachmentInstructionSuffix([])).toBe('');
    expect(
      attachmentInstructionSuffix([
        { name: 'v.csv', kind: 'csv', size: 10, storedPath: 'evidence/v.csv' },
        { name: 's.png', kind: 'image', size: 10, storedPath: null },
      ]),
    ).toContain('csvPath: evidence/v.csv');
    expect(
      attachmentInstructionSuffix([{ name: 's.png', kind: 'image', size: 10, storedPath: null }]),
    ).toBe('');
  });

  it('dropzone + screenshot button render with the visible-capture indicator contract', async () => {
    const view = mount(
      React.createElement(RingAttachmentBar, {
        attachments: [],
        client: { storeEvidenceFile: async () => ({ storedPath: 'evidence/x.csv' }) },
        onChange: () => {},
        onError: () => {},
      }),
    );
    await view.render();
    expect(view.container.querySelector('[data-testid="ring-attachment-dropzone"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="ring-screenshot-button"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="ring-attachment-input"]')).toBeTruthy();
    view.unmount();
  });
});

describe('RingOverlay', () => {
  function overlayClient(state: RingRunState): RingRunClient {
    return {
      startRun: async () => ({ runId: 'run-1' }),
      getRun: async () => state,
      cancelRun: async () => {},
      decideApproval: async () => {},
      downloadArtifact: async () => {},
    };
  }

  it('streams plan + live text + tool chips in the compact view with the exact badge', async () => {
    const running: RingRunState = {
      status: 'running',
      mode: 'hosted',
      events: [
        { type: 'run.started', ts: 't' },
        { type: 'model.delta', ts: 't', delta: 'T-07 verdict ' },
        { type: 'tool.call', ts: 't', tool: 'analyze_telemetry', toolCallId: 'c1' },
      ],
    };
    const view = mount(React.createElement(RingOverlay, { runClient: overlayClient(running), pollIntervalMs: 60_000 }));
    await view.render();
    // no run yet: empty state
    expect(view.container.querySelector('[data-testid="ring-overlay-empty"]')).toBeTruthy();
    // start a run via the overlay input
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="ring-overlay-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'check turbine');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.querySelector('[data-testid="ring-overlay-badge"]')?.textContent).toContain('HOSTED');
    expect(view.container.querySelector('[data-testid="ring-live-text"]')?.textContent).toContain('T-07 verdict');
    expect(view.container.querySelector('[data-testid="ring-tool-chip"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="ring-mark"]')?.getAttribute('data-state')).toBe('using-tool');
    view.unmount();
  });

  it('approval card inside the overlay posts Allow and records the decision', async () => {
    const decisions: Array<{ runId: string; approvalId: string; decision: string }> = [];
    let approved = false;
    const client: RingRunClient = {
      startRun: async () => ({ runId: 'run-1' }),
      getRun: async () =>
        approved
          ? {
              status: 'running',
              mode: 'hosted',
              events: [
                { type: 'approval.pending', ts: 't', approvalId: 'a1', action: 'Write note' },
                { type: 'approval.resolved', ts: 't', approvalId: 'a1', decision: 'approved' },
              ],
            }
          : {
              status: 'awaiting_approval',
              mode: 'hosted',
              events: [{ type: 'approval.pending', ts: 't', approvalId: 'a1', action: 'Write note' }],
            },
      cancelRun: async () => {},
      decideApproval: async (runId, approvalId, decision) => {
        decisions.push({ runId, approvalId, decision });
        approved = true;
      },
      downloadArtifact: async () => {},
    };
    const view = mount(React.createElement(RingOverlay, { runClient: client, pollIntervalMs: 60_000 }));
    await view.render();
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="ring-overlay-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'draft note');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.querySelector('[data-testid="ring-approval-card"]')).toBeTruthy();
    expect(view.container.querySelector('[data-testid="ring-mark"]')?.getAttribute('data-state')).toBe('waiting-for-approval');
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-approval-allow"]')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(decisions).toEqual([{ runId: 'run-1', approvalId: 'a1', decision: 'approved' }]);
    expect(view.container.querySelector('[data-testid="ring-approval-resolved"]')).toBeTruthy();
    view.unmount();
  });

  it('evidence-only badge stays exact in the overlay', async () => {
    const state: RingRunState = { status: 'completed', mode: 'evidence-only', events: [], finalAnswer: 'Local summary.' };
    const view = mount(React.createElement(RingOverlay, { runClient: overlayClient(state), pollIntervalMs: 60_000 }));
    await view.render();
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="ring-overlay-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'summarize');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.querySelector('[data-testid="ring-overlay-badge"]')?.textContent).toBe(
      'EVIDENCE-ONLY · no model configured',
    );
    view.unmount();
  });
});

describe('TASK RING-DEV-B-01: event-bus bridge (record fan-out)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-ring-devb-'));
    fs.mkdirSync(path.join(root, '.maos'), { recursive: true });
    fs.mkdirSync(path.join(root, 'demo', 'industrial'), { recursive: true });
    const repoRoot = path.resolve(__dirname, '../..');
    for (const f of ['sop_turbine_vibration_monitoring.md', 'maintenance_report.txt', 'safety_thresholds.json', 'turbine_vibration_log.csv']) {
      fs.copyFileSync(path.join(repoRoot, 'demo', 'industrial', f), path.join(root, 'demo', 'industrial', f));
    }
    fs.writeFileSync(
      path.join(root, '.maos', 'maos.config.json'),
      JSON.stringify({ schemaVersion: 1, projectName: 'ring-devb-test', profile: { id: 'industrial', displayName: 'MAOS Industrial', mode: 'sovereign-local', zeroCloud: true } }),
    );
    delete process.env.BASETEN_API_KEY;
  });
  afterEach(() => {
    delete process.env.BASETEN_API_KEY;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('evidence-only run fans mapped wire events into EventService as ring.run.* (runId-scoped)', async () => {
    delete process.env.BASETEN_API_KEY;
    const { RingAgentService } = await import('../../src/service/ring-agent-service');
    const { AuditService } = await import('../../src/service/audit-service');
    const { EventService } = await import('../../src/service/event-service');
    const event = new EventService(root);
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root), eventService: event });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    await service.waitForCompletion(runId, 30000);
    const sequenced = event.querySequenced({ runId, limit: 500 });
    const types = sequenced.map((e) => e.eventType);
    expect(types).toContain('ring.run.run.started');
    expect(types).toContain('ring.run.tool.call');
    expect(types).toContain('ring.run.tool.result');
    expect(types).toContain('ring.run.run.completed');
    // payload is the UI wire copy: no raw CSV rows attached
    const blob = JSON.stringify(sequenced.map((e) => e.payload));
    expect(blob).not.toContain('2026-08-22T09:00:00+05:30,T-07,2.82,74.5');
    // every fanned event carries the run id for the runId-scoped channel
    for (const e of sequenced) expect(e.runId).toBe(runId);
  });

  it('no EventService wired: run still completes (bus is optional)', async () => {
    delete process.env.BASETEN_API_KEY;
    const { RingAgentService } = await import('../../src/service/ring-agent-service');
    const { AuditService } = await import('../../src/service/audit-service');
    const service = new RingAgentService({ projectRoot: root, auditService: new AuditService(root) });
    const runId = service.startRun('Analyze turbine vibration telemetry and summarize the verdict');
    const snap = await service.waitForCompletion(runId, 30000);
    expect(snap.status).toBe('completed');
  });
});

describe('desktop overlay host (plain node)', () => {
  it('hotkey defaults to Ctrl+Shift+Space and is configurable; failure is loud', async () => {
    const host = require('../../desktop/ring-overlay-host.cjs') as typeof import('../../desktop/ring-overlay-host.cjs');
    expect(host.DEFAULT_HOTKEY).toBe('CommandOrControl+Shift+Space');
    expect(host.ringHotkey()).toBe('CommandOrControl+Shift+Space');
    process.env.MAOS_RING_HOTKEY = 'Ctrl+Alt+R';
    expect(host.ringHotkey()).toBe('Ctrl+Alt+R');
    delete process.env.MAOS_RING_HOTKEY;

    const errors: string[] = [];
    const failing = { register: () => false, unregisterAll: () => {} };
    const dialog = { showErrorBox: (title: string, msg: string) => errors.push(title + ': ' + msg) };
    const orig = console.error;
    console.error = () => {};
    try {
      const result = host.registerRingHotkey({ globalShortcut: failing, dialog } as never, () => {});
      expect(result.error).toContain("globalShortcut.register('CommandOrControl+Shift+Space') returned false");
      expect(errors.join(' ')).toContain('Ring overlay hotkey unavailable');
      expect(host.overlayState.hotkeyError).toContain('returned false');
    } finally {
      console.error = orig;
    }
    host.overlayState.hotkeyError = null;
    host.overlayState.hotkey = null;
  });

  it('toggle creates/shows/hides the overlay window through the injected BrowserWindow', async () => {
    const host = require('../../desktop/ring-overlay-host.cjs') as typeof import('../../desktop/ring-overlay-host.cjs');
    host.overlayState.window = null;
    const created: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const fakeWindow = () => ({
      isDestroyed: () => false,
      isVisible: () => created.length > 0 && (created[0] as { shown?: string }).shown !== 'hidden',
      show: () => {
        calls.push('show');
        (created[0] as { shown?: string }).shown = 'shown';
      },
      hide: () => {
        calls.push('hide');
        (created[0] as { shown?: string }).shown = 'hidden';
      },
      focus: () => calls.push('focus'),
      setAlwaysOnTop: () => {},
      setVisibleOnAllWorkspaces: () => {},
      loadURL: async (url: string) => {
        calls.push('load:' + url);
      },
      once: (event: string, cb: () => void) => {
        if (event === 'ready-to-show') cb();
      },
      webContents: { setWindowOpenHandler: () => {}, on: () => {} },
    });
    const FakeBrowserWindow = function (this: unknown, _opts: unknown) {
      created.push({ shown: 'shown' });
      return fakeWindow();
    };
    const ui = { origin: 'http://127.0.0.1:9' };
    const first = host.toggleOverlay(ui, { BrowserWindow: FakeBrowserWindow, ui, preloadPath: 'p', sessionPartition: 's' });
    expect(first).toBe('shown');
    expect(calls.join('|')).toContain('load:http://127.0.0.1:9/#/ring-overlay');
    const second = host.toggleOverlay(ui, { BrowserWindow: FakeBrowserWindow, ui, preloadPath: 'p', sessionPartition: 's' });
    expect(second).toBe('hidden');
    host.overlayState.window = null;
  });
});

describe('TASK RING-DEV-B-01: overlay Expand handoff + explicit screenshot', () => {
  function wsClient(state: RingRunState): RingRunClient {
    return {
      startRun: async () => ({ runId: 'run-1' }),
      getRun: async () => state,
      cancelRun: async () => {},
      decideApproval: async () => {},
      downloadArtifact: async () => {},
    };
  }

  it('Expand writes the handoff key and never navigates the overlay window itself', async () => {
    const running: RingRunState = { status: 'running', mode: 'hosted', events: [{ type: 'run.started', ts: 't' }] };
    window.localStorage.clear();
    const view = mount(React.createElement(RingOverlay, { runClient: wsClient(running), pollIntervalMs: 60_000 }));
    await view.render();
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="ring-overlay-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'check turbine');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const hashBefore = window.location.hash;
    // no Electron bridge in happy-dom: the overlay falls back to an
    // in-tab navigation and says so (Electron path keeps its own route).
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-expand-button"]')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(window.localStorage.getItem('maos:ring:expand-thread')).toBe('run-1');
    expect(view.container.querySelector('[data-testid="ring-expand-note"]')).toBeTruthy();
    window.location.hash = hashBefore;
    window.localStorage.clear();
    view.unmount();
  });

  it('overlay thread id wins over run id when a thread client exists', async () => {
    const running: RingRunState = { status: 'running', mode: 'hosted', events: [{ type: 'run.started', ts: 't' }] };
    const client: RingRunClient = {
      ...wsClient(running),
      threadClient: {
        createThread: async () => ({ threadId: 'thread-1-abcdef12' }),
        getThread: async (threadId) => ({ threadId, title: 't', role: 'operator', createdAt: 't', runs: [] }),
        postMessage: async () => ({ runId: 'run-9' }),
      },
    };
    window.localStorage.clear();
    const view = mount(React.createElement(RingOverlay, { runClient: client, pollIntervalMs: 60_000 }));
    await view.render();
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="ring-overlay-input"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'check turbine');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-expand-button"]')?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(window.localStorage.getItem('maos:ring:expand-thread')).toBe('thread-1-abcdef12');
    window.localStorage.clear();
    view.unmount();
  });

  it('overlay screenshot via the Electron bridge holds the image locally with the pending label', async () => {
    const running: RingRunState = { status: 'running', mode: 'hosted', events: [{ type: 'run.started', ts: 't' }] };
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    (window as unknown as { maosNative?: unknown }).maosNative = {
      initialize: async () => ({}),
      expandRing: () => {},
      captureRingScreen: async () => ({ pngBase64: png, width: 8, height: 8, displays: 1 }),
    };
    const view = mount(React.createElement(RingOverlay, { runClient: wsClient(running), pollIntervalMs: 60_000 }));
    await view.render();
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-overlay-screenshot"]')?.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    await view.flush();
    expect(view.container.querySelector('[data-testid="ring-overlay-screenshot-indicator"]')).toBeFalsy();
    const chip = view.container.querySelector('[data-testid="ring-overlay-screenshot-chip"]');
    expect(chip?.textContent).toContain('local only — inspect_image pending (Dev C)');
    expect(chip?.querySelector('img')?.getAttribute('src')).toContain('data:image/png;base64,');
    delete (window as unknown as { maosNative?: unknown }).maosNative;
    view.unmount();
  });

  it('capturePrimaryDisplay returns base64 on success and a loud reason on failure', async () => {
    const host = require('../../desktop/ring-overlay-host.cjs') as typeof import('../../desktop/ring-overlay-host.cjs');
    const png = Buffer.from([1, 2, 3]);
    const ok = await host.capturePrimaryDisplay({
      desktopCapturer: {
        getSources: async () => [{ display_id: '1', thumbnail: { toPNG: () => png, getSize: () => ({ width: 10, height: 5 }) } }],
      },
      screen: { getAllDisplays: () => [{ id: 1 }], getPrimaryDisplay: () => ({ id: 1, size: { width: 10, height: 5 } }) },
    });
    expect(ok.pngBase64).toBe(png.toString('base64'));
    expect(ok.displays).toBe(1);
    const denied = await host.capturePrimaryDisplay({
      desktopCapturer: { getSources: async () => { throw new Error('denied by OS'); } },
      screen: { getAllDisplays: () => [{ id: 1 }], getPrimaryDisplay: () => ({ id: 1, size: { width: 10, height: 5 } }) },
    });
    expect(denied.dismissed).toBe(true);
    expect(denied.reason).toContain('denied by OS');
    const empty = await host.capturePrimaryDisplay({
      desktopCapturer: { getSources: async () => [] },
      screen: { getAllDisplays: () => [], getPrimaryDisplay: () => null },
    });
    expect(empty.dismissed).toBe(true);
  });

  it('attachment bar routes screenshots through the bridge with the pending label', async () => {
    const png = Buffer.from([137, 80, 78, 71]).toString('base64');
    (window as unknown as { maosNative?: unknown }).maosNative = {
      initialize: async () => ({}),
      captureRingScreen: async () => ({ pngBase64: png, width: 4, height: 4, displays: 1 }),
    };
    let current: import('../../src/gui/src/components/RingAttachments').RingAttachment[] = [];
    const view = mount(
      React.createElement(RingAttachmentBar, {
        attachments: current,
        client: { storeEvidenceFile: async () => { throw new Error('no route'); } },
        onChange: (next) => { current = next; },
        onError: () => {},
      }),
    );
    await view.render();
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-testid="ring-screenshot-button"]')?.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(current.length).toBe(1);
    expect(current[0].storedPath).toBeNull();
    expect(current[0].previewUrl).toContain('data:image/png;base64,');
    delete (window as unknown as { maosNative?: unknown }).maosNative;
    view.unmount();
  });
});

describe('TASK RING-DEV-B-01: full view adopts the overlay Expand handoff', () => {
  it('run-id handoff appends the run to the transcript with an honest notice', async () => {
    const { RingWorkspace } = await import('../../src/gui/src/components/RingWorkspace');
    const adopted: RingRunState = {
      status: 'running',
      mode: 'hosted',
      events: [
        { type: 'run.started', ts: 't' },
        { type: 'model.turn', ts: 't', text: 'overlay draft' },
      ],
    };
    window.localStorage.setItem('maos:ring:expand-thread', 'run-adopt-1');
    const view = mount(
      React.createElement(RingWorkspace, {
        runClient: {
          startRun: async () => ({ runId: 'run-x' }),
          getRun: async () => adopted,
          cancelRun: async () => {},
          decideApproval: async () => {},
          downloadArtifact: async () => {},
        },
        pollIntervalMs: 60_000,
      }),
    );
    await view.render();
    await view.flush();
    expect(window.localStorage.getItem('maos:ring:expand-thread')).toBeNull();
    expect(view.container.querySelector('[data-testid="ring-expand-notice"]')?.textContent).toContain('Adopted run run-adopt-1 from the overlay.');
    expect(view.container.textContent).toContain('overlay draft');
    window.localStorage.clear();
    view.unmount();
  });

  it('thread handoff loads the summary, marks the thread active, and polls its runs', async () => {
    const { RingWorkspace } = await import('../../src/gui/src/components/RingWorkspace');
    const threadRun: RingRunState = {
      status: 'completed',
      mode: 'hosted',
      events: [{ type: 'model.turn', ts: 't', text: 'thread history text' }],
    };
    window.localStorage.setItem('maos:ring:expand-thread', 'thread-9-abcdef12');
    const view = mount(
      React.createElement(RingWorkspace, {
        runClient: {
          startRun: async () => ({ runId: 'run-x' }),
          getRun: async () => threadRun,
          cancelRun: async () => {},
          decideApproval: async () => {},
          downloadArtifact: async () => {},
          threadClient: {
            createThread: async () => ({ threadId: 'thread-9-abcdef12' }),
            getThread: async (threadId) => ({ threadId, title: 'Overlay thread', role: 'safety', createdAt: 't', runs: ['run-t1'] }),
            postMessage: async () => ({ runId: 'run-t2' }),
          },
        },
        pollIntervalMs: 60_000,
      }),
    );
    await view.render();
    await view.flush();
    await view.flush();
    expect(view.container.querySelector('[data-testid="ring-expand-notice"]')?.textContent).toContain('Adopted thread thread-9-abcdef12 from the overlay.');
    expect(view.container.textContent).toContain('thread history text');
    expect(view.container.textContent).toContain('Overlay thread');
    window.localStorage.clear();
    view.unmount();
  });
});
