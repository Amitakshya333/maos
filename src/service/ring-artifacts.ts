/**
 * TASK RING-CONTRACT-01 (Dev C stub): artifact store helper.
 *
 * FROZEN CONTRACT (Dev C implements against this; behavior spec only):
 * - Artifacts are stored under `.maos/ring-runs/artifacts/<runId>/`.
 * - Served by a download endpoint with path checks reusing the
 *   isWithin/isStrictlyWithin patterns (never serve outside the run dir).
 * - `artifact.created` streaming events carry `{ path, kind, size, sha256 }`.
 *
 * This stub exposes the interface with NOT_IMPLEMENTED bodies so Dev A/B
 * compile against the descriptor shape without waiting for Dev C.
 */

import type { RingArtifactDescriptor } from './ring-contract';

export interface RingArtifactStore {
  artifactDir(runId: string): string;
  saveArtifact(runId: string, filename: string, content: string | Buffer, kind: string): RingArtifactDescriptor;
  resolveArtifactPath(runId: string, filename: string): string;
}

const NOT_IMPLEMENTED = 'RING_ARTIFACT_NOT_IMPLEMENTED: Dev C lane implements the artifact store.';

export class RingArtifactService implements RingArtifactStore {
  constructor(private readonly _projectRoot: string) {}

  artifactDir(_runId: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }

  saveArtifact(_runId: string, _filename: string, _content: string | Buffer, _kind: string): RingArtifactDescriptor {
    throw new Error(NOT_IMPLEMENTED);
  }

  resolveArtifactPath(_runId: string, _filename: string): string {
    throw new Error(NOT_IMPLEMENTED);
  }
}
