import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';

const workflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('../src/temporal/workflows.ts', import.meta.url)),
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
});
