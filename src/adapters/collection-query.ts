import { isOwnedBy, type Ownership } from '../security/principal.js';

export interface CollectionCursor { timestamp: string; id: string }
export function encodeCollectionCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
export function decodeCollectionCursor(value: string | undefined): CollectionCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CollectionCursor>;
    if (typeof parsed.timestamp !== 'string' || !Number.isFinite(Date.parse(parsed.timestamp)) || typeof parsed.id !== 'string' || parsed.id.length < 1) throw new Error();
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch { throw new RangeError('Invalid collection cursor'); }
}
export function afterCollectionCursor(item: { id: string }, timestamp: string, cursor: CollectionCursor | undefined): boolean {
  if (!cursor) return true;
  const itemTime = Date.parse(timestamp), cursorTime = Date.parse(cursor.timestamp);
  return itemTime < cursorTime || (itemTime === cursorTime && item.id > cursor.id);
}

export interface VersionCursor { version: number; id: string }
export function encodeVersionCursor(cursor: VersionCursor): string { return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'); }
export function decodeVersionCursor(value: string | undefined): VersionCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<VersionCursor>;
    if (!Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1 || typeof parsed.id !== 'string' || parsed.id.length < 1) throw new Error();
    return { version: parsed.version as number, id: parsed.id };
  } catch { throw new RangeError('Invalid version cursor'); }
}
export function afterVersionCursor(item: { version: number; id: string }, cursor: VersionCursor | undefined): boolean {
  if (!cursor) return true;
  return item.version < cursor.version || (item.version === cursor.version && item.id > cursor.id);
}

/** Repository callers also validate limits; an invalid bound must never turn
 * into an unbounded query. HTTP imposes its own, smaller public maximum. */
export function validateCollectionLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new RangeError('Collection limit must be a positive safe integer');
  }
}

export function recentFirst<T extends { id: string }>(timestamp: (item: T) => string) {
  return (left: T, right: T): number => Date.parse(timestamp(right)) - Date.parse(timestamp(left)) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function scopedRecent<T extends { id: string; owner?: string; tenantId?: string }>(items: T[], timestamp: (item: T) => string, scope?: Ownership, limit?: number): T[] {
  validateCollectionLimit(limit);
  return items.filter(item => !scope || isOwnedBy(item, scope)).sort(recentFirst(timestamp)).slice(0, limit);
}

/** Membership only grants access within the Room's own tenant. IDs from a
 * separate membership store cannot override the canonical tenant boundary. */
export function visibleRooms<T extends { id: string; owner?: string; tenantId?: string; updatedAt: string }>(rooms: T[], scope?: Ownership, limit?: number, memberRoomIds: string[] = []): T[] {
  validateCollectionLimit(limit);
  const membership = new Set(memberRoomIds);
  return rooms.filter(room => !scope || (room.tenantId ?? 'local') === scope.tenantId && ((room.owner ?? 'owner') === scope.owner || membership.has(room.id)))
    .sort(recentFirst(room => room.updatedAt)).slice(0, limit);
}
