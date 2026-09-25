import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';

export interface AdvanceRunActivityResult { status: string }
export interface AdvanceReminderActivityResult { status: string; terminal: boolean; wakeAt?: string }
export interface AdvanceRunActivityOptions { api: string; token: string; timeoutMs?: number }

const responseSchema = z.object({ status: z.string().min(1).max(40) }).strict();
const reminderResponseSchema = z.object({ protocol: z.literal('aeeis-reminder-advance/1'), status: z.string().min(1).max(40), terminal: z.boolean(), wakeAt: z.string().datetime({ offset: true }).optional() }).strict();

/**
 * The activity is the only Temporal boundary that talks to the AEEIS API.
 * Transport and overload errors remain retryable; configuration, auth and
 * protocol errors are durable non-retryable failures. AEEIS run state is the
 * business source of truth, so the workflow may still wait for a wake signal
 * after an activity failure.
 */
export function createAdvanceRunActivity(options: AdvanceRunActivityOptions): (id: string) => Promise<AdvanceRunActivityResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  return async (id: string): Promise<AdvanceRunActivityResult> => {
    let response: Response;
    try {
      response = await fetch(`${options.api}/internal/runs/${encodeURIComponent(id)}/advance`, {
        method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
    } catch (error) {
      throw new Error(`AEEIS activity transport failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new Error(`AEEIS activity returned retryable HTTP ${response.status}`);
      throw ApplicationFailure.nonRetryable(`AEEIS activity returned non-retryable HTTP ${response.status}`, 'AeeisPermanentError');
    }
    let body: unknown;
    try { body = responseSchema.parse(await response.json()); }
    catch { throw ApplicationFailure.nonRetryable('AEEIS activity returned an invalid status envelope', 'AeeisProtocolError'); }
    return { status: (body as { status: string }).status };
  };
}

/** Advance a Reminder through the same durable claim/outbox state machine used
 * by the periodic safety pump. Temporal owns only the timer and wakeup; it
 * never sends a notification directly. */
export function createAdvanceReminderActivity(options: AdvanceRunActivityOptions): (id: string) => Promise<AdvanceReminderActivityResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  return async (id: string): Promise<AdvanceReminderActivityResult> => {
    let response: Response;
    try {
      response = await fetch(`${options.api}/internal/reminders/${encodeURIComponent(id)}/advance`, {
        method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
    } catch (error) {
      throw new Error(`AEEIS reminder activity transport failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new Error(`AEEIS reminder activity returned retryable HTTP ${response.status}`);
      throw ApplicationFailure.nonRetryable(`AEEIS reminder activity returned non-retryable HTTP ${response.status}`, 'AeeisPermanentError');
    }
    try {
      const parsed = reminderResponseSchema.parse(await response.json());
      return parsed.wakeAt === undefined
        ? { status: parsed.status, terminal: parsed.terminal }
        : { status: parsed.status, terminal: parsed.terminal, wakeAt: parsed.wakeAt };
    }
    catch { throw ApplicationFailure.nonRetryable('AEEIS reminder activity returned an invalid status envelope', 'AeeisProtocolError'); }
  };
}
