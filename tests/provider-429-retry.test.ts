import { afterEach, expect, it, vi } from 'vitest';
import { HttpModelAdapter, ModelResponseRejected } from '../src/runtime/model.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
const limited = (retryAfter?: string) => new Response('{"error":{"code":"RateLimitExceeded"}}', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
const model = (options = {}) => new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-code-latest', '', undefined, 1000, undefined, false, undefined,
  { maxAttempts: 3, retryBaseMs: 1000, retryMaxMs: 10000, ...options });

it('run_ee478491: retries JSON 429 errors with exponential jitter and the same body/key', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const fetch = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const done = model().complete({ system: 's', input: {}, idempotencyKey: 'stable' });
  await vi.advanceTimersByTimeAsync(749); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1499); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); await expect(done).resolves.toMatchObject({ value: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new Set(fetch.mock.calls.map(call => call[1].body)).size).toBe(1);
  expect(fetch.mock.calls.map(call => call[1].headers['idempotency-key'])).toEqual(['stable', 'stable', 'stable']);
});

it.each(['seconds', 'date'] as const)('honors Retry-After %s beyond the normal backoff cap', async kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValueOnce(limited(kind === 'seconds' ? '12' : 'Fri, 16 Oct 2026 00:00:12 GMT')).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const done = model().complete({ system: 's', input: {} });
  await vi.advanceTimersByTimeAsync(11999); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await expect(done).resolves.toMatchObject({ value: { ok: true } });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['garbage', '-1', 'Fri, 16 Oct 2020 00:00:00 GMT'])('uses jittered backoff for invalid/past Retry-After %s', async header => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0); vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn().mockResolvedValueOnce(limited(header)).mockResolvedValueOnce(success()); vi.stubGlobal('fetch', fetch);
  const done = model().complete({ system: 's', input: {} });
  await vi.advanceTimersByTimeAsync(499); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await done;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('bounds persistent rate limits to configured attempts and returns a definite HTTP rejection', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn(async () => limited()); vi.stubGlobal('fetch', fetch);
  const done = expect(model().complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelResponseRejected);
  await vi.runAllTimersAsync(); await done;
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['disabled', 'budget'] as const)('does not retry when %s forbids it', async kind => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn(async () => limited('700')); vi.stubGlobal('fetch', fetch);
  await expect(model().complete({ system: 's', input: {}, disableRetries: kind === 'disabled' })).rejects.toThrow('HTTP 429');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
