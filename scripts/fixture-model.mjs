#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const host = process.env.AEEIS_FIXTURE_MODEL_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_FIXTURE_MODEL_PORT ?? 4399);

function nextProposalVersion(baseVersion) {
  const [target, suffix] = baseVersion.split('/', 2);
  if (suffix && /^\d+$/.test(suffix)) {
    const numeric = Number(suffix);
    if (Number.isSafeInteger(numeric)) return `${target}/${numeric + 1}`;
  }
  return `${baseVersion}-next`;
}

function responseFor(system, input) {
  if (system.includes('governed AEEIS RSI proposal synthesizer')) {
    const versions = input?.targetVersions ?? {};
    const evidence = Array.isArray(input?.evidence) ? input.evidence.filter((item) => typeof item?.id === 'string') : [];
    const baseVersion = typeof versions.prompt === 'string' ? versions.prompt : 'prompt/1';
    if (evidence.length === 0) return { proposal: null };
    return {
      proposal: {
        target: 'prompt',
        baseVersion,
        proposedVersion: nextProposalVersion(baseVersion),
        change: 'Require every synthesized result to cite the supplied evidence before completion.',
        reason: 'The fixture received a bounded failure signal with evidence that supports a reversible prompt improvement.',
        risk: 'low',
        sourceReceiptRefs: [evidence[0].id],
      },
    };
  }
  if (system.includes('independent AEEIS competition evaluator')) {
    const candidates = Array.isArray(input.candidates) ? input.candidates : [];
    return {
      scores: candidates.map((candidate, index) => ({
        agentId: candidate.agentId,
        score: Math.max(0, 1 - index * 0.1),
        accepted: true,
        reasons: ['Deterministic Compose evaluator fixture accepted the bounded candidate envelope.'],
        evidenceRefs: [],
      })),
    };
  }
  if (system.includes('Plan a real deliverable')) {
    return {
      summary: 'Local fixture plan: inspect the request, then deliver an evidence-linked result.',
      nodes: [
        { id: 'inspect', title: 'Inspect supplied material', instruction: 'Read the supplied material and extract the facts needed for the result.', dependsOn: [] },
        { id: 'deliver', title: 'Deliver evidence-linked result', instruction: 'Produce the requested result using the inspected facts and cite their evidence IDs.', dependsOn: ['inspect'] },
      ],
    };
  }
  if (system.includes('bounded participant in an AEEIS debate')) {
    return {
      type: 'position',
      content: `Compose debate position from ${input?.speakerAgentId ?? 'the participant'} for the bounded smoke task.`,
      claimRefs: [],
    };
  }
  if (system.includes('independent Moderator of an AEEIS debate')) {
    return { status: 'accepted', violations: [], missingClaimRefs: [] };
  }
  if (system.includes('independent Adjudicator of an AEEIS debate')) {
    return {
      status: 'held',
      decision: 'No evidence-bound decision is available in the fixture debate.',
      rationale: 'The fixture messages contain no claims and therefore cannot support a decision.',
      evidenceRefs: [],
    };
  }
  if (system.includes('Independently review')) {
    if (String(input?.goal ?? '').includes('RSI synthesis smoke')) {
      return { verdict: 'needs_revision', summary: 'The fixture intentionally emits a bounded low-confidence review to exercise RSI proposal synthesis.', issues: ['The controlled smoke run requires a reversible improvement proposal.'], confidence: 0.2 };
    }
    return { verdict: 'accepted', summary: 'Fixture review accepted the evidence-linked artifact.', issues: [] };
  }

  const source = input.sourceCatalog?.[0];
  const dependency = input.dependencies?.[0];
  const catalogTools = Array.isArray(input.capabilityCatalog?.tools) ? input.capabilityCatalog.tools : [];
  const webTool = input.task && !(input.observations?.length)
    ? catalogTools.find((tool) => tool?.id === (String(input.goal ?? '').match(/https?:\/\//) ? 'web-fetch' : 'web-search'))
    : undefined;
  if (webTool) {
    const argument = webTool.id === 'web-fetch'
      ? String(input.goal).match(/https?:\/\/[^\s]+/)?.[0] ?? 'https://example.com'
      : String(input.goal ?? 'web search');
    return { type: 'capability', toolId: webTool.id, toolVersion: String(webTool.version), input: { input: argument }, purpose: `Use the authorized ${webTool.id} tool for the requested evidence.` };
  }
  if (input.task && input.observations?.length && catalogTools.some((tool) => tool?.id === 'web-search' || tool?.id === 'web-fetch')) {
    const observation = input.observations.at(-1)?.result ?? {};
    const evidenceRefs = Array.isArray(observation.outputRefs) ? observation.outputRefs.filter(Boolean) : [];
    return { type: 'finish', title: 'Web tool result', content: 'Completed the requested web lookup using the authorized toolkit tool.', evidenceRefs };
  }
  const fixtureAgent = input.capabilityCatalog?.agents?.find((agent) => agent.agentId === 'agent.fixture');
  // Delegate only the inspection task. Subsequent tasks should consume the
  // completed delegation as a dependency instead of spending another call.
  if (fixtureAgent && input.task?.id === 'inspect' && !(input.observations?.length)) {
    return { type: 'delegate', agentId: 'agent.fixture', goal: 'Return a bounded evidence-linked research result', expectedOutput: 'research/1' };
  }
  if (fixtureAgent && input.task && input.observations?.length) {
    const observation = input.observations.at(-1)?.result ?? {};
    const evidenceRefs = [observation.receiptRef, ...(observation.result?.claims ?? []).flatMap((claim) => claim.evidenceRefs ?? [])].filter(Boolean);
    return { type: 'finish', title: 'External Agent result', content: 'Completed the result using the admitted external Agent.', evidenceRefs };
  }
  if (input.task?.id === 'inspect' && !(input.observations?.length)) {
    if (source?.id) return { type: 'tool', tool: 'sources.read', argument: source.id };
    return { type: 'question', question: '请提供可核验的资料或允许访问天气数据的工具。当前任务没有可用证据来源。' };
  }
  return {
    type: 'finish',
    title: input.task?.id === 'inspect' ? 'Inspected source facts' : 'Evidence-linked deliverable',
    content: input.task?.id === 'inspect'
      ? `Inspected the supplied source: ${source?.title ?? 'source material'}.`
      : 'Completed the requested result from the inspected task and supplied source material.',
    evidenceRefs: dependency?.id ? [dependency.id] : source?.id ? [source.id] : [],
    ...(system.includes('Project Pulse') && input.task?.id !== 'inspect' ? {
      artifactType: 'project-pulse/1',
      structured: (() => {
        const evidenceRef = dependency?.id ?? source?.id;
        const item = evidenceRef ? [{ text: 'The fixture observed a release snapshot and produced an evidence-linked next step.', evidenceRefs: [evidenceRef] }] : [];
        return {
          schemaVersion: 'project-pulse/1',
          progress: item,
          completedChanges: [],
          blockers: [],
          risks: [],
          decisions: [],
          owners: [],
          deadlines: [],
          nextActions: evidenceRef ? [{ text: 'Review the release verification report before production rollout.', evidenceRefs: [evidenceRef] }] : [],
          unknowns: [],
        };
      })(),
    } : {}),
  };
}

export function createFixtureModelServer() {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, mode: 'development-fixture' }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }

    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = String(messages.find((item) => item?.role === 'system')?.content ?? '');
      const rawInput = messages.find((item) => item?.role === 'user')?.content ?? '{}';
      const input = JSON.parse(String(rawInput));
      const value = responseFor(system, input);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `fixture-${Date.now()}`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture model received invalid JSON' } }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createFixtureModelServer();
  server.listen(port, host, () => {
    console.log(`AEEIS development fixture model listening at http://${host}:${server.address().port}/v1`);
  });

  function shutdown(signal) {
    server.close(() => { console.log(`Fixture model stopped (${signal})`); process.exit(0); });
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
