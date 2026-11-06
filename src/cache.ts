import type { Cached, ContentStore, RateLimitState } from './contract.js';
import { toPublicError, V2exError } from './errors.js';
import { assertCacheKey } from './store.js';

export class ContentCache {
  private readonly inflight = new Map<string, Promise<Cached<unknown>>>();
  constructor(private readonly store: ContentStore, private readonly clock: () => Date = () => new Date()) {}

  async read<T>(key: string): Promise<Cached<T> | undefined> {
    const record = await this.store.getCache(assertCacheKey(key));
    if (!record) return undefined;
    return { value: record.value as T, fetchedAt: record.fetchedAt,
      stale: this.clock().getTime() >= Date.parse(record.expiresAt), source: 'cache' };
  }

  async writeSuccess<T>(key: string, value: T, ttlMs: number): Promise<Cached<T>> {
    assertCacheKey(key);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new V2exError('invalid_request');
    const now = this.clock();
    const fetchedAt = now.toISOString();
    await this.store.putCache(key, { value, fetchedAt, expiresAt: new Date(now.getTime() + ttlMs).toISOString(), accessedAt: fetchedAt });
    return { value, fetchedAt, stale: false, source: 'network' };
  }

  refresh<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<Cached<T>> {
    assertCacheKey(key);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<Cached<T>>;
    const request = Promise.resolve().then(fetcher).then((value) => this.writeSuccess(key, value, ttlMs))
      .catch((error: unknown) => { throw error instanceof V2exError ? error : new V2exError('upstream'); });
    this.inflight.set(key, request);
    void request.finally(() => this.inflight.delete(key)).catch(() => {});
    return request;
  }

  async readOrRefresh<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<Cached<T>> {
    const cached = await this.read<T>(key);
    if (cached && !cached.stale) return cached;
    try { return await this.refresh(key, fetcher, ttlMs); }
    catch (error) {
      if (!cached) throw error;
      return { ...cached, stale: true, refreshError: toPublicError(error) };
    }
  }
}

type RateObservation = Omit<RateLimitState, 'resetAt'> & { resetAt: string | number | null };
export class RequestBudget {
  private limit: number | null = null;
  private available: number | null = null;
  private resetTime: number | null = null;
  private observedWindow: number | null = null;
  private readonly reserveForInteractive: number;
  constructor(options: { reserveForInteractive?: number } = {}) {
    this.reserveForInteractive = options.reserveForInteractive ?? 10;
  }
  get remaining(): number | null { return this.available; }

  update(rateLimit: RateObservation): void {
    const limit = rateLimit.limit !== null && Number.isSafeInteger(rateLimit.limit) && rateLimit.limit >= 0 ? rateLimit.limit : null;
    const remaining = rateLimit.remaining !== null && Number.isSafeInteger(rateLimit.remaining) && rateLimit.remaining >= 0 ? rateLimit.remaining : null;
    let reset: number | null = null;
    if (rateLimit.resetAt !== null) {
      const value = typeof rateLimit.resetAt === 'number'
        ? rateLimit.resetAt < 1e12 ? rateLimit.resetAt * 1000 : rateLimit.resetAt
        : Date.parse(rateLimit.resetAt);
      reset = Number.isFinite(value) ? value : null;
    }
    if (reset !== null && this.observedWindow !== null && reset < this.observedWindow) return;
    const newWindow = reset !== null && (this.observedWindow === null || reset > this.observedWindow);
    if (limit !== null) this.limit = limit;
    if (newWindow) {
      this.observedWindow = reset;
      this.resetTime = reset;
      this.available = remaining;
    } else if (remaining !== null) {
      this.available = this.available === null ? remaining : Math.min(this.available, remaining);
    }
  }

  canRunBackground(now: Date | number = new Date()): boolean {
    const time = typeof now === 'number' ? now : now.getTime();
    if (this.resetTime !== null && time >= this.resetTime && this.limit !== null) {
      this.available = this.limit;
      this.resetTime = null;
    }
    return this.available !== null && this.available > this.reserveForInteractive;
  }

  reserve(kind: 'interactive' | 'background'): boolean {
    if (kind === 'background' && !this.canRunBackground()) return false;
    if (this.available === null) return kind === 'interactive';
    if (this.available <= 0) return false;
    this.available--;
    return true;
  }
}
