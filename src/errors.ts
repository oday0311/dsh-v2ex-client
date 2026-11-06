export const V2EX_ERROR_CODES = [
  'not_authenticated', 'token_invalid', 'token_expired', 'rate_limited',
  'offline', 'timeout', 'not_found', 'invalid_request', 'invalid_response',
  'upstream', 'ai_unavailable', 'history_access_denied', 'budget_exhausted',
  'incompatible_runtime',
] as const;

export type V2exErrorCode = typeof V2EX_ERROR_CODES[number];
export interface PublicError { code: V2exErrorCode; message: string; retryable: boolean }

const messages: Record<V2exErrorCode, string> = {
  not_authenticated: 'Sign in with a V2EX Personal Access Token.',
  token_invalid: 'The V2EX token is invalid. Replace it and try again.',
  token_expired: 'The V2EX token has expired. Replace it and try again.',
  rate_limited: 'V2EX is limiting requests. Try again later.',
  offline: 'V2EX is unavailable. Try again when connected.',
  timeout: 'The V2EX request timed out. Try again.',
  not_found: 'The requested V2EX content was not found.',
  invalid_request: 'Check the request and try again.',
  invalid_response: 'V2EX returned unexpected data. Try again later.',
  upstream: 'V2EX could not complete the request. Try again later.',
  ai_unavailable: 'AI features are unavailable. Try again later.',
  history_access_denied: 'Allow conversation-history access to use this feature.',
  budget_exhausted: 'The current request budget is exhausted. Try again later.',
  incompatible_runtime: 'The DSH runtime is incompatible with this plugin.',
};

const retryable = new Set<V2exErrorCode>([
  'rate_limited', 'offline', 'timeout', 'invalid_response', 'upstream', 'ai_unavailable',
]);

export class V2exError extends Error {
  constructor(public readonly code: V2exErrorCode) {
    super(messages[code]);
    this.name = 'V2exError';
  }
}

export function toPublicError(error: unknown): PublicError {
  const code = error instanceof V2exError ? error.code : 'upstream';
  return { code, message: messages[code], retryable: retryable.has(code) };
}
