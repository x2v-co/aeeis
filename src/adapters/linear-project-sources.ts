import { z } from 'zod';
import {
  projectSourceContentHash,
  projectSourceProtocolHash,
  makeSyncReceipt,
  projectSourceRecordSchema,
  validateProjectSources,
  validateProjectSourceSync,
  type ProjectSourceRecord,
  type ProjectSourceSearchRequest,
  type ProjectSourceSyncProvider,
  type ProjectSourceSyncRequest,
  type ProjectSourceSyncResult,
} from '../project-sources.js';

const classificationSchema = z.enum(['public', 'internal', 'confidential', 'private']);

export const linearProjectConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  endpoint: z.string().url().default('https://api.linear.app/graphql'),
  apiKey: z.string().trim().min(1).max(500),
  tenantId: z.string().trim().min(1).max(200),
  classification: classificationSchema.default('internal'),
  teamId: z.string().trim().min(1).max(200).optional(),
  maxPageSize: z.number().int().min(1).max(100).default(50),
}).strict().superRefine((config, context) => {
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endpoint'], message: 'Linear endpoint must use HTTPS except loopback' });
  }
  if (url.username || url.password || url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endpoint'], message: 'Linear endpoint must not contain credentials or fragments' });
  }
});
export type LinearProjectConfig = z.input<typeof linearProjectConfigSchema>;

const graphqlIssue = `
  id
  identifier
  title
  description
  updatedAt
  url
  state { name }
  team { id key name }
  assignee { name }
`;
const issueSearchQuery = `query AeeisIssueSearch($query: String!, $first: Int!, $after: String) {
  issueSearch(query: $query, first: $first, after: $after) {
    nodes { ${graphqlIssue} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const issueSchema = z.object({
  id: z.string().min(1).max(200),
  identifier: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).nullable().optional(),
  updatedAt: z.string().datetime({ offset: true }),
  url: z.string().url().optional().nullable(),
  state: z.object({ name: z.string().trim().min(1).max(200) }).strict().optional().nullable(),
  team: z.object({ id: z.string().min(1).max(200), key: z.string().min(1).max(100), name: z.string().min(1).max(300) }).strict().optional().nullable(),
  assignee: z.object({ name: z.string().trim().min(1).max(300) }).strict().optional().nullable(),
}).strict();
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().trim().min(1).max(1000).nullable().optional() }).strict();
const graphQlResponseSchema = z.object({
  data: z.object({ issueSearch: z.object({ nodes: z.array(z.unknown()).max(100), pageInfo: pageInfoSchema }).strict() }).strict().optional(),
  errors: z.array(z.object({ message: z.string().max(4000) }).passthrough()).max(20).optional(),
}).passthrough();

/**
 * Direct Linear GraphQL connector. It is deliberately a source adapter only:
 * AEEIS receives normalized, hash-bound records and keeps its own checkpoint,
 * context and evidence semantics. Wrapped cursors distinguish in-progress
 * pages from completed scans, which restart on the next sync to observe edits
 * and deletions. The checkpoint commits each page before requesting the next.
 */
export class LinearProjectSourceProvider implements ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  private readonly config: z.output<typeof linearProjectConfigSchema>;

  constructor(config: LinearProjectConfig) {
    this.config = linearProjectConfigSchema.parse(config);
    this.checkpointIdentity = `linear-v2:${projectSourceProtocolHash({ id: this.config.id, endpoint: this.config.endpoint, tenantId: this.config.tenantId, teamId: this.config.teamId ?? null, classification: this.config.classification, maxPageSize: this.config.maxPageSize })}`;
  }

  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    // Search is a fresh bounded view. Sync is the durable paginated API.
    const { cursor: _cursor, ...fresh } = request;
    return (await this.sync(fresh)).records;
  }

  async sync(request: ProjectSourceSyncRequest): Promise<ProjectSourceSyncResult> {
    if (request.tenantId !== this.config.tenantId || !(request.allowedClassifications ?? ['public', 'internal']).includes(this.config.classification)) {
      const nextCursor = 'denied';
      const records: ProjectSourceRecord[] = [];
      return { records, nextCursor, receipt: makeSyncReceipt(`linear:${this.config.id}`, request, records, nextCursor, { mode: 'snapshot' }) };
    }
    const { cursor: _cursor, ...scopeRequest } = request;
    const scope = projectSourceProtocolHash({ identity: this.checkpointIdentity, ...scopeRequest });
    const previous = decodeCursor(request.cursor, scope);
    const after = previous?.after ?? null;
    const page = await this.fetchPage(request, after);
    const records = page.records;
    const digest = projectSourceProtocolHash({ previous: after ? previous!.digest : null, records });
    const nextCursor = encodeCursor({ v: 2, after: page.after, digest, scope });
    const update = { mode: 'scan' as const, start: after === null, complete: page.after === null };
    const receipt = makeSyncReceipt(`linear:${this.config.id}`, request, records, nextCursor, update);
    return validateProjectSourceSync(request, { records, nextCursor, receipt });
  }

  private async fetchPage(request: ProjectSourceSearchRequest, after: string | null): Promise<{ records: ProjectSourceRecord[]; after: string | null }> {
    const first = Math.min(request.maxItems, this.config.maxPageSize);
    const response = await fetch(this.config.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: this.config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ query: issueSearchQuery, variables: { query: request.query, first, after } }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Linear GraphQL returned HTTP ${response.status}`);
    }
    const body = graphQlResponseSchema.parse(await response.json());
    if (body.errors?.length) throw new Error(`Linear GraphQL query failed: ${body.errors.slice(0, 3).map(item => item.message).join('; ')}`);
    const page = body.data?.issueSearch;
    if (!page) throw new Error('Linear GraphQL response did not contain issueSearch data');
    if (page.nodes.length > first) throw new Error('Linear GraphQL returned more issues than requested');
    const records = page.nodes.flatMap(value => {
      const parsed = issueSchema.safeParse(value);
      if (!parsed.success) throw new Error('Linear issue response did not match the supported schema');
      const issue = parsed.data;
      if (this.config.teamId && issue.team?.id !== this.config.teamId) return [];
      return [this.record(issue)];
    });
    if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)) throw new Error('Linear GraphQL pagination did not advance');
    return { records: validateProjectSources(request, records), after: page.pageInfo.hasNextPage ? page.pageInfo.endCursor! : null };
  }

  private record(issue: z.infer<typeof issueSchema>): ProjectSourceRecord {
    const details = [
      issue.description?.trim(),
      issue.state?.name ? `State: ${issue.state.name}` : undefined,
      issue.team?.name ? `Team: ${issue.team.name}` : undefined,
      issue.assignee?.name ? `Assignee: ${issue.assignee.name}` : undefined,
      issue.url ? `URL: ${issue.url}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const content = details.length ? details.join('\n') : issue.title;
    return projectSourceRecordSchema.parse({
      id: `linear:${this.config.id}:issue:${issue.identifier}`,
      title: `${this.config.id} / ${issue.identifier} · ${issue.title}`,
      content,
      source: `linear:${this.config.id}:${issue.identifier}`,
      kind: 'task', classification: this.config.classification, tenantId: this.config.tenantId,
      updatedAt: issue.updatedAt, contentHash: projectSourceContentHash(content),
    });
  }

}

const cursorSchema = z.object({ v: z.literal(2), after: z.string().min(1).max(1000).nullable(), digest: z.string().regex(/^[a-f0-9]{64}$/), scope: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  const encoded = `linear-v2:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
  if (encoded.length > 1000) throw new Error('Linear cursor exceeds the source protocol limit');
  return encoded;
}
function decodeCursor(cursor: string | undefined, scope: string): z.infer<typeof cursorSchema> | undefined {
  // Legacy raw cursors and local sentinels must never reach GraphQL as after.
  if (!cursor?.startsWith('linear-v2:')) return undefined;
  const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor.slice('linear-v2:'.length), 'base64url').toString('utf8')));
  if (parsed.scope !== scope) throw new Error('Linear cursor belongs to a different source scope');
  return parsed;
}
