import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/temporal/workflows.ts', import.meta.url)) });
const workflowId = 'run_11111111-1111-1111-1111-111111111111';
const fixture = new URL('./fixtures/temporal-legacy-terminal-history.json', import.meta.url);
// Use the proto owner's protobufjs instance, as the release replay script does.
const require = createRequire(import.meta.url);
const proto = require('@temporalio/proto');
const patch = require('@temporalio/proto/lib/patch-protobuf-root.js').patchProtobufRoot;
const historyType = patch(proto).lookupType('temporal.api.history.v1.History');
const protoJson = require(require.resolve('protobufjs/ext/protojson.js', { paths: [dirname(require.resolve('@temporalio/proto'))] }));

// Hand-authored command history for the pre-patch, single-argument workflow.
// The real replay worker needs neither a Temporal server nor provider calls.
describe('offline Temporal command history replay', () => {
  it.each(['succeeded', 'failed', 'needs_input'])('replays legacy %s history with unchanged per-run arguments', async status => {
    const history = JSON.parse(await readFile(fixture, 'utf8'));
    if (status !== 'succeeded') history.events.pop(); // Legacy business wait remains open.
    history.events[6].activityTaskCompletedEventAttributes.result.payloads[0].data = Buffer.from(JSON.stringify({ status })).toString('base64');
    await expect(Worker.runReplayHistory({ workflowBundle }, protoJson.fromJson(historyType, history, { ignoreUnknownFields: true }), workflowId)).resolves.toBeUndefined();
  }, 30_000);
  it('rejects a timer history incompatible with the activity command', async () => {
    const history = JSON.parse(await readFile(fixture, 'utf8'));
    history.events[4] = { eventId: '5', eventType: 'EVENT_TYPE_TIMER_STARTED', timerStartedEventAttributes: { timerId: '1', startToFireTimeout: '10s', workflowTaskCompletedEventId: '4' } };
    history.events.splice(5, 1);
    history.events[5] = { eventId: '6', eventType: 'EVENT_TYPE_TIMER_FIRED', timerFiredEventAttributes: { timerId: '1', startedEventId: '5' } };
    history.events[6].eventId = '7';
    history.events[7].eventId = '8'; history.events[7].workflowTaskStartedEventAttributes.scheduledEventId = '7';
    history.events[8].eventId = '9'; history.events[8].workflowTaskCompletedEventAttributes.scheduledEventId = '7'; history.events[8].workflowTaskCompletedEventAttributes.startedEventId = '8';
    history.events[9].eventId = '10'; history.events[9].workflowExecutionCompletedEventAttributes.workflowTaskCompletedEventId = '9';
    await expect(Worker.runReplayHistory({ workflowBundle }, protoJson.fromJson(historyType, history, { ignoreUnknownFields: true }), workflowId)).rejects.toThrow();
  }, 30_000);
});
