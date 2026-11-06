import { V2exError } from './errors.js';
import { boundUtf8 } from './intelligence.js';

export interface HistoryReader {
  readEligibleUserText(bounds: { maxSessions: number; maxBytes: number }, signal?: AbortSignal): Promise<string>;
}

interface SessionQuery {
  listSessions(): Promise<unknown>;
  filterEvents(sessionId: string, filters: Array<{ kind: 'type'; values: string[] }>): Promise<unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const arrayField = (value: unknown, key: string): unknown[] | null =>
  Array.isArray(value) ? value : record(value) && Array.isArray(value[key]) ? value[key] as unknown[] : null;
const badSource = /(?:^|[\/_-])(assistant|model|tool|plugin|system|developer|function|agent)(?:[\/_-]|$)/i;
function timeValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string' || value.length > 64) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eligible(event: Record<string, unknown>): boolean {
  if (event.type !== 'user/message') return false;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: event, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (queue.length) {
    const { value, depth } = queue.shift()!;
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value) || depth > 6 || ++visited > 256) return false;
    seen.add(value);
    if (Array.isArray(value) && value.length > 256) return false;
    let keys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++keys > 256) return false;
      const child = (value as Record<string, unknown>)[key];
      if (/^(toolCalls?|functionCall|attachments?|files?)$/i.test(key)) return false;
      if (/^(role|source|origin|actor|author|sender|kind)$/i.test(key)) {
        if (typeof child === 'string' && badSource.test(child)) return false;
      }
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

function content(event: Record<string, unknown>): unknown {
  const payload = record(event.payload) ? event.payload : record(event.data) ? event.data : event;
  const message = record(payload.message) ? payload.message : payload;
  return message.content;
}

function userText(event: Record<string, unknown>): string {
  if (!eligible(event)) return '';
  const blocks = content(event);
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  let remaining = 4096;
  for (const block of blocks.slice(0, 32)) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string' ||
      Object.keys(block).some(key => !['type', 'text'].includes(key))) continue;
    const piece = boundUtf8(block.text, remaining).trim();
    if (piece) { parts.push(piece); remaining -= Buffer.byteLength(piece) + 1; }
    if (remaining <= 0) break;
  }
  return parts.join('\n').trim();
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
    const sessions = arrayField(listed, 'sessions');
    if (!sessions) throw new V2exError('history_access_denied');
    const selected = sessions.slice(0, 1000).filter(record).filter(item => typeof item.id === 'string' && item.id.length <= 256)
      .sort((a, b) => timeValue(b.updatedAt ?? b.createdAt) - timeValue(a.updatedAt ?? a.createdAt) ||
        String(a.id).localeCompare(String(b.id))).slice(0, bounds.maxSessions);
    const lines: string[] = [];
    const seen = new Set<string>();
    let remaining = bounds.maxBytes;
    for (const session of selected) {
      if (signal?.aborted) throw new V2exError('timeout');
      let found: unknown;
      try { found = await query.filterEvents(session.id as string, [{ kind: 'type', values: ['user/message'] }]); }
      catch { throw new V2exError(signal?.aborted ? 'timeout' : 'history_access_denied'); }
      const events = arrayField(found, 'events');
      if (!events) throw new V2exError('history_access_denied');
      const ordered = events.slice(0, 1000).filter(record).sort((a, b) =>
        timeValue(b.timestamp ?? b.createdAt) - timeValue(a.timestamp ?? a.createdAt) ||
        String(a.id ?? '').localeCompare(String(b.id ?? '')));
      for (const event of ordered) {
        if (signal?.aborted) throw new V2exError('timeout');
        const text = boundUtf8(userText(event), Math.min(4096, remaining));
        if (!text || seen.has(text)) continue;
        seen.add(text); lines.push(text);
        remaining -= Buffer.byteLength(text);
        if (remaining < 2) return lines.join('\n');
        remaining--;
      }
    }
    return lines.join('\n');
  }
}
