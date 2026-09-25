import { z } from 'zod';
import { digestProtocol } from './protocol.js';
import { principalAudience, principalSchema } from './security/principal.js';

const participantSchema = z.object({
  principalId: principalSchema.shape.id,
  tenantId: principalSchema.shape.tenantId,
  audience: z.string().min(1).max(500),
  authority: z.enum(['goal-owner', 'room-owner', 'room-member']),
  role: z.enum(['owner', 'editor', 'viewer', 'agent']),
  membershipId: z.string().min(1).max(200).optional(),
  membershipUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const snapshotBodySchema = z.object({
  schemaVersion: z.literal('context-audience/1'),
  scope: z.literal('room').optional(),
  capturedAt: z.string().datetime({ offset: true }),
  roomId: z.string().min(1).max(200).optional(),
  participants: z.array(participantSchema).min(1).max(100),
}).strict();

/** An immutable observation of recipients, never a replacement for live ACLs. */
export const contextAudienceSnapshotSchema = snapshotBodySchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((value, ctx) => {
  const { digest, ...body } = value;
  if (digestProtocol(body) !== digest) ctx.addIssue({ code: 'custom', message: 'Audience snapshot digest mismatch' });
  const audiences = new Set<string>();
  const tenantId = value.participants[0]?.tenantId;
  for (const participant of value.participants) {
    if (participant.tenantId !== tenantId || participant.audience !== principalAudience({ id: participant.principalId, tenantId: participant.tenantId }) || audiences.has(participant.audience)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid audience identity binding' });
    }
    audiences.add(participant.audience);
    if (participant.authority === 'room-member' && (!value.roomId || !participant.membershipId || !participant.membershipUpdatedAt || participant.role === 'owner')) {
      ctx.addIssue({ code: 'custom', message: 'Room audience requires membership evidence' });
    }
    if (participant.authority === 'room-owner' && !value.roomId) ctx.addIssue({ code: 'custom', message: 'Room owner requires a Room' });
    if (participant.authority !== 'room-member' && participant.role !== 'owner') ctx.addIssue({ code: 'custom', message: 'Owner audience role mismatch' });
  }
  const goalOwners = value.participants.filter(participant => participant.authority === 'goal-owner').length;
  if (value.scope === 'room') {
    if (!value.roomId || goalOwners !== 0 || value.participants.filter(participant => participant.authority === 'room-owner').length !== 1) ctx.addIssue({ code: 'custom', message: 'Room audience requires exactly one Room owner and no Goal owner' });
  } else if (goalOwners !== 1) ctx.addIssue({ code: 'custom', message: 'Audience requires exactly one Goal owner' });
});

export type ContextAudienceSnapshot = z.infer<typeof contextAudienceSnapshotSchema>;
export function createContextAudienceSnapshot(input: z.input<typeof snapshotBodySchema>): ContextAudienceSnapshot {
  const body = snapshotBodySchema.parse(input);
  body.participants.sort((a, b) => a.audience.localeCompare(b.audience));
  return contextAudienceSnapshotSchema.parse({ ...body, digest: digestProtocol(body) });
}
