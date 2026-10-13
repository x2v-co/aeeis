import { readFileSync } from 'node:fs';
import type { AgentRun } from './contracts.js';
import { projectRunGraphs } from './graphs.js';
import { explainRun } from './explanation.js';

export const MAX_DEBUG_FIELD_BYTES = 8192;
export const MAX_DEBUG_ARRAY_ITEMS = 500;
export const MAX_DEBUG_NODES = 200_000;
const sensitiveKey = /(?:secret|password|passwd|authorization|api[ _-]?key|access[ _-]?key|private[ _-]?key|credential|(?:^env|env$|[_-]env[_-])|environment|token|cookie|signature|^sig$|^(?:x-)?auth(?:[_-][\w-]*)?$|session[_-]?(?:key|secret|id))/i;
// Usage counters carry no credentials and remain useful for debugging budgets.
const safeCounter = /^(?:inputTokens|outputTokens|tokens|unreportedTokenCalls|maxTokens|maxOutputTokens)$/;
const isSensitive = (key: string): boolean => sensitiveKey.test(key) && !safeCounter.test(key);
// Public views must not expose provider completions or schema-repair payloads,
// even when nested in observations, validation diagnostics or JSON strings.
const rawProviderKey = /^(?:raw(?:output|response|text|completion|content)|modelrawoutput|provider(?:raw|response|text|output)|reasoning(?:content|text)?|thinking|plannerrepair|finishrepair|reconciledmodelcall)$/i;
// Also recognize assignments inside prose and incomplete JSON. Quoted values
// honor escapes so a credential copied into another field can be scrubbed.
const credentialAssignment = /(?<![\w.-])((["']?[\w.-]{1,160}(?:[ _-](?:key|id|secret))?["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;{}\[\]"'\n]+)/gi;
const assignmentKey = (key: string): string => key.replace(/^["']|["']$/g, '');
/** Visit complete JSON objects/arrays inside prose or code fences before field capping. */
function redactJsonFragments(text: string, redact: (value: unknown) => unknown, depth = 0): string {
  if (depth > 40) return '[truncated]';
  let out = '', last = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack: string[] = [];
    let quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) {
          out += text.slice(last, start + 1) + redactJsonFragments(text.slice(start + 1, end), redact, depth + 1) + char;
          last = end + 1; start = end;
          break;
        }
        if (stack.length) continue;
        try {
          const parsed: unknown = JSON.parse(text.slice(start, end + 1));
          out += text.slice(last, start) + JSON.stringify(redact(parsed));
          last = end + 1;
        } catch {
          // Prose brackets may wrap a valid JSON fragment without themselves
          // being JSON. Inspect their interior rather than skipping the payload.
          out += text.slice(last, start + 1) + redactJsonFragments(text.slice(start + 1, end), redact, depth + 1) + char;
          last = end + 1;
        }
        start = end;
        break;
      }
      if (end === text.length - 1) {
        return out + text.slice(last, start + 1) + redactJsonFragments(text.slice(start + 1), redact, depth + 1);
      }
    }
  }
  return out + text.slice(last);
}
/** Redact `env: { ... }` objects with brace matching so nested objects cannot leak past the first `}`. */
function redactEnvBlocks(text: string): string {
  const opener = /(["']?(?:env|environment)[\w.-]*["']?\s*[:=]\s*)\{/gi;
  let out = '', last = 0, match: RegExpExecArray | null;
  while ((match = opener.exec(text))) {
    let depth = 0, end = text.length;
    for (let i = match.index + match[1]!.length; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    out += text.slice(last, match.index) + match[1] + '[REDACTED]'; last = end; opener.lastIndex = end;
  }
  return out + text.slice(last);
}
/** Keep the newest items; event/call history is most useful at the tail. */
function capArray<T>(items: T[]): Array<T | string> {
  return items.length <= MAX_DEBUG_ARRAY_ITEMS ? items : [`[${items.length - MAX_DEBUG_ARRAY_ITEMS} earlier items truncated]`, ...items.slice(-MAX_DEBUG_ARRAY_ITEMS)];
}
export function capDebugField(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_DEBUG_FIELD_BYTES) return value;
  const marker = '…[truncated]';
  return Buffer.from(value, 'utf8').subarray(0, MAX_DEBUG_FIELD_BYTES - Buffer.byteLength(marker)).toString('utf8').replace(/\uFFFD$/, '') + marker;
}
/** Remove credential fields and scrub recognizable credentials even inside free text.
 * Values found under credential/environment keys are also scrubbed wherever copied.
 * Callers with their own byte budget can defer field capping. */
export function redactRunData<T>(value: T, options: { capFields?: boolean; credentialSource?: unknown; omitRawProviderText?: boolean } = {}): T {
  const capField = (text: string): string => options.capFields === false ? text : capDebugField(text);
  const secrets = new Set<string>();
  let collected = 0, visited = 0;
  const collect = (item: unknown, sensitive = false, depth = 0): void => {
    if (depth > 40 || ++collected > MAX_DEBUG_NODES * 4) return;
    if (typeof item === 'string') {
      if (sensitive && item.length) secrets.add(item);
      for (const match of item.matchAll(credentialAssignment)) {
        if (!isSensitive(assignmentKey(match[2]!))) continue;
        const raw = match[3]!;
        if (raw.startsWith('"')) {
          try { const decoded = JSON.parse(raw) as string; if (decoded.length) secrets.add(decoded); } catch { /* incomplete string */ }
          if (raw.length > 2) secrets.add(raw.slice(1, -1));
        } else {
          const decoded = raw.startsWith("'") ? raw.slice(1, -1) : raw;
          if (decoded.length) secrets.add(decoded);
        }
      }
      if (/^\s*[\[{]/.test(item)) { try { collect(JSON.parse(item), sensitive, depth + 1); } catch { /* free text */ } }
      for (const match of item.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) {
        try { collect(JSON.parse(match[1]!), sensitive, depth + 1); } catch { /* incomplete model output */ }
      }
    }
    else if (Array.isArray(item)) capArray(item).forEach(child => collect(child, sensitive, depth + 1));
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) collect(child, sensitive || isSensitive(key), depth + 1);
  };
  collect(options.credentialSource);
  collect(value);
  const scrub = (text: string): string => {
    let result = redactEnvBlocks(text);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      if (secret.length >= 4) result = result.replaceAll(secret, '[REDACTED]');
      else {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'gi'), '$1[REDACTED]');
      }
    }
    result = result
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
      .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED]')
      .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b((?:set-)?cookie|proxy-authorization|x-auth[\w-]*)\s*:\s*[^\r\n]*/gi, '$1: [REDACTED]')
      .replace(/(\/(?:api\/)?share\/)[A-Za-z0-9_-]{43}/g, '$1[REDACTED]')
      .replace(/([?&](?:sig|signature|x-amz-[\w-]+|key|apikey|api_key|code|auth|token|access_token|refresh_token|id_token)=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
      .replace(/\btk_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(credentialAssignment, (match, prefix: string, key: string) => isSensitive(assignmentKey(key)) ? `${prefix}[REDACTED]` : match);
    return capField(redactEnvBlocks(result));
  };
  const visit = (item: unknown, depth = 0): unknown => {
    if (depth > 40 || ++visited > MAX_DEBUG_NODES) return '[truncated]';
    if (typeof item === 'string') {
      // JSON embedded in model raw output/materials still receives key-based redaction.
      if (/^\s*[\[{]/.test(item) || (options.omitRawProviderText && /^\s*"/.test(item))) {
        try { const parsed: unknown = JSON.parse(item); collect(parsed); return capField(JSON.stringify(visit(parsed, depth + 1))); } catch { /* free text */ }
      }
      return scrub(options.omitRawProviderText ? redactJsonFragments(item, parsed => { collect(parsed); return visit(parsed, depth + 1); }) : item);
    }
    if (Array.isArray(item)) return capArray(item).map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !isSensitive(key) && !(options.omitRawProviderText && rawProviderKey.test(key.replace(/[ _-]/g, '')))).map(([key, child]) => [scrub(key), visit(child, depth + 1)]));
    return item;
  };
  return visit(value) as T;
}
export function modelRawOutput(value: unknown, credentialSource?: unknown): string {
  const redacted = redactRunData({ value, sourceValue: credentialSource }).value;
  return capDebugField(typeof redacted === 'string' ? redacted : JSON.stringify(redacted) ?? String(redacted));
}
const appVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export function sharedRunView(run: AgentRun) {
  return redactRunData({ ...run, graphs: projectRunGraphs(run), explanation: explainRun(run) }, { omitRawProviderText: true });
}
export function debugRunView(run: AgentRun) {
  return redactRunData({ ...run, graphs: projectRunGraphs(run), explanation: explainRun(run) });
}
export function debugBundle(run: AgentRun, options: { omitRawProviderText?: boolean } = {}) {
  // Events, plans and steps (taskAttempts) are emitted once at the top level. Embedding them
  // again under `run` made every lifecycle event appear twice in the bundle.
  const { events: _events, plans: _plans, steps: _steps, ...runSummary } = run;
  return redactRunData({ schemaVersion: 'aeeis-debug-bundle/2', id: run.id, run: runSummary, plans: run.plans,
    taskAttempts: run.steps.map(step => ({ ...step, calls: run.calls.filter(call => call.taskId === step.taskId) })),
    modelRawOutput: run.calls.filter(call => call.rawOutput !== undefined).map(call => ({ callId: call.id, phase: call.phase, taskId: call.taskId, rawOutput: call.rawOutput })),
    validationErrors: run.calls.filter(call => call.validationErrors).map(call => ({ callId: call.id, taskId: call.taskId, errors: call.validationErrors })),
    events: run.events, graphs: projectRunGraphs(run), explanation: explainRun(run), appVersion, gitCommit: process.env.AEEIS_GIT_COMMIT || 'unknown' }, options);
}
