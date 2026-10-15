import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { OwnHowCliGovernance } from '../src/integrations.js';
import { InMemoryChangeAuditStore, type ChangeAuditStore } from '../src/change-audit.js';
import { SkillChangeAudit } from '../src/skill-change-audit.js';

const actor = { kind: 'user' as const, id: 'operator' }, reason = { taskId: 'proposal.test', trigger: 'approved skill change' };

describe('OwnHow skill change audit', () => {
  it('hooks apply and version rollback, restores exact JSON, and removes a rolled-back creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-skill-'));
    const file = join(directory, 'methods', 'personal-test.json');
    await mkdir(join(directory, 'methods'));
    const governance = new OwnHowCliGovernance('fixture', directory, 'codex');
    const first = { id: 'personal:test', version: '0.1.0', correction: 'first', basePlan: { steps: ['verify'] } };
    const second = { ...first, version: '0.1.1', correction: 'second' };
    const run = vi.spyOn(governance as unknown as { run(args: string[]): Promise<unknown> }, 'run');
    run.mockImplementation(async args => {
      const method = args[0] === 'rollback' ? { ...first, version: '0.1.2', restoredFrom: '0.1.0' } : args[1] === 'proposal.first' ? first : second;
      await writeFile(file, JSON.stringify(method));
      return method; // OwnHow returns id; older adapters also accept methodId.
    });
    try {
      expect(await governance.apply('proposal.first', { actor, reason })).toEqual({ methodId: first.id, version: first.version });
      const creation = (await governance.changeAudit.list())[0]!;
      await governance.apply('proposal.second', { actor, reason });
      const update = (await governance.changeAudit.list()).at(-1)!;
      expect(update).toMatchObject({ subjectKind: 'skill', subjectId: first.id, op: 'update', actor, reason, before: { method: first }, after: { method: second } });
      await governance.rollback(first.id, '0.1.0', { actor, reason });
      const versionRollback = (await governance.changeAudit.list()).at(-1)!;
      await governance.changeAudit.rollback(versionRollback.id, actor, reason);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(second);
      await governance.changeAudit.rollback(update.id, actor, reason);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(first);
      const prefix = await governance.changeAudit.list();
      await governance.changeAudit.rollback(creation.id, actor, reason);
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await governance.changeAudit.list()).slice(0, prefix.length)).toEqual(prefix);
      expect(await governance.changeAudit.verifyChain()).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not execute an invalid audit context or log a failed command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-skill-failure-'));
    const governance = new OwnHowCliGovernance('fixture', directory, 'codex');
    const run = vi.spyOn(governance as unknown as { run(args: string[]): Promise<unknown> }, 'run').mockRejectedValue(new Error('command failed'));
    try {
      await expect(governance.apply('proposal.test', { actor, reason: { trigger: 'missing task id' } })).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      await expect(governance.apply('proposal.test')).rejects.toThrow('command failed');
      expect(await governance.changeAudit.list()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('compensates a skill write and rollback when the audit transaction fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-skill-compensation-'));
    await mkdir(join(directory, 'methods'));
    const file = join(directory, 'methods', 'personal-test.json');
    const memory = new InMemoryChangeAuditStore();
    let fail = false;
    const store: ChangeAuditStore<unknown> = {
      list: () => memory.list(),
      transaction: work => memory.transaction(async log => { const result = await work(log, undefined); if (fail) throw new Error('audit commit failed'); return result; }),
    };
    const audit = new SkillChangeAudit(directory, store);
    const first = { id: 'personal:test', version: '0.1.0', correction: 'first' }, second = { ...first, version: '0.1.1', correction: 'second' };
    const mutate = (method: typeof first) => audit.mutate('skill.apply', 'proposal.test', async () => { await writeFile(file, JSON.stringify(method)); return { methodId: method.id }; });
    try {
      await mutate(first);
      fail = true;
      await expect(mutate(second)).rejects.toThrow('audit commit failed');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(first);
      expect(await audit.service.list()).toHaveLength(1);
      await expect(audit.service.rollback((await audit.service.list())[0]!.id, actor, reason)).rejects.toThrow('audit commit failed');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(first);
      expect(await audit.service.list()).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
