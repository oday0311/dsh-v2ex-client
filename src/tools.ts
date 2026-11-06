import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Cached, TopicListItem, TopicPage, TopicThread } from './contract.js';
import { V2exError } from './errors.js';
import { assertNodeName, assertTopicId } from './validation.js';
import type { IntelligenceService, SummaryMode } from './intelligence.js';
import type { InterestService } from './interests.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const RUNTIME_ENVELOPE_HEADROOM_BYTES = 256;
const encoder = new TextEncoder();

export interface ContentReader {
  latest(input: { page: number }, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  hot(signal?: AbortSignal): Promise<Cached<TopicListItem[]>>;
  nodeTopics(input: { node: string; page: number }, signal?: AbortSignal): Promise<Cached<TopicPage>>;
  topic(input: { topic: string; replyPages: number }, signal?: AbortSignal): Promise<Cached<TopicThread>>;
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new V2exError('invalid_request');
  return Math.min(value, maximum);
}

function text(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  return { value: value.slice(0, limit), truncated: true };
}

function renderedText(value: unknown): string { return JSON.stringify(value); }

function bytes(value: unknown): number {
  const content = [{ type: 'text', text: renderedText(value) }];
  return encoder.encode(JSON.stringify({ content })).byteLength + RUNTIME_ENVELOPE_HEADROOM_BYTES;
}

function metadata<T>(cached: Cached<T>) {
  return { fetchedAt: text(cached.fetchedAt, 64).value, stale: cached.stale,
    source: cached.source === 'cache' ? 'cache' as const : 'network' as const,
    ...(cached.refreshError ? { refreshError: { code: text(cached.refreshError.code, 64).value,
      message: text(cached.refreshError.message, 500).value, retryable: cached.refreshError.retryable } } : {}) };
}

function listItem(value: TopicListItem) {
  const title = text(value.title, 300);
  const nodeName = text(value.node.name, 64);
  const nodeTitle = text(value.node.title, 100);
  const username = text(value.author.username, 100);
  const createdAt = text(value.createdAt, 64);
  const lastReplyAt = value.lastReplyAt === null ? null : text(value.lastReplyAt, 64);
  const url = text(value.url, 300);
  return { id: value.id, title: title.value,
    node: { name: nodeName.value, title: nodeTitle.value },
    author: { username: username.value }, replyCount: value.replyCount,
    createdAt: createdAt.value, lastReplyAt: lastReplyAt?.value ?? null, url: url.value,
    fieldsTruncated: [title, nodeName, nodeTitle, username, createdAt, url].some((field) => field.truncated) ||
      (lastReplyAt?.truncated ?? false) };
}

function listResult(cached: Cached<TopicListItem[]>, page?: number, hasMore?: boolean) {
  const all = cached.value;
  const items = all.slice(0, 30).map(listItem);
  const result = { ok: true, items, ...(page === undefined ? {} : { page }),
    ...(hasMore === undefined ? {} : { hasMore }), ...metadata(cached),
    truncated: items.length < all.length || items.some((item) => item.fieldsTruncated),
    omittedItems: all.length - items.length };
  while (bytes(result) > MAX_OUTPUT_BYTES && result.items.length) {
    result.items.pop();
    result.truncated = true;
    result.omittedItems++;
  }
  return result;
}

function topicResult(cached: Cached<TopicThread>) {
  const thread = cached.value;
  const body = text(thread.content, 12_000);
  const topic = listItem(thread.topic);
  const replies = thread.replies.slice(0, 30).map((reply) => {
    const content = text(reply.content, 1_000);
    return { id: reply.id, author: { username: text(reply.author.username, 100).value },
      content: content.value, contentTruncated: content.truncated,
      createdAt: text(reply.createdAt, 64).value };
  });
  const result = { ok: true, topic: { ...topic, content: body.value,
    contentTruncated: body.truncated }, replies, replyPage: thread.replyPage,
    hasMoreReplies: thread.hasMoreReplies, ...metadata(cached), truncated: body.truncated ||
      topic.fieldsTruncated ||
      replies.length < thread.replies.length || replies.some((reply) => reply.contentTruncated),
    omittedReplies: thread.replies.length - replies.length };
  while (bytes(result) > MAX_OUTPUT_BYTES && result.replies.length) {
    result.replies.pop();
    result.truncated = true;
    result.omittedReplies++;
  }
  if (bytes(result) > MAX_OUTPUT_BYTES) {
    result.topic.content = '';
    result.topic.contentTruncated = true;
    result.truncated = true;
  }
  return result;
}

const output = { schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderedText(value) }] };

export function createBrowsingTools(reader: ContentReader): ToolDefinition[] {
  return [
    defineTool({ name: 'v2ex_latest', description: 'Read recent V2EX topics.',
      parameters: { page: { type: 'integer' } }, output,
      async execute(args, exec) {
        const page = clamp(args.page, 1, 1000);
        const cached = await reader.latest({ page }, exec.signal);
        return listResult({ ...cached, value: cached.value.items }, cached.value.page, cached.value.hasMore);
      } }),
    defineTool({ name: 'v2ex_hot', description: 'Read popular V2EX topics.',
      parameters: {}, output,
      async execute(_args, exec) { return listResult(await reader.hot(exec.signal)); } }),
    defineTool({ name: 'v2ex_node_topics', description: 'Read topics from a V2EX node.',
      parameters: { node: { type: 'string', required: true }, page: { type: 'integer' } }, output,
      async execute(args, exec) {
        const node = assertNodeName(args.node);
        const page = clamp(args.page, 1, 1000);
        const cached = await reader.nodeTopics({ node, page }, exec.signal);
        return listResult({ ...cached, value: cached.value.items }, cached.value.page, cached.value.hasMore);
      } }),
    defineTool({ name: 'v2ex_topic', description: 'Read a V2EX topic and a bounded number of reply pages.',
      parameters: { topic: { type: 'string', required: true }, replyPages: { type: 'integer' } }, output,
      async execute(args, exec) {
        const topic = String(assertTopicId(args.topic));
        const replyPages = clamp(args.replyPages, 1, 3);
        return topicResult(await reader.topic({ topic, replyPages }, exec.signal));
      } }),
  ];
}

export function createSummaryTool(reader: Pick<ContentReader, 'topic'>,
  intelligence: Pick<IntelligenceService, 'summarizeTopic'>): ToolDefinition {
  return defineTool({ name: 'v2ex_summarize_topic', description: 'Summarize a V2EX topic with reply-page provenance.',
    parameters: { topic: { type: 'string', required: true }, mode: { type: 'string', required: true },
      replyPages: { type: 'integer' } }, output,
    async execute(args, exec) {
      const topic = String(assertTopicId(args.topic));
      if (args.mode !== 'quick' && args.mode !== 'viewpoints' && args.mode !== 'full') throw new V2exError('invalid_request');
      const replyPages = clamp(args.replyPages, 1, 3);
      const cached = await reader.topic({ topic, replyPages }, exec.signal);
      const source = await intelligence.summarizeTopic({ topic: cached.value, mode: args.mode as SummaryMode }, exec.signal);
      const result = {
        topicId: source.topicId, summary: text(source.summary, 5000).value,
        viewpoints: source.viewpoints.slice(0, 30).map(value => text(value, 1000).value),
        notableReplies: source.notableReplies.slice(0, 100),
        generatedAt: text(source.generatedAt, 64).value,
        coveredReplyPages: source.coveredReplyPages.slice(0, 10),
        completeDiscussion: source.completeDiscussion,
        ...(source.coverage ? { coverage: source.coverage } : {}),
        ...(source.mode ? { mode: source.mode } : {}),
        ...(source.modelRoute ? { modelRoute: text(source.modelRoute, 500).value } : {}),
        ...(source.topicUpdatedAt ? { topicUpdatedAt: text(source.topicUpdatedAt, 64).value } : {}),
        truncated: false,
      };
      result.truncated = result.summary !== source.summary || result.viewpoints.length < source.viewpoints.length;
      while (bytes(result) > MAX_OUTPUT_BYTES && result.viewpoints.length) {
        result.viewpoints.pop(); result.truncated = true;
      }
      while (bytes(result) > MAX_OUTPUT_BYTES && result.summary.length) {
        result.summary = result.summary.slice(0, Math.floor(result.summary.length / 2));
        result.truncated = true;
      }
      if (bytes(result) > MAX_OUTPUT_BYTES) throw new V2exError('invalid_response');
      return result;
    } });
}

export function createInterestTool(service: Pick<InterestService, 'perform'>): ToolDefinition {
  return defineTool({ name: 'v2ex_interest_profile', description: 'Inspect the V2EX interest profile.',
    parameters: { action: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
        args.action !== 'get' || Object.keys(args).length !== 1) throw new V2exError('invalid_request');
      let result;
      try { result = await service.perform('get', undefined, exec.signal); }
      catch (error) { throw error instanceof V2exError ? error : new V2exError('ai_unavailable'); }
      if (bytes(result) > MAX_OUTPUT_BYTES) throw new V2exError('invalid_response');
      return JSON.parse(JSON.stringify(result));
    } });
}
