/**
 * TASK DEV-A-01 (Dev A): inspect_image tool (VisionService wrapper).
 *
 * Analyzes an equipment photo or screenshot under the evidence root via
 * the existing VisionService (no rewrite). When the vision model runtime
 * is unavailable (weights absent), returns an honest unavailable result
 * instead of fabricating observations. Non-consequential (read-only).
 */

import type { RingToolDefinition } from '../ring-contract';
import { truncate } from '../ring-tool-registry';
import { VlmError } from '../../domain/vision';
import { resolveEvidencePath } from './common';
import { auditToolExecution, resolveProjectId, type RingToolDeps } from './tool-deps';

export function createInspectImageTool(deps: RingToolDeps): RingToolDefinition {
  return {
    name: 'inspect_image',
    description:
      'Analyze an equipment photo or screenshot under the evidence root via the vision service. Honest unavailable result when the vision model is not installed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path relative to the evidence root (PNG or JPEG).' },
        prompt: { type: 'string', description: 'What to look for in the image.' },
      },
      required: ['path'],
    },
    consequential: false,
    execute: (toolCtx, toolArgs) => {
      const requested = typeof toolArgs.path === 'string' ? toolArgs.path : '';
      let resolved: { abs: string; rel: string };
      try {
        resolved = resolveEvidencePath(toolCtx.evidenceRoot, toolCtx.projectRoot, requested);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const prompt = typeof toolArgs.prompt === 'string' && toolArgs.prompt.trim()
        ? toolArgs.prompt.trim().slice(0, 1000)
        : 'Describe visible equipment condition, damage, wear, leaks, or safety concerns.';
      if (!deps.visionService) {
        return {
          ok: true,
          available: false,
          answered: false,
          path: resolved.rel,
          message: 'Vision inspection is unavailable: no vision service is configured for this run. No observations were fabricated.',
        };
      }
      try {
        const result = deps.visionService.analyzeImageSync(
          {
            schemaVersion: 1,
            projectId: resolveProjectId(deps),
            sourcePath: resolved.rel,
            prompt,
            taskType: 'general-observation',
            maxOutputTokens: 500,
            requestId: 'ring-' + toolCtx.runId,
          },
          'ring-agent',
        );
        const observations = Array.isArray(result.observations)
          ? result.observations.slice(0, 10).map((o) => ({
              observationType: o.observationType,
              value: truncate(String(o.value), 500),
              confidence: o.confidence,
              requiresReview: o.requiresReview,
            }))
          : [];
        auditToolExecution(deps, toolCtx, 'inspect_image', true, { path: resolved.rel });
        return {
          ok: true,
          available: true,
          path: resolved.rel,
          observations,
          observationCount: observations.length,
          requiresReviewCount: observations.filter((o) => o.requiresReview).length,
          message: observations.length > 0
            ? 'Vision inspection returned ' + observations.length + ' observation(s); requiresReview items need a human look.'
            : 'Vision inspection completed with no observations. No observations were fabricated.',
        };
      } catch (err) {
        if (err instanceof VlmError && String((err as { code?: string }).code) === 'MODEL_RUNTIME_UNAVAILABLE') {
          return {
            ok: true,
            available: false,
            answered: false,
            path: resolved.rel,
            message: 'Vision inspection is unavailable on this machine: ' + err.message + ' No observations were fabricated.',
          };
        }
        return { ok: false, error: 'Vision inspection failed on ' + resolved.rel + ': ' + (err instanceof Error ? err.message : String(err)) };
      }
    },
  };
}
