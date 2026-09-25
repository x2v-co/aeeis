import type { BuildIdOperation, TaskQueueClient, WorkerBuildIdVersionSets } from '@temporalio/client';

export type TemporalBuildIdRollout = 'none' | 'bootstrap' | 'new-default' | 'compatible' | 'promote';

export interface TemporalVersioningConfig {
  buildId: string;
  deploymentName: string;
  useVersioning: boolean;
  rollout: TemporalBuildIdRollout;
  compatibleWith?: string;
}

export interface BuildIdCompatibilityClient {
  getBuildIdCompatability(taskQueue: string): Promise<WorkerBuildIdVersionSets | undefined>;
  updateBuildIdCompatibility(taskQueue: string, operation: BuildIdOperation): Promise<void>;
}

const buildIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function assertTemporalBuildId(buildId: string): string {
  const value = buildId.trim();
  if (!buildIdPattern.test(value)) {
    throw new Error('AEEIS_BUILD_ID must be 1-128 characters using letters, digits, ., _, :, / or -');
  }
  return value;
}

export function parseTemporalVersioningConfig(env: NodeJS.ProcessEnv = process.env, defaultBuildId?: string): TemporalVersioningConfig {
  const buildId = assertTemporalBuildId(env.AEEIS_BUILD_ID?.trim() || defaultBuildId || '');
  const useVersioning = env.AEEIS_TEMPORAL_USE_VERSIONING === '1';
  const rollout = (env.AEEIS_TEMPORAL_BUILD_ID_ROLLOUT ?? 'none') as TemporalBuildIdRollout;
  if (!['none', 'bootstrap', 'new-default', 'compatible', 'promote'].includes(rollout)) {
    throw new Error(`Unsupported AEEIS_TEMPORAL_BUILD_ID_ROLLOUT: ${rollout}`);
  }
  if (!useVersioning && rollout !== 'none') {
    throw new Error('AEEIS_TEMPORAL_BUILD_ID_ROLLOUT requires AEEIS_TEMPORAL_USE_VERSIONING=1');
  }
  const compatibleWith = env.AEEIS_TEMPORAL_COMPATIBLE_WITH?.trim();
  if (rollout === 'compatible' && !compatibleWith) {
    throw new Error('Compatible Temporal rollout requires AEEIS_TEMPORAL_COMPATIBLE_WITH');
  }
  if (compatibleWith) assertTemporalBuildId(compatibleWith);
  const deploymentName = env.AEEIS_TEMPORAL_DEPLOYMENT_NAME?.trim() || env.AEEIS_TASK_QUEUE?.trim() || 'aeeis-worker';
  if (!buildIdPattern.test(deploymentName)) throw new Error('AEEIS_TEMPORAL_DEPLOYMENT_NAME must be 1-128 characters using letters, digits, ., _, :, / or -');
  return { buildId, deploymentName, useVersioning, rollout, ...(compatibleWith ? { compatibleWith } : {}) };
}

function containsBuildId(sets: WorkerBuildIdVersionSets | undefined, buildId: string): boolean {
  return Boolean(sets?.versionSets.some(set => set.buildIds.includes(buildId)));
}

/** Register an explicit compatibility transition before a versioned Worker polls. */
export async function configureTemporalBuildId(
  client: BuildIdCompatibilityClient | TaskQueueClient,
  taskQueue: string,
  config: TemporalVersioningConfig,
): Promise<{ registered: boolean; rollout: TemporalBuildIdRollout }> {
  if (!config.useVersioning) return { registered: true, rollout: 'none' };
  let sets: WorkerBuildIdVersionSets | undefined;
  try {
    sets = await client.getBuildIdCompatability(taskQueue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/versioning is disabled on this namespace/i.test(message)) {
      throw new Error('Temporal namespace has Worker Versioning disabled; enable the namespace feature or use the supported Worker Deployment API before starting a versioned AEEIS Worker', { cause: error });
    }
    throw error;
  }
  if (!containsBuildId(sets, config.buildId)) {
    if (config.rollout === 'none') {
      throw new Error(`Temporal Build ID ${config.buildId} is not registered for task queue ${taskQueue}; choose an explicit rollout operation`);
    }
    const operation: BuildIdOperation = config.rollout === 'compatible'
      ? { operation: 'addNewCompatibleVersion', buildId: config.buildId, existingCompatibleBuildId: config.compatibleWith! }
      : { operation: 'addNewIdInNewDefaultSet', buildId: config.buildId };
    await client.updateBuildIdCompatibility(taskQueue, operation);
    sets = await client.getBuildIdCompatability(taskQueue);
  }
  if (!containsBuildId(sets, config.buildId)) {
    throw new Error(`Temporal did not register Build ID ${config.buildId} for task queue ${taskQueue}`);
  }
  if (config.rollout === 'promote') {
    await client.updateBuildIdCompatibility(taskQueue, { operation: 'promoteSetByBuildId', buildId: config.buildId });
  }
  return { registered: true, rollout: config.rollout };
}
