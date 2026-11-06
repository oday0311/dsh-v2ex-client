import type { CredentialVault } from '../../src/credentials.js';
import type { CacheRecord, ContentStore, InterestProfile, PluginSettings, Recommendation, TopicAiSummary } from '../../src/contract.js';

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
  readonly summaries = new Map<string, TopicAiSummary>();
  settings: PluginSettings = {
    refreshIntervalMinutes: 30, scannedNodes: [], pagesPerNode: 2,
    aiCandidateBudget: 10, notificationThreshold: 0.7, quietHours: null,
  };
  profile: InterestProfile | null = null;

  async getCache(key: string) { return this.cache.get(key); }
  async putCache(key: string, value: CacheRecord) { this.cache.set(key, value); }
  async deleteCache(key: string) { this.cache.delete(key); }
  async getSettings() { return this.settings; }
  async putSettings(value: PluginSettings) { this.settings = value; }
  async getProfile() { return this.profile; }
  async putProfile(value: InterestProfile) { this.profile = value; }
  async clearProfile() { this.profile = null; }
  async getRecommendation(key: string) { return this.recommendations.get(key); }
  async putRecommendation(key: string, value: Recommendation) { this.recommendations.set(key, value); }
  async markRead(key: string) {
    const value = this.recommendations.get(key);
    if (value) this.recommendations.set(key, { ...value, read: true });
  }
  async getSummary(key: string) { return this.summaries.get(key); }
  async putSummary(key: string, value: TopicAiSummary) { this.summaries.set(key, value); }
  async listRecommendations() { return [...this.recommendations.values()]; }
}
