import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { ClientState, V2exClientStore } from './store.js';
import { formatTime, zh } from './locales.js';

export function TopicDetail({ state, store }: { state: Readonly<ClientState>; store: V2exClientStore }) {
  const thread = state.thread;
  return <section className="v2ex-detail" aria-label={zh.topicDetail}>
    <div className="v2ex-detail-toolbar"><button type="button" className="v2ex-icon" title={zh.back} aria-label={zh.back} onClick={() => store.closeTopic()}><ArrowLeft size={16} /></button>
      <span className="v2ex-muted">{thread?.value.topic.node.title}</span></div>
    {state.detailLoading && <p role="status">{zh.loading}</p>}
    {state.detailError && <p role="alert" className="v2ex-error">{zh.errors[state.detailError]} <button type="button" onClick={() => store.retry()}>{zh.retry}</button></p>}
    {thread && <><h3>{thread.value.topic.title}</h3>
      <p className="v2ex-meta">{thread.value.topic.author.username} · {formatTime(thread.value.topic.createdAt)}</p>
      {thread.stale && <p className="v2ex-stale" role="status">{zh.stale}</p>}
      <div className="v2ex-body">{thread.value.content}</div>
      <h4>{zh.replyHeading}</h4>
      {thread.value.replies.length === 0 && <p className="v2ex-muted">{zh.repliesEmpty}</p>}
      <ol className="v2ex-replies">{thread.value.replies.map(reply => <li key={reply.id}><span className="v2ex-meta">{reply.author.username} · {formatTime(reply.createdAt)}</span><p>{reply.content}</p></li>)}</ol>
      {thread.value.replyPage > 0 && <p className="v2ex-muted">{zh.page} {thread.value.replyPage} {zh.replies}</p>}
      {state.repliesError && <p className="v2ex-error" role="alert">{zh.errors[state.repliesError]} <button type="button" onClick={() => void store.loadMoreReplies()}>{zh.retry}</button></p>}
      {thread.value.hasMoreReplies && <button type="button" disabled={state.repliesLoading} onClick={() => void store.loadMoreReplies()}>{state.repliesLoading ? zh.loading : zh.moreReplies}</button>}
    </>}
  </section>;
}
