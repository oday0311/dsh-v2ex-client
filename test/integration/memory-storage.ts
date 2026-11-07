import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

type Route = {
  path: string;
  methods: string[];
  requestBody: 'buffered';
  fetch(request: Request): Promise<Response>;
};

class MemoryTable implements KvTable<string, unknown> {
  private readonly values = new Map<string, unknown>();
  get size() { return this.values.size; }
  get(key: string) { return this.values.get(key); }
  entries() { return new Map(this.values).entries(); }
  keys() { return new Map(this.values).keys(); }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async update(key: string, change: (current: unknown) => unknown) {
    if (!this.values.has(key)) throw new Error('missing-key');
    const value = structuredClone(change(this.values.get(key)));
    this.values.set(key, value);
    return value;
  }
}
class MemoryDomain implements Domain<DomainSpec> {
  readonly name: string;
  readonly global;
  private readonly tables = new Map<string, MemoryTable>();
  private closed = false;
  constructor(spec: DomainSpec, private readonly onClose: () => void) {
    this.name = spec.name;
    let globalValue = structuredClone(spec.global?.initial);
    this.global = {
      get: () => structuredClone(globalValue),
      set: async (value: unknown) => { if (this.closed) throw new Error('closed'); globalValue = structuredClone(value); },
    } as never;
    for (const name of Object.keys(spec.tables)) this.tables.set(name, new MemoryTable());
  }
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name);
    if (!table) throw new Error(`unknown table: ${name}`);
    return table;
  }
  async close() { if (this.closed) return; this.closed = true; this.onClose(); }
}

const tokenResult = { success: true, message: '', result: {
  scope: 'read', expiration: 1_900_000_000, created: 1_700_000_000,
} };
const memberResult = { success: true, message: '', result: {
  id: 42, username: 'fixture-reader', url: 'https://www.v2ex.com/member/fixture-reader', created: 1_700_000_000,
} };

export interface FixtureRuntime {
  toolNames(): string[];
  routePaths(): string[];
  openDomainCount(): number;
  externalRequests(): readonly string[];
  fetchRoute(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

export async function loadFixtureProfile(): Promise<FixtureRuntime> {
  const ctx = new Context();
  const tools = new Map<string, ToolDefinition>();
  const routes = new Map<string, Route>();
  const domains = new Set<MemoryDomain>();
  const credentials = new Map<string, string>();
  const externalRequests: string[] = [];
  const originalFetch = globalThis.fetch;
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
      const domain = new MemoryDomain(spec, () => domains.delete(domain));
      domains.add(domain);
      return domain;
    } }),
    ctx.provide('tools', { register(tool: ToolDefinition) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      tools.set(tool.name, tool);
      return () => { tools.delete(tool.name); };
    } }),
    ctx.provide('connection', { fetch: { register(route: Route) {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
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
    for (const dispose of providers.reverse()) await dispose();
    throw error;
  }

  let disposed = false;
  return {
    toolNames: () => [...tools.keys()],
    routePaths: () => [...routes.keys()],
    openDomainCount: () => domains.size,
    externalRequests: () => [...externalRequests],
    async fetchRoute(path, init = {}) {
      const url = new URL(path, 'http://fixture.local');
      const route = routes.get(url.pathname);
      if (!route) return new Response('not found', { status: 404 });
      return route.fetch(new Request(url, init));
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await fiber?.dispose(); }
      finally {
        for (const dispose of providers.reverse()) await dispose();
        globalThis.fetch = originalFetch;
      }
    },
  };
}
