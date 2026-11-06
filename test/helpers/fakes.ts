import type { CredentialVault } from '../../src/credentials.js';
import type { CacheRecord, ContentStore, InterestEditFlags, InterestProfile, PluginSettings, Recommendation, RecommendationBatch, TopicAiSummary } from '../../src/contract.js';

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
  readonly accountProfiles = new Map<string, { profile: InterestProfile; edits: InterestEditFlags }>();
  readonly summaries = new Map<string, TopicAiSummary>();
  settings: PluginSettings = {
    refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2,
    aiCandidateBudget: 10, notificationThreshold: 0.7, quietHours: null,
  };
  profile: InterestProfile | null = null;
  profileEdits: InterestEditFlags = { labels: false, preferredNodes: false, exclusions: false };

  async getCache(key: string) { return this.cache.get(key); }
  async putCache(key: string, value: CacheRecord) { this.cache.set(key, value); }
  async deleteCache(key: string) { this.cache.delete(key); }
  async getSettings() { return this.settings; }
  async putSettings(value: PluginSettings) { this.settings = value; }
  async getProfile(scope?: string) { return scope ? this.accountProfiles.get(scope)?.profile ?? null : this.profile; }
  async putProfile(value: InterestProfile, scope?: string) {
    if (scope) this.accountProfiles.set(scope, { profile: value, edits: this.accountProfiles.get(scope)?.edits ?? { labels: false, preferredNodes: false, exclusions: false } });
    else this.profile = value;
  }
  async getProfileEdits(scope?: string) { return { ...(scope ? this.accountProfiles.get(scope)?.edits ?? { labels: false, preferredNodes: false, exclusions: false } : this.profileEdits) }; }
  async putInterestState(profile: InterestProfile, edits: InterestEditFlags, scope?: string) {
    if (scope) this.accountProfiles.set(scope, { profile, edits: { ...edits } });
    else { this.profile = profile; this.profileEdits = { ...edits }; }
  }
  async clearProfile(scope?: string) {
    if (scope) this.accountProfiles.delete(scope);
    else { this.profile = null; this.profileEdits = { labels: false, preferredNodes: false, exclusions: false }; }
  }
  async getRecommendation(key: string) { return this.recommendations.get(key); }
  async putRecommendation(key: string, value: Recommendation) {
    const previous = this.recommendations.get(key);
    this.recommendations.set(key, previous ? { ...value, read: previous.read || value.read,
      feedback: previous.feedback ?? value.feedback } : value);
  }
  async markRead(key: string) {
    const value = this.recommendations.get(key);
    if (value) this.recommendations.set(key, { ...value, read: true });
  }
  async setRecommendationFeedback(key: string, feedback: Recommendation['feedback']) {
    const value = this.recommendations.get(key);
    if (!value) throw new Error('not found');
    this.recommendations.set(key, { ...value, feedback });
  }
  async deleteRecommendation(key: string) { this.recommendations.delete(key); }
  async getRecommendationBatch(scope: string) { return this.recommendationBatches.get(scope) ?? null; }
  async putRecommendationBatch(scope: string, batch: RecommendationBatch) { this.recommendationBatches.set(scope, batch); }
  async clearRecommendations(scope: string) {
    for (const key of this.recommendations.keys()) if (key.startsWith(scope)) this.recommendations.delete(key);
    this.recommendationBatches.delete(scope);
  }
  async clearLegacyRecommendations() {
    for (const key of this.recommendations.keys()) if (/^[1-9]\d*$/.test(key)) this.recommendations.delete(key);
  }
  async getSummary(key: string) { return this.summaries.get(key); }
  async putSummary(key: string, value: TopicAiSummary) { this.summaries.set(key, value); }
  async listRecommendations(scope?: string) { return [...this.recommendations.entries()]
    .filter(([key]) => scope === undefined || key.startsWith(scope)).map(([, value]) => value); }
}
