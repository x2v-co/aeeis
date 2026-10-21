import type { FetchFunction, Model } from '@earendil-works/pi-ai';
import type { ModelPin } from '../../src/runtime/contracts.js';

// Deliberately not a production model/endpoint. All requests must use recordingFetch.
export const piModel: Model<'openai-responses'> = {
  id: 'fixture-pi-model', name: 'Pi Responses fixture', api: 'openai-responses',
  provider: 'openai', baseUrl: 'http://127.0.0.1:9999/v1',
  reasoning: false, input: ['text'], contextWindow: 32_768, maxTokens: 4_096,
  cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
};
export const piPin: ModelPin = {
  model: piModel.id, provider: piModel.provider, endpoint: piModel.baseUrl, promptVersion: 'pi-fixture/1',
};

export interface NativeCall { name: string; arguments: unknown; id?: string }
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
export interface ResponsesOptions {
  calls?: NativeCall[];
  usage?: ResponsesUsage | null;
  stopReason?: 'stop' | 'length' | 'error';
  /** Emit literal text instead of JSON.stringify(value), including intentionally invalid JSON. */
  text?: string;
}

export function sse(events: Record<string, unknown>[]): Response {
  const body = events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
}

/** Real Responses SSE consumed by the installed pi/OpenAI parser, not a mocked pi result. */
export function responses(value: unknown, options: ResponsesOptions = {}): Response {
  const events: Record<string, unknown>[] = [];
  const output: Record<string, unknown>[] = [];
  const response = { id: 'resp_fixture', object: 'response', model: piModel.id, created_at: 1_700_000_000 };
  events.push({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  if (value !== undefined || options.text !== undefined) {
    const text = options.text ?? JSON.stringify(value);
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const output_index = output.length;
    events.push(
      { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: text },
      { type: 'response.output_text.done', output_index, item_id: item.id, content_index: 0, text },
      { type: 'response.output_item.done', output_index, item },
    );
    output.push(item);
  }
  for (const [index, call] of (options.calls ?? []).entries()) {
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
    const item = { type: 'function_call', id: `fc_fixture_${index}`, call_id: call.id ?? `call_fixture_${index}`, name: call.name, arguments: args, status: 'completed' };
    const output_index = output.length;
    events.push(
      { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: args },
      { type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: args },
      { type: 'response.output_item.done', output_index, item },
    );
    output.push(item);
  }
  const status = options.stopReason === 'length' ? 'incomplete' : options.stopReason === 'error' ? 'failed' : 'completed';
  const usage = options.usage === undefined ? { input_tokens: 20, output_tokens: 5, total_tokens: 25 } : options.usage;
  events.push({
    type: `response.${status}`,
    response: {
      ...response, status, output,
      ...(usage === null ? {} : { usage }),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(status === 'failed' ? { error: { code: 'server_error', message: 'Fixture provider failure' } } : {}),
    },
  });
  return sse(events);
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
}
export function recordingFetch(handler: (request: RecordedRequest, index: number) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      url: request.url, method: request.method, headers: request.headers,
      body: JSON.parse(await request.text()) as Record<string, unknown>, signal: request.signal,
    };
    requests.push(recorded);
    // Never fall through to the real fetch, including when the script is exhausted.
    return handler(recorded, requests.length - 1);
  };
  return { fetch, requests };
}
