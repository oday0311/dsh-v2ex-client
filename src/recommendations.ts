import { createHash } from 'node:crypto';
import type { ContentStore, InterestProfile, Recommendation, RecommendationList, TopicListItem } from './contract.js';
import { V2exError } from './errors.js';
import { RecommendationRankingSchema, type IntelligenceService } from './intelligence.js';

const MAX_INPUT_BYTES = 32 * 1024;
const MAX_CANDIDATES = 500;
const encoder = new TextEncoder();
const credentialShape = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|(?:bearer|token)\s*[=: ]\s*[A-Za-z0-9_-]{8,})/i;

export type RecommendationFeedback = 'interested' | 'not_interested';
export interface RecommendationRefresh extends RecommendationList { consideredTopicIds: number[] }

function updated(topic: TopicListItem): number {
  const value = Date.parse(topic.lastReplyAt ?? topic.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function order(a: Recommendation, b: Recommendation): number {
  return b.score - a.score || updated(b.topic) - updated(a.topic) || a.topic.id - b.topic.id;
}

function localScore(topic: TopicListItem, profile: InterestProfile): number {
  const title = topic.title.toLocaleLowerCase('en');
  let score = 0;
  for (const label of profile.labels) if (title.includes(label.name.toLocaleLowerCase('en'))) score += label.weight;
  for (const node of profile.preferredNodes) if (topic.node.name.toLocaleLowerCase('en') === node.name.toLocaleLowerCase('en')) score += node.weight;
  return score;
}

function boundedTopic(topic: TopicListItem) {
  return { id: topic.id, title: topic.title.slice(0, 500), node: topic.node.name.slice(0, 64),
    replyCount: topic.replyCount, updatedAt: (topic.lastReplyAt ?? topic.createdAt).slice(0, 40) };
}

export class RecommendationService {
  private readonly refreshEpoch = new Map<string, number>();
  constructor(private readonly store: Pick<ContentStore, 'getSettings' | 'getProfile' | 'getRecommendation' |
    'putRecommendation' | 'markRead' | 'setRecommendationFeedback' | 'listRecommendations'>,
  private readonly intelligence: Pick<IntelligenceService, 'rankRecommendationCandidates'>, private readonly account: () => Promise<string>,
  private readonly clock: () => Date = () => new Date(),
  private readonly feedbackSink?: { recordFeedback(topicId: number, interested: boolean): Promise<unknown> }) {}

  private async scope(): Promise<string> {
    let account: string;
    try { account = await this.account(); }
    catch (error) { throw error instanceof V2exError ? error : new V2exError('not_authenticated'); }
    if (typeof account !== 'string' || !account || account.length > 100 || /[\u0000-\u001f\u007f]/.test(account)) {
      throw new V2exError('not_authenticated');
    }
    return `${createHash('sha256').update(account.toLocaleLowerCase('en')).digest('hex')}:`;
  }

  async refreshCandidates(candidates: TopicListItem[], signal?: AbortSignal): Promise<RecommendationRefresh> {
    const scope = await this.scope();
    const epoch = (this.refreshEpoch.get(scope) ?? 0) + 1;
    this.refreshEpoch.set(scope, epoch);
    if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) throw new V2exError('invalid_request');
    if (signal?.aborted) throw new V2exError('timeout');
    let profile: InterestProfile | null;
    let settings;
    try { [profile, settings] = await Promise.all([this.store.getProfile(), this.store.getSettings()]); }
    catch { throw new V2exError('ai_unavailable'); }
    if (!profile) return { items: [], consideredTopicIds: [], generatedAt: null, stale: false, source: 'generated' };
    const excluded = profile.exclusions.map(value => value.toLocaleLowerCase('en'));
    let stored: Recommendation[];
    try { stored = await this.store.listRecommendations?.(scope) ?? []; }
    catch { throw new V2exError('ai_unavailable'); }
    const negative = new Set([...profile.feedback.filter(value => !value.interested).map(value => value.topicId),
      ...stored.filter(value => value.feedback === 'not_interested').map(value => value.topic.id)]);
    const deduped = new Map<number, TopicListItem>();
    for (const candidate of candidates) {
      if (!candidate || !Number.isSafeInteger(candidate.id) || candidate.id < 1 || typeof candidate.title !== 'string' ||
        candidate.title.length > 500 || typeof candidate.node?.name !== 'string' || candidate.node.name.length > 64) {
        throw new V2exError('invalid_request');
      }
      if (!deduped.has(candidate.id)) deduped.set(candidate.id, candidate);
    }
    const budget = Math.min(100, settings.aiCandidateBudget);
    const considered = [...deduped.values()].filter(candidate => {
      const haystack = `${candidate.title}\n${candidate.node.name}`.toLocaleLowerCase('en');
      return !negative.has(candidate.id) && !credentialShape.test(haystack) && !excluded.some(term => haystack.includes(term));
    }).sort((a, b) => localScore(b, profile!) - localScore(a, profile!) || updated(b) - updated(a) || a.id - b.id)
      .slice(0, budget);
    const data = { interests: profile.labels.filter(value => !credentialShape.test(value.name)).slice(0, 50),
      preferredNodes: profile.preferredNodes.filter(value => !credentialShape.test(value.name)).slice(0, 50),
      candidates: considered.map(boundedTopic) };
    let userData = JSON.stringify(data);
    while (encoder.encode(userData).byteLength > MAX_INPUT_BYTES - 1500 && data.candidates.length) {
      data.candidates.pop(); considered.pop(); userData = JSON.stringify(data);
    }
    const consideredTopicIds = considered.map(value => value.id);
    if (!considered.length || budget === 0) return { items: [], consideredTopicIds, generatedAt: null, stale: false, source: 'generated' };
    let raw;
    try { raw = await this.intelligence.rankRecommendationCandidates(data, signal); }
    catch (error) { throw error instanceof V2exError ? error : new V2exError('ai_unavailable'); }
    const parsed = RecommendationRankingSchema.safeParse(raw);
    if (!parsed.success) throw new V2exError('invalid_response');
    if (signal?.aborted || this.refreshEpoch.get(scope) !== epoch) throw new V2exError('timeout');
    const allowed = new Map(considered.map(value => [value.id, value]));
    const seen = new Set<number>();
    if (parsed.data.items.some(value => !allowed.has(value.topicId) || seen.has(value.topicId) || !seen.add(value.topicId) ||
      credentialShape.test(value.reason) || value.matchedInterests.some(interest => credentialShape.test(interest)))) {
      throw new V2exError('invalid_response');
    }
    const generatedAt = this.clock().toISOString();
    for (const ranked of parsed.data.items) {
      if (signal?.aborted || this.refreshEpoch.get(scope) !== epoch) throw new V2exError('timeout');
      const recommendation: Recommendation = { topic: allowed.get(ranked.topicId)!, score: ranked.score,
        reason: ranked.reason, matchedInterests: ranked.matchedInterests, generatedAt, read: false, feedback: null };
      try { await this.store.putRecommendation(`${scope}${ranked.topicId}`, recommendation); }
      catch { throw new V2exError('ai_unavailable'); }
    }
    const items = (await this.store.listRecommendations?.(scope) ?? []).filter(item => item.feedback !== 'not_interested').sort(order);
    return { items, consideredTopicIds, generatedAt, stale: false, source: 'generated' };
  }

  async list(): Promise<RecommendationList> {
    const scope = await this.scope();
    let items: Recommendation[];
    let interval: number;
    let profile: InterestProfile | null;
    try { [items, interval, profile] = await Promise.all([this.store.listRecommendations?.(scope) ?? [],
      this.store.getSettings().then(value => value.refreshIntervalMinutes), this.store.getProfile()]); }
    catch { throw new V2exError('ai_unavailable'); }
    const negative = new Set(profile?.feedback.filter(value => !value.interested).map(value => value.topicId) ?? []);
    items = items.filter(item => item.feedback !== 'not_interested' && !negative.has(item.topic.id)).sort(order);
    const generatedAt = items[0]?.generatedAt ?? null;
    const stale = generatedAt === null || this.clock().getTime() - Date.parse(generatedAt) > interval * 60_000;
    return { items, generatedAt, stale, source: 'stored' };
  }

  async feedback(input: { topicId: number; value: RecommendationFeedback }): Promise<void> {
    if (!Number.isSafeInteger(input?.topicId) || input.topicId < 1 ||
      (input.value !== 'interested' && input.value !== 'not_interested')) throw new V2exError('invalid_request');
    const scope = await this.scope();
    try {
      const key = `${scope}${input.topicId}`;
      if (!await this.store.getRecommendation(key)) throw new V2exError('not_found');
      await this.feedbackSink?.recordFeedback(input.topicId, input.value === 'interested');
      await this.store.setRecommendationFeedback(key, input.value);
    } catch (error) { throw error instanceof V2exError ? error : new V2exError('ai_unavailable'); }
  }

  async markRead(topicId: number): Promise<void> {
    if (!Number.isSafeInteger(topicId) || topicId < 1) throw new V2exError('invalid_request');
    const scope = await this.scope();
    try { await this.store.markRead(`${scope}${topicId}`); }
    catch { throw new V2exError('ai_unavailable'); }
  }
}
