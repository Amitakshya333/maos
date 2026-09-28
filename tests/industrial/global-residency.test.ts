/**
 * Cross-process residency guard regression coverage.
 *
 * The coordinators use different instance identities while sharing one registry,
 * which models separate project-host processes without spawning children.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GlobalResidencyCoordinator } from '../../src/service/model-manager/global-residency';

const registries: string[] = [];

function createRegistry(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maos-global-residency-test-'));
  const registry = path.join(directory, 'residency.json');
  registries.push(directory);
  return registry;
}

afterEach(() => {
  for (const directory of registries.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GlobalResidencyCoordinator', () => {
  it('serializes ownership across coordinator instances and releases on unload', () => {
    const registry = createRegistry();
    const first = new GlobalResidencyCoordinator(registry);
    const second = new GlobalResidencyCoordinator(registry);

    first.claimLease('model-a', 'revision-a', 'lease-a');
    expect(() => second.assertCanAcquire('model-a')).toThrow('CONCURRENCY_VIOLATION');

    first.releaseLease('lease-a');
    expect(() => second.assertCanAcquire('model-a')).toThrow('CONCURRENCY_VIOLATION');

    first.unload();
    expect(() => second.assertCanAcquire('model-a')).not.toThrow();
    second.claimLease('model-a', 'revision-a', 'lease-b');
    second.releaseLease('lease-b');
    second.unload();
  });

  it('recovers a registry owned by a dead process', () => {
    const registry = createRegistry();
    const deadPid = 2147483647;
    fs.writeFileSync(registry, JSON.stringify({
      schemaVersion: 1,
      residentModelId: 'stale-model',
      residentRevision: 'stale-revision',
      ownerPid: deadPid,
      ownerInstanceId: 'stale-instance',
      activeLeases: [{
        leaseId: 'stale-lease',
        modelId: 'stale-model',
        ownerPid: deadPid,
        ownerInstanceId: 'stale-instance',
      }],
      updatedAt: new Date().toISOString(),
    }));

    const coordinator = new GlobalResidencyCoordinator(registry);
    expect(() => coordinator.assertCanAcquire('model-a')).not.toThrow();
    coordinator.claimLease('model-a', 'revision-a', 'lease-a');
    coordinator.releaseLease('lease-a');
    coordinator.unload();
  });
});
