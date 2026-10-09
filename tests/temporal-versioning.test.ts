import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTemporalBuildId, parseTemporalVersioningConfig } from '../src/temporal/versioning.js';

function sets(buildIds: string[]) {
  return { versionSets: [{ buildIds, defaultBuildId: buildIds.at(-1) }] } as any;
}

describe('Temporal build ID versioning', () => {
  it.each(['0', '1'])('defaults to PINNED when versioning is %s', useVersioning => {
    expect(parseTemporalVersioningConfig({ AEEIS_BUILD_ID: 'worker-v1', AEEIS_TEMPORAL_USE_VERSIONING: useVersioning }).defaultVersioningBehavior).toBe('PINNED');
  });

  it.each([
    ['0', 'PINNED'], ['0', 'AUTO_UPGRADE'],
    ['1', 'PINNED'], ['1', 'AUTO_UPGRADE'],
  ])('accepts %s versioning with %s behavior', (useVersioning, behavior) => {
    expect(parseTemporalVersioningConfig({
      AEEIS_BUILD_ID: 'worker-v1',
      AEEIS_TEMPORAL_USE_VERSIONING: useVersioning,
      AEEIS_TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR: behavior,
    }).defaultVersioningBehavior).toBe(behavior);
  });

  it.each(['0', '1'])('rejects invalid behavior when versioning is %s', useVersioning => {
    for (const behavior of ['', 'auto_upgrade', 'AUTO', ' PINNED ']) {
      expect(() => parseTemporalVersioningConfig({
        AEEIS_BUILD_ID: 'worker-v1',
        AEEIS_TEMPORAL_USE_VERSIONING: useVersioning,
        AEEIS_TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR: behavior,
      })).toThrow('AEEIS_TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR must be PINNED or AUTO_UPGRADE');
    }
  });

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

describe('Temporal history replay script', () => {
  const originalExitCode = process.exitCode;
  const runReplayHistory = vi.fn();

  afterEach(() => {
    vi.doUnmock('@temporalio/worker');
    vi.doUnmock('node:fs/promises');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function replay(workflowType: string) {
    vi.resetModules();
    vi.stubEnv('AEEIS_TEMPORAL_HISTORY_FILE', 'history.json');
    vi.stubEnv('AEEIS_TEMPORAL_WORKFLOW_ID', 'workflow-test');
    vi.doMock('@temporalio/worker', () => ({ Worker: { runReplayHistory } }));
    vi.doMock('node:fs/promises', () => ({
      readFile: async () => JSON.stringify({ events: [{
        eventId: '1',
        workflowExecutionStartedEventAttributes: { workflowType: { name: workflowType } },
      }] }),
    }));
    await import('../scripts/replay-temporal-history.mjs');
  }

  it.each(['agentRunWorkflow', 'reminderWorkflow'])('accepts %s and reports its type on success', async workflowType => {
    runReplayHistory.mockReset().mockResolvedValue(undefined);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await replay(workflowType);
    expect(runReplayHistory).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      protocol: 'aeeis-temporal-replay/1', status: 'passed',
      workflowId: 'workflow-test', workflowType, historyFile: 'history.json', eventCount: 1,
    });
  });

  it('includes the Reminder type and preserves the failure protocol', async () => {
    runReplayHistory.mockReset().mockRejectedValue(new Error('Replay failed'));
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    await replay('reminderWorkflow');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      protocol: 'aeeis-temporal-replay/1', status: 'failed',
      workflowId: 'workflow-test', workflowType: 'reminderWorkflow',
      historyFile: 'history.json', eventCount: 1, error: { name: 'Error', message: 'Replay failed' },
    });
  });

  it('still rejects unsupported workflow types before replay', async () => {
    runReplayHistory.mockReset();
    await expect(replay('unknownWorkflow')).rejects.toThrow('not agentRunWorkflow or reminderWorkflow');
    expect(runReplayHistory).not.toHaveBeenCalled();
  });
});
