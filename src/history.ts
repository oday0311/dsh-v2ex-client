import { V2exError } from './errors.js';

export interface HistoryReader {
  readEligibleUserText(bounds: { maxSessions: number; maxBytes: number }, signal?: AbortSignal): Promise<string>;
}

interface SessionQuery {
  listSessions(): Promise<unknown>;
  filterEvents(sessionId: string, filters: Array<{ kind: 'type'; values: string[] }>): Promise<unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const plain = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
};
const ownData = (value: object, key: string): { value: unknown } | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? { value: descriptor.value } : undefined;
};
const arrayField = (value: unknown, key: string): unknown[] | null => {
  const candidate = Array.isArray(value) ? value : record(value) && plain(value) ? ownData(value, key)?.value : null;
  return Array.isArray(candidate) && plain(candidate) ? candidate : null;
};
const badSource = /(?:^|[^A-Za-z0-9])(assistant|model|llm|tool|plugin|system|developer|function|agent|bot)(?=$|[^A-Za-z0-9])/i;
const MAX_PROVENANCE_LENGTH = 256;
const credentialPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bV2EX_PERSONAL_ACCESS_TOKEN\s*[:=]\s*\S+|\bAuthorization\s*:?\s*Bearer\s+\S+|\b(?:token|api[-_]?key|password|secret)\s*[:=]\s*(?:["'][^"'\r\n]{12,}["']|[A-Za-z0-9_./+=-]{12,})/i;
const MAX_MESSAGE_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function timeValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string' || value.length > 64) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortable(value: Record<string, unknown>, timeKey: string, fallbackKey: string,
  requiredId: boolean): { id: string; time: number } | null {
  if (!plain(value)) return null;
  const idField = ownData(value, 'id');
  const id = idField?.value;
  if ((requiredId && (typeof id !== 'string' || !id || id.length > 256)) ||
      (idField && (typeof id !== 'string' || id.length > 256))) return null;
  const primary = Object.getOwnPropertyDescriptor(value, timeKey);
  const fallback = Object.getOwnPropertyDescriptor(value, fallbackKey);
  if (primary && !('value' in primary) || fallback && !('value' in fallback)) return null;
  const time = primary?.value ?? fallback?.value;
  if (time !== undefined && (typeof time !== 'string' && typeof time !== 'number' ||
      typeof time === 'string' && time.length > 64 || typeof time === 'number' && !Number.isFinite(time))) return null;
  return { id: typeof id === 'string' ? id : '', time: timeValue(time) };
}

function eligible(event: Record<string, unknown>): boolean {
  const type = ownData(event, 'type')?.value;
  if (typeof type !== 'string' || type.length > MAX_PROVENANCE_LENGTH || type !== 'user/message') return false;
  const queue: Array<{ value: unknown; depth: number; provenance: boolean }> = [{ value: event, depth: 0, provenance: false }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (queue.length) {
    const { value, depth, provenance } = queue.shift()!;
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value) || depth > 6 || ++visited > 256) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256) return false;
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
    }
    if (!plain(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 257 || provenance && (Array.isArray(value) ? value.length === 0 : keys.length === 0)) return false;
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > MAX_PROVENANCE_LENGTH) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return false;
      if (Array.isArray(value) && key === 'length') continue;
      const child = descriptor.value as unknown;
      if (/^(toolCalls?|functionCall|attachments?|files?)$/i.test(key)) return false;
      const source = provenance || /^(role|source|origin|actor|author|sender|kind)$/i.test(key) || key === 'type' && depth > 0;
      if (typeof child === 'string') {
        if (child.length > (source ? MAX_PROVENANCE_LENGTH : MAX_MESSAGE_BYTES) || source && badSource.test(child)) return false;
      } else if (child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1, provenance: source });
      } else if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint' || source) return false;
    }
  }
  return true;
}

function content(event: Record<string, unknown>): unknown {
  const payloadValue = ownData(event, 'payload')?.value;
  const dataValue = ownData(event, 'data')?.value;
  const payload = record(payloadValue) ? payloadValue : record(dataValue) ? dataValue : event;
  const messageValue = ownData(payload, 'message')?.value;
  const message = record(messageValue) ? messageValue : payload;
  return ownData(message, 'content')?.value;
}

function userText(event: Record<string, unknown>): string {
  const blocks = content(event);
  if (!Array.isArray(blocks) || blocks.length > 32) return '';
  const parts: string[] = [];
  let bytes = 0;
  for (const block of blocks) {
    if (!record(block) || ownData(block, 'type')?.value !== 'text' || typeof ownData(block, 'text')?.value !== 'string' ||
      Reflect.ownKeys(block).some(key => key !== 'type' && key !== 'text')) continue;
    const text = ownData(block, 'text')!.value as string;
    if (text.length > MAX_MESSAGE_BYTES) return '';
    const size = Buffer.byteLength(text);
    if (size > MAX_MESSAGE_BYTES || bytes + size + (parts.length ? 1 : 0) > MAX_MESSAGE_BYTES) return '';
    bytes += size + (parts.length ? 1 : 0);
    parts.push(decoder.decode(encoder.encode(text)));
  }
  const joined = parts.join('\n').trim();
  if (credentialPattern.test(joined) || credentialPattern.test(parts.join(''))) return '';
  return joined;
}

export class DshHistoryReader implements HistoryReader {
  constructor(private readonly resolve: () => unknown) {}
  async readEligibleUserText(bounds: { maxSessions: number; maxBytes: number }, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(bounds.maxSessions) || bounds.maxSessions < 1 || bounds.maxSessions > 100 ||
      !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || bounds.maxBytes > 32 * 1024) {
      throw new V2exError('invalid_request');
    }
    if (signal?.aborted) throw new V2exError('timeout');
    let query: SessionQuery;
    try { query = this.resolve() as SessionQuery; }
    catch { throw new V2exError('history_access_denied'); }
    if (typeof query?.listSessions !== 'function' || typeof query.filterEvents !== 'function') {
      throw new V2exError('history_access_denied');
    }
    let listed: unknown;
    try { listed = await query.listSessions(); }
    catch { throw new V2exError(signal?.aborted ? 'timeout' : 'history_access_denied'); }
    if (signal?.aborted) throw new V2exError('timeout');
    let sessions: unknown[] | null;
    try { sessions = arrayField(listed, 'sessions'); }
    catch { throw new V2exError('history_access_denied'); }
    if (!sessions) throw new V2exError('history_access_denied');
    const selected = sessions.slice(0, 1000).flatMap(item => {
      try {
        if (!record(item)) return [];
        const sort = sortable(item, 'updatedAt', 'createdAt', true);
        return sort ? [sort] : [];
      } catch { return []; }
    }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)).slice(0, bounds.maxSessions);
    const lines: string[] = [];
    const seen = new Set<string>();
    let remaining = bounds.maxBytes;
    let eventBudget = 2000;
    for (const session of selected) {
      if (signal?.aborted) throw new V2exError('timeout');
      if (eventBudget === 0) break;
      let found: unknown;
      try { found = await query.filterEvents(session.id, [{ kind: 'type', values: ['user/message'] }]); }
      catch { throw new V2exError(signal?.aborted ? 'timeout' : 'history_access_denied'); }
      let events: unknown[] | null;
      try { events = arrayField(found, 'events'); }
      catch { throw new V2exError('history_access_denied'); }
      if (!events) throw new V2exError('history_access_denied');
      const considered = events.slice(0, Math.min(1000, eventBudget));
      eventBudget -= considered.length;
      const ordered = considered.flatMap(item => {
        try {
          if (!record(item) || !eligible(item)) return [];
          const sort = sortable(item, 'timestamp', 'createdAt', false);
          return sort ? [{ event: item, ...sort }] : [];
        } catch { return []; }
      }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      for (const { event } of ordered) {
        if (signal?.aborted) throw new V2exError('timeout');
        let text: string;
        try { text = userText(event); }
        catch { continue; }
        if (!text || seen.has(text)) continue;
        const size = Buffer.byteLength(text);
        if (size + (lines.length ? 1 : 0) > remaining) continue;
        seen.add(text); lines.push(text);
        remaining -= size + (lines.length > 1 ? 1 : 0);
        if (remaining === 0) return lines.join('\n');
      }
    }
    return lines.join('\n');
  }
}
