import type { AccountStatus, Cached, NodeInfo, TopicPage, TopicThread } from '../contract.js';
import { V2exClientError, type V2exClientRemote, type ClientErrorCode } from './http.js';

export type BrowseView = 'latest' | 'hot' | 'node';
export interface ClientState {
  phase: 'checking' | 'guest' | 'ready';
  account: AccountStatus | null;
  view: BrowseView;
  nodeName: string;
  nodeInfo: Cached<NodeInfo> | null;
  topics: Cached<TopicPage> | null;
  thread: Cached<TopicThread> | null;
  loading: boolean;
  detailLoading: boolean;
  repliesLoading: boolean;
  error: ClientErrorCode | null;
  detailError: ClientErrorCode | null;
  repliesError: ClientErrorCode | null;
}

const initial: ClientState = { phase: 'checking', account: null, view: 'latest', nodeName: '', nodeInfo: null, topics: null, thread: null, loading: false, detailLoading: false, repliesLoading: false, error: null, detailError: null, repliesError: null };
type Lane = 'session' | 'list' | 'detail' | 'replies';

export class V2exClientStore {
  private state: Readonly<ClientState> = initial;
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<Lane, AbortController>();
  private readonly versions = new Map<Lane, number>();
  private disposed = false;
  private selectedTopicId: string | null = null;
  constructor(private readonly remote: V2exClientRemote) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): Readonly<ClientState> => this.state;
  private set(patch: Partial<ClientState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private start(lane: Lane): { signal: AbortSignal; current(): boolean } {
    this.controllers.get(lane)?.abort();
    const controller = new AbortController();
    this.controllers.set(lane, controller);
    const version = (this.versions.get(lane) ?? 0) + 1;
    this.versions.set(lane, version);
    return { signal: controller.signal, current: () => !this.disposed && !controller.signal.aborted && this.versions.get(lane) === version };
  }
  private stop(...lanes: Lane[]): void { for (const lane of lanes) this.controllers.get(lane)?.abort(); }
  private code(error: unknown): ClientErrorCode { return error instanceof V2exClientError ? error.code : 'upstream'; }
  private fail(error: unknown, patch: Partial<ClientState>): void {
    const code = this.code(error);
    if (code === 'not_authenticated' || code === 'token_expired') {
      this.sessionStatus({ authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null });
      this.set({ error: code });
    } else this.set(patch);
  }
  private sessionStatus(account: AccountStatus): void {
    this.stop('list', 'detail', 'replies');
    this.selectedTopicId = null;
    this.set({ account, phase: account.authenticated ? 'ready' : 'guest', topics: null, thread: null, nodeInfo: null, loading: false, detailLoading: false, repliesLoading: false, error: null, detailError: null, repliesError: null });
  }
  async loadSession(): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    this.set({ phase: 'checking', error: null });
    try { const status = await this.remote.session(request.signal); if (request.current()) this.sessionStatus(status); }
    catch (error) { if (request.current()) this.set({ phase: 'guest', error: this.code(error) }); }
  }
  async login(token: string): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    const previouslyReady = this.state.phase === 'ready';
    this.set({ loading: true, error: null });
    try { const status = await this.remote.login(token, request.signal); if (!status.authenticated) throw new V2exClientError('invalid_response'); if (request.current()) this.sessionStatus(status); }
    catch (error) { if (request.current()) this.set({ phase: previouslyReady ? 'ready' : 'guest', error: this.code(error) }); }
    finally { if (request.current()) this.set({ loading: false }); }
  }
  async logout(clearPersonalData = false): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    this.stop('list', 'detail', 'replies');
    this.set({ loading: true, error: null });
    try { const status = await this.remote.logout(clearPersonalData, request.signal); if (request.current()) this.sessionStatus(status); }
    catch (error) { if (request.current()) this.set({ error: this.code(error), loading: false }); }
  }
  selectView(view: BrowseView): void {
    if (this.disposed || this.state.phase !== 'ready') return;
    this.stop('list', 'detail', 'replies');
    this.selectedTopicId = null;
    this.set({ view, topics: null, thread: null, nodeInfo: null, error: null, detailError: null, repliesError: null,
      loading: false, detailLoading: false, repliesLoading: false });
    if (view === 'latest') void this.loadLatest();
    if (view === 'hot') void this.loadHot();
  }
  async loadLatest(page = 1): Promise<void> { await this.loadList(signal => this.remote.latest(page, signal), page); }
  private async loadList(fetchPage: (signal: AbortSignal) => Promise<Cached<TopicPage>>, page: number): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    const request = this.start('list');
    this.set({ loading: true, error: null });
    try { const topics = await fetchPage(request.signal); if (request.current()) this.set({ topics: page > 1 && this.state.topics ? { ...topics, value: { ...topics.value, items: [...this.state.topics.value.items, ...topics.value.items] } } : topics, loading: false }); }
    catch (error) { if (request.current()) this.fail(error, { loading: false, error: this.code(error) }); }
  }
  async loadHot(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    const request = this.start('list'); this.set({ loading: true, error: null });
    try { const result = await this.remote.hot(request.signal); if (request.current()) this.set({ topics: { ...result, value: { items: result.value, page: 1, hasMore: false, stale: result.stale } }, loading: false }); }
    catch (error) { if (request.current()) this.fail(error, { loading: false, error: this.code(error) }); }
  }
  async loadNode(node: string, page = 1): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    const name = node.trim(); if (!/^[a-z0-9_-]{1,64}$/i.test(name)) { this.set({ error: 'invalid_request' }); return; }
    const changed = this.state.view !== 'node' || this.state.nodeName !== name;
    if (changed) {
      this.stop('detail', 'replies');
      this.selectedTopicId = null;
    }
    this.set({ view: 'node', nodeName: name, error: null,
      ...(changed ? { nodeInfo: null, topics: null, thread: null, detailLoading: false,
        repliesLoading: false, detailError: null, repliesError: null } : {}) });
    const request = this.start('list'); this.set({ loading: true });
    try {
      const [nodeInfo, topics] = await Promise.all([this.remote.node(name, request.signal), this.remote.nodeTopics(name, page, request.signal)]);
      if (request.current()) this.set({ nodeInfo, topics: page > 1 && this.state.topics ? { ...topics, value: { ...topics.value, items: [...this.state.topics.value.items, ...topics.value.items] } } : topics, loading: false });
    } catch (error) { if (request.current()) this.fail(error, { loading: false, error: this.code(error) }); }
  }
  async openTopic(topicId: string): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    if (!/^[1-9][0-9]*$/.test(topicId)) { this.set({ detailError: 'invalid_request' }); return; }
    this.selectedTopicId = topicId;
    this.stop('replies'); const request = this.start('detail');
    this.set({ thread: null, detailLoading: true, repliesLoading: false, detailError: null, repliesError: null });
    try { const thread = await this.remote.topic(topicId, request.signal); if (request.current()) this.set({ thread, detailLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { detailLoading: false, detailError: this.code(error) }); }
  }
  closeTopic(): void { this.stop('detail', 'replies'); this.selectedTopicId = null; this.set({ thread: null, detailError: null, repliesError: null, detailLoading: false, repliesLoading: false }); }
  async loadMoreReplies(): Promise<void> {
    const thread = this.state.thread;
    if (this.disposed || this.state.phase !== 'ready' || !thread || !thread.value.hasMoreReplies) return;
    const id = String(thread.value.topic.id), page = thread.value.replyPage + 1;
    const request = this.start('replies'); this.set({ repliesLoading: true, repliesError: null });
    try {
      const result = await this.remote.replies(id, page, request.signal);
      if (request.current() && this.state.thread?.value.topic.id === thread.value.topic.id) {
        const current = this.state.thread;
        this.set({ thread: { ...current, stale: current.stale || result.stale, value: { ...current.value, replies: [...current.value.replies, ...result.value], replyPage: page, hasMoreReplies: result.value.length >= 20 } }, repliesLoading: false });
      }
    } catch (error) { if (request.current()) this.fail(error, { repliesLoading: false, repliesError: this.code(error) }); }
  }
  retry(): void {
    if (this.state.detailError && this.selectedTopicId) { void this.openTopic(this.selectedTopicId); return; }
    if (this.state.repliesError) { void this.loadMoreReplies(); return; }
    if (this.state.phase === 'guest') { void this.loadSession(); return; }
    if (this.state.view === 'hot') void this.loadHot();
    else if (this.state.view === 'node') void this.loadNode(this.state.nodeName);
    else void this.loadLatest();
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.stop('session', 'list', 'detail', 'replies'); this.controllers.clear(); this.listeners.clear(); }
}
