import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import type { V2exClientStore } from './store.js';
import { LoginView } from './LoginView.js';
import { TopicList } from './TopicList.js';
import { TopicDetail } from './TopicDetail.js';
import { copyFor, formatTime, type LocaleSource } from './locales.js';

const fallbackLocale = { active: 'zh' };

export function V2exApp({ store, locale }: { store: V2exClientStore; locale?: LocaleSource }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const subscribeLocale = useCallback((listener: () => void) => locale?.subscribe(listener) ?? (() => {}), [locale]);
  const readLocale = useCallback(() => locale?.getSnapshot() ?? fallbackLocale, [locale]);
  const activeLocale = useSyncExternalStore(subscribeLocale, readLocale, readLocale).active;
  const copy = copyFor(activeLocale);
  const [nodeInput, setNodeInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [filterNode, setFilterNode] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [clearPersonalData, setClearPersonalData] = useState(false);
  useEffect(() => { if (state.phase === 'checking') void store.loadSession(); }, [store]);
  useEffect(() => { if (state.phase === 'ready' && state.view === 'latest' && !state.topics && !state.loading && !state.error) void store.loadLatest(); }, [store, state.phase, state.account]);
  if (state.phase === 'checking') return <section className="v2ex-app" role="status">{copy.loading}</section>;
  if (state.phase === 'guest') return <div className="v2ex-app"><LoginView store={store} busy={state.loading} error={state.error ? copy.errors[state.error] : null} copy={copy} /></div>;
  const refresh = () => { if (state.view === 'hot') void store.loadHot(); else if (state.view === 'node') void store.loadNode(state.nodeName); else void store.loadLatest(); };
  const filtered = state.view === 'latest' && (keyword.trim() !== '' || filterNode.trim() !== '');
  const items = state.topics?.value.items.filter(item => !filtered || (
    item.title.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()) &&
    (item.node.name.toLocaleLowerCase().includes(filterNode.trim().toLocaleLowerCase()) ||
      item.node.title.toLocaleLowerCase().includes(filterNode.trim().toLocaleLowerCase())))) ?? [];
  return <section className="v2ex-app" aria-label={copy.title}>
    <header className="v2ex-header"><strong>{copy.title}</strong><span className="v2ex-account">{state.account?.username}</span>
      <button type="button" className="v2ex-icon" title={copy.reload} aria-label={copy.reload} onClick={refresh}><RefreshCw size={16} /></button>
      <button type="button" className="v2ex-icon" title={copy.logout} aria-label={copy.logout} onClick={() => void store.logout(clearPersonalData)}><LogOut size={16} /></button>
    </header>
    <div className="v2ex-account-details">
      {state.account?.tokenScope && <span>{copy.tokenScope}: {state.account.tokenScope}</span>}
      {state.account?.expiresAt && <span>{copy.expiresAt}: {formatTime(state.account.expiresAt, activeLocale)}</span>}
      <button type="button" onClick={() => setReplaceOpen(open => !open)} aria-expanded={replaceOpen}>{copy.replaceToken}</button>
    </div>
    {replaceOpen && <LoginView store={store} busy={state.loading} error={state.error ? copy.errors[state.error] : null}
      copy={copy} replacement onSuccess={() => { setReplaceOpen(false); refresh(); }} />}
    <label className="v2ex-clear"><input type="checkbox" checked={clearPersonalData} onChange={event => setClearPersonalData(event.target.checked)} />{copy.clearPersonalData}</label>
    <nav className="v2ex-tabs" aria-label={copy.viewTabs}>
      {(['latest', 'hot', 'node'] as const).map(view => <button key={view} type="button" aria-pressed={state.view === view} onClick={() => store.selectView(view)}>{copy[view === 'node' ? 'nodes' : view]}</button>)}
    </nav>
    {state.view === 'latest' && <div className="v2ex-filters"><label>{copy.keyword}<input value={keyword} onChange={event => setKeyword(event.target.value)} /></label><label>{copy.filterNode}<input value={filterNode} onChange={event => setFilterNode(event.target.value)} /></label></div>}
    {state.view === 'node' && <form className="v2ex-node-form" onSubmit={event => { event.preventDefault(); void store.loadNode(nodeInput); }}><label htmlFor="v2ex-node">{copy.nodeLabel}</label><div><input id="v2ex-node" value={nodeInput} onChange={event => setNodeInput(event.target.value)} placeholder={copy.nodePlaceholder} /><button type="submit">{copy.browse}</button></div></form>}
    <div className="v2ex-layout"><section className="v2ex-list" aria-label={copy.topicList}>
      {state.nodeInfo && <h2>{state.nodeInfo.value.title}</h2>}
      {state.loading && <p role="status">{copy.loading}</p>}
      {state.error && <p className="v2ex-error" role="alert">{copy.errors[state.error]} <button type="button" onClick={refresh}>{copy.retry}</button></p>}
      {state.topics?.stale && <p className="v2ex-stale" role="status">{copy.stale}</p>}
      {state.topics?.stale && state.topics.refreshError && <p className="v2ex-error">{copy.errors[state.topics.refreshError.code]}</p>}
      {state.topics && <TopicList items={items} onOpen={id => void store.openTopic(id)} copy={copy} locale={activeLocale} filtered={filtered} />}
      {state.topics?.value.hasMore && <button type="button" disabled={state.loading} onClick={() => state.view === 'node' ? void store.loadNode(state.nodeName, state.topics!.value.page + 1) : void store.loadLatest(state.topics!.value.page + 1)}>{copy.loadMore}</button>}
    </section>
    {(state.thread || state.detailLoading || state.detailError) && <TopicDetail state={state} store={store} copy={copy} locale={activeLocale} />}</div>
  </section>;
}
