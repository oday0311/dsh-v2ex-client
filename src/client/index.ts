import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import './slots.js';
import { createV2exHttpClient } from './http.js';
import { V2exClientStore } from './store.js';
import { V2exApp } from './V2exApp.js';
import { SidebarIcon } from './sidebar.js';
import { injectStyles } from './styles.js';
import { zh } from './locales.js';

export const name = 'v2ex-dsh-client';
export const inject = ['slots'];

export function apply(ctx: Context): void {
  const store = new V2exClientStore(createV2exHttpClient());
  ctx.effect(() => () => store.dispose(), 'v2ex: store');
  ctx.effect(() => injectStyles(), 'v2ex: styles');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'v2ex', order: 27, label: () => zh.title,
  }, SidebarIcon)), 'v2ex: sidebar entry');
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'v2ex',
  }, () => React.createElement(V2exApp, { store }))), 'v2ex: main panel');
}
