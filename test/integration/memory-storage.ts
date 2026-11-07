import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { JSDOM } from 'jsdom';
import { apply as applyClient } from '../../src/client/index.js';

type Route = {
  path: string;
  methods: string[];
  requestBody: 'buffered';
  fetch(request: Request): Promise<Response>;
};

class MemoryTable implements KvTable<string, unknown> {
  readonly values = new Map<string, unknown>();
  constructor(private readonly domain: MemoryDomain) {}
  get size() { return this.domain.read(() => this.values.size); }
  get(key: string) { return this.domain.read(() => this.values.get(key)); }
  entries() { return this.domain.read(() => new Map(this.values).entries()); }
  keys() { return this.domain.read(() => new Map(this.values).keys()); }
  put(key: string, value: unknown) { return this.domain.write(() => { this.values.set(key, structuredClone(value)); }); }
  delete(key: string) { return this.domain.write(() => this.values.delete(key)); }
  update(key: string, change: (current: unknown) => unknown) {
    return this.domain.write(() => {
      if (!this.values.has(key)) throw new Error('missing-key');
      const value = structuredClone(change(this.values.get(key)));
      this.values.set(key, value); return value;
    });
  }
}
export class MemoryDomain implements Domain<DomainSpec> {
  readonly name: string;
  readonly global;
  private readonly tables = new Map<string, MemoryTable>();
  private state: 'active' | 'closing' | 'closed' = 'active';
  private chain: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private nextBarrier?: Promise<void>;
  private acceptedMutations = 0;
  private postCloseOperations = 0;
  private lateMutations = 0;
  private globalValue: unknown;
  constructor(spec: DomainSpec, private readonly onClose: () => void) {
    this.name = spec.name;
    this.globalValue = structuredClone(spec.global?.initial);
    this.global = {
      get: () => this.read(() => this.globalValue),
      set: (value: unknown) => this.write(() => { this.globalValue = structuredClone(value); }),
    } as never;
    for (const name of Object.keys(spec.tables)) this.tables.set(name, new MemoryTable(this));
  }
  read<T>(operation: () => T): T {
    if (this.state !== 'active') { this.postCloseOperations++; throw new Error(this.state); }
    return operation();
  }
  write<T>(operation: () => T): Promise<T> {
    if (this.state !== 'active') { this.postCloseOperations++; return Promise.reject(new Error(this.state)); }
    this.acceptedMutations++;
    const barrier = this.nextBarrier; this.nextBarrier = undefined;
    let result!: T;
    const accepted = this.chain.then(async () => {
      await barrier; result = operation();
      if (this.state === 'closed') this.lateMutations++;
    });
    this.chain = accepted.catch(() => {});
    return accepted.then(() => result);
  }
  blockNextWrite(barrier: Promise<void>): void { this.nextBarrier = barrier; }
  acceptedMutationCount(): number { return this.acceptedMutations; }
  postCloseAttemptCount(): number { return this.postCloseOperations; }
  lateMutationCount(): number { return this.lateMutations; }
  table(name: string): KvTable<string, unknown> {
    if (this.state !== 'active') { this.postCloseOperations++; throw new Error(this.state); }
    const table = this.tables.get(name);
    if (!table) throw new Error(`unknown table: ${name}`);
    return table;
  }
  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.state = 'closing';
    return this.disposal = this.chain.then(() => { this.state = 'closed'; this.onClose(); });
  }
}

export function createMemoryDomain(): MemoryDomain {
  return new MemoryDomain({ name: 'fixture', version: 1, tables: { cache: {} as never, summaries: {} as never } }, () => {});
}

const tokenResult = { success: true, message: '', result: {
  scope: 'read', expiration: 2_592_000, good_for_days: 30, created: 1_794_000_000,
} };
const memberResult = { success: true, message: '', result: {
  id: 42, username: 'fixture-reader', url: 'https://www.v2ex.com/member/fixture-reader', created: 1_700_000_000,
} };

export interface FixtureRuntime {
  toolNames(): string[];
  routes(): Array<{ path: string; methods: string[] }>;
  clientRegistrations(): Array<Record<string, unknown>>;
  clientInjectionNames(): string[];
  clientEffectLabels(): string[];
  leaks(): Record<string, number>;
  externalRequests(): readonly string[];
  fetchRoute(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export async function loadFixtureProfile(): Promise<FixtureRuntime> {
  const ctx = new Context();
  const tools = new Map<string, ToolDefinition>();
  const routes: Route[] = [];
  const domains = new Map<string, MemoryDomain>();
  const allDomains: MemoryDomain[] = [];
  const credentials = new Map<string, string>();
  const externalRequests: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const clientDom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { document: clientDom.window.document });
  const clientEffects = new Set<number>(); const clientEffectLabels: string[] = [];
  const clientCleanups: Array<() => unknown> = [];
  const clientSlots = new Map<string, { injection: string; descriptor: Record<string, unknown>; component: unknown }>();
  const clientInjections = new Set<string>();
  let nextEffect = 0; let clientLocales = 0; let clientMounts = 0;
  const clientContext = {
    effect(factory: () => unknown, label: string) {
      const id = ++nextEffect; clientEffects.add(id); clientEffectLabels.push(label);
      const value = factory(); let active = true;
      const cleanup = () => { if (!active) return; active = false;
        try { if (typeof value === 'function') return value(); } finally { clientEffects.delete(id); } };
      clientCleanups.push(cleanup); return cleanup;
    },
    locale: {
      register() { clientLocales++; let active = true; return () => { if (active) clientLocales--; active = false; }; },
      bind: () => () => 'V2EX', getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {},
    },
    slots: {
      inject(injection: string, factory: () => unknown) {
        if (clientInjections.has(injection)) throw new Error(`duplicate injection: ${injection}`);
        clientInjections.add(injection); const release = factory(); let active = true;
        return () => { if (!active) return; active = false; clientInjections.delete(injection);
          if (typeof release === 'function') return release(); };
      },
      register(descriptor: Record<string, unknown>, component: unknown) {
        const injection = String(descriptor.name); const identity = `${injection}:${String(descriptor.id ?? descriptor.key)}`;
        if (clientSlots.has(identity)) throw new Error(`duplicate client slot: ${identity}`);
        clientSlots.set(identity, { injection, descriptor, component }); clientMounts++; let active = true;
        return () => { if (!active) return; active = false; clientSlots.delete(identity); clientMounts--; };
      },
    },
  };
  applyClient(clientContext as never);
  let fiber: Fiber | undefined;

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    externalRequests.push(url.toString());
    if (url.origin !== 'https://www.v2ex.com' || init?.method !== 'GET') {
      throw new Error('fixture blocks non-read-only external traffic');
    }
    const value = url.pathname.endsWith('/token') ? tokenResult :
      url.pathname.endsWith('/member') ? memberResult : { success: true, message: '', result: [] };
    return new Response(JSON.stringify(value), { status: 200, headers: {
      'content-type': 'application/json', 'x-rate-limit-limit': '120', 'x-rate-limit-remaining': '119',
    } });
  };

  const providers = [
    ctx.provide('credentials', {
      async resolve(ref: string) { const value = credentials.get(ref); return value === undefined ? undefined : { value }; },
      async set(ref: string, value: string) { credentials.set(ref, value); },
      async unset(ref: string) { credentials.delete(ref); },
      async describe(ref: string) { return { configured: credentials.has(ref), writable: true }; },
    }),
    ctx.provide('storageDomain', { async open(spec: DomainSpec) {
      if (domains.has(spec.name)) throw new Error(`already-open: ${spec.name}`);
      const domain = new MemoryDomain(spec, () => { if (domains.get(spec.name) === domain) domains.delete(spec.name); });
      domains.set(spec.name, domain); allDomains.push(domain);
      return domain;
    } }),
    ctx.provide('tools', { register(tool: ToolDefinition) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
      return () => { tools.delete(tool.name); };
    } }),
    ctx.provide('connection', { fetch: { register(route: Route) {
      if (routes.some(value => value.path === route.path)) throw new Error(`duplicate route: ${route.path}`);
      routes.push(route); let active = true;
      return () => { if (!active) return; active = false; const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); };
    } } }),
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'deterministic' }) }),
    ctx.provide('llm', { async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }),
    ctx.provide('sessionQuery', { async listSessions() { return []; }, async filterEvents() { return []; } }),
  ];

  try {
    const runtime = await import('../../lib/index.js');
    const config = runtime.Config({ requestTimeoutMs: 1_000, responseLimitBytes: 256_000 });
    fiber = ctx.plugin({ name: runtime.name, inject: runtime.inject,
      apply: (pluginContext: Context) => runtime.apply(pluginContext, config) });
    await fiber.await();
    const deadline = Date.now() + 5_000;
    while (tools.size !== 7 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (tools.size !== 7) throw new Error('plugin did not finish loading');
  } catch (error) {
    globalThis.fetch = originalFetch;
    for (const cleanup of clientCleanups.reverse()) await cleanup();
    if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.assign(globalThis, { document: originalDocument });
    clientDom.window.close();
    for (const dispose of providers.reverse()) await dispose();
    throw error;
  }

  let disposed = false;
  return {
    toolNames: () => [...tools.keys()],
    routes: () => routes.map(route => ({ path: route.path, methods: [...route.methods] })).sort((a, b) => a.path.localeCompare(b.path)),
    clientRegistrations: () => [...clientSlots.values()].map(({ injection, descriptor }) => ({ injection,
      ...Object.fromEntries(Object.entries(descriptor).filter(([key, value]) => ['name', 'id', 'order', 'key'].includes(key) && typeof value !== 'function')) })),
    clientInjectionNames: () => [...clientInjections],
    clientEffectLabels: () => [...clientEffectLabels],
    leaks: () => ({ domains: domains.size, tools: tools.size, routes: routes.length, clientSlots: clientSlots.size,
      clientEffects: clientEffects.size, clientStyles: clientDom.window.document.querySelectorAll('style[data-v2ex-styles]').length,
      clientLocales, clientMounts, hostListeners: (ctx.events._hooks['agent/status']?.length ?? 0) + (ctx.events._hooks['agent/disposed']?.length ?? 0),
      postCloseAttempts: allDomains.reduce((sum, domain) => sum + domain.postCloseAttemptCount(), 0),
      lateMutations: allDomains.reduce((sum, domain) => sum + domain.lateMutationCount(), 0) }),
    externalRequests: () => [...externalRequests],
    async fetchRoute(path, init = {}) {
      const url = new URL(path, 'http://fixture.local');
      const route = routes.find(value => value.path === url.pathname);
      if (!route) return new Response('not found', { status: 404 });
      return route.fetch(new Request(url, init));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await fiber?.dispose(); }
      finally {
        for (const cleanup of clientCleanups.reverse()) await cleanup();
        if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
        else Object.assign(globalThis, { document: originalDocument });
        clientDom.window.close();
        for (const dispose of providers.reverse()) await dispose();
        globalThis.fetch = originalFetch;
      }
    },
  };
}
