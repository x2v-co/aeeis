import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CollaborationService, DebateRecord } from './collaboration-service.js';
import type { Ownership } from './security/principal.js';
import type { CollaborationTriggerEvent } from './collaboration-triggers.js';
import type { ChannelIdentity, ChannelIdentityResolver } from './security/channel-identity.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const externalId = z.string().trim().min(1).max(500);

export const hermesDebateRouteSchema = z.object({
  roomId: externalId,
  debateId: id,
  owner: z.string().min(1).max(200).default('owner'),
  tenantId: z.string().min(1).max(200).default('local'),
}).strict();
export type HermesDebateRoute = z.infer<typeof hermesDebateRouteSchema>;

export const hermesDebateEventSchema = z.object({
  schemaVersion: z.literal('hermes-debate-event/1'),
  eventId: externalId,
  roomId: externalId,
  senderRef: externalId,
  messageId: externalId.optional(),
  message: z.object({
    content: z.string().trim().min(1).max(8000),
    type: z.enum(['position', 'evidence', 'challenge', 'rebuttal', 'clarification', 'concession', 'decision']).optional(),
    round: z.number().int().positive().optional(),
    claimRefs: z.array(id).max(100).optional(),
    replyTo: id.optional(),
  }).strict(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type HermesDebateEvent = z.infer<typeof hermesDebateEventSchema>;

export interface HermesDebateIngressOptions {
  collaboration: CollaborationService;
  routes: HermesDebateRoute[];
  /** Legacy local mapping. Ignored when channelIdentityResolver is configured. */
  senderAgentIds?: Record<string, string>;
  channelIdentityResolver?: ChannelIdentityResolver;
  signingKeys: Record<string, string>;
  onTrigger?: (event: CollaborationTriggerEvent) => Promise<unknown>;
  maxAgeSeconds?: number;
  now?: () => number;
}

export type HermesIngressResult =
  | { status: 'accepted' | 'duplicate'; debate: DebateRecord; externalEventId: string }
  | { status: 'ignored'; reason: 'unmapped_room' | 'unmapped_sender' | 'sender_not_admitted' };

/**
 * Versioned bridge contract for the local Hermes Feishu-debate skill.
 * Hermes is a transport adapter only: the Debate room remains the admission
 * boundary and its event log remains the canonical source of truth.
 *
 * Signature input is `${timestamp}\n${nonce}\n${rawBody}` with HMAC-SHA256.
 * The `x-hermes-signature` header may be a bare hex digest or `sha256=<hex>`.
 */
export class HermesDebateIngress {
  private readonly routeByRoom: Map<string, HermesDebateRoute>;
  private readonly senderAgentIds: Map<string, string>;
  private readonly maxAgeSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: HermesDebateIngressOptions) {
    this.routeByRoom = new Map(options.routes.map(route => {
      const parsed = hermesDebateRouteSchema.parse(route);
      return [parsed.roomId, parsed];
    }));
    if (this.routeByRoom.size !== options.routes.length) throw new Error('Hermes Debate room routes must be unique');
    this.senderAgentIds = new Map(Object.entries(options.senderAgentIds ?? {}).map(([sender, agent]) => [sender, id.parse(agent)]));
    if (!Object.keys(options.signingKeys).length) throw new Error('Hermes signing keys are required');
    for (const [keyId, key] of Object.entries(options.signingKeys)) {
      if (!keyId.trim() || key.length < 16) throw new Error('Hermes signing keys must be at least 16 characters');
    }
    this.maxAgeSeconds = options.maxAgeSeconds ?? 300;
    if (!Number.isInteger(this.maxAgeSeconds) || this.maxAgeSeconds < 30 || this.maxAgeSeconds > 3600) throw new Error('Hermes event max age must be between 30 and 3600 seconds');
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): void {
    const timestamp = header(headers, 'x-hermes-timestamp');
    const nonce = header(headers, 'x-hermes-nonce');
    const signatureHeader = header(headers, 'x-hermes-signature');
    const keyId = header(headers, 'x-hermes-key-id');
    if (!timestamp || !nonce || !signatureHeader || !keyId) throw new Error('Hermes signature headers are required');
    const seconds = Number(timestamp);
    if (!Number.isInteger(seconds) || Math.abs(this.now() - seconds) > this.maxAgeSeconds) throw new Error('Hermes event timestamp is outside the allowed window');
    const key = this.options.signingKeys[keyId];
    if (!key) throw new Error('Hermes signing key is unknown');
    const supplied = signatureHeader.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : signatureHeader;
    const expected = createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${rawBody}`).digest('hex');
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(supplied, 'utf8');
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Hermes event signature is invalid');
  }

  async handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<HermesIngressResult> {
    this.verify(rawBody, headers);
    const event = hermesDebateEventSchema.parse(JSON.parse(rawBody));
    const route = this.routeByRoom.get(event.roomId);
    if (!route) return { status: 'ignored', reason: 'unmapped_room' };
    const sender = await this.resolveSender(event.senderRef, route.tenantId);
    if (!sender) return { status: 'ignored', reason: 'unmapped_sender' };
    const speakerAgentId = sender.agentId;
    const externalEventId = event.eventId;
    const debate = await this.options.collaboration.getDebate(route.debateId, ownership(route));
    if (!debate.room.participantAgentIds.includes(speakerAgentId)) return { status: 'ignored', reason: 'sender_not_admitted' };
    const sourceMessageId = event.messageId ?? event.eventId;
    const messageId = `msg_hermes_${createHash('sha256').update(`${event.roomId}:${externalEventId}:${sourceMessageId}`).digest('hex').slice(0, 32)}`;
    const existing = debate.room.messages.find(message => message.messageId === messageId);
    if (existing) {
      await this.dispatchTrigger(route, debate, existing, externalEventId);
      return { status: 'duplicate', debate, externalEventId };
    }
    const round = event.message.round ?? Math.max(1, Math.min(debate.room.maxRounds, Math.max(0, ...debate.room.messages.map(message => message.round)) || 1));
    const message = {
      schemaVersion: 'debate-message/1' as const,
      messageId,
      debateId: debate.id,
      round,
      speakerAgentId,
      type: event.message.type ?? 'clarification' as const,
      content: event.message.content,
      claimRefs: event.message.claimRefs ?? [],
      contextVersion: debate.room.contextVersion,
      ...(event.message.replyTo ? { replyTo: event.message.replyTo } : {}),
      origin: { channel: 'hermes', externalEventId, senderRef: event.senderRef, receivedAt: event.occurredAt ?? new Date(this.now() * 1000).toISOString(), ...(sender.identity ? { identity: sender.identity } : {}) },
    };
    const updated = await this.options.collaboration.appendMessage(debate.id, message, ownership(route));
    await this.dispatchTrigger(route, updated, message, externalEventId);
    return { status: 'accepted', debate: updated, externalEventId };
  }

  private async resolveSender(senderRef: string, tenantId: string): Promise<{ agentId: string; identity?: ChannelIdentity } | undefined> {
    if (this.options.channelIdentityResolver) {
      const identity = await this.options.channelIdentityResolver.resolve({ channel: 'hermes', externalSubjectId: senderRef, tenantId });
      if (!identity || identity.channel !== 'hermes' || identity.externalSubjectId !== senderRef || identity.tenantId !== tenantId || identity.status !== 'active' || identity.subjectType !== 'agent') return undefined;
      return { agentId: identity.stableSubjectId, identity };
    }
    const agentId = this.senderAgentIds.get(senderRef);
    return agentId ? { agentId } : undefined;
  }

  private async dispatchTrigger(route: HermesDebateRoute, debate: DebateRecord, message: DebateRecord['room']['messages'][number], externalEventId: string): Promise<void> {
    if (!this.options.onTrigger) return;
    await this.options.onTrigger({
      schemaVersion: 'collaboration-trigger-event/1',
      eventId: `hermes:${createHash('sha256').update(`${route.roomId}:${externalEventId}`).digest('hex')}`,
      eventType: 'external.message',
      source: 'hermes',
      owner: route.owner,
      tenantId: route.tenantId,
      taskId: debate.room.taskId,
      contextVersion: debate.room.contextVersion,
      goal: message.content,
      allowedAgentIds: debate.room.participantAgentIds,
      context: {
        classification: debate.room.context?.classification ?? 'private',
        claims: debate.room.context?.claims ?? [],
        artifactRefs: debate.room.context?.artifactRefs ?? [],
        redactions: [...(debate.room.context?.redactions ?? []), 'External Hermes message is untrusted input'],
      },
      evidenceRefs: [],
      occurredAt: message.origin?.receivedAt ?? new Date(this.now() * 1000).toISOString(),
    });
  }
}

function ownership(route: HermesDebateRoute): Ownership { return { owner: route.owner, tenantId: route.tenantId }; }

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
