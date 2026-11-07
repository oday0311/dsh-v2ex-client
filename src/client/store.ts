import { TOPIC_TABS, type AccountStatus, type Cached, type InterestProfile, type NodeInfo, type PluginSettings, type PublicTopicAiSummary, type RecommendationList, type TopicPage, type TopicTab, type TopicThread } from '../contract.js';
import { V2exClientError, type V2exClientRemote, type ClientErrorCode } from './http.js';

export type BrowseView = 'smart' | 'tabs' | 'latest' | 'hot' | 'node' | 'interests' | 'settings';
export interface ClientState {
  phase: 'checking' | 'guest' | 'ready';
  account: AccountStatus | null;
  view: BrowseView;
  tab: TopicTab;
  nodeName: string;
  nodeInfo: Cached<NodeInfo> | null;
  nodes: Cached<NodeInfo[]> | null;
  nodesLoading: boolean;
  nodesError: ClientErrorCode | null;
  topics: Cached<TopicPage> | null;
  thread: Cached<TopicThread> | null;
  loading: boolean;
  detailLoading: boolean;
  repliesLoading: boolean;
  error: ClientErrorCode | null;
  detailError: ClientErrorCode | null;
  repliesError: ClientErrorCode | null;
  summary: PublicTopicAiSummary | null;
  summaryMode: 'quick' | 'viewpoints' | 'full';
  summaryLoading: boolean;
  summaryError: ClientErrorCode | null;
  interests: InterestProfile | null;
  interestsLoading: boolean;
  interestsError: ClientErrorCode | null;
  recommendations: RecommendationList | null;
  recommendationsLoading: boolean;
  recommendationsError: ClientErrorCode | null;
  settings: PluginSettings | null;
  settingsLoading: boolean;
  settingsError: ClientErrorCode | null;
}

const initial: ClientState = { phase: 'checking', account: null, view: 'latest', tab: 'tech', nodeName: '', nodeInfo: null, nodes: null, nodesLoading: false, nodesError: null,
  topics: null, thread: null, loading: false, detailLoading: false, repliesLoading: false, error: null, detailError: null, repliesError: null,
  summary: null, summaryMode: 'quick', summaryLoading: false, summaryError: null,
  interests: null, interestsLoading: false, interestsError: null,
  recommendations: null, recommendationsLoading: false, recommendationsError: null,
  settings: null, settingsLoading: false, settingsError: null };
type Lane = 'session' | 'list' | 'detail' | 'replies' | 'summary' | 'nodes' | 'interests' | 'recommendations' | 'settings' |
  `recommendationRead:${number}` | `recommendationFeedback:${number}`;

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
  hasSummary = (): boolean => typeof this.remote.summary === 'function';
  private set(patch: Partial<ClientState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private start(lane: Lane): { signal: AbortSignal; current(): boolean; finish(): void } {
    this.controllers.get(lane)?.abort();
    const controller = new AbortController();
    this.controllers.set(lane, controller);
    const version = (this.versions.get(lane) ?? 0) + 1;
    this.versions.set(lane, version);
    const current = () => !this.disposed && !controller.signal.aborted && this.versions.get(lane) === version;
    return { signal: controller.signal, current, finish: () => {
      if (!current()) return;
      this.controllers.delete(lane); this.versions.delete(lane);
    } };
  }
  private stop(...lanes: Lane[]): void { for (const lane of lanes) this.controllers.get(lane)?.abort(); }
  private stopRecommendationActions(): void {
    for (const [lane, controller] of this.controllers) {
      if (lane.startsWith('recommendationRead:') || lane.startsWith('recommendationFeedback:')) {
        controller.abort(); this.controllers.delete(lane); this.versions.delete(lane);
      }
    }
  }
  private code(error: unknown): ClientErrorCode { return error instanceof V2exClientError ? error.code : 'upstream'; }
  private fail(error: unknown, patch: Partial<ClientState>): void {
    const code = this.code(error);
    if (code === 'not_authenticated' || code === 'token_expired') {
      this.sessionStatus({ authenticated: false, writable: false, username: null, tokenScope: null, expiresAt: null });
      this.set({ error: code });
    } else this.set(patch);
  }
  private sessionStatus(account: AccountStatus): void {
    this.stop('list', 'detail', 'replies', 'summary', 'nodes', 'interests', 'recommendations', 'settings');
    this.stopRecommendationActions();
    this.selectedTopicId = null;
    this.set({ account, phase: account.authenticated ? 'ready' : 'guest', topics: null, thread: null, nodeInfo: null, nodes: null, nodesLoading: false, nodesError: null,
      loading: false, detailLoading: false, repliesLoading: false, error: null, detailError: null, repliesError: null,
      summary: null, summaryLoading: false, summaryError: null, interests: null, interestsLoading: false, interestsError: null,
      recommendations: null, recommendationsLoading: false, recommendationsError: null, settings: null, settingsLoading: false, settingsError: null });
  }
  /** Transient boot/route failures are retried once before surfacing them. */
  private retryable(error: unknown): boolean {
    const code = this.code(error);
    return code === 'invalid_response' || code === 'plugin_unavailable' || code === 'offline';
  }
  async loadSession(): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    this.set({ phase: 'checking', error: null });
    try {
      const status = await this.remote.session(request.signal);
      if (request.current()) this.sessionStatus(status);
      return;
    } catch (error) {
      if (!request.current() || !this.retryable(error)) {
        if (request.current()) this.set({ phase: 'guest', error: this.code(error) });
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    if (!request.current()) return;
    try {
      const status = await this.remote.session(request.signal);
      if (request.current()) this.sessionStatus(status);
    } catch (error) {
      if (!request.current()) return;
      const code = this.code(error);
      // The plugin may still be registering its routes during Host startup.
      // Keep the login form clean for that case; a real login attempt will
      // surface the precise error.
      this.set({ phase: 'guest', error: code === 'invalid_response' || code === 'plugin_unavailable' || code === 'cancelled' ? null : code });
    }
  }
  async login(token: string): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    const previouslyReady = this.state.phase === 'ready';
    this.set({ loading: true, error: null });
    const attempt = async () => {
      const status = await this.remote.login(token, request.signal);
      if (!status.authenticated) throw new V2exClientError('invalid_response');
      return status;
    };
    try {
      const status = await attempt();
      if (request.current()) this.sessionStatus(status);
    } catch (error) {
      if (!request.current()) return;
      if (!this.retryable(error)) {
        this.set({ phase: previouslyReady ? 'ready' : 'guest', error: this.code(error) });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!request.current()) return;
      try {
        const status = await attempt();
        if (request.current()) this.sessionStatus(status);
      } catch (retryError) {
        if (request.current()) this.set({ phase: previouslyReady ? 'ready' : 'guest', error: this.code(retryError) });
      }
    } finally { if (request.current()) this.set({ loading: false }); }
  }
  async logout(clearPersonalData = false): Promise<void> {
    if (this.disposed) return;
    const request = this.start('session');
    this.stop('list', 'detail', 'replies', 'summary', 'nodes', 'interests', 'recommendations', 'settings');
    this.stopRecommendationActions();
    this.set({ loading: true, error: null });
    try { const status = await this.remote.logout(clearPersonalData, request.signal); if (request.current()) this.sessionStatus(status); }
    catch (error) { if (request.current()) this.set({ error: this.code(error), loading: false }); }
  }
  selectView(view: BrowseView): void {
    if (this.disposed || this.state.phase !== 'ready') return;
    this.stop('list', 'detail', 'replies', 'summary');
    this.selectedTopicId = null;
    this.set({ view, topics: null, thread: null, nodeInfo: null, error: null, detailError: null, repliesError: null,
      loading: false, detailLoading: false, repliesLoading: false });
    if (view === 'tabs') void this.loadTab();
    if (view === 'latest') void this.loadLatest();
    if (view === 'hot') void this.loadHot();
    if (view === 'node') void this.loadNodes();
    if (view === 'smart') void this.loadRecommendations();
    if (view === 'interests') void this.loadInterests();
    if (view === 'settings') void this.loadSettings();
  }
  /** Switch the V2EX topic tab and load its single page of topics. */
  selectTab(tab: TopicTab): void {
    if (this.disposed || this.state.phase !== 'ready') return;
    if (!(TOPIC_TABS as readonly string[]).includes(tab)) { this.set({ error: 'invalid_request' }); return; }
    this.stop('list', 'detail', 'replies', 'summary');
    this.selectedTopicId = null;
    this.set({ view: 'tabs', tab, topics: null, thread: null, nodeInfo: null, error: null, detailError: null, repliesError: null,
      loading: false, detailLoading: false, repliesLoading: false });
    void this.loadTab(tab);
  }
  async loadTab(tab: TopicTab = this.state.tab): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    if (!(TOPIC_TABS as readonly string[]).includes(tab)) { this.set({ error: 'invalid_request' }); return; }
    if (!this.remote.tab) { this.set({ error: 'incompatible_runtime' }); return; }
    const request = this.start('list');
    this.set({ view: 'tabs', tab, loading: true, error: null });
    try { const topics = await this.remote.tab(tab, request.signal); if (request.current()) this.set({ topics, loading: false }); }
    catch (error) { if (request.current()) this.fail(error, { loading: false, error: this.code(error) }); }
  }
  async loadNodes(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return;
    if (!this.remote.nodes) { this.set({ nodesError: 'incompatible_runtime' }); return; }
    const request = this.start('nodes');
    this.set({ nodesLoading: true, nodesError: null });
    try { const nodes = await this.remote.nodes(request.signal); if (request.current()) this.set({ nodes, nodesLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { nodesLoading: false, nodesError: this.code(error) }); }
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
    this.stop('replies', 'summary'); const request = this.start('detail');
    this.set({ thread: null, detailLoading: true, repliesLoading: false, detailError: null, repliesError: null,
      summary: null, summaryLoading: false, summaryError: null });
    try { const thread = await this.remote.topic(topicId, request.signal); if (request.current()) this.set({ thread, detailLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { detailLoading: false, detailError: this.code(error) }); }
  }
  closeTopic(): void { this.stop('detail', 'replies', 'summary'); this.selectedTopicId = null; this.set({ thread: null, detailError: null, repliesError: null, detailLoading: false, repliesLoading: false, summary: null, summaryLoading: false, summaryError: null }); }
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
  async generateSummary(mode: 'quick' | 'viewpoints' | 'full' = this.state.summaryMode): Promise<void> {
    const thread = this.state.thread;
    if (this.disposed || this.state.phase !== 'ready' || !thread || !this.remote.summary) return;
    const topicId = thread.value.topic.id;
    const request = this.start('summary');
    this.set({ summary: null, summaryMode: mode, summaryLoading: true, summaryError: null });
    try {
      const summary = await this.remote.summary(String(topicId), mode, Math.max(1, thread.value.replyPage || 1), request.signal);
      if (summary.topicId !== topicId || summary.mode !== mode) throw new V2exClientError('invalid_response');
      if (request.current() && this.state.thread?.value.topic.id === topicId && this.state.summaryMode === mode) this.set({ summary, summaryLoading: false });
    } catch (error) { if (request.current()) this.fail(error, { summary: null, summaryLoading: false, summaryError: this.code(error) }); }
  }
  setSummaryMode(mode: 'quick' | 'viewpoints' | 'full'): void {
    if (mode === this.state.summaryMode) return;
    this.stop('summary');
    this.set({ summary: null, summaryMode: mode, summaryLoading: false, summaryError: null });
  }
  async loadInterests(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || !this.remote.interests) return;
    const request = this.start('interests'); this.set({ interestsLoading: true, interestsError: null });
    try { const interests = await this.remote.interests('get', undefined, request.signal); if (request.current()) this.set({ interests, interestsLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { interestsLoading: false, interestsError: this.code(error) }); }
  }
  async changeInterests(action: 'authorize' | 'revoke' | 'relearn' | 'clear' | 'update', payload?: unknown): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || !this.remote.interests) return;
    const request = this.start('interests'); this.set({ interestsLoading: true, interestsError: null });
    try { const interests = await this.remote.interests(action, payload, request.signal); if (request.current()) this.set({ interests,
      interestsLoading: false, ...(action === 'clear' ? { recommendations: null } : {}) }); }
    catch (error) { if (request.current()) this.fail(error, { interestsLoading: false, interestsError: this.code(error) }); }
  }
  async loadRecommendations(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || !this.remote.recommendations) return;
    const request = this.start('recommendations'); this.set({ recommendationsLoading: true, recommendationsError: null });
    try { const recommendations = await this.remote.recommendations(request.signal); if (request.current()) this.set({ recommendations, recommendationsLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { recommendationsLoading: false, recommendationsError: this.code(error) }); }
  }
  async markRecommendationRead(topicId: number): Promise<void> {
    if (this.disposed || !this.remote.recommendationRead) return;
    const request = this.start(`recommendationRead:${topicId}`);
    try { await this.remote.recommendationRead(topicId, request.signal); if (request.current() && this.state.recommendations) this.set({ recommendations: {
      ...this.state.recommendations, items: this.state.recommendations.items.map(item => item.topic.id === topicId ? { ...item, read: true } : item) } }); }
    catch (error) { if (request.current()) this.set({ recommendationsError: this.code(error) }); }
    finally { request.finish(); }
  }
  async setRecommendationFeedback(topicId: number, value: 'interested' | 'not_interested'): Promise<void> {
    if (this.disposed || !this.remote.recommendationFeedback) return;
    const request = this.start(`recommendationFeedback:${topicId}`);
    try { await this.remote.recommendationFeedback(topicId, value, request.signal); if (request.current() && this.state.recommendations) this.set({ recommendations: {
      ...this.state.recommendations, items: this.state.recommendations.items.map(item => item.topic.id === topicId ? { ...item, feedback: value } : item) } }); }
    catch (error) { if (request.current()) this.set({ recommendationsError: this.code(error) }); }
    finally { request.finish(); }
  }
  async loadSettings(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || !this.remote.settings) return;
    const request = this.start('settings'); this.set({ settingsLoading: true, settingsError: null });
    try { const settings = await this.remote.settings(request.signal); if (request.current()) this.set({ settings, settingsLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { settingsLoading: false, settingsError: this.code(error) }); }
  }
  async saveSettings(settings: PluginSettings): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready' || !this.remote.updateSettings) return;
    const request = this.start('settings'); this.set({ settingsLoading: true, settingsError: null });
    try { const saved = await this.remote.updateSettings(settings, request.signal); if (request.current()) this.set({ settings: saved, settingsLoading: false }); }
    catch (error) { if (request.current()) this.fail(error, { settingsLoading: false, settingsError: this.code(error) }); }
  }
  retry(): void {
    if (this.state.detailError && this.selectedTopicId) { void this.openTopic(this.selectedTopicId); return; }
    if (this.state.repliesError) { void this.loadMoreReplies(); return; }
    if (this.state.nodesError) { void this.loadNodes(); return; }
    if (this.state.phase === 'guest') { void this.loadSession(); return; }
    if (this.state.view === 'tabs') void this.loadTab();
    else if (this.state.view === 'hot') void this.loadHot();
    else if (this.state.view === 'node') {
      if (this.state.nodeName) void this.loadNode(this.state.nodeName); else void this.loadNodes();
    } else void this.loadLatest();
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.stop('session', 'list', 'detail', 'replies', 'summary', 'nodes', 'interests', 'recommendations', 'settings'); this.stopRecommendationActions(); this.controllers.clear(); this.listeners.clear(); }
}
