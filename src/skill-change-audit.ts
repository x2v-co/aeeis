import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChangeAuditConflict, ChangeAuditService, InMemoryChangeAuditStore, changeActorSchema, changeReasonSchema, type ChangeAuditStore, type ChangeContext } from './change-audit.js';

const snapshotSchema = z.object({ file: z.string().refine(file => basename(file) === file && file.endsWith('.json')), method: z.object({ id: z.string().min(1), version: z.string().min(1) }).passthrough() }).strict();
type SkillSnapshot = z.infer<typeof snapshotSchema>;

/** OwnHow methods are local overlays; restore exact JSON, retaining its separate version history. */
export class SkillChangeAudit {
  readonly service: ChangeAuditService<unknown>;
  private readonly directory: string;
  constructor(stateDirectory?: string, private readonly store: ChangeAuditStore<unknown> = new InMemoryChangeAuditStore()) {
    this.directory = join(resolve(stateDirectory ?? process.env.OWNHOW_HOME ?? join(homedir(), '.ownhow')), 'methods');
    // Also compensate filesystem restores if the database rejects a rollback's log append.
    const rollbackStore: ChangeAuditStore<unknown> = {
      list: () => store.list(),
      transaction: async work => {
        let undo: { id: string; snapshot: SkillSnapshot | null } | undefined;
        try {
          return await store.transaction(async (log, tx) => {
            const target = { capture: (id: string, snapshot: SkillSnapshot | null) => { undo = { id, snapshot }; }, tx };
            return work(log, target);
          });
        } catch (error) {
          if (undo) await this.restore(undo.id, undo.snapshot);
          throw error;
        }
      },
    };
    this.service = new ChangeAuditService(rollbackStore, {
      read: async entry => (await this.snapshots()).find(snapshot => snapshot.method.id === entry.subjectId) ?? null,
      restore: async (entry, snapshot, transaction) => {
        const current = (await this.snapshots()).find(item => item.method.id === entry.subjectId) ?? null;
        (transaction as { capture: (id: string, snapshot: SkillSnapshot | null) => void }).capture(entry.subjectId, current);
        await this.restore(entry.subjectId, snapshot);
      },
    });
  }
  async mutate<T extends { methodId: string }>(trigger: string, taskId: string, command: () => Promise<T>, context?: ChangeContext, op?: 'rollback'): Promise<T> {
    if (context) { changeActorSchema.parse(context.actor); changeReasonSchema.parse(context.reason); }
    let changed: { id: string; before: SkillSnapshot | null } | undefined;
    try {
      return await this.store.transaction(async log => {
        const before = await this.snapshots();
        const result = await command();
        changed = { id: result.methodId, before: before.find(snapshot => snapshot.method.id === result.methodId) ?? null };
        const after = (await this.snapshots()).find(snapshot => snapshot.method.id === result.methodId);
        if (!after) throw new ChangeAuditConflict('OwnHow did not persist a method snapshot');
        log.append({ subjectKind: 'skill', subjectId: result.methodId, op: op ?? (changed.before === null ? 'create' : 'update'), before: changed.before, after,
          actor: context?.actor ?? { kind: 'system', id: 'ownhow' }, reason: context?.reason ?? { taskId, trigger } });
        return result;
      });
    } catch (error) {
      // Filesystem and PostgreSQL cannot share a transaction. Compensate a failed log commit.
      if (changed) await this.restore(changed.id, changed.before);
      throw error;
    }
  }
  private async snapshots(): Promise<SkillSnapshot[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => snapshotSchema.parse({ file, method: JSON.parse(await readFile(join(this.directory, file), 'utf8')) })));
  }
  private async restore(subjectId: string, input: unknown): Promise<void> {
    const snapshot = input === null ? null : snapshotSchema.parse(input);
    if (snapshot && snapshot.method.id !== subjectId) throw new ChangeAuditConflict('Skill snapshot subject does not match');
    const current = (await this.snapshots()).find(item => item.method.id === subjectId);
    if (snapshot === null) {
      if (current) await unlink(join(this.directory, current.file));
      return;
    }
    const collision = (await this.snapshots()).find(item => item.file === snapshot.file && item.method.id !== subjectId);
    if (collision) throw new ChangeAuditConflict('Skill snapshot filename belongs to another subject');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, snapshot.file), temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(snapshot.method)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (current && current.file !== snapshot.file) await unlink(join(this.directory, current.file));
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
