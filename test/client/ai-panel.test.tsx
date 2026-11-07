import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { AiPanel } from '../../src/client/AiPanel.js';
import { zh } from '../../src/client/locales.js';
import type { TopicAiSummary } from '../../src/contract.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://host.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
afterEach(cleanup);

const summary: TopicAiSummary = {
  topicId: 7, summary: '简明归纳', viewpoints: ['观点 A'], notableReplies: [11],
  generatedAt: '2026-11-06T00:00:00.000Z', coveredReplyPages: [1, 2], completeDiscussion: false,
  coverage: { loadedReplyPages: 2, totalReplyPages: 5, complete: false, includedReplies: 20, omittedReplies: 30 },
  mode: 'quick', modelRoute: 'provider/model', topicUpdatedAt: '2026-11-06T00:00:00.000Z',
};

test('partial summaries disclose reply coverage without exposing provider routing', () => {
  render(<AiPanel summary={summary} mode="quick" loading={false} error={null} onMode={() => {}} onGenerate={() => {}} copy={zh} locale="zh" />);
  assert.ok(screen.getByText('已覆盖 2/5 页回复'));
  assert.ok(screen.getByText('内容并非完整讨论归纳'));
  assert.equal(document.body.textContent?.includes('provider/model'), false);
});

test('legacy summary provenance still discloses covered pages and incompleteness', () => {
  render(<AiPanel summary={{ ...summary, coverage: undefined, coveredReplyPages: [1, 3], completeDiscussion: false }}
    mode="quick" loading={false} error={null} onMode={() => {}} onGenerate={() => {}} copy={zh} locale="zh" />);
  assert.ok(screen.getByText('已覆盖回复页：1, 3'));
  assert.ok(screen.getByText('内容并非完整讨论归纳'));
});

test('summary modes are keyboard-friendly radio controls and regeneration is explicit', () => {
  const modes: string[] = []; let generated = 0;
  render(<AiPanel summary={summary} mode="quick" loading={false} error={null}
    onMode={value => modes.push(value)} onGenerate={() => { generated++; }} copy={zh} locale="zh" />);
  fireEvent.click(screen.getByRole('radio', { name: '观点与争议' }));
  fireEvent.click(screen.getByRole('button', { name: '重新生成总结' }));
  assert.deepEqual(modes, ['viewpoints']);
  assert.equal(generated, 1);
});

test('summary radio modes support arrow-key selection', () => {
  const modes: string[] = [];
  render(<AiPanel summary={summary} mode="quick" loading={false} error={null}
    onMode={value => modes.push(value)} onGenerate={() => {}} copy={zh} locale="zh" />);
  const quick = screen.getByRole('radio', { name: '快速总结' });
  quick.focus(); fireEvent.keyDown(quick, { key: 'ArrowRight' });
  assert.deepEqual(modes, ['viewpoints']);
  assert.equal(document.activeElement, screen.getByRole('radio', { name: '观点与争议' }));
});

test('summary loading has stable disabled controls and bounded public error copy', () => {
  const { rerender } = render(<AiPanel summary={null} mode="full" loading error={null}
    onMode={() => {}} onGenerate={() => {}} copy={zh} locale="zh" />);
  assert.equal((screen.getByRole('button', { name: '正在生成总结' }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('radio', { name: '重点回复' }) as HTMLButtonElement).disabled, true);
  rerender(<AiPanel summary={null} mode="full" loading={false} error="ai_unavailable"
    onMode={() => {}} onGenerate={() => {}} copy={zh} locale="zh" />);
  assert.ok(screen.getByRole('alert').textContent?.includes('智能功能暂不可用'));
});
