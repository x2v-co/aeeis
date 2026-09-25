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

export const jiraProjectConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  endpoint: z.string().url().default('https://your-domain.atlassian.net/rest/api/3/search/jql'),
  apiToken: z.string().trim().min(1).max(1000),
  /** Jira Cloud supports bearer tokens for OAuth/API gateways. Basic auth
   * can be selected for an email + API token installation. */
  auth: z.enum(['bearer', 'basic']).default('bearer'),
  username: z.string().trim().min(1).max(500).optional(),
  tenantId: z.string().trim().min(1).max(200),
  classification: classificationSchema.default('internal'),
  projectKey: z.string().trim().min(1).max(100).optional(),
  maxPageSize: z.number().int().min(1).max(100).default(50),
}).strict().superRefine((config, context) => {
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endpoint'], message: 'Jira endpoint must use HTTPS except loopback' });
  }
  if (url.username || url.password || url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endpoint'], message: 'Jira endpoint must not contain credentials or fragments' });
  }
  if (config.auth === 'basic' && !config.username) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['username'], message: 'Jira basic auth requires username' });
  }
});
export type JiraProjectConfig = z.input<typeof jiraProjectConfigSchema>;

const jiraIssueSchema = z.object({
  id: z.string().min(1).max(200),
  key: z.string().trim().min(1).max(100),
  self: z.string().url().optional(),
  fields: z.object({
    summary: z.string().trim().min(1).max(500),
    description: z.unknown().nullable().optional(),
    // Jira Cloud commonly returns offsets as `+0000` (without the RFC3339
    // colon). Normalize that wire format only after the connector boundary.
    updated: z.string().trim().min(1).max(100).optional().nullable(),
    status: z.object({ name: z.string().trim().min(1).max(200) }).passthrough().optional().nullable(),
    assignee: z.object({ displayName: z.string().trim().min(1).max(300) }).passthrough().optional().nullable(),
    project: z.object({ key: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(300).optional() }).passthrough().optional().nullable(),
  }).passthrough(),
}).passthrough();

const jiraResponseSchema = z.object({
  issues: z.array(z.unknown()).max(100),
  isLast: z.boolean().optional(),
  nextPageToken: z.string().trim().min(1).max(1000).nullable().optional(),
  startAt: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
}).passthrough();

/**
 * Jira REST source adapter. Jira's nextPageToken is treated as opaque and is
 * wrapped with a source scope/digest, so a cursor from another installation,
 * query or tenant cannot be replayed against this connector. A Jira search
 * page is committed as a scan page by the shared checkpoint implementation;
 * deletion is only possible after the provider reports the final page.
 */
export class JiraProjectSourceProvider implements ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  private readonly config: z.output<typeof jiraProjectConfigSchema>;

  constructor(config: JiraProjectConfig) {
    this.config = jiraProjectConfigSchema.parse(config);
    this.checkpointIdentity = `jira-v1:${projectSourceProtocolHash({ id: this.config.id, endpoint: this.config.endpoint, tenantId: this.config.tenantId, projectKey: this.config.projectKey ?? null, classification: this.config.classification, auth: this.config.auth, maxPageSize: this.config.maxPageSize })}`;
  }

  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    const { cursor: _cursor, ...fresh } = request;
    return (await this.sync(fresh)).records;
  }

  async sync(request: ProjectSourceSyncRequest): Promise<ProjectSourceSyncResult> {
    if (request.tenantId !== this.config.tenantId || !(request.allowedClassifications ?? ['public', 'internal']).includes(this.config.classification)) {
      const nextCursor = 'denied';
      const records: ProjectSourceRecord[] = [];
      return { records, nextCursor, receipt: makeSyncReceipt(`jira:${this.config.id}`, request, records, nextCursor, { mode: 'snapshot' }) };
    }
    const { cursor: _cursor, ...scopeRequest } = request;
    const scope = projectSourceProtocolHash({ identity: this.checkpointIdentity, ...scopeRequest });
    const previous = decodeCursor(request.cursor, scope);
    const page = await this.fetchPage(request, previous?.nextPageToken ?? null);
    const digest = projectSourceProtocolHash({ previous: previous?.digest ?? null, records: page.records });
    const nextCursor = encodeCursor({ v: 1, nextPageToken: page.nextPageToken, digest, scope });
    const update = { mode: 'scan' as const, start: previous === undefined, complete: page.nextPageToken === null };
    const receipt = makeSyncReceipt(`jira:${this.config.id}`, request, page.records, nextCursor, update);
    return validateProjectSourceSync(request, { records: page.records, nextCursor, receipt });
  }

  private async fetchPage(request: ProjectSourceSearchRequest, nextPageToken: string | null): Promise<{ records: ProjectSourceRecord[]; nextPageToken: string | null }> {
    const first = Math.min(request.maxItems, this.config.maxPageSize);
    const jql = buildJql(this.config.projectKey, request.query);
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    if (this.config.auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.apiToken}`).toString('base64')}`;
    else headers.authorization = `Bearer ${this.config.apiToken}`;
    const body = { jql, maxResults: first, fields: ['summary', 'description', 'updated', 'status', 'assignee', 'project'], ...(nextPageToken ? { nextPageToken } : {}) };
    const response = await fetch(this.config.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Jira REST returned HTTP ${response.status}`); }
    const parsed = jiraResponseSchema.parse(await response.json());
    if (parsed.issues.length > first) throw new Error('Jira REST returned more issues than requested');
    const records = parsed.issues.flatMap(value => {
      const issue = jiraIssueSchema.safeParse(value);
      if (!issue.success) throw new Error('Jira issue response did not match the supported schema');
      if (this.config.projectKey && issue.data.fields.project?.key !== this.config.projectKey) return [];
      return [this.record(issue.data)];
    });
    const next = parsed.isLast === true || !parsed.nextPageToken ? null : parsed.nextPageToken;
    if (next !== null && next === nextPageToken) throw new Error('Jira pagination did not advance');
    return { records: validateProjectSources(request, records), nextPageToken: next };
  }

  private record(issue: z.infer<typeof jiraIssueSchema>): ProjectSourceRecord {
    const fields = issue.fields;
    const details = [
      textFromJiraDescription(fields.description),
      fields.status?.name ? `Status: ${fields.status.name}` : undefined,
      fields.project?.name ? `Project: ${fields.project.name}` : fields.project?.key ? `Project: ${fields.project.key}` : undefined,
      fields.assignee?.displayName ? `Assignee: ${fields.assignee.displayName}` : undefined,
      issue.self ? `URL: ${issue.self}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const content = details.length ? details.join('\n') : fields.summary;
    return projectSourceRecordSchema.parse({
      id: `jira:${this.config.id}:issue:${issue.key}`,
      title: `${this.config.id} / ${issue.key} · ${fields.summary}`,
      content,
      source: `jira:${this.config.id}:${issue.key}`,
      kind: 'task', classification: this.config.classification, tenantId: this.config.tenantId,
      updatedAt: normalizeJiraDate(fields.updated), contentHash: projectSourceContentHash(content),
    });
  }
}

const cursorSchema = z.object({ v: z.literal(1), nextPageToken: z.string().min(1).max(1000).nullable(), digest: z.string().regex(/^[a-f0-9]{64}$/), scope: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  const encoded = `jira-v1:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
  if (encoded.length > 1000) throw new Error('Jira cursor exceeds the source protocol limit');
  return encoded;
}
function decodeCursor(cursor: string | undefined, scope: string): z.infer<typeof cursorSchema> | undefined {
  if (!cursor?.startsWith('jira-v1:')) return undefined;
  const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor.slice('jira-v1:'.length), 'base64url').toString('utf8')));
  if (parsed.scope !== scope) throw new Error('Jira cursor belongs to a different source scope');
  return parsed;
}

function quoteJql(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function buildJql(projectKey: string | undefined, query: string): string {
  const trimmed = query.trim();
  const base = trimmed || 'updated IS NOT EMPTY';
  if (!projectKey || /\bproject\s*=/.test(base)) return base;
  const order = /\border\s+by\b/i.exec(base);
  const filter = order ? base.slice(0, order.index).trim() : base;
  const suffix = order ? ` ${base.slice(order.index!).trim()}` : '';
  return `project = ${quoteJql(projectKey)} AND (${filter})${suffix}`;
}

function textFromJiraDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const parts: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') { if (current.trim()) parts.push(current.trim()); return; }
    if (Array.isArray(current)) { for (const item of current) visit(item); return; }
    if (!current || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.trim()) parts.push(record.text.trim());
    for (const [key, child] of Object.entries(record)) if (key !== 'text') visit(child);
  };
  visit(value);
  return parts.length ? [...new Set(parts)].join('\n') : undefined;
}

function normalizeJiraDate(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error('Jira issue returned an invalid updated timestamp');
  return date.toISOString();
}
