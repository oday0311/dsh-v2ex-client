import type { CredentialVault } from '../../src/credentials.js';

export class FakeCredentialVault implements CredentialVault {
  value: string | undefined;
  writable = true;
  setCalls: string[] = [];
  clearCount = 0;

  async resolve() { return this.value; }
  async set(value: string) { this.value = value; this.setCalls.push(value); }
  async clear() { this.value = undefined; this.clearCount++; }
  async describe() { return { configured: this.value !== undefined, writable: this.writable }; }
}

export function recordingFetch(response: Response | ((url: URL) => Response)): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return typeof response === 'function' ? response(new URL(url)) : response.clone();
    },
  };
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
