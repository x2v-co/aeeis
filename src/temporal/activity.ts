import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';

export interface AdvanceRunActivityResult { status: string }
export interface AdvanceRunActivityOptions { api: string; token: string; timeoutMs?: number }

const responseSchema = z.object({ status: z.string().min(1).max(40) }).strict();

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
