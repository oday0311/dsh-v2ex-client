import { V2exError } from './errors.js';
import type { Config } from './index.js';
import { V2exApi } from './v2ex-api.js';
import { DshCredentialVault, type CredentialProvider } from './credentials.js';
import { v2exDomainSpec, DomainContentStore } from './store.js';
import { ContentCache, RequestBudget } from './cache.js';
import { ContentService } from './content-service.js';
import { createBrowsingTools } from './tools.js';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

export async function composePlugin(ctx: unknown, config: Config): Promise<{ dispose(): void }> {
  const host = ctx as {
    credentials?: CredentialProvider;
    storageDomain?: { open(spec: typeof v2exDomainSpec): Promise<Domain<typeof v2exDomainSpec>> };
    tools?: { register(tool: ToolDefinition): () => void };
  };
  if (!host.credentials || !host.storageDomain || !host.tools) {
    throw new V2exError('incompatible_runtime');
  }
  const domain = await host.storageDomain.open(v2exDomainSpec);
  const disposers: Array<() => void> = [];
  try {
    const api = new V2exApi({ fetch: globalThis.fetch, timeoutMs: config.requestTimeoutMs,
      responseLimitBytes: config.responseLimitBytes });
    const service = new ContentService(api, new DshCredentialVault(host.credentials),
      new ContentCache(new DomainContentStore(domain)), new RequestBudget());
    for (const tool of createBrowsingTools(service)) disposers.push(host.tools.register(tool));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    await domain.close();
    throw error;
  }
  let disposed = false;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) dispose();
    void domain.close().catch(() => {});
  } };
}
