import React from 'react';
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { RecommendationList } from '../contract.js';
import type { ClientErrorCode } from './http.js';
import { formatTime, type Copy } from './locales.js';

export function RecommendationView({ value, loading, error, copy, locale, onOpen, onFeedback, onRetry }: {
  value: RecommendationList | null; loading: boolean; error: ClientErrorCode | null; copy: Copy; locale: string;
  onOpen(topicId: number): void; onFeedback(topicId: number, value: 'interested' | 'not_interested'): void; onRetry(): void;
}) {
  return <section className="v2ex-workflow" aria-label={copy.smartRecommendations}>
    <div className="v2ex-section-heading"><h2>{copy.smartRecommendations}</h2></div>
    {loading && <p role="status">{copy.loading}</p>}
    {error && <p role="alert" className="v2ex-error">{copy.errors[error]} <button type="button" onClick={onRetry}>{copy.retry}</button></p>}
    {value && <p className={value.stale ? 'v2ex-stale' : 'v2ex-meta'}>{copy.recommendationSource}{value.source === 'stored' ? copy.sourceStored : copy.sourceGenerated}
      {value.generatedAt ? ` · ${formatTime(value.generatedAt, locale)}` : ''}{value.stale ? ` · ${copy.stale}` : ''}</p>}
    {value && value.items.length === 0 && <p className="v2ex-muted">{copy.noRecommendations}</p>}
    <ul className="v2ex-recommendations">{value?.items.map(item => <li key={item.topic.id} className={item.read ? '' : 'is-unread'}>
      <button type="button" className="v2ex-recommendation-topic" onClick={() => onOpen(item.topic.id)}>
        <span className="v2ex-topic-title">{item.topic.title}</span>
        <span className="v2ex-meta">{item.topic.node.title} · {item.topic.author.username} · {item.topic.replyCount} {copy.replyCount}</span>
      </button>
      <p>{item.reason}</p>
      <div className="v2ex-recommendation-actions">
        {!item.read && <span className="v2ex-unread"><Check size={12} aria-hidden="true" />{copy.unread}</span>}
        <button type="button" aria-pressed={item.feedback === 'interested'} onClick={() => onFeedback(item.topic.id, 'interested')}><ThumbsUp size={14} aria-hidden="true" />{copy.interested}</button>
        <button type="button" aria-pressed={item.feedback === 'not_interested'} onClick={() => onFeedback(item.topic.id, 'not_interested')}><ThumbsDown size={14} aria-hidden="true" />{copy.notInterested}</button>
      </div>
    </li>)}</ul>
  </section>;
}
