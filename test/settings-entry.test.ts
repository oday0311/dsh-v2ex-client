import assert from 'node:assert/strict';
import test from 'node:test';
import { registerV2exHttpRoutes } from '../src/http-routes.js';
import type { PluginSettings } from '../src/contract.js';

const settings: PluginSettings = { refreshIntervalMinutes: 30, scannedNodes: ['programmer'], pagesPerNode: 2,
  aiCandidateBudget: 10, maxModelCallsPerRefresh: 1, notificationThreshold: 0.7,
  quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' } };

async function fixture() {
  let route: { fetch(request: Request): Promise<Response> } | undefined;
  const calls: string[] = [];
  await registerV2exHttpRoutes({ fetch: { register(value) {
    if (value.path === '/api/v2ex/settings') route = value;
    return () => {};
  } } }, { auth: {} as never, credential: {} as never, content: {} as never,
    settings: { async get() { calls.push('get'); return settings; }, async update(value: PluginSettings) { calls.push(`put:${value.refreshIntervalMinutes}`); return value; } } } as never);
  return { calls, fetch: (method: string, body?: unknown, headers: Record<string, string> = {}) => route!.fetch(new Request('https://host.test/api/v2ex/settings', {
    method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) };
}

test('settings route reads and atomically writes a complete bounded account profile', async () => {
  const f = await fixture();
  const read = await f.fetch('GET');
  assert.deepEqual(await read.json(), { ok: true, data: settings });
  const next = { ...settings, refreshIntervalMinutes: 60, maxModelCallsPerRefresh: 0 };
  const write = await f.fetch('PUT', next);
  assert.deepEqual(await write.json(), { ok: true, data: next });
  assert.deepEqual(f.calls, ['get', 'put:60']);
});

test('settings route rejects invalid, extra, cross-origin, and non-JSON input before service I/O', async () => {
  const f = await fixture();
  for (const [body, headers] of [
    [{ ...settings, pagesPerNode: 21 }, {}],
    [{ ...settings, extra: true }, {}],
    [{ ...settings }, { origin: 'https://other.test' }],
    [{ ...settings }, { 'content-type': 'text/plain' }],
    [{ ...settings, quietHours: { start: '22:00', end: '07:00', timeZone: 'Not/AZone' } }, {}],
  ] as const) {
    const response = await f.fetch('PUT', body, headers);
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.calls, []);
});
