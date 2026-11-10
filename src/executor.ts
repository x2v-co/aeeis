import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentTransport, AgentTransportResponse, DelegationContext, DelegationReceipt, DelegationRequest } from './agent-gateway.js';
import type { ExecutorPoll, MachineView, RelayUsage } from './docker-sandbox.js';
import type { AgentCard, ResultEnvelope } from './protocol.js';
import type { AcceptanceCheck, AcceptanceItem } from './runtime/contracts.js';

export const EXECUTOR_ENDPOINT = 'aeeis-executor://claude-code';
export const executorConfigSchema = z.object({
  agentId: z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).default('executor.claude-code'),
  /** Where the relay sends model calls. Only the relay ever sees this and the key. */
  upstream: z.string().url().default('https://api.anthropic.com'),
  /** The environment variable on the AEEIS host that holds the real API key. Never copied into the Run container. */
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/).default('AEEIS_EXECUTOR_API_KEY'),
  model: z.string().min(1).max(200).optional(),
  tools: z.array(z.enum(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'])).min(1).default(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']),
  maxMinutes: z.number().int().min(1).max(480).default(60),
  /** Share of what the Run has left that one independent check may spend. */
  verifyShare: z.number().min(0.05).max(0.5).default(0.3),
  /** How long an accepted Run's machine stays up, so its preview link still opens. */
  keepHours: z.number().min(0).max(72).default(4),
  /** The port a delivered preview is shared from. */
  previewPort: z.number().int().min(1024).max(65535).default(3000),
}).strict();
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;

/** The part of the sandbox an executor session uses. */
export interface ExecutorSandbox {
  startExecutor(runId: string, session: { id: string; token: string; prompt: string; argv: string[]; env: Record<string, string>; key: string; upstream: string; budget: number; seconds: number }, workspace?: string): Promise<void>;
  executorRecord(runId: string): Promise<{ session: string; token: string; pid: number } | undefined>;
  pollExecutor(runId: string, session: string, offset: number): Promise<ExecutorPoll>;
  relayUsage(runId: string, token: string): Promise<RelayUsage | undefined>;
  closeRelay(runId: string, token: string): Promise<RelayUsage | undefined>;
  stopExecutor(runId: string, pid: number): Promise<void>;
  observe(runId: string, live: boolean): Promise<MachineView>;
  exportArtifacts(runId: string): Promise<void>;
  screenshots(runId: string): Promise<{ name: string }[]>;
  runShell(runId: string, command: string): Promise<{ ok: boolean; output: unknown }>;
  preview(runId: string, port: number): Promise<string | undefined>;
  keepMachine(runId: string, hours: number): Promise<void>;
}

/** Stops short of the grant so that the call in flight when the limit is reached cannot overrun it. */
const BUDGET_HEADROOM = 0.9;
const POLL_MS = 3000;
const UNREACHABLE_LIMIT_MS = 15 * 60_000;
const NOT_VERIFIED = 'The executor reports this as done. AEEIS has not verified it.';

function sessionEnv(token: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: 'http://aeeis-proxy:3129', ANTHROPIC_API_KEY: token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', NO_PROXY: 'localhost,127.0.0.1,aeeis-proxy', no_proxy: 'localhost,127.0.0.1,aeeis-proxy' };
}

function sessionId(idempotencyKey: string): string {
  const hash = createHash('sha256').update(idempotencyKey).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function executorPrompt(request: DelegationRequest): string {
  const brief = request.taskBrief;
  const list = (title: string, items: string[]) => items.length ? [`${title}:`, ...items.map(item => `- ${item}`), ''] : [];
  return [
    `Goal: ${brief.goal}`, '',
    ...list('Out of scope', brief.nonGoals),
    ...list('Constraints', brief.constraints),
    ...list('Known facts', brief.knownFacts.map(fact => fact.claim)),
    ...list('Context', request.contextPack.claims.map(claim => claim.text)),
    'Work in the current directory. This is a sandbox: outbound network is limited to an allowlist, and other hosts are refused. Run the tests before you finish. End with a short summary of what changed and what you could not do.',
  ].join('\n');
}

export function executorArgv(config: ExecutorConfig, session: string): string[] {
  const tools = config.tools.join(',');
  return ['claude', '--print', '--output-format', 'stream-json', '--verbose', '--session-id', session, '--tools', tools, '--allowedTools', tools,
    '--setting-sources', 'user', '--strict-mcp-config', ...(config.model ? ['--model', config.model] : [])];
}

interface SessionEnd { kind: 'finished' | 'budget' | 'timeout' | 'stopped' | 'lost'; result?: { isError: boolean; text: string; costUsd?: number }; errors?: string; exitCode?: number | null }

/** Runs Claude Code in a Run's container as an ordinary AEEIS Agent. It gets a task and a session token, and nothing
 * else: the grant, the real key and the budget stay here and in the relay, where it cannot reach them. */
export class ClaudeCodeTransport implements AgentTransport {
  constructor(private readonly sandbox: ExecutorSandbox, private readonly config: ExecutorConfig, private readonly evidenceRoot: string,
    private readonly apiKey: () => string | undefined = () => process.env[config.apiKeyEnv], private readonly pollMs = POLL_MS) {}
  private budget(request: DelegationRequest, context: DelegationContext): number {
    const limits = [request.grant.budget.tokens, request.taskBrief.budget.tokens, context.tokens].filter(item => item !== undefined);
    const tokens = limits.length ? Math.min(...limits) : 0;
    if (!tokens) throw new Error('The executor needs a token budget: start the Run with one, or under a Work Grant that has one');
    return Math.floor(tokens * BUDGET_HEADROOM);
  }
  async submit(card: AgentCard, request: DelegationRequest, context?: DelegationContext): Promise<AgentTransportResponse> {
    if (!context) throw new Error('The executor runs only inside a Run');
    const key = this.apiKey();
    if (!key) throw new Error(`Set ${this.config.apiKeyEnv} on the AEEIS host to use the executor`);
    const session = sessionId(request.idempotencyKey);
    const token = `aeeis-session-${randomBytes(32).toString('hex')}`;
    await this.sandbox.startExecutor(context.runId, {
      id: session, token, prompt: executorPrompt(request), argv: executorArgv(this.config, session), key, upstream: this.config.upstream, budget: this.budget(request, context), seconds: this.config.maxMinutes * 60,
      env: sessionEnv(token),
    }, context.workspace);
    return this.follow(card, request, context, session, token);
  }
  /** After a restart: read how the session went. It is never started again. */
  async reconcile(card: AgentCard, request: DelegationRequest, _receipt: DelegationReceipt, context?: DelegationContext): Promise<AgentTransportResponse> {
    if (!context) throw new Error('The executor runs only inside a Run');
    const record = await this.sandbox.executorRecord(context.runId);
    if (!record || record.session !== sessionId(request.idempotencyKey)) return { status: 'unknown', receiptRef: receiptRef(request) };
    return this.follow(card, request, context, record.session, record.token);
  }
  /** An independent check of finished work. A new session with no edit tools, which never sees the executor's report.
   * What it says is then held against what AEEIS can see for itself: its screenshots must exist and the project must not have changed. */
  async verify(input: VerifyInput): Promise<AcceptanceCheck> {
    const at = new Date().toISOString(), config = { ...this.config, tools: [...verifierTools] };
    const failed = (error: string): AcceptanceCheck => ({ round: input.round, at, passed: false, projectChanged: false, error, items: input.requirements.map(requirement => ({ requirement, status: 'unverified', notes: error })) });
    const key = this.apiKey();
    if (!key) return failed(`Set ${this.config.apiKeyEnv} on the AEEIS host to verify work`);
    const budget = Math.floor(input.tokens * this.config.verifyShare);
    if (budget < 2000) return failed('Not enough of the Run budget is left for an independent check');
    const before = await this.sandbox.observe(input.runId, true).catch(() => undefined);
    const session = verifySession(input);
    const token = `aeeis-session-${randomBytes(32).toString('hex')}`;
    try {
      await this.sandbox.startExecutor(input.runId, { id: session, token, prompt: verifierPrompt(input.goal, input.requirements, this.config.previewPort), argv: executorArgv(config, session), key, upstream: this.config.upstream, budget, seconds: this.config.maxMinutes * 60, env: sessionEnv(token) }, input.workspace);
    } catch (error) { return failed(error instanceof Error ? error.message : 'Could not start the check'); }
    const directory = join(this.evidenceRoot, input.runId, 'executor');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const end = await this.watch(budget, input.runId, session, token, join(directory, `${session}.jsonl`));
    const usage = await this.sandbox.closeRelay(input.runId, token);
    const cost = { ...(usage ? { tokens: usage.tokens } : {}), ...(end.result?.costUsd !== undefined ? { money: end.result.costUsd, currency: 'USD' } : {}) };
    if (!end.result) return { ...failed(`The check did not finish (${end.kind}). ${end.errors ?? ''}`.trim()), cost };
    await this.sandbox.exportArtifacts(input.runId).catch(() => undefined);
    const shots = new Set((await this.sandbox.screenshots(input.runId).catch(() => [])).map(item => item.name));
    const after = await this.sandbox.observe(input.runId, true).catch(() => undefined);
    const projectChanged = Boolean(before?.live && after?.live) && JSON.stringify(before!.live!.repository) !== JSON.stringify(after!.live!.repository);
    const items = readVerdict(end.result.text, input.requirements, shots);
    const passed = !projectChanged && items.every(item => item.status === 'passed');
    const check: AcceptanceCheck = { round: input.round, at, passed, items, projectChanged, cost, ...(projectChanged ? { error: 'The checker changed the project, so its verdict does not count.' } : {}) };
    if (passed && input.deliver) Object.assign(check, await this.deliver(input));
    return check;
  }
  /** A check whose process died while it ran. Its session may still be going: follow it to its end, only to learn what it
   * cost. Its verdict is not used, since nothing saw the project before it started. Undefined when no such session exists. */
  async resume(input: VerifyInput): Promise<AcceptanceCheck | undefined> {
    const session = verifySession(input);
    const record = await this.sandbox.executorRecord(input.runId).catch(() => undefined);
    if (!record || record.session !== session) return undefined;
    const directory = join(this.evidenceRoot, input.runId, 'executor');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const budget = (await this.sandbox.relayUsage(input.runId, record.token))?.budget ?? Math.floor(input.tokens * this.config.verifyShare);
    const end = await this.watch(budget, input.runId, session, record.token, join(directory, `${session}.jsonl`));
    const usage = await this.sandbox.closeRelay(input.runId, record.token);
    const error = `The check was interrupted (${end.kind}), so its verdict does not count`;
    return { round: input.round, at: new Date().toISOString(), passed: false, projectChanged: false, error,
      items: input.requirements.map(requirement => ({ requirement, status: 'unverified', notes: error })),
      cost: { ...(usage ? { tokens: usage.tokens } : {}), ...(end.result?.costUsd !== undefined ? { money: end.result.costUsd, currency: 'USD' } : {}) } };
  }
  /** Packs the source and shares the running site. Both are best effort: the check has already passed. */
  private async deliver(input: VerifyInput): Promise<Pick<AcceptanceCheck, 'previewUrl' | 'sourceArchive'>> {
    // Projects often live under artifacts/, so only what is not source is left out. Say nothing rather than deliver an empty archive.
    const packed = await this.sandbox.runShell(input.runId, "mkdir -p artifacts && tar czf /tmp/source.tar.gz --exclude='node_modules' --exclude='./artifacts/screenshots' --exclude='./artifacts/source.tar.gz' --exclude='./.previous-artifacts' --exclude='./.git' . && test $(tar tzf /tmp/source.tar.gz | grep -vc '/$') -gt 0 && mv /tmp/source.tar.gz artifacts/source.tar.gz").catch(() => ({ ok: false, output: undefined }));
    await this.sandbox.exportArtifacts(input.runId).catch(() => undefined);
    const url = await this.sandbox.preview(input.runId, this.config.previewPort).catch(() => undefined);
    if (url) await this.sandbox.keepMachine(input.runId, this.config.keepHours).catch(() => undefined);
    return { ...(packed.ok ? { sourceArchive: 'source.tar.gz' } : {}), ...(url ? { previewUrl: url } : {}) };
  }
  private async follow(card: AgentCard, request: DelegationRequest, context: DelegationContext, session: string, token: string): Promise<AgentTransportResponse> {
    const directory = join(this.evidenceRoot, context.runId, 'executor');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const log = join(directory, `${session}.jsonl`);
    const end = await this.watch((await this.sandbox.relayUsage(context.runId, token))?.budget ?? this.budget(request, context), context.runId, session, token, log, request);
    const usage = await this.sandbox.closeRelay(context.runId, token);
    const look = await this.sandbox.observe(context.runId, true).catch(() => undefined);
    await writeFile(join(directory, `${session}.evidence.json`), JSON.stringify({ end: end.kind, usage, repository: look?.live?.repository ?? null, files: look?.live?.files ?? [] }, null, 2), { mode: 0o600 });
    if (end.kind === 'stopped' || end.kind === 'lost') return { status: 'unknown', receiptRef: receiptRef(request) };
    return this.outcome(card, request, end, usage, look);
  }
  private async watch(budget: number, runId: string, session: string, token: string, log: string, request?: DelegationRequest): Promise<SessionEnd> {
    let offset = 0, sequence = 0, working = 0, last = Date.now(), unreachableSince = 0, result: SessionEnd['result'];
    for (;;) {
      // A look that fails is a bad moment, not the end of the session.
      const poll = await this.sandbox.pollExecutor(runId, session, offset).catch(() => ({ state: 'unreachable' as const, output: '', offset, more: false, exitCode: null, errors: '' }));
      const now = Date.now();
      // A paused Run is not using up its time.
      if (poll.state === 'running') working += now - last;
      last = now;
      if (poll.state === 'stopped' || poll.state === 'missing') return { kind: 'stopped' };
      const before = offset;
      unreachableSince = poll.state === 'unreachable' ? unreachableSince || now : 0;
      if (unreachableSince && now - unreachableSince > UNREACHABLE_LIMIT_MS) return { kind: 'lost' };
      if (poll.output) {
        await appendFile(log, poll.output, { mode: 0o600 });
        offset = poll.offset;
        for (const line of poll.output.split('\n').filter(Boolean)) {
          const event = parse(line);
          if (event?.type === 'result') result = { isError: Boolean(event.is_error), text: String(event.result ?? ''), ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}) };
          for (const name of toolNames(event)) {
            sequence += 1;
            if (request) await request.onProgress?.({ schemaVersion: 'agent-progress/1', taskId: request.taskBrief.taskId, agentId: request.agentId, contextVersion: request.contextPack.id, sequence, status: 'running', message: `Using ${name}`, evidenceRefs: [], artifactRefs: [], at: new Date().toISOString() });
          }
        }
      }
      // Only read straight on while it is actually moving forward.
      if (poll.more && poll.offset > before) continue;
      if (poll.exitCode !== null) return { kind: 'finished', ...(result ? { result } : {}), errors: poll.errors, exitCode: poll.exitCode };
      if (poll.state === 'running') {
        const usage = await this.sandbox.relayUsage(runId, token);
        const record = await this.sandbox.executorRecord(runId);
        if ((usage && usage.tokens >= budget) || working > this.config.maxMinutes * 60_000) {
          if (record) await this.sandbox.stopExecutor(runId, record.pid);
          return { kind: usage && usage.tokens >= budget ? 'budget' : 'timeout' };
        }
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }
  private outcome(card: AgentCard, request: DelegationRequest, end: SessionEnd, usage: RelayUsage | undefined, look: MachineView | undefined): AgentTransportResponse {
    const finished = end.kind === 'finished' && end.result && !end.result.isError && end.exitCode === 0;
    const status: ResultEnvelope['status'] = finished ? 'completed' : end.kind === 'finished' && !end.result ? 'failed' : 'partial';
    const reason = { budget: 'Stopped: the token budget ran out.', timeout: `Stopped: the ${this.config.maxMinutes}-minute limit was reached.`, finished: end.result?.isError ? 'The executor ended with an error.' : !end.result ? `The executor exited with code ${end.exitCode} and no result. ${end.errors ?? ''}`.trim() : '' , stopped: '', lost: '' }[end.kind];
    // Outside a git repository, recent files are the best AEEIS can see for itself.
    const changes = look?.live?.repository ? look.live.repository.status.trim() || 'none' : look?.live?.files.slice(0, 20).map(file => file.path).join('\n') || 'none';
    const seen = `${look?.live?.repository ? 'Changes' : 'Recent files'} seen by AEEIS:\n${changes}`;
    const summary = [reason, end.result?.text, seen].filter(Boolean).join('\n\n').slice(0, 4000);
    return {
      status, receiptRef: receiptRef(request),
      acknowledgement: { schemaVersion: 'context-ack/1', taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true },
      result: {
        schemaVersion: 'result-envelope/1', taskId: request.taskBrief.taskId, agentId: card.agentId, status, resultType: request.taskBrief.expectedOutput, summary, claims: [], artifacts: [],
        unresolved: [NOT_VERIFIED], requestedFollowups: [],
        cost: { ...(usage ? { tokens: usage.tokens } : {}), ...(end.result?.costUsd !== undefined ? { money: end.result.costUsd, currency: 'USD' } : {}) },
        capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef: receiptRef(request),
      },
    };
  }
}

const verifierTools = ['Bash', 'Read', 'Glob', 'Grep'] as const;
const verdictSchema = z.object({ items: z.array(z.object({
  index: z.number().int().min(1), status: z.enum(['passed', 'failed', 'unverified']), notes: z.string().max(1000).default(''), screenshot: z.string().max(300).optional(),
}).strip()).max(30) }).strip();

export function verifierPrompt(goal: string, requirements: string[], port: number): string {
  return [
    'You are checking finished work. You did not build it, and you have not seen any report from whoever did. Decide from what you can observe, and do not change the project: do not edit, create or delete its files.',
    '', `The request was: ${goal}`, '', 'Requirements to check:', ...requirements.map((item, index) => `${index + 1}. ${item}`), '',
    `Find how the project runs. If it is not already serving on 0.0.0.0:${port}, start it there in the background so that it stays up after you finish, with: nohup <command> >/tmp/server.log 2>&1 &`,
    'To look at a page, run this in the shell. It opens the page in Chromium, can click and type, and saves a screenshot under artifacts/screenshots/:',
    `python3 /opt/aeeis/browse.py '{"url": "http://127.0.0.1:${port}/", "steps": [{"action": "click", "selector": "button"}, {"action": "type", "selector": "input", "text": "x"}, {"action": "press", "key": "Enter"}, {"action": "wait", "ms": 300}], "width": 1280, "height": 800}'`,
    'It prints the title, HTTP status, visible text, console errors, failed requests, the screenshot path, and layout: compare pageWidth with viewportWidth to check for sideways scrolling. Actually perform each check, including failure cases. A requirement passes only if you saw it pass. If you could not check one, mark it unverified.',
    '', 'End with only this JSON, in a ```json block:', '{"items": [{"index": 1, "status": "passed|failed|unverified", "notes": "what you did and saw", "screenshot": "artifacts/screenshots/<file>.png"}]}',
  ].join('\n');
}

/** `attempt` names this try at the round: a second try (after a pause, or a restart) gets its own session, since the sandbox never starts one twice. */
export interface VerifyInput { runId: string; goal: string; requirements: string[]; tokens: number; workspace?: string; round: number; attempt?: string; deliver: boolean }
function verifySession(input: Pick<VerifyInput, 'runId' | 'round' | 'attempt'>): string {
  return sessionId(`verify:${input.runId}:${input.round}${input.attempt ? `:${input.attempt}` : ''}`);
}

/** Turns the checker's last message into a report. Anything it did not clearly pass counts against the work. */
export function readVerdict(text: string, requirements: string[], screenshots: Set<string>): AcceptanceItem[] {
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  let items: z.infer<typeof verdictSchema>['items'] = [];
  try { items = verdictSchema.parse(JSON.parse(block ?? text)).items; } catch { items = []; }
  return requirements.map((requirement, index) => {
    const item = items.find(entry => entry.index === index + 1);
    if (!item) return { requirement, status: 'unverified' as const, notes: 'The checker gave no verdict for this requirement.' };
    const name = item.screenshot?.split('/').pop();
    const real = name !== undefined && screenshots.has(name);
    if (item.status === 'passed' && !item.notes.trim()) return { requirement, status: 'unverified' as const, notes: 'Marked passed with nothing to show for it.' };
    if (item.status === 'passed' && item.screenshot && !real) return { requirement, status: 'unverified' as const, notes: `Claimed a screenshot that does not exist. ${item.notes}`.trim() };
    return { requirement, status: item.status, notes: item.notes, ...(real ? { screenshot: `screenshots/${name}` } : {}) };
  });
}

function receiptRef(request: DelegationRequest): string { return `executor_${createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 32)}`; }
function parse(line: string): Record<string, any> | undefined { try { return JSON.parse(line) as Record<string, any>; } catch { return undefined; } }
function toolNames(event: Record<string, any> | undefined): string[] {
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  return event.message.content.filter((item: { type?: string; name?: unknown }) => item.type === 'tool_use' && typeof item.name === 'string').map((item: { name: string }) => item.name.slice(0, 100));
}

/** Sends executor cards to the sandbox and everything else over the normal transport. */
export class RoutedAgentTransport implements AgentTransport {
  constructor(private readonly executor: AgentTransport, private readonly remote: AgentTransport) {}
  private pick(card: AgentCard) { return card.endpoint === EXECUTOR_ENDPOINT ? this.executor : this.remote; }
  submit(card: AgentCard, request: DelegationRequest, context?: DelegationContext) { return this.pick(card).submit(card, request, context); }
  async reconcile(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt, context?: DelegationContext) {
    const transport = this.pick(card);
    if (!transport.reconcile) throw new Error('Agent transport does not support reconciliation');
    return transport.reconcile(card, request, receipt, context);
  }
}

/** The executor is configured by the operator on this host, so it needs no separate admission step, on any start. */
export async function ensureExecutorAdmitted(directory: { register(card: AgentCard): unknown; admit(agentId: string): unknown }, card: AgentCard): Promise<void> {
  // Already admitted from an earlier start, or revoked by an operator, which must stick and must not stop AEEIS starting.
  const settled = (error: unknown) => error instanceof Error && /not awaiting admission|Revoked Agent/.test(error.message);
  try { await directory.register(card); await directory.admit(card.agentId); } catch (error) { if (!settled(error)) throw error; }
}

export function executorCard(config: ExecutorConfig): AgentCard {
  return {
    schemaVersion: 'agent-card/1', agentId: config.agentId, name: 'Claude Code', owner: 'aeeis', protocols: ['aeeis-task/1'],
    capabilities: ['code', 'test', 'file-edit'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'], auth: ['local'],
    // Model calls go to the configured provider under that provider's terms, so this is declared rather than "none".
    privacy: { dataRetention: 'declared', regions: [] }, pricing: { unit: 'tokens' }, cardVersion: '1', endpoint: EXECUTOR_ENDPOINT,
  };
}
