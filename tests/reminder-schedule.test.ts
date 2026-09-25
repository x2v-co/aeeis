import { describe, expect, it } from 'vitest';
import { nextCalendarOccurrence, nextReminderOccurrence, reminderRecurrenceSchema } from '../src/reminder-schedule.js';

describe('calendar reminder rules', () => {
  it('keeps a local daily time across DST and skips missing wall times', () => {
    const daily = { frequency: 'daily' as const, timeZone: 'America/New_York', time: '09:00' };
    expect(nextCalendarOccurrence(daily, '2026-03-07T14:00:00Z')).toBe('2026-03-08T13:00:00.000Z');
    expect(nextCalendarOccurrence({ ...daily, time: '02:30' }, '2026-03-07T07:30:00Z')).toBe('2026-03-09T06:30:00.000Z');
  });

  it('fires only once at the earlier instant when a local time repeats', () => {
    const daily = { frequency: 'daily' as const, timeZone: 'America/New_York', time: '01:30' };
    expect(nextCalendarOccurrence(daily, '2026-10-31T05:30:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(nextCalendarOccurrence(daily, '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');
    expect(nextCalendarOccurrence(daily, '2026-11-01T06:00:00Z')).toBe('2026-11-02T06:30:00.000Z');
  });

  it('handles weekly weekdays, month ends, leap days and date-line skips', () => {
    expect(nextCalendarOccurrence({ frequency: 'weekly', timeZone: 'Asia/Singapore', time: '09:00', daysOfWeek: [1, 5] }, '2026-09-21T01:00:00Z')).toBe('2026-09-25T01:00:00.000Z');
    expect(nextCalendarOccurrence({ frequency: 'monthly', timeZone: 'UTC', time: '09:00', dayOfMonth: 31 }, '2026-01-31T09:00:00Z')).toBe('2026-03-31T09:00:00.000Z');
    expect(nextCalendarOccurrence({ frequency: 'monthly', timeZone: 'UTC', time: '09:00', dayOfMonth: 29 }, '2028-01-29T09:00:00Z')).toBe('2028-02-29T09:00:00.000Z');
    expect(nextCalendarOccurrence({ frequency: 'daily', timeZone: 'Pacific/Apia', time: '09:00' }, '2011-12-29T19:00:00Z')).toBe('2011-12-30T19:00:00.000Z');
  });

  it('uses dueAt as an inclusive first bound and skips missed occurrences after commit', () => {
    const calendar = { frequency: 'daily' as const, timeZone: 'Asia/Singapore', time: '09:00' };
    expect(nextCalendarOccurrence(calendar, '2026-09-21T01:00:00Z', true)).toBe('2026-09-21T01:00:00.000Z');
    expect(nextCalendarOccurrence(calendar, '2026-09-21T01:00:00.001Z', true)).toBe('2026-09-22T01:00:00.000Z');
    expect(nextReminderOccurrence({ calendar }, '2026-09-01T01:00:00Z', '2026-09-21T03:00:00Z')).toBe('2026-09-22T01:00:00.000Z');
    expect(nextReminderOccurrence({ intervalMs: 60_000 }, '2026-09-21T01:00:00Z', '2026-09-21T03:00:00Z')).toBe('2026-09-21T03:01:00.000Z');
  });

  it.each([
    { frequency: 'daily', timeZone: 'Not/AZone', time: '09:00' },
    { frequency: 'daily', timeZone: '+08:00', time: '09:00' },
    { frequency: 'daily', timeZone: 'UTC', time: '24:00' },
    { frequency: 'weekly', timeZone: 'UTC', time: '09:00' },
    { frequency: 'weekly', timeZone: 'UTC', time: '09:00', daysOfWeek: [1, 1] },
    { frequency: 'monthly', timeZone: 'UTC', time: '09:00', dayOfMonth: 32 },
    { frequency: 'daily', timeZone: 'UTC', time: '09:00', dayOfMonth: 1 },
  ])('rejects invalid calendar rules %j', calendar => {
    expect(reminderRecurrenceSchema.safeParse({ calendar }).success).toBe(false);
  });
});
