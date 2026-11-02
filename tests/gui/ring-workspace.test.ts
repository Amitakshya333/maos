// @vitest-environment happy-dom
/**
 * TASK RING-UI-01: Ring agent workspace (roster + streaming run transcript
 * + inline approval cards). happy-dom render with an injected run client;
 * tool chips, approval Allow/Deny posting, evidence-only honesty, and
 * cancel are exercised against mocked RING-AGENT-LOOP-01 run payloads.
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RING_EVIDENCE_ONLY_BADGE,
  RING_HOSTED_BADGE,
  RingWorkspace,
  buildRingRoster,
  ringRunBadgeText,
  type RingRunClient,
} from '../../src/gui/src/components/RingWorkspace';
import type { RingRunState } from '../../src/gui/src/api/ring-run-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG_AGENTS = [
  { id: 'INGEST_AGENT', role: 'industrial_ingest' },
  { id: 'ANALYST_AGENT', role: 'industrial_analyst' },
  { id: 'AUDITOR_AGENT', role: 'industrial_auditor' },
  { id: 'SYNTHESIZER_AGENT', role: 'industrial_synthesizer' },
];

const HOSTED_RUNNING: RingRunState = {
  status: 'running',
  mode: 'hosted',
  events: [
    { type: 'run.started', ts: '2026-11-02T00:00:00Z' },
    { type: 'tool.call', ts: '2026-11-02T00:00:01Z', tool: 'analyze_telemetry', toolCallId: 'call-telemetry-1', argsSummary: 'turbine_vibration_log.csv' },
    {
      type: 'tool.result',
      ts: '2026-11-02T00:00:02Z',
      tool: 'analyze_telemetry',
      toolCallId: 'call-telemetry-1',
      resultSummary: 'WARNING: RMS 4.125 mm/s above the demo limit (analysis telemetry-1793000000000-abcdef12)',
      verdict: 'WARNING',
      overallRms: 4.125,
      sources: ['demo/industrial/turbine_vibration_log.csv'],
    },
    { type: 'model.turn', ts: '2026-11-02T00:00:03Z', text: 'The deterministic check flags turbine 7; drafting the note next.' },
  ],
};

const AWAITING_APPROVAL: RingRunState = {
  status: 'awaiting_approval',
  mode: 'hosted',
  events: [
    { type: 'run.started', ts: '2026-11-02T00:00:00Z' },
    {
      type: 'approval.pending',
      ts: '2026-11-02T00:00:04Z',
      approvalId: 'appr-1',
      action: 'Write safety note to demo/industrial/generated/safety_note.md',
      reason: 'The synthesizer drafts operator-facing notes only after a human approves the write.',
    },
  ],
};

const APPROVED_RUNNING: RingRunState = {
  status: 'running',
  mode: 'hosted',
  events: [
    ...AWAITING_APPROVAL.events,
    { type: 'approval.resolved', ts: '2026-11-02T00:00:05Z', approvalId: 'appr-1', decision: 'approved', action: 'Write safety note to demo/industrial/generated/safety_note.md' },
  ],
};

const EVIDENCE_ONLY_DONE: RingRunState = {
  status: 'completed',
  mode: 'evidence-only',
  events: [
    { type: 'run.started', ts: '2026-11-02T00:00:00Z' },
    { type: 'tool.call', ts: '2026-11-02T00:00:01Z', tool: 'analyze_telemetry', toolCallId: 'call-telemetry-1', argsSummary: 'turbine_vibration_log.csv' },
    {
      type: 'tool.result',
      ts: '2026-11-02T00:00:02Z',
      tool: 'analyze_telemetry',
      toolCallId: 'call-telemetry-1',
      resultSummary: 'WARNING: RMS 4.125 mm/s above the demo limit',
      verdict: 'WARNING',
      overallRms: 4.125,
      sources: ['demo/industrial/turbine_vibration_log.csv'],
    },
    { type: 'run.completed', ts: '2026-11-02T00:00:03Z' },
  ],
  finalAnswer: 'Local evidence summary: WARNING verdict, RMS 4.125 mm/s. No model ran.',
};

function makeClient(states: RingRunState[]) {
  // The workspace polls once immediately after startRun, then again after
  // cancel/approval posts; serve states[stateIndex] until advance() is
  // called so a test controls exactly when the run state changes.
  let stateIndex = 0;
  const calls = {
    starts: [] as Array<{ instruction: string; agentId?: string }>,
    cancels: [] as string[],
    decisions: [] as Array<{ runId: string; approvalId: string; decision: string }>,
  };
  const client: RingRunClient = {
    startRun: async (input) => {
      calls.starts.push(input);
      return { runId: 'run-1' };
    },
    getRun: async () => states[Math.min(stateIndex, states.length - 1)],
    cancelRun: async (runId) => {
      calls.cancels.push(runId);
    },
    decideApproval: async (runId, approvalId, decision) => {
      calls.decisions.push({ runId, approvalId, decision });
    },
  };
  return {
    client,
    calls,
    advance: () => {
      stateIndex = Math.min(stateIndex + 1, states.length - 1);
    },
  };
}

async function mountWorkspace(props: React.ComponentProps<typeof RingWorkspace>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(RingWorkspace, props));
  });
  return {
    container,
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function sendInstruction(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="ring-instruction-input"]');
  expect(input, 'instruction input exists').toBeTruthy();
  await act(async () => {
    setInputValue(input!, text);
  });
  const form = input!.closest('form');
  expect(form, 'instruction form exists').toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ring roster', () => {
  it('renders agents from a config fixture with Ring as lead, ids, roles, and status dots', () => {
    const roster = buildRingRoster(CONFIG_AGENTS);
    expect(roster.map((agent) => agent.id)).toEqual([
      'RING',
      'INGEST_AGENT',
      'ANALYST_AGENT',
      'AUDITOR_AGENT',
      'SYNTHESIZER_AGENT',
    ]);

    const html = renderToStaticMarkup(
      React.createElement(RingWorkspace, { agents: roster, runClient: makeClient([HOSTED_RUNNING]).client, pollIntervalMs: 60000 }),
    );
    for (const agent of CONFIG_AGENTS) {
      expect(html).toContain(`data-testid="ring-agent-${agent.id}"`);
      expect(html).toContain(agent.role);
    }
    expect(html).toContain('data-testid="ring-agent-RING"');
    expect(html).toContain('ring-agent-status-dot');
    expect(html).toContain('No runs yet');
    expect(html).toContain('Why is turbine 7 above its vibration limit');
    expect(html).toContain('Draft a safety note');
    expect(html).toContain('Verify the last export');
    expect(html).not.toContain('data-testid="ring-ask-panel"');
  });

  it('badges stay verbatim and never invent a reported served-model id', () => {
    expect(ringRunBadgeText(HOSTED_RUNNING, 'LOCAL: None')).toBe(RING_HOSTED_BADGE);
    expect(RING_HOSTED_BADGE).toBe('HOSTED · meta-models/muse-spark-open-1026 via Baseten');
    expect(ringRunBadgeText(HOSTED_RUNNING, 'LOCAL: None')).not.toContain('reported');
    expect(ringRunBadgeText(EVIDENCE_ONLY_DONE, 'LOCAL: None')).toBe(RING_EVIDENCE_ONLY_BADGE);
    expect(RING_EVIDENCE_ONLY_BADGE).toBe('EVIDENCE-ONLY · no model configured');
    expect(ringRunBadgeText(null, 'CUDA: qwen2.5-3b-instruct-local')).toBe('CUDA: qwen2.5-3b-instruct-local');
  });
});

describe('ring run transcript', () => {
  it('sending an instruction creates a run scoped to the selected agent and renders tool chips', async () => {
    const { client, calls } = makeClient([HOSTED_RUNNING]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      const analyst = view.container.querySelector<HTMLButtonElement>('[data-testid="ring-agent-ANALYST_AGENT"]');
      await act(async () => analyst!.click());
      await sendInstruction(view.container, 'Why is turbine 7 above its vibration limit?');

      expect(calls.starts).toEqual([{ instruction: 'Why is turbine 7 above its vibration limit?', agentId: 'ANALYST_AGENT' }]);
      expect(view.container.querySelector('[data-testid="ring-user-message"]')?.textContent).toContain('turbine 7');
      const chip = view.container.querySelector('[data-testid="ring-tool-chip"]');
      expect(chip?.textContent).toContain('analyze_telemetry · turbine_vibration_log.csv');

      await act(async () => chip!.querySelector('button')!.click());
      const result = view.container.querySelector('[data-testid="ring-tool-result"]');
      expect(result?.textContent).toContain('WARNING');
      expect(result?.textContent).toContain('RMS: 4.125');
      expect(result?.textContent).toContain('demo/industrial/turbine_vibration_log.csv');
      expect(view.container.querySelector('[data-testid="ring-model-turn"]')?.textContent).toContain('RING');
      expect(view.container.querySelector('[data-testid="ring-working-indicator"]')).toBeTruthy();
      expect(view.container.querySelector('[data-testid="ring-cancel-button"]')).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('cancel button posts cancel for the active run', async () => {
    const cancelled: RingRunState = {
      status: 'cancelled',
      mode: 'hosted',
      events: [...HOSTED_RUNNING.events, { type: 'run.cancelled', ts: '2026-11-02T00:00:09Z' }],
    };
    const { client, calls, advance } = makeClient([HOSTED_RUNNING, cancelled]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      await sendInstruction(view.container, 'Check turbine 7');
      advance();
      const cancel = view.container.querySelector<HTMLButtonElement>('[data-testid="ring-cancel-button"]');
      expect(cancel).toBeTruthy();
      await act(async () => {
        cancel!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(calls.cancels).toEqual(['run-1']);
      expect(view.container.querySelector('[data-testid="ring-run-cancelled"]')).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('backend down shows an honest error with retry and fabricates no run', async () => {
    const client: RingRunClient = {
      startRun: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3847');
      },
      getRun: async () => HOSTED_RUNNING,
      cancelRun: async () => {},
      decideApproval: async () => {},
    };
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      await sendInstruction(view.container, 'Check turbine 7');
      const error = view.container.querySelector('[data-testid="ring-start-error"]');
      expect(error?.textContent).toContain('ECONNREFUSED');
      expect(view.container.querySelector('[data-testid="ring-retry-button"]')).toBeTruthy();
      expect(view.container.querySelector('[data-testid="ring-user-message"]')).toBeNull();
      expect(view.container.querySelector('[data-testid="ring-empty-state"]')).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('run failed shows the failure event message verbatim', async () => {
    const failed: RingRunState = {
      status: 'failed',
      mode: 'hosted',
      events: [
        { type: 'run.started', ts: '2026-11-02T00:00:00Z' },
        { type: 'run.failed', ts: '2026-11-02T00:00:05Z', message: 'Baseten returned 429: rate limit for muse-spark-open-1026' },
      ],
    };
    const { client } = makeClient([failed]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      await sendInstruction(view.container, 'Check turbine 7');
      expect(view.container.querySelector('[data-testid="ring-run-failed"]')?.textContent).toContain(
        'Baseten returned 429: rate limit for muse-spark-open-1026',
      );
      expect(view.container.querySelector('[data-testid="ring-working-indicator"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe('ring approval cards', () => {
  it('approval.pending renders Allow/Deny, posts the decision, and records the resolution', async () => {
    const { client, calls, advance } = makeClient([AWAITING_APPROVAL, APPROVED_RUNNING]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      await sendInstruction(view.container, 'Draft a safety note for turbine 7');
      advance();
      const card = view.container.querySelector('[data-testid="ring-approval-card"]');
      expect(card?.textContent).toContain('Write safety note to demo/industrial/generated/safety_note.md');
      expect(card?.textContent).toContain('human approves the write');
      const allow = view.container.querySelector<HTMLButtonElement>('[data-testid="ring-approval-allow"]');
      const deny = view.container.querySelector<HTMLButtonElement>('[data-testid="ring-approval-deny"]');
      expect(allow?.textContent).toBe('Allow');
      expect(deny?.textContent).toBe('Deny');
      expect(view.container.querySelector('[data-testid="ring-working-indicator"]')?.textContent).toContain('Waiting for approval');

      await act(async () => {
        allow!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(calls.decisions).toEqual([{ runId: 'run-1', approvalId: 'appr-1', decision: 'approved' }]);
      expect(view.container.querySelector('[data-testid="ring-approval-card"]')).toBeNull();
      expect(view.container.querySelector('[data-testid="ring-approval-resolved"]')?.textContent).toContain('Approved');
    } finally {
      view.unmount();
    }
  });
});

describe('ring threads (Dev A lane)', () => {
  it('thread UI: new thread button posts to the thread routes and scopes runs', async () => {
    const threadCalls: Array<{ title?: string }> = [];
    const messageCalls: Array<{ threadId: string; instruction: string }> = [];
    const { client } = makeClient([HOSTED_RUNNING]);
    const threadClient: RingRunClient = {
      ...client,
      createThread: async (input) => { threadCalls.push(input); return { threadId: 'thread-1' }; },
      getThread: async (threadId) => ({ threadId, title: 'T-07 review', role: 'operator', createdAt: '2026-11-02T00:00:00Z', runs: [] }),
      postThreadMessage: async (threadId, instruction) => { messageCalls.push({ threadId, instruction }); return { runId: 'run-1' }; },
    };
    const view = await mountWorkspace({ agents: buildRingRoster(CONFIG_AGENTS), runClient: threadClient, pollIntervalMs: 60000 });
    try {
      expect(view.container.querySelector('[data-testid="ring-thread-bar"]')).toBeTruthy();
      await act(async () => { view.container.querySelector<HTMLButtonElement>('[data-testid="ring-new-thread-button"]')!.click(); await new Promise((r) => setTimeout(r, 0)); });
      expect(threadCalls.length).toBe(1);
      expect(view.container.querySelector('[data-testid="ring-active-thread"]')?.textContent).toContain('thread-1');
      await sendInstruction(view.container, 'Brief me on T-07');
      expect(messageCalls).toEqual([{ threadId: 'thread-1', instruction: 'Brief me on T-07' }]);
    } finally {
      view.unmount();
    }
  });

  it('without thread methods the thread bar stays hidden and runs stay unthreaded', async () => {
    const { client, calls } = makeClient([HOSTED_RUNNING]);
    const view = await mountWorkspace({ agents: buildRingRoster(CONFIG_AGENTS), runClient: client, pollIntervalMs: 60000 });
    try {
      expect(view.container.querySelector('[data-testid="ring-thread-bar"]')).toBeNull();
      const analyst = view.container.querySelector<HTMLButtonElement>('[data-testid="ring-agent-ANALYST_AGENT"]');
      await act(async () => analyst!.click());
      await sendInstruction(view.container, 'Check turbine 7');
      expect(calls.starts).toEqual([{ instruction: 'Check turbine 7', agentId: 'ANALYST_AGENT' }]);
    } finally {
      view.unmount();
    }
  });
});

describe('ring evidence-only honesty', () => {
  it('shows the evidence-only banner and no fake model text appears', async () => {
    const { client } = makeClient([EVIDENCE_ONLY_DONE]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
    });
    try {
      await sendInstruction(view.container, 'What does the evidence say about turbine 7?');
      const banner = view.container.querySelector('[data-testid="ring-evidence-only-banner"]');
      expect(banner?.textContent).toContain('no model wrote this answer');
      expect(banner?.textContent).toContain('no model ran');
      expect(view.container.querySelector('[data-testid="ring-model-turn"]')).toBeNull();
      const finalAnswer = view.container.querySelector('[data-testid="ring-final-answer"]');
      expect(finalAnswer?.textContent).toContain('Local evidence summary: WARNING verdict');
      expect(finalAnswer?.textContent).toContain('No model wrote this answer');
      expect(view.container.querySelector('[data-testid="ring-no-model-note"]')).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  it('keeps the completion-refusal demo reachable from Ring via prepareReview', async () => {
    const prepareReview = vi.fn(async () => {
      throw new Error('Accepted agent report was not found inside the active project.');
    });
    const { client } = makeClient([HOSTED_RUNNING]);
    const view = await mountWorkspace({
      agents: buildRingRoster(CONFIG_AGENTS),
      runClient: client,
      pollIntervalMs: 60000,
      prepareReview,
    });
    try {
      await sendInstruction(view.container, 'Why is turbine 7 above its vibration limit?');
      const claim = [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Try to claim completion without the required tool'),
      );
      expect(claim, 'refusal demo action is rendered in Ring').toBeTruthy();
      await act(async () => {
        claim!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(prepareReview).toHaveBeenCalledWith('telemetry-1793000000000-abcdef12');
      expect(view.container.textContent).toContain('Accepted agent report was not found inside the active project.');
    } finally {
      view.unmount();
    }
  });
});
