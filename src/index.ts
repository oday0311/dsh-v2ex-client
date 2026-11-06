import { V2exError, toPublicError } from './errors.js';

export * from './contract.js';
export { V2exError, V2EX_ERROR_CODES, toPublicError } from './errors.js';
export { assertTopicId, assertNodeName, assertPage, assertLimit } from './validation.js';

export const name = 'v2ex-dsh-client';
export const inject = ['credentials', 'storageDomain', 'tools'];

export interface Config { requestTimeoutMs: number; responseLimitBytes: number }

export function Config(value: Partial<Config> = {}): Config {
  const requestTimeoutMs = value.requestTimeoutMs ?? 15_000;
  const responseLimitBytes = value.responseLimitBytes ?? 2_000_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isSafeInteger(responseLimitBytes) || responseLimitBytes < 1) {
    throw new V2exError('invalid_request');
  }
  return { requestTimeoutMs, responseLimitBytes };
}

interface HostContext {
  effect(callback: () => Promise<() => Promise<void> | void>, label: string): () => void;
  logger(name: string): { warn(message: string): void };
}

export function apply(ctx: HostContext, config: Config = Config({})): () => void {
  try {
    return ctx.effect(async () => {
      try {
        const { composePlugin } = await import('./plugin.js');
        const plugin = await composePlugin(ctx, config);
        return () => plugin.dispose();
      } catch (error) {
        const code = toPublicError(error instanceof V2exError
          ? error : new V2exError('incompatible_runtime')).code;
        ctx.logger(name).warn(code);
        return () => {};
      }
    }, 'v2ex-dsh-client: load');
  } catch {
    ctx.logger(name).warn('incompatible_runtime');
    return () => {};
  }
}
