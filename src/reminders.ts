import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Recommendation } from './contract.js';
import type { ReminderSink } from './refresh.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { readonly kind: 'plugin'; readonly plugin: string; readonly form: 'notice' };
  }
}

const credentialShape = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|(?:bearer|token)\s*[=: ]\s*[A-Za-z0-9_-]{8,})/i;

interface AgentLike {
  readonly status?: unknown;
  readonly root?: unknown;
  readonly parentAgent?: unknown;
  readonly session?: { readonly header?: { readonly origin?: unknown } };
  followup?: (message: unknown) => unknown;
}

function rootAgent(value: unknown): value is AgentLike {
  if (!value || typeof value !== 'object') return false;
  try {
    const agent = value as AgentLike;
    return agent.root !== false && agent.parentAgent === undefined && agent.session?.header?.origin !== 'subagent' &&
      typeof agent.followup === 'function';
  } catch { return false; }
}

function safe(value: string, fallback: string, limit: number): string {
  if (credentialShape.test(value) || /(?:provider|model|api|private)\s+(?:error|failure|exception)/i.test(value)) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) || fallback;
}

export class DshReminderSink implements ReminderSink {
  private latest?: AgentLike;
  private pending: Recommendation[] = [];

  observe(agent: unknown, status: unknown): void {
    if (!rootAgent(agent)) return;
    if (status === 'running') { this.latest = agent; return; }
    if (status === 'idle' && agent === this.latest && this.pending.length) void this.deliver(agent, this.takePending());
  }

  bind(host: { on?: (name: string, listener: (this: unknown, payload: unknown) => void) => (() => unknown) | unknown }): () => void {
    if (typeof host.on !== 'function') return () => {};
    const sink = this;
    try {
      const dispose = host.on('agent/status', function (this: unknown, payload: unknown) {
        const status = payload && typeof payload === 'object' ? (payload as { status?: unknown }).status : undefined;
        sink.observe(this, status);
      });
      return typeof dispose === 'function' ? () => {
        sink.pending = []; sink.latest = undefined;
        try { dispose(); } catch { /* Host already disposed it. */ }
      } : () => { sink.pending = []; sink.latest = undefined; };
    } catch { return () => {}; }
  }

  async notify(items: readonly Recommendation[]): Promise<void> {
    const agent = this.latest;
    if (!agent || !rootAgent(agent)) return;
    let status: unknown;
    try { status = agent.status; } catch { return; }
    if (status !== 'idle') {
      const current = new Map(this.pending.map(item => [item.topic.id, item]));
      for (const item of items.slice(0, 10)) current.set(item.topic.id, item);
      this.pending = [...current.values()].slice(-10);
      return;
    }
    await this.deliver(agent, items);
  }

  private takePending(): Recommendation[] { const values = this.pending; this.pending = []; return values; }

  private async deliver(agent: AgentLike, items: readonly Recommendation[]): Promise<void> {
    const rows = items.slice(0, 10).map(item => {
      const title = safe(item.topic.title, 'V2EX topic', 200);
      const node = safe(item.topic.node.name, 'unknown', 64);
      const reason = safe(item.reason, 'Relevant to your V2EX interests', 500);
      return `- ${title} [${node}]\n  ${reason}`;
    });
    if (!rows.length) return;
    const message = createUserMessage({
      content: [{ type: 'text' as const, text: `V2EX recommendations:\n${rows.join('\n')}`.slice(0, 4096) }],
      source: { kind: 'plugin' as const, plugin: 'v2ex', form: 'notice' },
    });
    try { await agent.followup!(message); } catch { /* Session reminders never expose host/provider failures. */ }
  }
}
