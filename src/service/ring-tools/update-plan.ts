/**
 * TASK DEV-A-01 (Dev A): update_plan tool.
 *
 * The model publishes and ticks its visible to-do list. Each call records
 * a `plan.updated` streaming event carrying the ordered steps; the wire
 * validator passes the steps through verbatim. Non-consequential (it only
 * writes to the run transcript, never to disk or the outside world).
 */

import type { RingToolDefinition } from '../ring-contract';
import { auditToolExecution, type RingToolDeps } from './tool-deps';

export type RingPlanStatus = 'pending' | 'in_progress' | 'done';

export interface RingPlanUpdateStep {
  step: string;
  status: RingPlanStatus;
}

const VALID_STATUSES: readonly string[] = ['pending', 'in_progress', 'done'];

function isValidStep(value: unknown): value is RingPlanUpdateStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.step === 'string' &&
    s.step.trim().length > 0 &&
    s.step.length <= 200 &&
    typeof s.status === 'string' &&
    (VALID_STATUSES as string[]).includes(s.status)
  );
}

export function createUpdatePlanTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'update_plan',
    description:
      'Publish or tick the visible to-do list for this run. Emits a plan.updated event with the ordered steps. Non-consequential.',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          description: 'Ordered to-do steps, each { step, status: pending|in_progress|done }.',
          items: {
            type: 'object',
            properties: { step: { type: 'string' }, status: { type: 'string' } },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      const raw = (toolArgs as Record<string, unknown>).plan;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
        return { ok: false, error: 'update_plan requires a plan array of 1..20 steps.' };
      }
      if (!raw.every(isValidStep)) {
        return { ok: false, error: 'update_plan steps must be { step: non-empty string (<=200 chars), status: pending|in_progress|done }.' };
      }
      const plan: RingPlanUpdateStep[] = raw.map((s) => ({
        step: (s.step as string).trim(),
        status: s.status as RingPlanStatus,
      }));
      auditToolExecution(deps, toolCtx, 'update_plan', true, { steps: plan.length });
      return {
        ok: true,
        steps: plan.length,
        // Service-side envelope: recorded as plan.updated, stripped before
        // the result reaches the model.
        __ringEvents: [{ type: 'plan.updated', plan }],
      };
    },
  };
}
