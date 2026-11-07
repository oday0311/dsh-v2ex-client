import type { ContentStore, InterestProfile, PendingReminderNotice, PluginSettings, TopicListItem, TopicPage } from './contract.js';
import type { ContentService } from './content-service.js';
import type { IdentityLease, IdentityLeaseProvider } from './credentials.js';
import type { RecommendationRefresh, RecommendationService } from './recommendations.js';
import type { RequestBudget } from './cache.js';
import { V2exError } from './errors.js';
import { accountScope } from './account-scope.js';
import { createReminderNotice } from './reminders.js';

const MAX_NODES = 20;
const MAX_NODE_PAGES = 2;
const MAX_CANDIDATES = 500;

export interface RefreshClock {
  now(): Date;
  every(ms: number, task: () => void): () => void;
}

export interface ReminderSink {
  notify(items: readonly PendingReminderNotice[], signal?: AbortSignal): Promise<string[]>;
}

type RefreshStore = Pick<ContentStore, 'getSettings' | 'getProfile' | 'enqueuePendingNotifications' |
  'getPendingNotifications' | 'markNotificationSent' | 'clearRefreshState'>;
type RefreshContent = Pick<ContentService, 'latest' | 'nodeTopics'>;
type RefreshRecommendations = Pick<RecommendationService, 'refreshCandidates'>;

export interface RefreshServiceOptions {
  store: RefreshStore;
  content: RefreshContent;
  recommendations: RefreshRecommendations;
  budget: RequestBudget;
  identity: IdentityLeaseProvider;
  reminders: ReminderSink;
  clock?: RefreshClock;
}

type DeliveryMode = 'cached' | 'normal';
interface PreparedDelivery {
  mode: DeliveryMode;
  lease: IdentityLease;
  pending: PendingReminderNotice[];
  key: string;
  epoch: number;
}

const systemClock: RefreshClock = {
  now: () => new Date(),
  every(ms, task) { const timer = setInterval(task, ms); return () => clearInterval(timer); },
};

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

export function isQuietTime(now: Date, quiet: NonNullable<PluginSettings['quietHours']>): boolean {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: quiet.timeZone, hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23' }).formatToParts(now); } catch { return false; }
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const current = hour * 60 + minute; const start = minuteOfDay(quiet.start); const end = minuteOfDay(quiet.end);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function abortAware<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new V2exError('timeout'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (callback: (value: never) => void, value: unknown) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort); callback(value as never);
    };
    const abort = () => done(reject, new V2exError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(value => done(resolve as (value: never) => void, value), error => done(reject, error));
  });
}

function deliveryKey(mode: DeliveryMode, lease: IdentityLease): string {
  return `${mode}:${lease.account}:${lease.scope}:${lease.credentialFingerprint}:${lease.generation}`;
}

function linkAbortSignals(primary: AbortSignal, identity?: AbortSignal): {
  signal: AbortSignal; release: () => void;
} {
  const controller = new AbortController(); const signals = identity ? [primary, identity] : [primary];
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, release: () => {
    for (const signal of signals) signal.removeEventListener('abort', abort);
  } };
}

function nodeNames(settings: PluginSettings, profile: InterestProfile | null): string[] {
  const values = [...settings.scannedNodes, ...(profile?.preferredNodes.map(value => value.name) ?? [])];
  return [...new Set(values)].slice(0, MAX_NODES);
}

export class RefreshService {
  private readonly clock: RefreshClock;
  private active?: { promise: Promise<void>; controller: AbortController };
  private delivery?: { key: string; account: string; promise: Promise<void>; controller: AbortController; rerun?: Promise<void> };
  private readonly deliveryEpochs = new Map<string, number>();
  private stopTimer?: () => void;
  private timerMinutes?: number;
  private disposing?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: RefreshServiceOptions) { this.clock = options.clock ?? systemClock; }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new V2exError('timeout'));
    this.schedule(30);
    return Promise.resolve();
  }

  private schedule(minutes: number): void {
    const interval = Math.max(1, Math.min(1440, minutes));
    if (this.disposed || this.timerMinutes === interval) return;
    this.stopTimer?.(); this.timerMinutes = interval;
    this.stopTimer = this.clock.every(interval * 60_000, () => {
      void this.runNow('timer').catch(() => {});
    });
  }

  runNow(_reason: 'timer' | 'manual'): Promise<void> {
    if (this.disposed) return Promise.reject(new V2exError('timeout'));
    if (this.active) return this.active.promise;
    const controller = new AbortController();
    const active = { controller, promise: Promise.resolve() as Promise<void> };
    active.promise = this.run(controller.signal)
      .finally(() => { if (this.active === active) this.active = undefined; });
    this.active = active;
    return active.promise;
  }

  private async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new V2exError('timeout');
    await this.drainCachedPending();
    if (signal.aborted) throw new V2exError('timeout');
    if (!this.options.budget.canRunBackground(this.clock.now())) return;
    const loaded = await this.options.identity.withRead(async lease => {
      const [settings, profile] = await Promise.all([this.options.store.getSettings(lease.scope), this.options.store.getProfile(lease.scope)]);
      return { lease, settings, profile };
    });
    const { lease, settings, profile } = loaded; this.schedule(settings.refreshIntervalMinutes);
    if (signal.aborted) throw new V2exError('timeout');
    await this.drainPending(lease);
    if (signal.aborted) throw new V2exError('timeout');
    if (!this.options.budget.canRunBackground(this.clock.now()) || settings.maxModelCallsPerRefresh < 1) return;

    const candidates = new Map<number, TopicListItem>();
    const append = (page: TopicPage) => {
      for (const item of page.items) {
        if (candidates.size >= MAX_CANDIDATES) break;
        if (!candidates.has(item.id)) candidates.set(item.id, item);
      }
    };
    const latest = await abortAware(() => this.options.content.latest({ page: 1 }, signal, 'background'), signal);
    append(latest.value);
    const pages = Math.min(MAX_NODE_PAGES, settings.pagesPerNode);
    outer: for (const node of nodeNames(settings, profile)) {
      for (let page = 1; page <= pages; page++) {
        if (signal.aborted || candidates.size >= MAX_CANDIDATES || !this.options.budget.canRunBackground(this.clock.now())) break outer;
        try {
          const result = await abortAware(() => this.options.content.nodeTopics({ node, page }, signal, 'background'), signal);
          append(result.value);
        } catch (error) {
          if (error instanceof V2exError && error.code === 'budget_exhausted') break outer;
          if (error instanceof V2exError && (error.code === 'timeout' || error.code === 'not_authenticated')) throw error;
          break;
        }
      }
    }
    if (!this.options.budget.canRunBackground(this.clock.now())) return;
    const ranked: RecommendationRefresh = await abortAware(() =>
      this.options.recommendations.refreshCandidates([...candidates.values()], signal, lease), signal);
    if (signal.aborted || !ranked.items.length || (settings.quietHours && isQuietTime(this.clock.now(), settings.quietHours))) return;
    const eligible = ranked.items.filter(item => !item.read && item.feedback !== 'not_interested' && item.score >= settings.notificationThreshold)
      .slice(0, 20).map(createReminderNotice);
    if (!eligible.length) return;
    await this.options.identity.withMutation(async current => {
      if (signal.aborted) throw new V2exError('timeout');
      await this.options.store.enqueuePendingNotifications(current.scope, eligible);
    }, lease);
    await this.drainPending(lease);
  }

  drainPending(expectedLease?: IdentityLease): Promise<void> {
    return this.attemptDelivery('normal', expectedLease);
  }

  private drainCachedPending(): Promise<void> {
    if (!this.options.identity.withCachedMutation) return Promise.resolve();
    return this.attemptDelivery('cached');
  }

  private deliveryEpoch(account: string): number { return this.deliveryEpochs.get(account) ?? 0; }

  private invalidateDelivery(account: string): void {
    this.deliveryEpochs.set(account, this.deliveryEpoch(account) + 1);
    if (this.delivery?.account === account) this.delivery.controller.abort();
  }

  private async attemptDelivery(mode: DeliveryMode, expectedLease?: IdentityLease, afterJoin = false): Promise<void> {
    if (this.disposed) return Promise.reject(new V2exError('timeout'));
    const prepared = await this.prepareDelivery(mode, expectedLease);
    if (!prepared) return;
    const current = this.delivery;
    if (current) {
      if (current.key === prepared.key) {
        if (afterJoin) return current.promise;
        return current.rerun ??= current.promise.catch(() => {})
          .then(() => this.attemptDelivery(mode, prepared.lease, true));
      }
      await current.promise.catch(() => {});
      return this.attemptDelivery(mode, prepared.lease, true);
    }
    if (this.disposed || prepared.lease.signal?.aborted || this.deliveryEpoch(prepared.lease.account) !== prepared.epoch) {
      throw new V2exError('timeout');
    }
    const controller = new AbortController();
    const linked = linkAbortSignals(controller.signal, prepared.lease.signal);
    const delivery = { key: prepared.key, account: prepared.lease.account, controller,
      promise: Promise.resolve() as Promise<void>, rerun: undefined as Promise<void> | undefined };
    delivery.promise = this.deliverPrepared(prepared, linked.signal)
      .finally(linked.release)
      .finally(() => { if (this.delivery === delivery) this.delivery = undefined; });
    this.delivery = delivery;
    return delivery.promise;
  }

  handleReminderIdle(): Promise<void> { return this.drainPending(); }

  private async prepareDelivery(mode: DeliveryMode, expectedLease?: IdentityLease): Promise<PreparedDelivery | undefined> {
    const prepare = async (lease: IdentityLease): Promise<PreparedDelivery | undefined> => {
      if (this.disposed || lease.signal?.aborted) throw new V2exError('timeout');
      const epoch = this.deliveryEpoch(lease.account);
      const settings = await this.options.store.getSettings(lease.scope);
      if (this.disposed || lease.signal?.aborted || this.deliveryEpoch(lease.account) !== epoch) throw new V2exError('timeout');
      if (settings.quietHours && isQuietTime(this.clock.now(), settings.quietHours)) return;
      const pending = await this.options.store.getPendingNotifications(lease.scope);
      if (this.disposed || lease.signal?.aborted || this.deliveryEpoch(lease.account) !== epoch) throw new V2exError('timeout');
      if (!pending.length) return;
      return { mode, lease, pending: pending.slice(0, 20), key: deliveryKey(mode, lease), epoch };
    };
    if (mode === 'cached') return this.options.identity.withCachedMutation?.(prepare, expectedLease);
    return this.options.identity.withMutation(prepare, expectedLease);
  }

  private async deliverPrepared(prepared: PreparedDelivery, signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted || prepared.lease.signal?.aborted ||
      this.deliveryEpoch(prepared.lease.account) !== prepared.epoch) throw new V2exError('timeout');
    const delivered = new Set(await abortAware(() => this.options.reminders.notify(prepared.pending, signal), signal));
    if (signal.aborted) throw new V2exError('timeout');
    const finalize = async (lease: IdentityLease) => {
      if (signal.aborted) throw new V2exError('timeout');
      for (const notice of prepared.pending) {
        if (signal.aborted) throw new V2exError('timeout');
        if (delivered.has(notice.noticeId)) await this.options.store.markNotificationSent(lease.scope, notice);
      }
    };
    if (prepared.mode === 'cached') {
      await this.options.identity.withCachedMutation?.(finalize, prepared.lease); return;
    }
    await this.options.identity.withMutation(finalize, prepared.lease);
  }

  clear(account: string): Promise<void> {
    this.invalidateDelivery(account);
    this.active?.controller.abort();
    return this.options.store.clearRefreshState(accountScope(account));
  }

  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.disposed = true; this.stopTimer?.(); this.stopTimer = undefined;
      this.timerMinutes = undefined;
      this.active?.controller.abort();
      this.delivery?.controller.abort();
      try { await this.active?.promise; } catch { /* Cancellation is expected. */ }
      try { await this.delivery?.promise; } catch { /* Cancellation is expected. */ }
    })();
  }
}
