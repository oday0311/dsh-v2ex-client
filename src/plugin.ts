import { V2exError } from './errors.js';
import type { Config } from './index.js';
import { V2exApi } from './v2ex-api.js';
import { AuthService, DshCredentialVault, type CredentialProvider } from './credentials.js';
import { v2exDomainSpec, DomainContentStore } from './store.js';
import { ContentCache, RequestBudget } from './cache.js';
import { ContentService } from './content-service.js';
import { createBrowsingTools, createInterestTool, createSummaryTool } from './tools.js';
import { DshModelGateway } from './model-gateway.js';
import { IntelligenceService } from './intelligence.js';
import { InterestService } from './interests.js';
import { DshHistoryReader } from './history.js';
import { registerV2exHttpRoutes, type FetchConnection } from './http-routes.js';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

export async function composePlugin(ctx: unknown, config: Config): Promise<{ dispose(): Promise<void> }> {
  const host = ctx as {
    credentials?: CredentialProvider;
    storageDomain?: { open(spec: typeof v2exDomainSpec): Promise<Domain<typeof v2exDomainSpec>> };
    tools?: { register(tool: ToolDefinition): () => void };
    get?: (name: string) => unknown;
    reflect?: { get(name: string): unknown };
    llm?: unknown;
    agentDefaultModel?: unknown;
    sessionQuery?: unknown;
  };
  if (!host.credentials || !host.storageDomain || !host.tools) {
    throw new V2exError('incompatible_runtime');
  }
  let connection: FetchConnection | undefined;
  try { connection = host.get?.('connection') as FetchConnection | undefined; }
  catch { throw new V2exError('incompatible_runtime'); }
  if (!connection?.fetch?.register) throw new V2exError('incompatible_runtime');
  const domain = await host.storageDomain.open(v2exDomainSpec);
  const disposers: Array<() => void | Promise<void>> = [];
  try {
    const api = new V2exApi({ fetch: globalThis.fetch, timeoutMs: config.requestTimeoutMs,
      responseLimitBytes: config.responseLimitBytes });
    const vault = new DshCredentialVault(host.credentials);
    const store = new DomainContentStore(domain);
    const optional = (name: 'llm' | 'agentDefaultModel') => {
      try { return host.reflect?.get(name) ?? host[name]; } catch { return undefined; }
    };
    const model = new DshModelGateway({
      get llm() { return optional('llm'); },
      get agentDefaultModel() { return optional('agentDefaultModel'); },
    } as never);
    const interests = new InterestService(store, new DshHistoryReader(() => {
      try { return host.reflect?.get('sessionQuery') ?? host.get?.('sessionQuery') ?? host.sessionQuery; }
      catch { return undefined; }
    }), model);
    const auth = new AuthService(api, vault, async () => {
      await interests.clear();
      for (const [key] of domain.table('recommendations').entries()) {
        await domain.table('recommendations').delete(key);
      }
    });
    const service = new ContentService(api, vault,
      new ContentCache(store), new RequestBudget());
    const intelligence = new IntelligenceService(model, store);
    for (const tool of createBrowsingTools(service)) disposers.push(host.tools.register(tool));
    disposers.push(host.tools.register(createSummaryTool(service, intelligence)));
    disposers.push(host.tools.register(createInterestTool(interests)));
    disposers.push(await registerV2exHttpRoutes(connection, { auth, credential: vault, content: service, intelligence, interests }));
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { await dispose(); } catch { /* Preserve startup error. */ } }
    await domain.close();
    throw error;
  }
  let disposing: Promise<void> | undefined;
  return { dispose() {
    return disposing ??= (async () => {
      let failed = false;
      for (const dispose of disposers.reverse()) { try { await dispose(); } catch { failed = true; } }
      try { await domain.close(); } catch { failed = true; }
      if (failed) throw new V2exError('incompatible_runtime');
    })();
  } };
}
