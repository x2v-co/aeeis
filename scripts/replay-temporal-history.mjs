import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';

// @temporalio/common@1.24 and @temporalio/proto can be installed with
// separate protobufjs copies. Its historyFromJSON helper then rejects the
// generated Type as belonging to a different protobufjs instance. Parse with
// the protobufjs copy that owns @temporalio/proto and pass the resulting
// message object to Worker, which avoids that cross-package instanceof check.
const require = createRequire(import.meta.url);
const proto = require('@temporalio/proto');
const patchProtobufRoot = require('@temporalio/proto/lib/patch-protobuf-root.js').patchProtobufRoot;
const protoPackagePath = dirname(require.resolve('@temporalio/proto'));
const protoJson = require(require.resolve('protobufjs/ext/protojson.js', { paths: [protoPackagePath] }));
const historyType = patchProtobufRoot(proto).lookupType('temporal.api.history.v1.History');

const historyFile = process.env.AEEIS_TEMPORAL_HISTORY_FILE ?? process.argv[2];
const workflowId = process.env.AEEIS_TEMPORAL_WORKFLOW_ID ?? process.argv[3];
const workflowPath = process.env.AEEIS_TEMPORAL_WORKFLOW_PATH
  ?? fileURLToPath(new URL('../dist/temporal/workflows.js', import.meta.url));

if (!historyFile || !workflowId) {
  throw new Error('Usage: AEEIS_TEMPORAL_HISTORY_FILE=history.json AEEIS_TEMPORAL_WORKFLOW_ID=<workflow-id> npm run temporal:replay');
}

const raw = JSON.parse(await readFile(historyFile, 'utf8'));
const history = raw && typeof raw === 'object' && raw.history && typeof raw.history === 'object'
  ? raw.history
  : raw;
if (!history || !Array.isArray(history.events) || history.events.length === 0) {
  throw new Error(`Temporal history file ${historyFile} must contain a non-empty events array`);
}
const started = history.events.find(event => event.workflowExecutionStartedEventAttributes);
const historyWorkflowType = started?.workflowExecutionStartedEventAttributes?.workflowType?.name;
if (historyWorkflowType && historyWorkflowType !== 'agentRunWorkflow') {
  throw new Error(`Temporal history workflow type ${historyWorkflowType} is not agentRunWorkflow`);
}
const parsedHistory = protoJson.fromJson(historyType, history, { ignoreUnknownFields: true });

try {
  await Worker.runReplayHistory({
    workflowsPath: workflowPath,
    replayName: `aeeis-history-replay-${workflowId}`,
  }, parsedHistory, workflowId);
} catch (error) {
  const detail = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'UnknownError', message: String(error) };
  console.error(JSON.stringify({
    protocol: 'aeeis-temporal-replay/1',
    status: 'failed',
    workflowId,
    historyFile,
    eventCount: history.events.length,
    error: detail,
  }));
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  console.log(JSON.stringify({
    protocol: 'aeeis-temporal-replay/1',
    status: 'passed',
    workflowId,
    historyFile,
    eventCount: history.events.length,
    workflowPath,
  }));
}
