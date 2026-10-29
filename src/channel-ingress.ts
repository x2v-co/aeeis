import { z } from 'zod';
import { hasSignatureHeaders, parseEnvelope, parseFeishuContent, verifyFeishuSignature } from './feishu-debate-ingress.js';
import type { Ownership } from './security/principal.js';
import type { ChannelIdentityResolver } from './security/channel-identity.js';

/**
 * A message app reaching one of the owner's people. The transport proves the
 * event came from the platform; the identity resolver says the sender is the
 * owner. The message is then written into that person's life thread as
 * discussion. Arriving never starts work.
 */
export interface ChannelInboundMessage extends Ownership {
  channel: string;
  /** Person whose life thread receives the message. */
  agentId: string;
  /** Title for the life thread when this is the person's first message. */
  title?: string;
  /** Platform event id. The same id is written once. */
  externalEventId: string;
  senderRef: string;
  chatId: string;
  text: string;
  receivedAt: string;
}

export interface LifeThreadInbox {
  receive(message: ChannelInboundMessage): Promise<{ status: 'accepted' | 'duplicate'; conversationId: string; messageId: string }>;
}

export type ChannelIngressResult =
  | { status: 'challenge'; challenge: string }
  | { status: 'accepted' | 'duplicate'; conversationId: string; messageId: string; externalEventId: string }
  | { status: 'ignored'; reason: 'unsupported_event' | 'unmapped_chat' | 'unmapped_sender' | 'sender_not_owner' | 'empty_message' };

export interface ChannelIngress {
  readonly channel: string;
  handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<ChannelIngressResult>;
}

const personId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
export const feishuLifeRouteSchema = z.object({
  chatId: z.string().trim().min(1).max(500), agentId: personId,
  title: z.string().trim().min(1).max(200).optional(),
  owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'),
  /** Feishu open_id/user_id values that are the owner. Ignored when a channel identity resolver is configured. */
  ownerSenderRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
}).strict();
export type FeishuLifeRoute = z.infer<typeof feishuLifeRouteSchema>;

export interface FeishuChannelIngressOptions {
  routes: FeishuLifeRoute[];
  inbox: LifeThreadInbox;
  encryptKey: string;
  verificationToken?: string;
  channelIdentityResolver?: ChannelIdentityResolver;
  maxAgeSeconds?: number;
  now?: () => number;
}

/** Feishu private chat with one of the owner's people. */
export class FeishuChannelIngress implements ChannelIngress {
  readonly channel = 'feishu';
  private readonly routeByChat: Map<string, FeishuLifeRoute>;
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: FeishuChannelIngressOptions) {
    if (!options.encryptKey || options.encryptKey.length < 8) throw new Error('Feishu event encrypt key must be at least 8 characters');
    this.routeByChat = new Map(options.routes.map(route => { const parsed = feishuLifeRouteSchema.parse(route); return [parsed.chatId, parsed]; }));
    if (this.routeByChat.size !== options.routes.length) throw new Error('Feishu life-thread chat routes must be unique');
    for (const route of this.routeByChat.values()) {
      if (!options.channelIdentityResolver && !route.ownerSenderRefs?.length) throw new Error(`Feishu life-thread route ${route.chatId} needs ownerSenderRefs or a channel identity resolver`);
    }
    this.maxAgeSeconds = options.maxAgeSeconds ?? 300;
    if (!Number.isInteger(this.maxAgeSeconds) || this.maxAgeSeconds < 30 || this.maxAgeSeconds > 3600) throw new Error('Feishu event max age must be between 30 and 3600 seconds');
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  routes(chatId: string): boolean { return this.routeByChat.has(chatId); }

  async handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<ChannelIngressResult> {
    const body = parseEnvelope(rawBody);
    if (body.type === 'url_verification' && body.challenge) {
      if (this.options.verificationToken && body.token !== this.options.verificationToken) throw new Error('Feishu verification token is invalid');
      if (!this.options.verificationToken || !hasSignatureHeaders(headers)) verifyFeishuSignature(rawBody, headers, this.options.encryptKey, this.now(), this.maxAgeSeconds);
      return { status: 'challenge', challenge: body.challenge };
    }
    verifyFeishuSignature(rawBody, headers, this.options.encryptKey, this.now(), this.maxAgeSeconds);
    if (body.header?.event_type !== 'im.message.receive_v1' || !body.event) return { status: 'ignored', reason: 'unsupported_event' };
    const route = this.routeByChat.get(body.event.message.chat_id);
    if (!route) return { status: 'ignored', reason: 'unmapped_chat' };
    const senderRef = body.event.sender?.sender_id?.open_id ?? body.event.sender?.sender_id?.user_id ?? body.event.sender?.sender_id?.union_id;
    if (!senderRef) return { status: 'ignored', reason: 'unmapped_sender' };
    const sender = await this.resolveOwner(senderRef, route);
    if (sender !== 'owner') return { status: 'ignored', reason: sender };
    const text = parseFeishuContent(body.event.message.content).slice(0, 7000).trim();
    if (!text) return { status: 'ignored', reason: 'empty_message' };
    const externalEventId = body.header?.event_id ?? body.event.message.message_id;
    const result = await this.options.inbox.receive({
      channel: 'feishu', owner: route.owner, tenantId: route.tenantId, agentId: route.agentId, ...(route.title ? { title: route.title } : {}),
      externalEventId, senderRef, chatId: route.chatId, text, receivedAt: new Date(this.now() * 1000).toISOString(),
    });
    return { ...result, externalEventId };
  }

  /** Only the owner talks to their own people here. Anyone else in the chat is ignored. */
  private async resolveOwner(senderRef: string, route: FeishuLifeRoute): Promise<'owner' | 'unmapped_sender' | 'sender_not_owner'> {
    if (this.options.channelIdentityResolver) {
      const identity = await this.options.channelIdentityResolver.resolve({ channel: 'feishu', externalSubjectId: senderRef, tenantId: route.tenantId });
      if (!identity || identity.channel !== 'feishu' || identity.externalSubjectId !== senderRef || identity.tenantId !== route.tenantId || identity.status !== 'active') return 'unmapped_sender';
      return identity.subjectType === 'principal' && identity.stableSubjectId === route.owner ? 'owner' : 'sender_not_owner';
    }
    return route.ownerSenderRefs?.includes(senderRef) ? 'owner' : 'unmapped_sender';
  }
}
