export type { PublicError, V2exErrorCode } from './errors.js';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: import('./errors.js').PublicError };

export interface AccountStatus {
  authenticated: boolean;
  writable: boolean;
  username: string | null;
  tokenScope: string | null;
  expiresAt: string | null;
}

export interface CredentialVault {
  resolve(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
  describe(): Promise<{ configured: boolean; writable: boolean }>;
}

export interface PluginSettings {
  refreshIntervalMinutes: number;
  scannedNodes: string[];
  pagesPerNode: number;
  aiCandidateBudget: number;
  notificationThreshold: number;
  quietHours: { start: string; end: string; timeZone: string } | null;
}

export interface TopicListItem {
  id: number;
  title: string;
  node: { name: string; title: string };
  author: { username: string };
  replyCount: number;
  createdAt: string;
  lastReplyAt: string | null;
  url: string;
}

export interface TopicPage {
  items: TopicListItem[];
  page: number;
  hasMore: boolean;
  stale: boolean;
}

export interface NodeInfo {
  name: string;
  title: string;
  topicCount: number | null;
  url: string;
}

export interface ReplyItem {
  id: number;
  author: { username: string };
  content: string;
  createdAt: string;
}

export interface TopicThread {
  topic: TopicListItem;
  content: string;
  replies: ReplyItem[];
  replyPage: number;
  hasMoreReplies: boolean;
  stale: boolean;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface TopicAiSummary {
  topicId: number;
  summary: string;
  viewpoints: string[];
  notableReplies: number[];
  generatedAt: string;
  coveredReplyPages: number[];
  completeDiscussion: boolean;
  coverage?: { loadedReplyPages: number; totalReplyPages: number; complete: boolean;
    includedReplies?: number; omittedReplies?: number; contentTruncated?: boolean };
  mode?: 'quick' | 'viewpoints' | 'full';
  modelRoute?: string;
  topicUpdatedAt?: string;
}

export interface InterestProfile {
  authorized: boolean;
  learningPaused: boolean;
  labels: Array<{ name: string; weight: number }>;
  preferredNodes: Array<{ name: string; weight: number }>;
  exclusions: string[];
  feedback: Array<{ topicId: number; interested: boolean }>;
  updatedAt: string;
  source: 'manual' | 'history' | 'mixed';
}

export interface InterestEditFlags { labels: boolean; preferredNodes: boolean; exclusions: boolean; legacyManual?: boolean }

export interface Recommendation {
  topic: TopicListItem;
  score: number;
  reason: string;
  matchedInterests: string[];
  generatedAt: string;
  read: boolean;
  feedback: 'interested' | 'not_interested' | null;
}

export interface RecommendationList {
  items: Recommendation[];
  generatedAt: string | null;
  stale: boolean;
  source: 'generated' | 'stored';
}
export interface RecommendationBatch { generatedAt: string; topicIds: number[]; generation?: number }
export interface RecommendationSnapshot { batch: RecommendationBatch; items: Recommendation[] }

export interface PendingReminderNotice {
  noticeId: string;
  topicId: number;
  title: string;
  node: string;
  reason: string;
  createdAt: string;
}

export interface CacheRecord<T = unknown> {
  value: T;
  fetchedAt: string;
  expiresAt: string;
  accessedAt: string;
}

export interface Cached<T> {
  value: T;
  fetchedAt: string;
  stale: boolean;
  source: 'network' | 'cache';
  refreshError?: import('./errors.js').PublicError;
}

export interface ContentStore {
  getCache(key: string): Promise<CacheRecord | undefined>;
  putCache(key: string, record: CacheRecord): Promise<void>;
  deleteCache(key: string): Promise<void>;
  getSettings(scope?: string): Promise<PluginSettings>;
  putSettings(settings: PluginSettings, scope?: string): Promise<void>;
  enqueuePendingNotifications(scope: string, notices: PendingReminderNotice[]): Promise<PendingReminderNotice[]>;
  getPendingNotifications(scope: string): Promise<PendingReminderNotice[]>;
  markNotificationSent(scope: string, noticeId: string): Promise<void>;
  clearRefreshState(scope: string): Promise<void>;
  getProfile(scope?: string): Promise<InterestProfile | null>;
  putProfile(profile: InterestProfile, scope?: string): Promise<void>;
  clearProfile(scope?: string): Promise<void>;
  getProfileEdits(scope?: string): Promise<InterestEditFlags>;
  putInterestState(profile: InterestProfile, edits: InterestEditFlags, scope?: string): Promise<void>;
  getRecommendation(key: string): Promise<Recommendation | undefined>;
  putRecommendation(key: string, recommendation: Recommendation): Promise<void>;
  markRead(key: string): Promise<void>;
  setRecommendationFeedback(key: string, value: Recommendation['feedback']): Promise<void>;
  deleteRecommendation(key: string): Promise<void>;
  getRecommendationBatch(scope: string): Promise<RecommendationBatch | null>;
  putRecommendationBatch(scope: string, batch: RecommendationBatch): Promise<void>;
  getRecommendationSnapshot(scope: string): Promise<RecommendationSnapshot | null>;
  replaceRecommendationBatch(scope: string, batch: RecommendationBatch, items: Recommendation[]): Promise<RecommendationSnapshot>;
  discardRecommendationBatch(scope: string, generation: number): Promise<void>;
  clearRecommendations(scope: string): Promise<void>;
  clearLegacyRecommendations(): Promise<void>;
  getSummary?(key: string): Promise<TopicAiSummary | undefined>;
  putSummary?(key: string, summary: TopicAiSummary): Promise<void>;
  listRecommendations?(scope?: string): Promise<Recommendation[]>;
}
