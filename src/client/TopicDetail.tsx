import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { ClientState, V2exClientStore } from './store.js';
import { formatTime, type Copy } from './locales.js';
import { AiPanel } from './AiPanel.js';

export function TopicDetail({ state, store, copy, locale }: { state: Readonly<ClientState>; store: V2exClientStore; copy: Copy; locale: string }) {
  const thread = state.thread;
  return <section className="v2ex-detail" aria-label={copy.topicDetail}>
    <div className="v2ex-detail-toolbar"><button type="button" className="v2ex-icon" title={copy.back} aria-label={copy.back} onClick={() => store.closeTopic()}><ArrowLeft size={16} /></button>
      <span className="v2ex-muted">{thread?.value.topic.node.title}</span></div>
    {state.detailLoading && <p role="status">{copy.loading}</p>}
    {state.detailError && <p role="alert" className="v2ex-error">{copy.errors[state.detailError]} <button type="button" onClick={() => store.retry()}>{copy.retry}</button></p>}
    {thread && <><h3>{thread.value.topic.title}</h3>
      <p className="v2ex-meta">{thread.value.topic.author.username} · {formatTime(thread.value.topic.createdAt, locale)}</p>
      {thread.stale && <p className="v2ex-stale" role="status">{copy.stale}</p>}
      <div className="v2ex-body">{thread.value.content}</div>
      <h4>{copy.replyHeading}</h4>
      {thread.value.replies.length === 0 && <p className="v2ex-muted">{copy.repliesEmpty}</p>}
      <ol className="v2ex-replies">{thread.value.replies.map(reply => <li key={reply.id}><span className="v2ex-meta">{reply.author.username} · {formatTime(reply.createdAt, locale)}</span><p>{reply.content}</p></li>)}</ol>
      {thread.value.replyPage > 0 && <p className="v2ex-muted">{copy.page} {thread.value.replyPage} {copy.replies}</p>}
      {state.repliesError && <p className="v2ex-error" role="alert">{copy.errors[state.repliesError]} <button type="button" onClick={() => void store.loadMoreReplies()}>{copy.retry}</button></p>}
      {thread.value.hasMoreReplies && <button type="button" disabled={state.repliesLoading} onClick={() => void store.loadMoreReplies()}>{state.repliesLoading ? copy.loading : copy.moreReplies}</button>}
      <AiPanel summary={state.summary} mode={state.summaryMode} loading={state.summaryLoading} error={state.summaryError} available={store.hasSummary()}
        onMode={mode => store.setSummaryMode(mode)} onGenerate={() => void store.generateSummary()} copy={copy} locale={locale} />
    </>}
  </section>;
}
