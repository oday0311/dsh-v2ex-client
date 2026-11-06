import React from 'react';
import type { TopicListItem } from '../contract.js';
import { formatTime, zh } from './locales.js';

export function TopicList({ items, onOpen }: { items: TopicListItem[]; onOpen(id: string): void }) {
  if (items.length === 0) return <p className="v2ex-muted">{zh.empty}</p>;
  return <ul className="v2ex-topics">{items.map(item => <li key={item.id}>
    <button type="button" onClick={() => onOpen(String(item.id))} aria-label={`${item.title}，${item.node.title}，${item.replyCount} ${zh.replyCount}`}>
      <span className="v2ex-topic-title">{item.title}</span>
      <span className="v2ex-meta">{item.node.title} · {item.author.username} · {item.replyCount} {zh.replyCount} · {formatTime(item.lastReplyAt ?? item.createdAt)}</span>
    </button>
  </li>)}</ul>;
}
