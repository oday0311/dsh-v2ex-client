export type { PublicError, V2exErrorCode } from './errors.js';

export interface AccountStatus {
  authenticated: boolean;
  writable: boolean;
  username: string | null;
  tokenScope: string | null;
  expiresAt: string | null;
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
