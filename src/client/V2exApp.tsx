import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import type { V2exClientStore } from './store.js';
import { LoginView } from './LoginView.js';
import { TopicList } from './TopicList.js';
import { TopicDetail } from './TopicDetail.js';
import { zh } from './locales.js';

export function V2exApp({ store }: { store: V2exClientStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [nodeInput, setNodeInput] = useState('');
  const [clearPersonalData, setClearPersonalData] = useState(false);
  useEffect(() => { if (state.phase === 'checking') void store.loadSession(); }, [store]);
  useEffect(() => { if (state.phase === 'ready' && state.view === 'latest' && !state.topics && !state.loading && !state.error) void store.loadLatest(); }, [store, state.phase]);
  if (state.phase === 'checking') return <section className="v2ex-app" role="status">{zh.loading}</section>;
  if (state.phase === 'guest') return <div className="v2ex-app"><LoginView store={store} busy={state.loading} error={state.error ? zh.errors[state.error] : null} /></div>;
  const refresh = () => { if (state.view === 'hot') void store.loadHot(); else if (state.view === 'node') void store.loadNode(state.nodeName); else void store.loadLatest(); };
  return <section className="v2ex-app" aria-label={zh.title}>
    <header className="v2ex-header"><strong>{zh.title}</strong><span className="v2ex-account">{state.account?.username}</span>
      <button type="button" className="v2ex-icon" title={zh.reload} aria-label={zh.reload} onClick={refresh}><RefreshCw size={16} /></button>
      <button type="button" className="v2ex-icon" title={zh.logout} aria-label={zh.logout} onClick={() => void store.logout(clearPersonalData)}><LogOut size={16} /></button>
    </header>
    <label className="v2ex-clear"><input type="checkbox" checked={clearPersonalData} onChange={event => setClearPersonalData(event.target.checked)} />{zh.clearPersonalData}</label>
    <nav className="v2ex-tabs" role="tablist" aria-label={zh.viewTabs}>
      {(['latest', 'hot', 'node'] as const).map(view => <button key={view} type="button" role="tab" aria-selected={state.view === view} onClick={() => store.selectView(view)}>{zh[view === 'node' ? 'nodes' : view]}</button>)}
    </nav>
    {state.view === 'node' && <form className="v2ex-node-form" onSubmit={event => { event.preventDefault(); void store.loadNode(nodeInput); }}><label htmlFor="v2ex-node">{zh.nodeLabel}</label><div><input id="v2ex-node" value={nodeInput} onChange={event => setNodeInput(event.target.value)} placeholder={zh.nodePlaceholder} /><button type="submit">{zh.browse}</button></div></form>}
    <div className="v2ex-layout"><section className="v2ex-list" aria-label={zh.topicList}>
      {state.nodeInfo && <h2>{state.nodeInfo.value.title}</h2>}
      {state.loading && <p role="status">{zh.loading}</p>}
      {state.error && <p className="v2ex-error" role="alert">{zh.errors[state.error]} <button type="button" onClick={refresh}>{zh.retry}</button></p>}
      {state.topics?.stale && <p className="v2ex-stale" role="status">{zh.stale}</p>}
      {state.topics?.stale && state.topics.refreshError && <p className="v2ex-error">{zh.errors[state.topics.refreshError.code]}</p>}
      {state.topics && <TopicList items={state.topics.value.items} onOpen={id => void store.openTopic(id)} />}
      {state.topics?.value.hasMore && <button type="button" disabled={state.loading} onClick={() => state.view === 'node' ? void store.loadNode(state.nodeName, state.topics!.value.page + 1) : void store.loadLatest(state.topics!.value.page + 1)}>{zh.loadMore}</button>}
    </section>
    {(state.thread || state.detailLoading || state.detailError) && <TopicDetail state={state} store={store} />}</div>
  </section>;
}
