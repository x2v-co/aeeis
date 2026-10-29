import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { notifyTemporalRunWorkflow } from '../src/runtime/dispatcher.js';
import { parseTemporalSetupTimeoutMs } from './support/temporal-timeouts.js';

const setupTimeoutMs = parseTemporalSetupTimeoutMs(process.env.AEEIS_TEST_TEMPORAL_SETUP_TIMEOUT_MS);

const workflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('../src/temporal/workflows.ts', import.meta.url)),
});
// Keep a tiny previous bundle in the test suite so a new Worker is proven
// against a history produced by an older workflow implementation. This is
// the same contract that a production Build ID rollout must satisfy.
const previousWorkflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./fixtures/temporal-v1-workflows.ts', import.meta.url)),
});

const preTerminalBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./fixtures/temporal-pre-terminal-workflows.ts', import.meta.url)),
});

describe('AEEIS Temporal workflow', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  const taskQueue = `aeeis-workflow-test-${process.pid}`;

  beforeAll(async () => {
    const downloadDir = process.env.AEEIS_TEST_TEMPORAL_DOWNLOAD_DIR;
    environment = downloadDir
      ? await TestWorkflowEnvironment.createTimeSkipping({
        server: { executable: { type: 'cached-download', downloadDir } },
      })
      : await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowBundle,
      activities: {
        advanceRun: async (id: string) => ({ status: id.startsWith('run-terminal-') ? id.slice('run-terminal-'.length) : 'succeeded' }),
        advanceReminder: async () => ({ status: 'projected', terminal: true }),
      },
    });
    workerRun = worker.run();
  }, setupTimeoutMs);

  afterAll(async () => {
    await worker?.shutdown();
    await workerRun;
    await environment?.teardown();
  }, setupTimeoutMs);

  it('finishes when the activity reports a terminal status', async () => {
    await expect(environment.client.workflow.execute('agentRunWorkflow', {
      workflowId: 'temporal-terminal',
      taskQueue,
      args: ['run-terminal'],
    })).resolves.toBeUndefined();
  });

  it('starts independent follow-up workflows with unchanged arguments and resumes child waits without restarting the parent', async () => {
    const queue = `${taskQueue}-threads`;
    const parentId = 'run_11111111-1111-1111-1111-111111111111';
    const childId = 'run_22222222-2222-2222-2222-222222222222';
    let childStatus = 'needs_approval';
    const calls: string[] = [];
    let wakeObserved!: () => void;
    let nextAdvance = new Promise<void>(resolve => { wakeObserved = resolve; });
    const threadWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: { advanceRun: async (id: string) => {
        calls.push(id);
        if (id === childId) wakeObserved();
        return { status: id === parentId ? 'succeeded' : childStatus };
      } },
    });
    const driver = threadWorker.run();
    try {
      await notifyTemporalRunWorkflow(environment.client, queue, parentId);
      const parent = environment.client.workflow.getHandle(parentId);
      await parent.result();
      const parentExecution = await parent.describe();
      await notifyTemporalRunWorkflow(environment.client, queue, childId);
      const child = environment.client.workflow.getHandle(childId);
      await nextAdvance;
      await environment.sleep(60_000);
      expect(calls.filter(id => id === childId)).toHaveLength(1);
      childStatus = 'needs_input';
      nextAdvance = new Promise<void>(resolve => { wakeObserved = resolve; });
      await notifyTemporalRunWorkflow(environment.client, queue, childId); await nextAdvance;
      await environment.sleep(60_000);
      expect(calls.filter(id => id === childId)).toHaveLength(2);
      childStatus = 'succeeded';
      await notifyTemporalRunWorkflow(environment.client, queue, childId); await child.result();
      expect(calls.filter(id => id === parentId)).toHaveLength(1);
      expect((await parent.describe()).runId).toBe(parentExecution.runId);
      for (const handle of [parent, child]) {
        const history = await handle.fetchHistory();
        expect(history.events?.some(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
        await expect(Worker.runReplayHistory({ workflowBundle }, history, handle.workflowId)).resolves.toBeUndefined();
      }
    } finally { await threadWorker.shutdown(); await driver; }
  }, 120_000);

  it.each(['failed', 'cancelled', 'succeeded'])('completes terminal %s Runs without needing another wake', async status => {
    await expect(environment.client.workflow.execute('agentRunWorkflow', {
      workflowId: `temporal-terminal-${status}`, taskQueue, args: [`run-terminal-${status}`],
    })).resolves.toBeUndefined();
  });

  it('uses a durable timer and wake signal for Reminder advancement', async () => {
    let calls = 0;
    let firstCallResolve!: () => void;
    const firstCall = new Promise<void>(resolve => { firstCallResolve = resolve; });
    const queue = `${taskQueue}-reminder-timer`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceReminder: async () => {
          calls += 1;
          if (calls === 1) {
            firstCallResolve();
            return { status: 'scheduled', terminal: false, wakeAt: new Date(Date.now() + 86_400_000).toISOString() };
          }
          return { status: 'projected', terminal: true };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      const handle = await environment.client.workflow.start('reminderWorkflow', {
        workflowId: 'temporal-reminder-timer',
        taskQueue: queue,
        args: ['reminder-timer'],
      });
      await firstCall;
      expect(calls).toBe(1);
      await handle.signal('wake');
      await expect(handle.result()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('terminalizes a permanent activity error without requiring a wake', async () => {
    const queue = `${taskQueue}-permanent`;
    let calls = 0, closed = 0;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: {
        advanceRun: async () => { calls++; const { ApplicationFailure } = await import('@temporalio/activity'); throw ApplicationFailure.nonRetryable('provider configuration is missing', 'AeeisPermanentError'); },
        terminalizeRun: async () => { closed++; return { status: 'failed' }; },
      },
    });
    await localWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', { workflowId: 'temporal-permanent-terminal', taskQueue: queue, args: ['run-permanent'] });
      await expect(handle.result()).rejects.toThrow();
      expect((await handle.describe()).status.name).toBe('FAILED');
      expect(calls).toBe(1); expect(closed).toBe(1);
      await expect(Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory(), handle.workflowId)).resolves.toBeUndefined();
    });
  }, 120_000);

  it.each(['failed', 'succeeded'])('closes unknown outcomes automatically with terminal projection %s', async status => {
    const queue = `${taskQueue}-unknown-${status}`;
    let calls = 0;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: { advanceRun: async () => { calls++; return { status: 'unknown' }; }, terminalizeRun: async () => ({ status }) },
    });
    await localWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', { workflowId: `temporal-unknown-${status}`, taskQueue: queue, args: ['run-unknown'] });
      if (status === 'failed') await expect(handle.result()).rejects.toThrow();
      else await expect(handle.result()).resolves.toBeUndefined();
      expect(calls).toBe(1);
      expect((await handle.describe()).status.name).toBe(status === 'failed' ? 'FAILED' : 'COMPLETED');
      await expect(Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory(), handle.workflowId)).resolves.toBeUndefined();
    });
  }, 120_000);

  it('fails the workflow after bounded retries when the API cannot persist terminal state', async () => {
    const queue = `${taskQueue}-terminal-api-unavailable`;
    let closed = 0;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: { advanceRun: async () => ({ status: 'unknown' }), terminalizeRun: async () => { closed++; throw new Error('API unavailable'); } },
    });
    await localWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', { workflowId: 'temporal-terminal-api-unavailable', taskQueue: queue, args: ['run-unknown'] });
      await expect(handle.result()).rejects.toThrow();
      expect(closed).toBe(3);
      expect((await handle.describe()).status.name).toBe('FAILED');
    });
  }, 120_000);

  it.each(['needs_approval'])('does not poll %s until the API signals progress', async status => {
    let calls = 0;
    let firstCallResolve!: () => void;
    let secondCallResolve!: () => void;
    const firstCall = new Promise<void>(resolve => { firstCallResolve = resolve; });
    const secondCall = new Promise<void>(resolve => { secondCallResolve = resolve; });
    const queue = `${taskQueue}-business-wait-${status}`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceRun: async () => {
          calls += 1;
          if (calls === 1) { firstCallResolve(); return { status }; }
          secondCallResolve();
          return { status: 'succeeded' };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: `temporal-business-wait-${status}`, taskQueue: queue, args: ['run-business-wait'],
      });
      await firstCall;
      await environment.sleep(60_000);
      expect(calls).toBe(1);
      await handle.signal('wake');
      await secondCall;
      await expect(handle.result()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('retries transient activity failures according to the workflow policy', async () => {
    let calls = 0;
    const queue = `${taskQueue}-retry`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceRun: async () => {
          calls += 1;
          if (calls < 3) throw new Error('temporary transport failure');
          return { status: 'succeeded' };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      await expect(environment.client.workflow.execute('agentRunWorkflow', {
        workflowId: 'temporal-retry',
        taskQueue: queue,
        args: ['run-retry'],
      })).resolves.toBeUndefined();
      expect(calls).toBe(3);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('uses bounded durable backoff for unchanged active results and keeps a timer until completion', async () => {
    let calls = 0;
    let finish = false;
    const queue = `${taskQueue}-stalled`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: { advanceRun: async () => {
        calls++;
        return { status: finish ? 'succeeded' : 'planning', progress: 'unchanged' };
      } },
    });
    await localWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: 'temporal-stalled', taskQueue: queue, args: ['run-stalled'],
      });
      try {
        await environment.sleep(120_000);
        // First observation establishes progress, then eight unchanged attempts.
        expect(calls).toBe(9);
        const history = await handle.fetchHistory();
        const timers = history.events?.flatMap(event => {
          const timeout = event.timerStartedEventAttributes?.startToFireTimeout;
          return timeout ? [Number(timeout.seconds)] : [];
        });
        expect(timers).toEqual([1, 2, 4, 8, 16, 30, 30, 60]);
        expect((await handle.describe()).status.name).toBe('RUNNING');
        finish = true;
        await environment.sleep(60_000);
        await expect(handle.result()).resolves.toBeUndefined();
        expect(calls).toBe(10);
      } finally {
        if ((await handle.describe()).status.name === 'RUNNING') await handle.terminate('test cleanup');
      }
    });
  }, 120_000);

  it('terminalizes after exhausting activity transport retries without an external signal', async () => {
    let calls = 0;
    const queue = `${taskQueue}-retry-exhausted`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace, taskQueue: queue, workflowBundle,
      activities: { advanceRun: async () => {
        calls++;
        throw new Error('AEEIS activity transport failed: fetch failed');
      }, terminalizeRun: async () => ({ status: 'failed' }) },
    });
    await localWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', { workflowId: 'temporal-retry-exhausted', taskQueue: queue, args: ['run-retry-exhausted'] });
      await expect(handle.result()).rejects.toThrow();
      expect(calls).toBe(5);
      expect((await handle.describe()).status.name).toBe('FAILED');
      const history = await handle.fetchHistory();
      const timers = history.events?.filter(event => event.timerStartedEventAttributes);
      expect(timers?.some(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 30)).toBe(false);
      const closeActivity = history.events?.find(event => event.activityTaskScheduledEventAttributes?.activityType?.name === 'terminalizeRun')?.activityTaskScheduledEventAttributes;
      expect(Number(closeActivity?.startToCloseTimeout?.seconds)).toBe(30);
      expect(Number(closeActivity?.scheduleToCloseTimeout?.seconds)).toBe(120);
      expect(closeActivity?.retryPolicy?.maximumAttempts).toBe(3);
      const activity = history.events?.find(event => event.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes;
      expect(Number(activity?.heartbeatTimeout?.seconds)).toBe(45);
      expect(Number(activity?.startToCloseTimeout?.seconds)).toBe(65 * 60);
      expect(Number(activity?.scheduleToCloseTimeout?.seconds)).toBe(2 * 60 * 60);
      expect(activity?.retryPolicy?.maximumAttempts).toBe(5);
    });
  }, 120_000);

  it('retries transient Reminder activity failures without duplicating the workflow', async () => {
    let calls = 0;
    const queue = `${taskQueue}-reminder-retry`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceReminder: async () => {
          calls += 1;
          if (calls < 2) throw new Error('temporary projection transport failure');
          return { status: 'projected', terminal: true };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      await expect(environment.client.workflow.execute('reminderWorkflow', {
        workflowId: 'temporal-reminder-retry',
        taskQueue: queue,
        args: ['reminder-retry'],
      })).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('waits for an explicit wake after a permanent Reminder activity error', async () => {
    let calls = 0;
    let firstCallResolve!: () => void;
    const firstCall = new Promise<void>(resolve => { firstCallResolve = resolve; });
    const queue = `${taskQueue}-reminder-permanent`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceReminder: async () => {
          calls += 1;
          firstCallResolve();
          if (calls === 1) {
            const { ApplicationFailure } = await import('@temporalio/activity');
            throw ApplicationFailure.nonRetryable('reminder configuration is missing', 'AeeisPermanentError');
          }
          return { status: 'cancelled', terminal: true };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      const handle = await environment.client.workflow.start('reminderWorkflow', {
        workflowId: 'temporal-reminder-permanent-wake',
        taskQueue: queue,
        args: ['reminder-permanent-wake'],
      });
      await firstCall;
      expect(calls).toBe(1);
      await handle.signal('wake');
      await expect(handle.result()).resolves.toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('continues a Reminder workflow as new after a bounded timer window', async () => {
    let calls = 0;
    const queue = `${taskQueue}-reminder-continue`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceReminder: async () => {
          calls += 1;
          return calls > 100
            ? { status: 'projected', terminal: true }
            : { status: 'scheduled', terminal: false, wakeAt: new Date(Date.now()).toISOString() };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      await expect(environment.client.workflow.execute('reminderWorkflow', {
        workflowId: 'temporal-reminder-continue-as-new',
        taskQueue: queue,
        args: ['reminder-continue-as-new'],
      })).resolves.toBeUndefined();
      expect(calls).toBe(101);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('continues as new after the bounded tick window', async () => {
    let calls = 0;
    const queue = `${taskQueue}-continue`; 
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceRun: async () => {
          calls += 1;
          return { status: calls > 100 ? 'succeeded' : 'queued', progress: `tick-${calls}` };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      await expect(environment.client.workflow.execute('agentRunWorkflow', {
        workflowId: 'temporal-continue-as-new',
        taskQueue: queue,
        args: ['run-continue-as-new'],
      })).resolves.toBeUndefined();
      expect(calls).toBe(101);
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('replays pre-fix history that already waited indefinitely on failed', async () => {
    const queue = `${taskQueue}-failed-history`;
    let called!: () => void;
    const firstCall = new Promise<void>(resolve => { called = resolve; });
    const oldWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace,
      taskQueue: queue, workflowBundle: preTerminalBundle,
      activities: { advanceRun: async () => { called(); return { status: 'failed' }; } },
    });
    await oldWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: 'temporal-pre-fix-failed-history', taskQueue: queue, args: ['failed-run'],
      });
      try {
        await firstCall;
        await new Promise(resolve => setTimeout(resolve, 100));
        expect((await handle.describe()).status.name).toBe('RUNNING');
        await expect(Worker.runReplayHistory({ workflowBundle }, await handle.fetchHistory(), handle.workflowId)).resolves.toBeUndefined();
      } finally { await handle.terminate('test cleanup'); }
    });
  }, 120_000);

  it('replays an old active loop without introducing progress timers into its history', async () => {
    const queue = `${taskQueue}-active-history`;
    let calls = 0;
    let parked!: () => void;
    const waiting = new Promise<void>(resolve => { parked = resolve; });
    const oldWorker = await Worker.create({
      connection: environment.nativeConnection, namespace: environment.namespace,
      taskQueue: queue, workflowBundle: preTerminalBundle,
      activities: { advanceRun: async () => {
        calls++;
        if (calls === 4) { parked(); return { status: 'unknown' }; }
        return { status: 'planning' };
      } },
    });
    await oldWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: 'temporal-pre-backoff-history', taskQueue: queue, args: ['active-run'],
      });
      try {
        await waiting;
        await environment.sleep(60_000);
        const history = await handle.fetchHistory();
        expect(history.events?.some(event => event.timerStartedEventAttributes)).toBe(false);
        await expect(Worker.runReplayHistory({ workflowBundle }, history, handle.workflowId)).resolves.toBeUndefined();
      } finally { await handle.terminate('test cleanup'); }
    });
  }, 120_000);

  it('replays history produced by the previous workflow bundle', async () => {
    const queue = `${taskQueue}-previous-bundle`;
    const previousWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle: previousWorkflowBundle,
      activities: {
        advanceRun: async () => ({ status: 'succeeded' }),
      },
    });
    const previousRun = previousWorker.run();
    const workflowId = 'temporal-previous-bundle-history';
    try {
      await expect(environment.client.workflow.execute('agentRunWorkflow', {
        workflowId,
        taskQueue: queue,
        args: ['run-previous-bundle-history'],
      })).resolves.toBeUndefined();

      const history = await environment.client.workflow.getHandle(workflowId).fetchHistory();
      await expect(Worker.runReplayHistory({
        workflowBundle,
        replayName: 'aeeis-previous-bundle-replay',
      }, history, workflowId)).resolves.toBeUndefined();
    } finally {
      await previousWorker.shutdown();
      await previousRun;
    }
  }, 120_000);

  it('replays Reminder history produced by the previous workflow bundle', async () => {
    const queue = `${taskQueue}-previous-reminder-bundle`;
    const previousWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle: previousWorkflowBundle,
      activities: {
        advanceReminder: async () => ({ status: 'projected', terminal: true }),
      },
    });
    const previousRun = previousWorker.run();
    const workflowId = 'temporal-previous-reminder-bundle-history';
    try {
      await expect(environment.client.workflow.execute('reminderWorkflow', {
        workflowId,
        taskQueue: queue,
        args: ['reminder-previous-bundle-history'],
      })).resolves.toBeUndefined();

      const history = await environment.client.workflow.getHandle(workflowId).fetchHistory();
      await expect(Worker.runReplayHistory({
        workflowBundle,
        replayName: 'aeeis-previous-reminder-bundle-replay',
      }, history, workflowId)).resolves.toBeUndefined();
    } finally {
      await previousWorker.shutdown();
      await previousRun;
    }
  }, 120_000);
});
