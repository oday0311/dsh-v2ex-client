import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { SettingsView } from '../../src/client/SettingsView.js';
import { zh } from '../../src/client/locales.js';
import type { PluginSettings } from '../../src/contract.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://host.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
afterEach(cleanup);

const settings: PluginSettings = { refreshIntervalMinutes: 30, scannedNodes: ['programmer'], pagesPerNode: 2,
  aiCandidateBudget: 10, maxModelCallsPerRefresh: 1, notificationThreshold: 0.7, quietHours: null };

test('settings expose bounded refresh budgets and threshold value', () => {
  render(<SettingsView settings={settings} loading={false} error={null} copy={zh} onSave={() => {}} />);
  assert.equal((screen.getByLabelText('刷新间隔（分钟）') as HTMLInputElement).min, '1');
  assert.equal((screen.getByLabelText('每节点页数') as HTMLInputElement).max, '2');
  assert.equal((screen.getByLabelText('候选主题上限') as HTMLInputElement).max, '100');
  assert.equal(screen.getByText('通知阈值：70%').textContent, '通知阈值：70%');
});

test('quiet hours include an explicit enable switch and IANA timezone', () => {
  let saved: PluginSettings | undefined;
  render(<SettingsView settings={settings} loading={false} error={null} copy={zh} onSave={value => { saved = value; }} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '启用静默时段' }));
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '22:00' } });
  fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '07:00' } });
  fireEvent.change(screen.getByLabelText('时区'), { target: { value: 'Asia/Shanghai' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  assert.deepEqual(saved?.quietHours, { start: '22:00', end: '07:00', timeZone: 'Asia/Shanghai' });
});

test('invalid client input blocks submit while Host remains authoritative', () => {
  let saves = 0;
  render(<SettingsView settings={settings} loading={false} error={null} copy={zh} onSave={() => { saves++; }} />);
  fireEvent.change(screen.getByLabelText('刷新间隔（分钟）'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  assert.equal(saves, 0);
  assert.ok(screen.getByRole('alert'));
});
