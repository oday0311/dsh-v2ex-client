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
  quietHours: { start: string; end: string } | null;
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
}

export interface InterestProfile {
  labels: Array<{ name: string; weight: number }>;
  preferredNodes: string[];
  excludedTerms: string[];
  feedback: Array<{ topicId: number; interested: boolean }>;
  updatedAt: string;
}

export interface Recommendation {
  topic: TopicListItem;
  score: number;
  reason: string;
  read: boolean;
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
  getSettings(): Promise<PluginSettings>;
  putSettings(settings: PluginSettings): Promise<void>;
  getProfile(): Promise<InterestProfile | null>;
  putProfile(profile: InterestProfile): Promise<void>;
  clearProfile(): Promise<void>;
  getRecommendation(key: string): Promise<Recommendation | undefined>;
  putRecommendation(key: string, recommendation: Recommendation): Promise<void>;
  markRead(key: string): Promise<void>;
  getSummary?(key: string): Promise<TopicAiSummary | undefined>;
  putSummary?(key: string, summary: TopicAiSummary): Promise<void>;
  listRecommendations?(): Promise<Recommendation[]>;
}
