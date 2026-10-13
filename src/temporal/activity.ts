import { ApplicationFailure, Context } from '@temporalio/activity';
import { z } from 'zod';

export interface AdvanceRunActivityResult { status: string; progress?: string }
export interface AdvanceReminderActivityResult { status: string; terminal: boolean; wakeAt?: string }
export interface AdvanceRunActivityOptions { api: string; token: string; timeoutMs?: number; requestTimeoutMs?: number; pollIntervalMs?: number; heartbeat?: (details: unknown) => void }

const responseSchema = z.object({ status: z.string().min(1).max(40), progress: z.string().min(1).max(200).optional() }).strict();
const reminderResponseSchema = z.object({ protocol: z.literal('aeeis-reminder-advance/1'), status: z.string().min(1).max(40), terminal: z.boolean(), wakeAt: z.string().datetime({ offset: true }).optional() }).strict();

/**
 * The activity is the only Temporal boundary that talks to the AEEIS API.
 * Transport and overload errors remain retryable; configuration, auth and
 * protocol errors are durable non-retryable failures. AEEIS run state is the
 * business source of truth. Transient failures retain a workflow timer; only
 * permanent configuration errors and business waits require an explicit wake.
 */
export function createAdvanceRunActivity(options: AdvanceRunActivityOptions): (id: string) => Promise<AdvanceRunActivityResult> {
  // No HTTP exchange waits on the model. Undici/proxy 300s limits therefore
  // cannot interrupt a healthy long model stream. Retried activities rejoin
  // the durable in-flight tick instead of replaying provider requests.
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  return async (id: string): Promise<AdvanceRunActivityResult> => {
    const overall = AbortSignal.timeout(timeoutMs);
    let context: Context | undefined;
    try { context = Context.current(); } catch { /* standalone/unit invocation */ }
    const heartbeat = options.heartbeat ?? (details => context?.heartbeat(details));
    const signal = context ? AbortSignal.any([overall, context.cancellationSignal]) : overall;
    const url = `${options.api}/internal/runs/${encodeURIComponent(id)}/advance`;
    let method: 'POST' | 'GET' = 'POST';
    for (;;) {
      signal.throwIfAborted();
      heartbeat({ runId: id, polling: method === 'GET' });
      let response: Response;
      try {
        response = await fetch(url, {
          method, headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', 'x-aeeis-advance-progress': '1', 'x-aeeis-advance-async': '1' },
          ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 15_000)]), redirect: 'error',
        });
      } catch (error) {
        throw new Error(`AEEIS activity transport failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new Error(`AEEIS activity returned retryable HTTP ${response.status}`);
        throw ApplicationFailure.nonRetryable(`AEEIS activity returned non-retryable HTTP ${response.status}`, 'AeeisPermanentError');
      }
      let body: AdvanceRunActivityResult;
      try {
        const parsed = responseSchema.parse(await response.json());
        body = parsed.progress === undefined ? { status: parsed.status } : { status: parsed.status, progress: parsed.progress };
      }
      catch (error) {
        // A disconnected/timed-out body is transport failure, not a permanent
        // schema failure; Temporal must retry it too.
        if (!(error instanceof z.ZodError)) throw new Error('AEEIS activity response transport failed');
        throw ApplicationFailure.nonRetryable('AEEIS activity returned an invalid status envelope', 'AeeisProtocolError');
      }
      heartbeat({ runId: id, ...body });
      if (response.status !== 202) return body; // status-only older API rollout
      method = 'GET';
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, options.pollIntervalMs ?? 1_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
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
