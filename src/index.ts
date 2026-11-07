import { V2exError, toPublicError } from './errors.js';

export * from './contract.js';
export { V2exError, V2EX_ERROR_CODES, toPublicError } from './errors.js';
export { assertTopicId, assertNodeName, assertPage, assertLimit } from './validation.js';

export const name = 'v2ex-dsh-client';
export const inject = ['credentials', 'storageDomain', 'tools', 'connection'];

export interface Config { requestTimeoutMs: number; responseLimitBytes: number }

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 2_000_000;

function normalizeConfig(value: Partial<Config> = {}): Config {
  const requestTimeoutMs = value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const responseLimitBytes = value.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isSafeInteger(responseLimitBytes) || responseLimitBytes < 1) {
    throw new V2exError('invalid_request');
  }
  return { requestTimeoutMs, responseLimitBytes };
}

/** Standard Schema v1 result, the shape the Cordis loader reads from `Config`. */
interface ConfigValidation {
  value?: Config;
  issues?: Array<{ message: string; path?: Array<string | number> }>;
}

/**
 * Callable config schema. `Config(value)` keeps the hand-written callers
 * (tests and `apply` defaults) working, while `Config['~standard'].validate`
 * answers the Cordis loader: a plugin that exports a `Config` without Standard
 * Schema validation makes the Host fail activation with a `validate` TypeError.
 */
export interface ConfigSchema {
  (value?: Partial<Config>): Config;
  '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): ConfigValidation;
  };
}

export const Config: ConfigSchema = Object.assign(
  (value: Partial<Config> = {}): Config => normalizeConfig(value),
  {
    '~standard': {
      version: 1 as const,
      vendor: 'v2ex-dsh-client',
      validate(value: unknown): ConfigValidation {
        if (value === undefined) return { value: normalizeConfig() };
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { issues: [{ message: 'config must be an object' }] };
        }
        try {
          return { value: normalizeConfig(value as Partial<Config>) };
        } catch {
          return { issues: [{ message: 'invalid config' }] };
        }
      },
    },
  },
);

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
