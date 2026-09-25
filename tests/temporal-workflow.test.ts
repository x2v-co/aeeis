import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';

const workflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('../src/temporal/workflows.ts', import.meta.url)),
});
// Keep a tiny previous bundle in the test suite so a new Worker is proven
// against a history produced by an older workflow implementation. This is
// the same contract that a production Build ID rollout must satisfy.
const previousWorkflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./fixtures/temporal-v1-workflows.ts', import.meta.url)),
});

describe('AEEIS Temporal workflow', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  const taskQueue = `aeeis-workflow-test-${process.pid}`;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowBundle,
      activities: {
        advanceRun: async () => ({ status: 'succeeded' }),
        advanceReminder: async () => ({ status: 'projected', terminal: true }),
      },
    });
    workerRun = worker.run();
  }, 120_000);

  afterAll(async () => {
    await worker.shutdown();
    await workerRun;
    await environment.teardown();
  }, 120_000);

  it('finishes when the activity reports a terminal status', async () => {
    await expect(environment.client.workflow.execute('agentRunWorkflow', {
      workflowId: 'temporal-terminal',
      taskQueue,
      args: ['run-terminal'],
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

  it('waits for wake after a permanent activity error and resumes', async () => {
    let calls = 0;
    let firstCallResolve!: () => void;
    const firstCall = new Promise<void>(resolve => { firstCallResolve = resolve; });
    // This test uses a dedicated workflow task queue so the activity behavior
    // can be selected without changing the production workflow contract.
    const queue = `${taskQueue}-permanent`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceRun: async () => {
          calls += 1;
          firstCallResolve();
          if (calls === 1) {
            const { ApplicationFailure } = await import('@temporalio/activity');
            throw ApplicationFailure.nonRetryable('provider configuration is missing', 'AeeisPermanentError');
          }
          return { status: 'succeeded' };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: 'temporal-permanent-wake',
        taskQueue: queue,
        args: ['run-permanent-wake'],
      });
      await firstCall;
      expect(calls).toBe(1);
      await handle.signal('wake');
      await expect(handle.result()).resolves.toBeUndefined();
    } finally {
      await localWorker.shutdown();
      await localRun;
    }
  }, 120_000);

  it('does not poll a business wait state until the API signals progress', async () => {
    let calls = 0;
    let firstCallResolve!: () => void;
    let secondCallResolve!: () => void;
    const firstCall = new Promise<void>(resolve => { firstCallResolve = resolve; });
    const secondCall = new Promise<void>(resolve => { secondCallResolve = resolve; });
    const queue = `${taskQueue}-business-wait`;
    const localWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: queue,
      workflowBundle,
      activities: {
        advanceRun: async () => {
          calls += 1;
          if (calls === 1) { firstCallResolve(); return { status: 'needs_approval' }; }
          secondCallResolve();
          return { status: 'succeeded' };
        },
      },
    });
    const localRun = localWorker.run();
    try {
      const handle = await environment.client.workflow.start('agentRunWorkflow', {
        workflowId: 'temporal-business-wait', taskQueue: queue, args: ['run-business-wait'],
      });
      await firstCall;
      await new Promise(resolve => setTimeout(resolve, 50));
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
          return { status: calls > 100 ? 'succeeded' : 'queued' };
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
