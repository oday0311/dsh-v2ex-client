import type { PublicTopicAiSummary, TopicAiSummary } from './contract.js';
import { V2exError } from './errors.js';

export function publicTopicSummary(source: TopicAiSummary, expected: { topicId: number; mode: PublicTopicAiSummary['mode'] }): PublicTopicAiSummary {
  if (source.topicId !== expected.topicId || source.mode !== undefined && source.mode !== expected.mode) {
    throw new V2exError('invalid_response');
  }
  return {
    topicId: source.topicId,
    summary: source.summary,
    viewpoints: [...source.viewpoints],
    notableReplies: [...source.notableReplies],
    generatedAt: source.generatedAt,
    coveredReplyPages: [...source.coveredReplyPages],
    completeDiscussion: source.completeDiscussion,
    ...(source.coverage ? { coverage: {
      loadedReplyPages: source.coverage.loadedReplyPages,
      totalReplyPages: source.coverage.totalReplyPages,
      complete: source.coverage.complete,
      ...(source.coverage.includedReplies === undefined ? {} : { includedReplies: source.coverage.includedReplies }),
      ...(source.coverage.omittedReplies === undefined ? {} : { omittedReplies: source.coverage.omittedReplies }),
      ...(source.coverage.contentTruncated === undefined ? {} : { contentTruncated: source.coverage.contentTruncated }),
    } } : {}),
    mode: expected.mode,
  };
}
