import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CollaborationService, DebateRecord } from './collaboration-service.js';
import type { Ownership } from './security/principal.js';
import type { CollaborationTriggerEvent } from './collaboration-triggers.js';
import type { ChannelIdentity, ChannelIdentityResolver } from './security/channel-identity.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
export const feishuDebateRouteSchema = z.object({
  chatId: z.string().trim().min(1).max(500), debateId: id, owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'),
}).strict();
export type FeishuDebateRoute = z.infer<typeof feishuDebateRouteSchema>;

export interface FeishuDebateIngressOptions {
  collaboration: CollaborationService;
  routes: FeishuDebateRoute[];
  /** Legacy local mapping. Ignored when channelIdentityResolver is configured. */
  senderAgentIds?: Record<string, string>;
  channelIdentityResolver?: ChannelIdentityResolver;
  encryptKey: string;
  verificationToken?: string;
  onTrigger?: (event: CollaborationTriggerEvent) => Promise<unknown>;
  maxAgeSeconds?: number;
  now?: () => number;
}

export type FeishuIngressResult =
  | { status: 'challenge'; challenge: string }
  | { status: 'accepted' | 'duplicate'; debate: DebateRecord; externalEventId: string }
  | { status: 'ignored'; reason: 'unsupported_event' | 'unmapped_chat' | 'unmapped_sender' | 'sender_not_admitted' };

/** Feishu/Hermes ingress. Accepted transport events become durable Debate
 * messages carrying external provenance; the transport is never canonical. */
export class FeishuDebateIngress {
  private readonly routeByChat: Map<string, FeishuDebateRoute>;
  private readonly senderAgentIds: Map<string, string>;
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: FeishuDebateIngressOptions) {
    if (!options.encryptKey || options.encryptKey.length < 8) throw new Error('Feishu event encrypt key must be at least 8 characters');
    this.routeByChat = new Map(options.routes.map(route => {
      const parsed = feishuDebateRouteSchema.parse(route);
      return [parsed.chatId, parsed];
    }));
    if (this.routeByChat.size !== options.routes.length) throw new Error('Feishu Debate chat routes must be unique');
    this.senderAgentIds = new Map(Object.entries(options.senderAgentIds ?? {}).map(([sender, agent]) => [sender, id.parse(agent)]));
    this.maxAgeSeconds = options.maxAgeSeconds ?? 300;
    if (!Number.isInteger(this.maxAgeSeconds) || this.maxAgeSeconds < 30 || this.maxAgeSeconds > 3600) throw new Error('Feishu event max age must be between 30 and 3600 seconds');
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): void {
    const timestamp = header(headers, 'x-lark-request-timestamp') ?? header(headers, 'x-feishu-request-timestamp');
    const nonce = header(headers, 'x-lark-request-nonce') ?? header(headers, 'x-feishu-request-nonce');
    const signature = header(headers, 'x-lark-signature') ?? header(headers, 'x-feishu-signature');
    if (!timestamp || !nonce || !signature) throw new Error('Feishu event signature headers are required');
    const seconds = Number(timestamp);
    if (!Number.isInteger(seconds) || Math.abs(this.now() - seconds) > this.maxAgeSeconds) throw new Error('Feishu event timestamp is outside the allowed window');
    const expected = createHash('sha256').update(`${timestamp}\n${nonce}\n${this.options.encryptKey}\n${rawBody}`).digest('hex');
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(signature, 'utf8');
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Feishu event signature is invalid');
  }

  async handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<FeishuIngressResult> {
    const body = parseEnvelope(rawBody);
    if (body.type === 'url_verification' && body.challenge) {
      if (this.options.verificationToken && body.token !== this.options.verificationToken) throw new Error('Feishu verification token is invalid');
      // Feishu's URL verification request may omit event-signature headers;
      // the configured verification token is the trust mechanism for this
      // one-time handshake. If no token is configured, require the signature.
      if (!this.options.verificationToken || !hasSignatureHeaders(headers)) this.verify(rawBody, headers);
      return { status: 'challenge', challenge: body.challenge };
    }
    this.verify(rawBody, headers);
    if (body.header?.event_type !== 'im.message.receive_v1' || !body.event) return { status: 'ignored', reason: 'unsupported_event' };
    const chatId = body.event.message.chat_id;
    const route = this.routeByChat.get(chatId);
    if (!route) return { status: 'ignored', reason: 'unmapped_chat' };
    const senderRef = body.event.sender?.sender_id?.open_id ?? body.event.sender?.sender_id?.user_id ?? body.event.sender?.sender_id?.union_id;
    if (!senderRef) return { status: 'ignored', reason: 'unmapped_sender' };
    const sender = await this.resolveSender(senderRef, route.tenantId);
    if (!sender) return { status: 'ignored', reason: 'unmapped_sender' };
    const speakerAgentId = sender.agentId;
    const externalEventId = body.header?.event_id ?? body.event.message.message_id;
    const debate = await this.options.collaboration.getDebate(route.debateId, ownership(route));
    if (!debate.room.participantAgentIds.includes(speakerAgentId)) return { status: 'ignored', reason: 'sender_not_admitted' };
    const messageId = `msg_feishu_${createHash('sha256').update(`${chatId}:${externalEventId}`).digest('hex').slice(0, 32)}`;
    const existing = debate.room.messages.find(message => message.messageId === messageId);
    if (existing) {
      await this.dispatchTrigger(route, debate, existing, externalEventId);
      return { status: 'duplicate', debate, externalEventId };
    }
    const parsedContent = parseFeishuContent(body.event.message.content);
    const structured = parseStructuredMessage(parsedContent);
    const round = structured?.round ?? Math.max(1, Math.min(debate.room.maxRounds, Math.max(0, ...debate.room.messages.map(message => message.round)) || 1));
    const message = {
      schemaVersion: 'debate-message/1' as const,
      messageId, debateId: debate.id, round, speakerAgentId,
      type: structured?.type ?? 'clarification' as const,
      content: structured?.content ?? parsedContent,
      claimRefs: structured?.claimRefs ?? [], contextVersion: debate.room.contextVersion,
      ...(structured?.replyTo ? { replyTo: structured.replyTo } : {}),
      origin: { channel: 'feishu', externalEventId, senderRef, receivedAt: new Date(this.now() * 1000).toISOString(), ...(sender.identity ? { identity: sender.identity } : {}) },
    };
    const updated = await this.options.collaboration.appendMessage(debate.id, message, ownership(route));
    await this.dispatchTrigger(route, updated, message, externalEventId);
    return { status: 'accepted', debate: updated, externalEventId };
  }

  private async resolveSender(senderRef: string, tenantId: string): Promise<{ agentId: string; identity?: ChannelIdentity } | undefined> {
    if (this.options.channelIdentityResolver) {
      const identity = await this.options.channelIdentityResolver.resolve({ channel: 'feishu', externalSubjectId: senderRef, tenantId });
      if (!identity || identity.channel !== 'feishu' || identity.externalSubjectId !== senderRef || identity.tenantId !== tenantId || identity.status !== 'active' || identity.subjectType !== 'agent') return undefined;
      return { agentId: identity.stableSubjectId, identity };
    }
    const agentId = this.senderAgentIds.get(senderRef);
    return agentId ? { agentId } : undefined;
  }

  private async dispatchTrigger(route: FeishuDebateRoute, debate: DebateRecord, message: DebateRecord['room']['messages'][number], externalEventId: string): Promise<void> {
    if (!this.options.onTrigger) return;
    await this.options.onTrigger({
      schemaVersion: 'collaboration-trigger-event/1', eventId: `feishu:${createHash('sha256').update(`${route.chatId}:${externalEventId}`).digest('hex')}`,
      eventType: 'external.message', source: 'feishu', owner: route.owner, tenantId: route.tenantId,
      taskId: debate.room.taskId, contextVersion: debate.room.contextVersion, goal: message.content,
      // The Debate room is the admission boundary for an external message.
      // Preserve its frozen context and participants so a trigger policy
      // cannot fan the message out to an Agent that was never admitted to the
      // Debate. The message itself remains untrusted input and contributes no
      // new evidence claims.
      allowedAgentIds: debate.room.participantAgentIds,
      context: {
        classification: debate.room.context?.classification ?? 'private',
        claims: debate.room.context?.claims ?? [],
        artifactRefs: debate.room.context?.artifactRefs ?? [],
        redactions: [...(debate.room.context?.redactions ?? []), 'External Feishu message is untrusted input'],
      },
      evidenceRefs: [], occurredAt: message.origin?.receivedAt ?? new Date(this.now() * 1000).toISOString(),
    });
  }
}

function ownership(route: FeishuDebateRoute): Ownership { return { owner: route.owner, tenantId: route.tenantId }; }

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function hasSignatureHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return Boolean((header(headers, 'x-lark-request-timestamp') ?? header(headers, 'x-feishu-request-timestamp')) && (header(headers, 'x-lark-request-nonce') ?? header(headers, 'x-feishu-request-nonce')) && (header(headers, 'x-lark-signature') ?? header(headers, 'x-feishu-signature')));
}

type Envelope = {
  type?: string; challenge?: string; token?: string;
  header?: { event_type?: string; event_id?: string };
  event?: { message: { chat_id: string; message_id: string; content: string }; sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string } } };
};

function parseEnvelope(rawBody: string): Envelope {
  const value: unknown = JSON.parse(rawBody);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Feishu event body must be an object');
  const record = value as Record<string, unknown>;
  const headerValue = record.header && typeof record.header === 'object' && !Array.isArray(record.header) ? record.header as Record<string, unknown> : undefined;
  const eventValue = record.event && typeof record.event === 'object' && !Array.isArray(record.event) ? record.event as Record<string, unknown> : undefined;
  const message = eventValue?.message && typeof eventValue.message === 'object' && !Array.isArray(eventValue.message) ? eventValue.message as Record<string, unknown> : undefined;
  const sender = eventValue?.sender && typeof eventValue.sender === 'object' && !Array.isArray(eventValue.sender) ? eventValue.sender as Record<string, unknown> : undefined;
  const senderId = sender?.sender_id && typeof sender.sender_id === 'object' && !Array.isArray(sender.sender_id) ? sender.sender_id as Record<string, unknown> : undefined;
  return {
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.challenge === 'string' ? { challenge: record.challenge } : {}),
    ...(typeof record.token === 'string' ? { token: record.token } : {}),
    ...(headerValue ? { header: { ...(typeof headerValue.event_type === 'string' ? { event_type: headerValue.event_type } : {}), ...(typeof headerValue.event_id === 'string' ? { event_id: headerValue.event_id } : {}) } } : {}),
    ...(message && typeof message.chat_id === 'string' && typeof message.message_id === 'string' && typeof message.content === 'string'
      ? { event: { message: { chat_id: message.chat_id, message_id: message.message_id, content: message.content }, ...(senderId ? { sender: { sender_id: { ...(typeof senderId.open_id === 'string' ? { open_id: senderId.open_id } : {}), ...(typeof senderId.user_id === 'string' ? { user_id: senderId.user_id } : {}), ...(typeof senderId.union_id === 'string' ? { union_id: senderId.union_id } : {}) } } } : {}) } }
      : {}),
  };
}

function parseFeishuContent(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text.trim().slice(0, 8000);
  } catch { /* Feishu text can be a non-JSON string in fixtures and bridges. */ }
  return content.trim().slice(0, 8000);
}

const structuredMessageSchema = z.object({
  schemaVersion: z.literal('debate-message/1'), round: z.number().int().positive().optional(),
  type: z.enum(['position', 'evidence', 'challenge', 'rebuttal', 'clarification', 'concession', 'decision']).optional(),
  content: z.string().min(1).max(8000), claimRefs: z.array(id).max(100).optional(), replyTo: id.optional(),
}).strict();
type StructuredMessage = z.infer<typeof structuredMessageSchema>;
function parseStructuredMessage(content: string): StructuredMessage | undefined {
  try {
    const value: unknown = JSON.parse(content);
    const parsed = structuredMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
