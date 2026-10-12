#!/usr/bin/env python3
"""Validate Temporal CLI JSON/JSONL; output exact AEEIS execution IDs."""
import json
import sys

raw = sys.stdin.read().strip()
if not raw:
    raise ValueError('empty workflow list output (expected JSON)')
try:
    items = json.loads(raw)
except json.JSONDecodeError:
    items = [json.loads(line) for line in raw.splitlines() if line.strip()]
if isinstance(items, dict):
    items = items['executions'] if 'executions' in items else [items]
if not isinstance(items, list):
    raise ValueError('workflow list must be an array or JSONL records')
for w in items:
    # CLI versions use either proto fields or flattened summary fields.
    kind = w.get('type') or w.get('workflowType')
    kind = kind.get('name') if isinstance(kind, dict) else kind
    execution = w.get('execution', w)
    workflow_id = execution.get('workflowId')
    run_id = execution.get('runId')
    if not isinstance(kind, str) or not isinstance(workflow_id, str) or not isinstance(run_id, str):
        raise ValueError('workflow list record lacks type/workflowId/runId')
    if kind in ('agentRunWorkflow', 'reminderWorkflow'):
        if any(c.isspace() for c in workflow_id + run_id) or not workflow_id or not run_id:
            raise ValueError('invalid workflow execution IDs')
        print(workflow_id + '\t' + run_id)
