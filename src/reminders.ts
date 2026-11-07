import { randomUUID } from 'node:crypto';
import { createUserMessage, freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { PendingReminderNotice, Recommendation } from './contract.js';
import type { ReminderSink } from './refresh.js';
import { isUnsafeReminder, normalizeReminderText, reminderText } from './reminder-safety.js';
import { V2exError } from './errors.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { readonly kind: 'plugin'; readonly plugin: string; readonly form: 'notice' };
  }
}

interface AgentLike {
  readonly status?: unknown;
  readonly root?: unknown;
  readonly parentAgent?: unknown;
  readonly session?: { readonly header?: { readonly origin?: unknown } };
  followup?: (message: unknown) => unknown;
}

interface AgentEvent { agent?: unknown; status?: unknown }

function rootAgent(value: unknown): value is AgentLike {
  if (!value || typeof value !== 'object') return false;
  try {
    const agent = value as AgentLike;
    return agent.root !== false && agent.parentAgent === undefined && agent.session?.header?.origin !== 'subagent' &&
      typeof agent.followup === 'function';
  } catch { return false; }
}

export function createReminderNotice(item: Recommendation): PendingReminderNotice {
  const fallback = { title: 'V2EX topic', node: 'unknown', reason: 'Relevant to your V2EX interests' };
  let fields = { title: normalizeReminderText(item.topic.title, 200) || fallback.title,
    node: normalizeReminderText(item.topic.node.name, 64) || fallback.node,
    reason: normalizeReminderText(item.reason, 500) || fallback.reason };
  if (isUnsafeReminder(fields)) fields = fallback;
  if (isUnsafeReminder(fields)) fields = { title: 'Topic', node: 'general', reason: 'Relevant' };
  return { noticeId: randomUUID(), topicId: item.topic.id, ...fields, createdAt: item.generatedAt };
}

export class DshReminderSink implements ReminderSink {
  private latest?: { agent: AgentLike; controller: AbortController; generation: number };
  private targetGeneration = 0;
  private readonly disposedAgents = new WeakSet<object>();
  private idleHandler?: () => Promise<void>;
  private unbound = false;

  onIdle(handler: () => Promise<void>): () => void {
    this.idleHandler = handler; let active = true;
    return () => { if (active && this.idleHandler === handler) this.idleHandler = undefined; active = false; };
  }

  bind(host: { on?: (name: string, listener: (payload: unknown) => void) => (() => unknown) | unknown }): () => void {
    if (typeof host.on !== 'function') return () => {};
    const disposers: Array<() => unknown> = [];
    try {
      const status = host.on('agent/status', payload => this.statusEvent(payload));
      if (typeof status === 'function') disposers.push(status as () => unknown);
      const disposed = host.on('agent/disposed', payload => this.disposedEvent(payload));
      if (typeof disposed === 'function') disposers.push(disposed as () => unknown);
    } catch { for (const dispose of disposers.reverse()) try { dispose(); } catch {} return () => {}; }
    let active = true;
    return () => {
      if (!active) return; active = false; this.unbound = true; this.latest?.controller.abort();
      this.latest = undefined; this.idleHandler = undefined;
      for (const dispose of disposers.reverse()) try { dispose(); } catch { /* Host already disposed it. */ }
    };
  }

  private statusEvent(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as AgentEvent; const agent = event.agent;
    if (!rootAgent(agent) || this.disposedAgents.has(agent as object)) return;
    if (event.status === 'running') {
      if (this.latest?.agent !== agent) {
        this.latest?.controller.abort();
        this.latest = { agent, controller: new AbortController(), generation: ++this.targetGeneration };
      }
      return;
    }
    if (event.status === 'idle' && agent === this.latest?.agent && this.idleHandler) void this.idleHandler().catch(() => {});
  }

  private disposedEvent(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const agent = (payload as AgentEvent).agent;
    if (!agent || typeof agent !== 'object') return;
    this.disposedAgents.add(agent);
    if (agent === this.latest?.agent) { this.latest.controller.abort(); this.latest = undefined; }
  }

  async notify(items: readonly PendingReminderNotice[], signal?: AbortSignal): Promise<string[]> {
    const target = this.latest; const agent = target?.agent;
    if (this.unbound || !target || !agent || !rootAgent(agent) || this.disposedAgents.has(agent as object)) return [];
    let status: unknown;
    try { status = agent.status; } catch { return []; }
    if (status !== 'idle') return [];
    const linked = linkSignals(signal, target.controller.signal);
    const delivered: string[] = [];
    try { for (const notice of items.slice(0, 20)) {
      if (linked.signal.aborted || target !== this.latest || agent !== this.latest?.agent ||
        this.disposedAgents.has(agent as object)) break;
      if (isUnsafeReminder(notice)) continue;
      const text = reminderText(notice);
      if (linked.signal.aborted || target !== this.latest || this.disposedAgents.has(agent as object)) break;
      const generated = createUserMessage({ content: [{ type: 'text' as const, text }],
        source: { kind: 'plugin' as const, plugin: 'v2ex', form: 'notice' } });
      const message = freezeMessage({ ...generated, id: notice.noticeId } as unknown as UserMessage);
      try {
        if (linked.signal.aborted || target !== this.latest || this.disposedAgents.has(agent as object)) break;
        await abortAgentWork(() => agent.followup!(message), linked.signal);
        if (linked.signal.aborted || target !== this.latest || agent !== this.latest?.agent ||
          this.disposedAgents.has(agent as object)) break;
        delivered.push(notice.noticeId);
      }
      catch { break; }
    } return delivered; } finally { linked.release(); }
  }
}

function linkSignals(caller: AbortSignal | undefined, target: AbortSignal): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController(); const signals = caller ? [caller, target] : [target];
  const abort = () => controller.abort();
  for (const value of signals) {
    if (value.aborted) controller.abort(); else value.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, release: () => {
    for (const value of signals) value.removeEventListener('abort', abort);
  } };
}

function abortAgentWork(work: () => unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new V2exError('timeout'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal.removeEventListener('abort', abort); };
    const succeed = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(new V2exError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new V2exError('timeout');
      return work();
    }).then(succeed, fail);
  });
}
