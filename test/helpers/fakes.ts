import type { CredentialVault } from '../../src/credentials.js';
import type { CacheRecord, ContentStore, InterestEditFlags, InterestProfile, PendingReminderNotice, PluginSettings, Recommendation, RecommendationBatch, RecommendationSnapshot, TopicAiSummary } from '../../src/contract.js';

export class FakeCredentialVault implements CredentialVault {
  value: string | undefined;
  writable = true;
  setCalls: string[] = [];
  clearCount = 0;

  async resolve() { return this.value; }
  async set(value: string) { this.value = value; this.setCalls.push(value); }
  async clear() { this.value = undefined; this.clearCount++; }
  async describe() { return { configured: this.value !== undefined, writable: this.writable }; }
}

export function recordingFetch(response: Response | ((url: URL) => Response)): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return typeof response === 'function' ? response(new URL(url)) : response.clone();
    },
  };
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

export class FakeContentStore implements ContentStore {
  readonly cache = new Map<string, CacheRecord>();
  readonly recommendations = new Map<string, Recommendation>();
  readonly recommendationBatches = new Map<string, RecommendationBatch>();
  readonly migratedRecommendationScopes = new Set<string>();
  readonly accountProfiles = new Map<string, { profile: InterestProfile; edits: InterestEditFlags }>();
  readonly summaries = new Map<string, TopicAiSummary>();
  readonly accountSettings = new Map<string, PluginSettings>();
  readonly notificationStates = new Map<string, { sent: Set<number>; pending: PendingReminderNotice[] }>();
  beforeNotificationSent?: () => Promise<void>;
  beforeSettingsRead?: () => Promise<void>;
  beforePendingRead?: () => Promise<void>;
  beforeRecommendationSnapshot?: () => Promise<void>;
  beforeRecommendationPublish?: () => Promise<void>;
  beforeProfileRead?: () => Promise<void>;
  beforeInterestPut?: () => Promise<void>;
  beforeMarkRead?: () => Promise<void>;
  beforeSetFeedback?: () => Promise<void>;
  failNextRecommendationPublish = false;
  private recommendationOperation: Promise<void> = Promise.resolve();
  settings: PluginSettings = {
    refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2,
    aiCandidateBudget: 10, notificationThreshold: 0.7, quietHours: null,
  };
  profile: InterestProfile | null = null;
  profileEdits: InterestEditFlags = { labels: false, preferredNodes: false, exclusions: false };

  async getCache(key: string) { return this.cache.get(key); }
  async putCache(key: string, value: CacheRecord) { this.cache.set(key, value); }
  async deleteCache(key: string) { this.cache.delete(key); }
  async getSettings(scope?: string) { const value = scope ? this.accountSettings.get(scope) ?? this.settings : this.settings;
    await this.beforeSettingsRead?.(); return value; }
  async putSettings(value: PluginSettings, scope?: string) { if (scope) this.accountSettings.set(scope, value); else this.settings = value; }
  async enqueuePendingNotifications(scope: string, notices: PendingReminderNotice[]) {
    const state = this.notificationStates.get(scope) ?? { sent: new Set<number>(), pending: [] };
    const topics = new Set(state.pending.map(value => value.topicId)); const accepted: PendingReminderNotice[] = [];
    for (const notice of notices) if (state.pending.length < 20 && !state.sent.has(notice.topicId) && !topics.has(notice.topicId)) {
      state.pending.push(structuredClone(notice)); accepted.push(structuredClone(notice)); topics.add(notice.topicId);
    }
    this.notificationStates.set(scope, state); return accepted;
  }
  async getPendingNotifications(scope: string) { const value = structuredClone(this.notificationStates.get(scope)?.pending ?? []);
    await this.beforePendingRead?.(); return value; }
  async markNotificationSent(scope: string, expected: PendingReminderNotice) { await this.beforeNotificationSent?.();
    const state = this.notificationStates.get(scope); const notice = state?.pending.find(value =>
      value.noticeId === expected.noticeId && value.topicId === expected.topicId && value.title === expected.title &&
      value.node === expected.node && value.reason === expected.reason && value.createdAt === expected.createdAt);
    if (state && notice) { state.sent.add(notice.topicId);
      state.pending = state.pending.filter(value => value.noticeId !== expected.noticeId); } }
  async clearRefreshState(scope: string) { this.accountSettings.delete(scope); this.notificationStates.delete(scope); }
  async getProfile(scope?: string) { await this.beforeProfileRead?.(); return scope ? this.accountProfiles.get(scope)?.profile ?? null : this.profile; }
  async putProfile(value: InterestProfile, scope?: string) {
    if (scope) this.accountProfiles.set(scope, { profile: value, edits: this.accountProfiles.get(scope)?.edits ?? { labels: false, preferredNodes: false, exclusions: false } });
    else this.profile = value;
  }
  async getProfileEdits(scope?: string) { return { ...(scope ? this.accountProfiles.get(scope)?.edits ?? { labels: false, preferredNodes: false, exclusions: false } : this.profileEdits) }; }
  async putInterestState(profile: InterestProfile, edits: InterestEditFlags, scope?: string) {
    await this.beforeInterestPut?.();
    if (scope) this.accountProfiles.set(scope, { profile, edits: { ...edits } });
    else { this.profile = profile; this.profileEdits = { ...edits }; }
  }
  async clearProfile(scope?: string) {
    if (scope) this.accountProfiles.delete(scope);
    else { this.profile = null; this.profileEdits = { labels: false, preferredNodes: false, exclusions: false }; }
  }
  async getRecommendation(key: string) {
    const scope = /^[0-9a-f]{64}:/.exec(key)?.[0];
    if (scope && this.migratedRecommendationScopes.has(scope)) {
      const batch = this.recommendationBatches.get(scope);
      return batch?.topicIds.includes(Number(key.slice(scope.length))) ? this.recommendations.get(key) : undefined;
    }
    return this.recommendations.get(key);
  }
  async putRecommendation(key: string, value: Recommendation) {
    const previous = this.recommendations.get(key);
    this.recommendations.set(key, previous ? { ...value, read: previous.read || value.read,
      feedback: previous.feedback ?? value.feedback } : value);
  }
  async markRead(key: string) {
    await this.beforeMarkRead?.();
    const scope = /^[0-9a-f]{64}:/.exec(key)?.[0];
    if (scope && this.migratedRecommendationScopes.has(scope) && !this.recommendationBatches.get(scope)?.topicIds.includes(Number(key.slice(scope.length)))) return;
    const value = this.recommendations.get(key);
    if (value) this.recommendations.set(key, { ...value, read: true });
  }
  async setRecommendationFeedback(key: string, feedback: Recommendation['feedback']) {
    await this.beforeSetFeedback?.();
    const scope = /^[0-9a-f]{64}:/.exec(key)?.[0];
    if (scope && this.migratedRecommendationScopes.has(scope) && !this.recommendationBatches.get(scope)?.topicIds.includes(Number(key.slice(scope.length)))) throw new Error('not found');
    const value = this.recommendations.get(key);
    if (!value) throw new Error('not found');
    this.recommendations.set(key, { ...value, feedback });
  }
  async deleteRecommendation(key: string) { this.recommendations.delete(key); }
  async getRecommendationBatch(scope: string) { return this.recommendationBatches.get(scope) ?? null; }
  async putRecommendationBatch(scope: string, batch: RecommendationBatch) { this.recommendationBatches.set(scope, batch); }
  async getRecommendationSnapshot(scope: string): Promise<RecommendationSnapshot | null> {
    await this.beforeRecommendationSnapshot?.();
    const batch = this.recommendationBatches.get(scope);
    if (!batch) return null;
    return { batch: structuredClone(batch), items: structuredClone([...this.recommendations.entries()]
      .filter(([key]) => key.startsWith(scope) && batch.topicIds.includes(Number(key.slice(scope.length))))
      .map(([, value]) => value)) };
  }
  async replaceRecommendationBatch(scope: string, batch: RecommendationBatch, items: Recommendation[]): Promise<RecommendationSnapshot> {
    let result!: RecommendationSnapshot;
    const operation = this.recommendationOperation.then(async () => {
      await this.beforeRecommendationPublish?.();
      if (this.failNextRecommendationPublish) { this.failNextRecommendationPublish = false; throw new Error('publish failed'); }
      const previous = new Map([...this.recommendations.entries()].filter(([key]) => key.startsWith(scope)));
      const next = items.map(item => { const old = previous.get(`${scope}${item.topic.id}`); return old ?
        { ...item, read: old.read || item.read, feedback: old.feedback ?? item.feedback } : item; });
      for (const key of previous.keys()) this.recommendations.delete(key);
      for (const item of next) this.recommendations.set(`${scope}${item.topic.id}`, structuredClone(item));
      this.recommendationBatches.set(scope, structuredClone(batch));
      this.migratedRecommendationScopes.add(scope);
      result = { batch: structuredClone(batch), items: structuredClone(next) };
    });
    this.recommendationOperation = operation.then(() => {}, () => {});
    await operation; return result;
  }
  async discardRecommendationBatch(scope: string, generation: number) {
    const batch = this.recommendationBatches.get(scope);
    if (batch?.generation === generation) await this.clearRecommendations(scope);
  }
  async clearRecommendations(scope: string) {
    const operation = this.recommendationOperation.then(() => {
      for (const key of this.recommendations.keys()) if (key.startsWith(scope)) this.recommendations.delete(key);
      this.recommendationBatches.delete(scope);
    });
    this.recommendationOperation = operation.then(() => {}, () => {}); await operation;
  }
  async clearLegacyRecommendations() {
    for (const key of this.recommendations.keys()) if (/^[1-9]\d*$/.test(key)) this.recommendations.delete(key);
  }
  async getSummary(key: string) { return this.summaries.get(key); }
  async putSummary(key: string, value: TopicAiSummary) { this.summaries.set(key, value); }
  async listRecommendations(scope?: string) { if (scope && this.migratedRecommendationScopes.has(scope) && !this.recommendationBatches.has(scope)) return [];
    return [...this.recommendations.entries()]
    .filter(([key]) => scope === undefined || key.startsWith(scope)).map(([, value]) => value); }
}
