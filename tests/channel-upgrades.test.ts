import { taskBoardFixture, scope } from './support/task-board.js';
import { InMemoryTaskBoardStore } from '../src/adapters/task-board-store.js';
import { InMemorySessionEventRepository } from '../src/session-events.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { FileEvolutionActivationStore } from '../src/evolution-activation.js';
import { EvolutionEngine, type EvolutionCandidate } from '../src/evolution.js';
import { channelUpgradeCards, upgradeSourceRunId } from '../src/channel-upgrades.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const alice = { authorization: 'Bearer alice' };
const bob = { authorization: 'Bearer bob' };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-upgrades-'));
  const evolution = new FileEvolutionRepository(directory); await evolution.init();
  const activation = new FileEvolutionActivationStore(directory); await activation.init();
  const app = buildApp({
    repository: new InMemoryRunRepository(),
    domain: new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository()),
    rsi: new RsiService(evolution, activation),
    principalTokens: { alice: { id: 'alice', tenantId: 'team', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team', roles: ['owner'] } },
  });
  cleanup.push(() => app.close(), () => evolution.close(), () => activation.close());
  const room = async (title: string, description: string) => (await app.inject({ method: 'POST', url: '/api/rooms', headers: alice, payload: { title, description } })).json().id as string;
  const group = await room('发布协作', '群聊');
  await room('备用群', '群聊');
  const direct = await room('阿研', '私聊');
  expect((await app.inject({ method: 'POST', url: `/api/rooms/${group}/members`, headers: alice, payload: { principalId: 'bob', role: 'viewer' } })).statusCode).toBe(200);
  const propose = async (version: string, risk = 'low') => {
    const response = await app.inject({ method: 'POST', url: '/api/evolution/candidates', headers: alice, payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: version, change: '回答先写结论，再列证据。', sourceReceiptRefs: ['receipt.1', 'receipt.2'], reason: '复盘里三次被要求先写结论', risk } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().id as string;
  };
  const evaluate = async (id: string) => {
    for (const kind of ['replay', 'holdout', 'safety']) {
      const response = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${id}/evaluate`, headers: alice, payload: { kind, passed: true, score: 0.9, evidenceRefs: [`${kind}.1`] } });
      expect(response.statusCode, response.body).toBe(200);
    }
  };
  const cards = async (headers: Record<string, string>, roomId = group) => {
    const response = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/upgrades`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().items as Array<Record<string, any>>;
  };
  const act = (id: string, action: string, payload: unknown = {}) => app.inject({ method: 'POST', url: `/api/evolution/candidates/${id}/${action}`, headers: alice, payload });
  return { app, group, direct, propose, evaluate, cards, act };
}

describe('Bot upgrade cards in a group chat', () => {
  it('shows the owner the full card and walks it from approval to new Runs, while a member sees only a summary', async () => {
    const f = await setup();
    const id = await f.propose('prompt/2');
    let [card] = await f.cards(alice);
    expect(card).toMatchObject({ kind: 'full', id, target: 'prompt', baseVersion: 'prompt/1', version: 'prompt/2', status: 'proposed', risk: 'low', evaluated: false, sources: 2, affectedChannels: 2, active: false, canActivate: true, fromThisChannel: false });
    expect(card!.change).toBe('回答先写结论，再列证据。');
    const [summary] = await f.cards(bob);
    expect(summary).toEqual({ kind: 'summary', id, target: 'prompt', version: 'prompt/2', status: 'proposed', updatedAt: expect.any(String) });
    expect(JSON.stringify(await f.cards(bob))).not.toContain('先写结论');
    expect(await f.cards(alice, f.direct)).toEqual([]);

    await f.evaluate(id);
    [card] = await f.cards(alice);
    expect(card).toMatchObject({ status: 'evaluating', evaluated: true, evaluations: [{ kind: 'replay', passed: true, score: 0.9 }, { kind: 'holdout', passed: true, score: 0.9 }, { kind: 'safety', passed: true, score: 0.9 }] });
    expect((await f.act(id, 'approve', { approvalRef: `room:${f.group}` })).statusCode).toBe(200);
    expect((await f.act(id, 'promote')).statusCode).toBe(200);
    [card] = await f.cards(alice);
    expect(card).toMatchObject({ status: 'promoted', active: false });
    expect((await f.act(id, 'activate', { activationRef: `room:${f.group}` })).statusCode).toBe(200);
    [card] = await f.cards(alice);
    expect(card).toMatchObject({ status: 'promoted', active: true });
    // A promoted upgrade cannot be rejected, only rolled back.
    const late = await f.act(id, 'reject', { reason: '晚了' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toContain('roll it back');
    expect((await f.act(id, 'rollback', { reason: '回答变长了' })).statusCode).toBe(200);
    [card] = await f.cards(alice);
    expect(card).toMatchObject({ status: 'rolled_back', active: false });
  });

  it('turns down an upgrade that has not rolled out, and refuses a member acting on it', async () => {
    const f = await setup();
    const id = await f.propose('prompt/3', 'medium');
    expect((await f.act(id, 'reject', { reason: '' })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: `/api/evolution/candidates/${id}/reject`, headers: bob, payload: { reason: '不要' } })).statusCode).toBeGreaterThanOrEqual(400);
    const rejected = await f.act(id, 'reject', { reason: '先不改语气' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'rejected' });
    expect(rejected.json().reason).toContain('Rejected: 先不改语气');
    expect((await f.cards(alice))[0]).toMatchObject({ status: 'rejected' });
  });
});

describe('channel upgrade projection', () => {
  const engine = new EvolutionEngine();
  const base = (overrides: Partial<EvolutionCandidate> = {}): EvolutionCandidate => ({ ...engine.propose({ target: 'skill', baseVersion: 's/1', proposedVersion: 's/2', change: 'x'.repeat(3000), sourceReceiptRefs: ['r'], reason: 'why', risk: 'medium' }), ...overrides });
  const now = '2026-11-02T00:00:00.000Z';

  it('keeps open upgrades, drops settled ones after a week, and marks the channel it came from', () => {
    const open = base({ proposalSignalId: 'rsi-signal:run_here:evt_1', status: 'shadowing', shadowObservations: [{ id: 'a', passed: true, score: 1, evidenceRefs: ['e'], recordedAt: now }] });
    const recent = base({ status: 'promoted', updatedAt: '2026-10-30T00:00:00.000Z' });
    const old = base({ status: 'rejected', updatedAt: '2026-10-01T00:00:00.000Z' });
    const cards = channelUpgradeCards([open, recent, old], { manager: true, roomRunIds: new Set(['run_here']), affectedChannels: 3, now });
    expect(cards.map(card => card.id)).toEqual([recent.id, open.id].sort((a, b) => [recent, open].find(c => c.id === a)!.updatedAt!.localeCompare([recent, open].find(c => c.id === b)!.updatedAt!)));
    const shadowing = cards.find(card => card.id === open.id)!;
    expect(shadowing).toMatchObject({ kind: 'full', fromThisChannel: true, shadow: { passed: 1, failed: 0, needed: 3 }, canary: { passed: 0, failed: 0, needed: 3 }, active: false, canActivate: false });
    expect((shadowing as { change: string }).change).toHaveLength(2001);
    expect(channelUpgradeCards([open], { manager: false, roomRunIds: new Set(), affectedChannels: 0, now })[0]).toEqual({ kind: 'summary', id: open.id, target: 'skill', version: 's/2', status: 'shadowing', updatedAt: open.updatedAt });
  });

  it('keeps upgrade provenance on the current Run while a board is manually organized',async () => {
    const f = await taskBoardFixture(new InMemorySessionEventRepository(),new InMemoryTaskBoardStore());
    try {
      const candidate = base({ proposalSignalId: `rsi-signal:${f.task.runId}:evt_1` });
      const project = async () => channelUpgradeCards([candidate],{ manager: true,roomRunIds: new Set((await f.get()).cards.flatMap(card => card.runId ? [card.runId] : [])),affectedChannels: 1,now });
      expect((await project())[0]).toMatchObject({ fromThisChannel: true,active: false });
      await f.move('blocked'); expect((await project())[0]).toMatchObject({ fromThisChannel: true,active: false });
      f.task.latestRunId = 'run_retry'; expect((await project())[0]).toMatchObject({ fromThisChannel: false,active: false });
    } finally { await f.close(); }
  });
  it('reads the source Run from the signal id', () => {
    expect(upgradeSourceRunId({ proposalSignalId: 'rsi-signal:run_abc:evt_1' })).toBe('run_abc');
    expect(upgradeSourceRunId({ proposalSignalId: 'manual' })).toBeUndefined();
    expect(upgradeSourceRunId({})).toBeUndefined();
  });

  it('rejects only before rollout', () => {
    expect(engine.reject(base({ status: 'approved' }), 'no').status).toBe('rejected');
    expect(() => engine.reject(base({ status: 'shadowing' }), 'no')).toThrow('roll it back');
  });
});
