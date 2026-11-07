import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { InterestView } from '../../src/client/InterestView.js';
import { zh } from '../../src/client/locales.js';
import type { InterestProfile } from '../../src/contract.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://host.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
afterEach(cleanup);

const profile = (authorized: boolean): InterestProfile => ({ authorized, learningPaused: false,
  labels: [{ name: 'TypeScript', weight: 0.8 }], preferredNodes: [{ name: 'programmer', weight: 0.7 }],
  exclusions: ['招聘'], feedback: [], updatedAt: '2026-11-06T00:00:00.000Z', source: authorized ? 'history' : 'manual' });

test('history learning requires an explicit authorization action', () => {
  render(<InterestView profile={profile(false)} loading={false} error={null} copy={zh}
    onAuthorize={() => {}} onUpdate={() => {}} onPause={() => {}} onRelearn={() => {}} onRevoke={() => {}} onClear={() => {}} />);
  assert.ok(screen.getByRole('button', { name: '授权读取历史并学习' }));
  assert.equal(screen.queryByRole('button', { name: '重新学习' }), null);
  assert.ok(screen.getByText(/只读取你的历史用户消息/));
});

test('authorized profile exposes editable weighted fields and saves structured values', () => {
  let updated: unknown;
  render(<InterestView profile={profile(true)} loading={false} error={null} copy={zh}
    onAuthorize={() => {}} onUpdate={value => { updated = value; }} onPause={() => {}} onRelearn={() => {}} onRevoke={() => {}} onClear={() => {}} />);
  fireEvent.change(screen.getByLabelText('兴趣标签'), { target: { value: 'TypeScript:0.9, Rust:0.6' } });
  fireEvent.change(screen.getByLabelText('偏好节点'), { target: { value: 'programmer:0.8' } });
  fireEvent.change(screen.getByLabelText('排除内容'), { target: { value: '招聘, 币圈' } });
  fireEvent.click(screen.getByRole('button', { name: '保存兴趣设置' }));
  assert.deepEqual(updated, { labels: [{ name: 'TypeScript', weight: 0.9 }, { name: 'Rust', weight: 0.6 }],
    preferredNodes: [{ name: 'programmer', weight: 0.8 }], exclusions: ['招聘', '币圈'] });
});

test('revoke and clear require a second explicit confirmation while pause stays reversible', () => {
  let revoked = 0; let cleared = 0; const pauses: boolean[] = [];
  render(<InterestView profile={profile(true)} loading={false} error={null} copy={zh}
    onAuthorize={() => {}} onUpdate={() => {}} onPause={value => pauses.push(value)} onRelearn={() => {}}
    onRevoke={() => { revoked++; }} onClear={() => { cleared++; }} />);
  fireEvent.click(screen.getByRole('button', { name: '暂停自动学习' }));
  assert.deepEqual(pauses, [true]);
  fireEvent.click(screen.getByRole('button', { name: '撤销历史授权' }));
  assert.equal(revoked, 0);
  fireEvent.click(screen.getByRole('button', { name: '确认撤销历史授权' }));
  fireEvent.click(screen.getByRole('button', { name: '清除兴趣与推荐数据' }));
  assert.equal(cleared, 0);
  fireEvent.click(screen.getByRole('button', { name: '确认清除兴趣与推荐数据' }));
  assert.equal(revoked, 1); assert.equal(cleared, 1);
});
