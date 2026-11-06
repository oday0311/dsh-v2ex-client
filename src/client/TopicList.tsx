import React from 'react';
import type { TopicListItem } from '../contract.js';
import { formatTime, type Copy } from './locales.js';

export function TopicList({ items, onOpen, copy, locale, filtered = false }: { items: TopicListItem[]; onOpen(id: string): void; copy: Copy; locale: string; filtered?: boolean }) {
  if (items.length === 0) return <p className="v2ex-muted">{filtered ? copy.noMatches : copy.empty}</p>;
  return <ul className="v2ex-topics">{items.map(item => <li key={item.id}>
    <button type="button" onClick={() => onOpen(String(item.id))} aria-label={`${item.title}，${item.node.title}，${item.replyCount} ${copy.replyCount}`}>
      <span className="v2ex-topic-title">{item.title}</span>
      <span className="v2ex-meta">{item.node.title} · {item.author.username} · {item.replyCount} {copy.replyCount} · {formatTime(item.lastReplyAt ?? item.createdAt, locale)}</span>
    </button>
  </li>)}</ul>;
}
