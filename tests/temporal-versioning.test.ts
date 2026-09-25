import { describe, expect, it } from 'vitest';
import { configureTemporalBuildId, parseTemporalVersioningConfig } from '../src/temporal/versioning.js';

function sets(buildIds: string[]) {
  return { versionSets: [{ buildIds, defaultBuildId: buildIds.at(-1) }] } as any;
}

describe('Temporal build ID versioning', () => {
  it('requires explicit registration for a versioned worker', async () => {
    const client = {
      getBuildIdCompatability: async () => undefined,
      updateBuildIdCompatibility: async () => undefined,
    };
    await expect(configureTemporalBuildId(client, 'aeeis-agent', { buildId: 'worker-v2', useVersioning: true, rollout: 'none' })).rejects.toThrow('not registered');
  });

  it('explains when the Temporal namespace has versioning disabled', async () => {
    const client = {
      getBuildIdCompatability: async () => { throw new Error('7 PERMISSION_DENIED: Worker versioning is disabled on this namespace.'); },
      updateBuildIdCompatibility: async () => undefined,
    };
    await expect(configureTemporalBuildId(client, 'aeeis-agent', { buildId: 'worker-v2', useVersioning: true, rollout: 'bootstrap' })).rejects.toThrow('namespace has Worker Versioning disabled');
  });

  it('registers a compatible build and promotes it only when requested', async () => {
    let current = sets(['worker-v1']);
    const operations: unknown[] = [];
    const client = {
      getBuildIdCompatability: async () => current,
      updateBuildIdCompatibility: async (_queue: string, operation: any) => {
        operations.push(operation);
        if (operation.operation === 'addNewCompatibleVersion') current = sets(['worker-v1', operation.buildId]);
      },
    };
    await configureTemporalBuildId(client, 'aeeis-agent', { buildId: 'worker-v2', useVersioning: true, rollout: 'compatible', compatibleWith: 'worker-v1' });
    expect(operations).toEqual([{ operation: 'addNewCompatibleVersion', buildId: 'worker-v2', existingCompatibleBuildId: 'worker-v1' }]);
    await configureTemporalBuildId(client, 'aeeis-agent', { buildId: 'worker-v2', useVersioning: true, rollout: 'promote', compatibleWith: 'worker-v1' });
    expect(operations.at(-1)).toEqual({ operation: 'promoteSetByBuildId', buildId: 'worker-v2' });
  });

  it('rejects mutable or incomplete rollout configuration', () => {
    expect(() => parseTemporalVersioningConfig({ AEEIS_BUILD_ID: 'worker v1', AEEIS_TEMPORAL_USE_VERSIONING: '1' })).toThrow();
    expect(() => parseTemporalVersioningConfig({ AEEIS_BUILD_ID: 'worker-v1', AEEIS_TEMPORAL_BUILD_ID_ROLLOUT: 'compatible', AEEIS_TEMPORAL_USE_VERSIONING: '1' })).toThrow();
    expect(parseTemporalVersioningConfig({ AEEIS_BUILD_ID: 'worker-v1', AEEIS_TEMPORAL_USE_VERSIONING: '1', AEEIS_TEMPORAL_BUILD_ID_ROLLOUT: 'compatible', AEEIS_TEMPORAL_COMPATIBLE_WITH: 'worker-v0' })).toMatchObject({ buildId: 'worker-v1', rollout: 'compatible', compatibleWith: 'worker-v0' });
  });
});
