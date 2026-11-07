import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { analyzePng, informativeImageFailures } from '../support/png-stats.js';
import { positionScroll, type ScrollPositionAdapter } from '../support/scroll-position.js';

const NOW = '2026-11-07T08:00:00.000Z';
const error = (code: string) => ({ ok: false, error: { code, message: 'fixture error', retryable: true } });
const ok = (data: unknown) => ({ ok: true, data });
const cached = (value: unknown, stale = false) => ({ value, fetchedAt: NOW, stale, source: stale ? 'cache' : 'network' });

function topic(id = 61, title = 'TypeScript 6 严格模式实践') {
  return { id, title, node: { name: 'typescript', title: 'TypeScript' }, author: { username: 'fixture-author' },
    replyCount: 42, createdAt: NOW, lastReplyAt: NOW, url: `https://www.v2ex.com/t/${id}` };
}

interface ApiState {
  authenticated: boolean; username: string; external: string[]; consoleErrors: string[];
  localApiRequests: string[];
  offline: boolean; aiUnavailable: boolean; malformed: boolean; longContent: boolean;
  profile: { authorized: boolean; learningPaused: boolean; labels: Array<{ name: string; weight: number }>;
    preferredNodes: Array<{ name: string; weight: number }>; exclusions: string[];
    feedback: Array<{ topicId: number; interested: boolean }>; updatedAt: string; source: 'manual' | 'history' | 'mixed' };
  settings: { refreshIntervalMinutes: number; scannedNodes: string[]; pagesPerNode: number;
    aiCandidateBudget: number; maxModelCallsPerRefresh: number; notificationThreshold: number;
    quietHours: null | { start: string; end: string; timeZone: string } };
}

async function setup(page: Page): Promise<ApiState> {
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('Playwright baseURL is required');
  const harnessOrigin = new URL(baseURL).origin;
  const state: ApiState = {
    authenticated: false, username: 'fixture-reader', external: [], consoleErrors: [], localApiRequests: [], offline: false,
    aiUnavailable: false, malformed: false, longContent: false,
    profile: { authorized: false, learningPaused: false, labels: [{ name: 'TypeScript', weight: 0.9 }],
      preferredNodes: [{ name: 'typescript', weight: 0.8 }], exclusions: ['招聘'], feedback: [], updatedAt: NOW, source: 'manual' },
    settings: { refreshIntervalMinutes: 30, scannedNodes: ['typescript'], pagesPerNode: 2,
      aiCandidateBudget: 10, maxModelCallsPerRefresh: 1, notificationThreshold: 0.7, quietHours: null },
  };
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
  page.on('pageerror', value => state.consoleErrors.push(value.message));
  await page.addInitScript((fixed) => {
    const NativeDate = Date;
    class FixtureDate extends NativeDate {
      constructor(...args: ConstructorParameters<typeof Date>) { super(...(args.length ? args : [fixed])); }
      static now() { return new NativeDate(fixed).getTime(); }
    }
    Object.defineProperty(window, 'Date', { value: FixtureDate });
  }, NOW);
  await page.route('**/api/v2ex/**', route => {
    const url = new URL(route.request().url());
    if (url.origin !== harnessOrigin) { state.external.push(url.toString()); return route.abort('blockedbyclient'); }
    return api(route, state);
  });
  // Registered last, this guard runs first; local API calls fall through to the exact fixture above.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== harnessOrigin) { state.external.push(url.toString()); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/api/v2ex/')) return route.fallback();
    return route.continue();
  });
  return state;
}

async function api(route: Route, state: ApiState): Promise<void> {
  const request = route.request(); const url = new URL(request.url());
  state.localApiRequests.push(url.toString());
  const path = url.pathname.slice('/api/v2ex'.length); const method = request.method();
  let body: unknown; try { body = request.postDataJSON(); } catch { body = undefined; }
  let result: unknown;
  if (path === '/session' && method === 'GET') {
    result = ok({ authenticated: state.authenticated, writable: true, username: state.authenticated ? state.username : null,
      tokenScope: state.authenticated ? 'read' : null, expiresAt: state.authenticated ? '2030-03-17T17:46:40.000Z' : null });
  } else if (path === '/session' && method === 'POST') {
    const token = (body as { token?: string } | undefined)?.token ?? '';
    if (token.includes('expired')) result = error('token_expired');
    else { state.authenticated = true; state.username = token.includes('second') ? 'fixture-second' : 'fixture-reader';
      result = ok({ authenticated: true, writable: true, username: state.username, tokenScope: 'read', expiresAt: '2030-03-17T17:46:40.000Z' }); }
  } else if (path === '/session' && method === 'DELETE') {
    state.authenticated = false; result = ok({ authenticated: false, writable: true, username: null, tokenScope: null, expiresAt: null });
  } else if (!state.authenticated) result = error('not_authenticated');
  else if (path === '/latest') result = state.offline ? error('offline') : state.malformed ?
    ok(cached({ items: [{ ...topic(), title: 'bad\u0000title' }], page: 1, hasMore: false, stale: false })) :
    ok(cached({ items: [topic(), topic(62, 'Rust 异步运行时对比')], page: 1, hasMore: false, stale: false }));
  else if (path === '/hot') result = ok(cached([topic(63, '本周热门开发讨论')]));
  else if (path === '/node') result = ok(cached({ name: 'typescript', title: 'TypeScript', topicCount: 2, url: 'https://www.v2ex.com/go/typescript' }));
  else if (path === '/node/topics') result = ok(cached({ items: [topic()], page: 1, hasMore: false, stale: false }));
  else if (path === '/topic') {
    const longTitle = `TypeScript-${'VeryLongUnbrokenIdentifier'.repeat(120)}`;
    result = ok(cached({ topic: topic(61, state.longContent ? longTitle : undefined),
      content: state.longContent ? '超长内容'.repeat(650).slice(0, 4_000) : '这是一个关于 TypeScript 6 的确定性测试主题。',
      replies: [{ id: 1, author: { username: 'reply-user' }, content: '回复内容一', createdAt: NOW }],
      replyPage: 0, hasMoreReplies: true, stale: false }));
  } else if (path === '/replies') result = ok(cached([{ id: 2, author: { username: 'another-user' }, content: '第一页回复', createdAt: NOW }]));
  else if (path === '/topic/summary') result = state.aiUnavailable ? error('ai_unavailable') : ok({ topicId: 61,
    summary: 'TypeScript 6 的重点是更可预测的类型检查。', viewpoints: ['支持者关注安全性', '反对者关注迁移成本'],
    notableReplies: [1], generatedAt: NOW, coveredReplyPages: [1], completeDiscussion: false,
    coverage: { loadedReplyPages: 1, totalReplyPages: 3, complete: false, includedReplies: 1, omittedReplies: 41, contentTruncated: false },
    mode: (body as { mode?: string })?.mode ?? 'quick' });
  else if (path === '/interests' && method === 'GET') result = ok(state.profile);
  else if (path === '/interests' && method === 'PUT') { state.profile = { ...state.profile, ...(body as Partial<ApiState['profile']>), source: 'mixed', updatedAt: '2026-11-07T08:01:00.000Z' }; result = ok(state.profile); }
  else if (path === '/interests' && method === 'POST') {
    const action = (body as { action?: string })?.action;
    if (action === 'authorize') state.profile = { ...state.profile, authorized: true, updatedAt: '2026-11-07T08:02:00.000Z' };
    if (action === 'revoke') state.profile = { ...state.profile, authorized: false, updatedAt: '2026-11-07T08:03:00.000Z' };
    if (action === 'relearn') state.profile = { ...state.profile, labels: [{ name: 'TypeScript', weight: 0.95 }], source: 'history', updatedAt: '2026-11-07T08:04:00.000Z' };
    result = ok(state.profile);
  } else if (path === '/interests' && method === 'DELETE') {
    state.profile = { ...state.profile, authorized: false, labels: [], preferredNodes: [], exclusions: [], feedback: [], source: 'manual', updatedAt: '2026-11-07T08:05:00.000Z' }; result = ok(state.profile);
  } else if (path === '/recommendations' && method === 'GET') result = ok({ items: [{ topic: topic(), score: 0.96,
    reason: '匹配 TypeScript 与类型安全偏好', matchedInterests: ['TypeScript'], generatedAt: NOW, read: false, feedback: null }],
    generatedAt: NOW, stale: false, source: 'generated' });
  else if (path === '/recommendations/read' || path === '/recommendations/feedback') result = ok({ updated: true });
  else if (path === '/settings' && method === 'GET') result = ok(state.settings);
  else if (path === '/settings' && method === 'PUT') { state.settings = body as ApiState['settings']; result = ok(state.settings); }
  else result = error('not_found');
  await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(result) });
}

async function login(page: Page, token = 'fixture-read-only-token'): Promise<void> {
  const input = page.getByLabel('V2EX Personal Access Token');
  await input.focus(); await input.fill(token); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '登录' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('tab', { name: '最新' })).toBeVisible();
}

async function assertLayout(page: Page): Promise<void> {
  const issues = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('.v2ex-app'); if (!app) return ['missing app'];
    const failures: string[] = []; const appRect = app.getBoundingClientRect();
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 &&
        rect.bottom > appRect.top && rect.top < appRect.bottom && rect.right > appRect.left && rect.left < appRect.right;
    };
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) failures.push('document horizontal overflow');
    if (app.scrollWidth > app.clientWidth + 1) failures.push('app horizontal overflow');
    const controls = [...app.querySelectorAll<HTMLElement>('button,input')].filter(visible);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (rect.left < appRect.left - 1 || rect.right > appRect.right + 1) failures.push(`control clipped: ${control.getAttribute('aria-label') ?? control.textContent}`);
      const name = control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent?.trim() ||
        (control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent?.trim() : '') || control.closest('label')?.textContent?.trim();
      if (!name) failures.push('unnamed control');
    }
    const textElements = [...app.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,span,label,button,legend')]
      .filter(element => visible(element) && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
    for (const element of textElements) {
      const style = getComputedStyle(element);
      const horizontal = element.scrollWidth > element.clientWidth + 1;
      const vertical = element.scrollHeight > element.clientHeight + 1;
      if (horizontal && /^(hidden|clip|auto|scroll)$/.test(style.overflowX)) failures.push(`text horizontally clipped: ${element.textContent?.trim().slice(0, 40)}`);
      if (vertical && /^(hidden|clip|auto|scroll)$/.test(style.overflowY)) failures.push(`text vertically clipped: ${element.textContent?.trim().slice(0, 40)}`);
      for (let parent = element.parentElement; parent && parent !== app; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent); const parentRect = parent.getBoundingClientRect(); const rect = element.getBoundingClientRect();
        if (/^(hidden|clip)$/.test(parentStyle.overflowX) && (rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1)) failures.push(`text clipped by ancestor: ${element.textContent?.trim().slice(0, 40)}`);
        if (/^(hidden|clip)$/.test(parentStyle.overflowY) && (rect.top < parentRect.top - 1 || rect.bottom > parentRect.bottom + 1)) failures.push(`text vertically clipped by ancestor: ${element.textContent?.trim().slice(0, 40)}`);
      }
    }
    const regions = [...app.querySelectorAll<HTMLElement>('.v2ex-header,.v2ex-tabs,.v2ex-active-panel,.v2ex-detail,.v2ex-workflow')].filter(visible);
    const candidates = [...app.querySelectorAll<HTMLElement>('button,input,h2,h3,h4,p,label')].filter(visible);
    for (let left = 0; left < candidates.length; left++) for (let right = left + 1; right < candidates.length; right++) {
      const first = candidates[left]!, second = candidates[right]!;
      if (first.contains(second) || second.contains(first) || !regions.some(region => region.contains(first) && region.contains(second))) continue;
      const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
        failures.push(`visible elements overlap: ${first.tagName}/${second.tagName}`);
      }
    }
    return failures;
  });
  expect(issues).toEqual([]);
}

async function assertStable(page: Page): Promise<void> {
  const first = await page.locator('.v2ex-app').boundingBox(); await page.waitForTimeout(120);
  expect(await page.locator('.v2ex-app').boundingBox()).toEqual(first);
}
type ScrollDepth = 'top' | 'mid' | 'bottom';
async function traverseScrollSlices(page: Page, testInfo: TestInfo, scenario: string,
  atDepth?: (depth: ScrollDepth) => Promise<void>): Promise<string[]> {
  const app = page.locator('.v2ex-app');
  const scroll: ScrollPositionAdapter = {
    setScrollTop: target => app.evaluate((element, value) => { element.scrollTop = value; }, target),
    readScrollMetrics: () => app.evaluate(element => ({ position: element.scrollTop,
      maximum: Math.max(0, element.scrollHeight - element.clientHeight) })),
    settleFrame: () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))),
  };
  const initial = await scroll.readScrollMetrics();
  const requested: Array<{ depth: ScrollDepth; position: number }> = [
    { depth: 'top', position: 0 },
    { depth: 'mid', position: Math.round(initial.maximum / 2) },
    { depth: 'bottom', position: initial.maximum },
  ];
  const positions = requested.filter((entry, index) => requested.findIndex(other => Math.abs(other.position - entry.position) <= 1) === index);
  const names: string[] = [];
  const positionAndValidate = async (target: number) => {
    const settled = await positionScroll(scroll, target);
    await page.waitForTimeout(120); await assertStable(page); await assertLayout(page);
    return settled;
  };
  let primaryFailure: unknown; let failed = false;
  try {
    for (const { depth, position } of positions) {
      await positionAndValidate(position); await atDepth?.(depth);
      const name = `${scenario}-${depth}`;
      const pixels = await app.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' });
      expect(informativeImageFailures(analyzePng(pixels)), name).toEqual([]); names.push(name);
    }
  } catch (error) {
    failed = true; primaryFailure = error;
  }
  let restorationFailure: unknown;
  try {
    await positionAndValidate(initial.position);
  } catch (error) {
    restorationFailure = error;
  }
  if (failed && restorationFailure !== undefined) {
    throw new AggregateError([primaryFailure, restorationFailure], `${scenario}: scenario and scroll restoration both failed`);
  }
  if (failed) throw primaryFailure;
  if (restorationFailure !== undefined) throw restorationFailure;
  return names;
}
function assertNoEscapes(state: ApiState) { expect(state.external).toEqual([]); expect(state.consoleErrors).toEqual([]); }

test('login to recommendation to summary workflow', async ({ page }, testInfo) => {
  const state = await setup(page); await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__V2EX_HARNESS__?.mounted)).toBe(true); await login(page);
  const latest = page.getByRole('tab', { name: '最新' }); await latest.focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: /智能推荐/ })).toBeFocused();
  await page.getByRole('tab', { name: /智能推荐/ }).click(); await page.getByRole('button', { name: /TypeScript 6/ }).click();
  await page.getByRole('button', { name: '生成总结' }).click(); await expect(page.getByText('已覆盖 1/3 页回复')).toBeVisible();
  const captures = await traverseScrollSlices(page, testInfo, 'workflow', async depth => {
    if (depth === 'bottom') await expect(page.getByText('已覆盖 1/3 页回复')).toBeInViewport();
  });
  if (testInfo.project.name === 'mobile-390') expect(captures).toEqual(['workflow-top', 'workflow-mid', 'workflow-bottom']);
  assertNoEscapes(state);
});

test('interest consent, editing, settings, account switch, and clear logout', async ({ page }, testInfo) => {
  const state = await setup(page); await page.goto('/'); await login(page);
  await page.getByRole('tab', { name: '兴趣管理' }).click(); await page.getByLabel('兴趣标签').fill('TypeScript:1, Rust:0.7');
  await page.getByLabel('偏好节点').fill('typescript:1, rust:0.6'); await page.getByLabel('排除内容').fill('招聘, 广告');
  await page.getByRole('button', { name: '保存兴趣设置' }).click(); await expect.poll(() => state.profile.labels.length).toBe(2);
  await page.getByRole('button', { name: '授权读取历史并学习' }).click(); await expect.poll(() => state.profile.authorized).toBe(true);
  await page.getByRole('tab', { name: '设置' }).click(); await page.getByLabel('扫描节点').fill('typescript, rust');
  await page.getByRole('button', { name: '保存设置' }).click(); await expect.poll(() => state.settings.scannedNodes.join(',')).toBe('typescript,rust');
  await page.getByRole('button', { name: '更换令牌' }).click(); await page.getByLabel('V2EX Personal Access Token').fill('fixture-second-token');
  await page.getByRole('button', { name: '更换令牌' }).last().click(); await expect(page.getByText('fixture-second', { exact: true })).toBeVisible();
  await page.getByLabel('同时清除个人数据').check(); await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  await traverseScrollSlices(page, testInfo, 'lifecycle'); assertNoEscapes(state);
});

test('offline, expired token, AI unavailable, and malformed response stay contained', async ({ page }, testInfo) => {
  const state = await setup(page); await page.goto('/'); await page.getByLabel('V2EX Personal Access Token').fill('fixture-expired-token');
  await page.getByRole('button', { name: '登录' }).click(); await expect(page.getByRole('alert')).toContainText('令牌已过期');
  state.offline = true; await login(page); await expect(page.getByRole('alert')).toContainText('网络不可用');
  state.offline = false; await page.getByRole('button', { name: '刷新' }).click(); await page.getByRole('button', { name: /TypeScript 6/ }).click();
  state.aiUnavailable = true; await page.getByRole('button', { name: '生成总结' }).click(); await expect(page.getByRole('alert')).toContainText('智能功能暂不可用');
  await page.getByRole('button', { name: '返回列表' }).click(); state.malformed = true; await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByRole('alert')).toContainText('返回内容异常');
  await traverseScrollSlices(page, testInfo, 'contained-errors'); assertNoEscapes(state);
});

test('long unbroken titles and content wrap without clipping', async ({ page }, testInfo) => {
  const state = await setup(page); state.longContent = true; await page.goto('/'); await login(page);
  await page.getByRole('tab', { name: /智能推荐/ }).click(); await page.getByRole('button', { name: /TypeScript 6/ }).click();
  await expect(page.locator('.v2ex-detail h3')).toBeVisible();
  const captures = await traverseScrollSlices(page, testInfo, 'long-content', async depth => {
    if (depth === 'bottom') {
      await expect(page.locator('.v2ex-replies')).toBeInViewport();
      await expect(page.locator('.v2ex-ai-panel')).toBeInViewport();
    }
  });
  expect(captures).toEqual(['long-content-top', 'long-content-mid', 'long-content-bottom']);
  assertNoEscapes(state);
});

test('external origin cannot reuse the local V2EX API fixture path', async ({ page }) => {
  const state = await setup(page); await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__V2EX_HARNESS__?.mounted)).toBe(true);
  await expect.poll(() => state.localApiRequests.length).toBeGreaterThan(0);
  const localRequestCount = state.localApiRequests.length;
  const result = await page.evaluate(async () => {
    try { await fetch('https://evil.example/api/v2ex/session'); return 'unexpected-success'; }
    catch { return 'blocked'; }
  });
  expect(result).toBe('blocked');
  expect(state.authenticated).toBe(false);
  expect(state.localApiRequests).toHaveLength(localRequestCount);
  expect(state.external).toEqual(['https://evil.example/api/v2ex/session']);
});

test.afterEach(async ({ page }) => { await page.evaluate(() => window.__V2EX_HARNESS__?.cleanup()); });
