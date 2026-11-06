import { V2exError } from './errors.js';
import type { Config } from './index.js';

export async function composePlugin(ctx: unknown, _config: Config): Promise<{ dispose(): void }> {
  const host = ctx as { credentials?: unknown; storageDomain?: unknown; tools?: unknown };
  if (!host.credentials || !host.storageDomain || !host.tools) {
    throw new V2exError('incompatible_runtime');
  }
  return { dispose() {} };
}
