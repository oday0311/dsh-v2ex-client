import React from 'react';
import { createRoot } from 'react-dom/client';

type ClientModule = { apply(ctx: unknown): void };
type LoaderEntry = { id: string; factory(require: (name: string) => unknown): ClientModule };

declare global {
  interface Window {
    __ModuleLoader__: { load(entry: LoaderEntry): void };
    __V2EX_HARNESS__?: { mounted: boolean; cleanup(): void };
  }
}

let client: ClientModule | undefined;
window.__ModuleLoader__ = { load(entry) {
  if (entry.id !== 'v2ex-dsh-client') throw new Error(`unexpected client module: ${entry.id}`);
  client = entry.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`external browser dependency is unavailable: ${name}`);
  });
} };

window.addEventListener('DOMContentLoaded', () => {
  if (!client) throw new Error('built V2EX client did not register');
  const cleanups: Array<() => void> = [];
  const mount = document.getElementById('app');
  if (!mount) throw new Error('missing harness mount');
  const root = createRoot(mount);
  let mounted = false;
  const localeSnapshot = { active: 'zh' };
  const ctx = {
    effect(factory: () => unknown) {
      const result = factory();
      if (typeof result === 'function') cleanups.push(result as () => void);
      return () => {};
    },
    locale: {
      register: () => () => {}, bind: () => () => 'V2EX',
      getSnapshot: () => localeSnapshot, subscribe: () => () => {},
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register(entry: { name: string; key?: string }, component: React.ComponentType) {
        if (entry.name === 'main' && entry.key === 'v2ex') {
          root.render(React.createElement(component));
          mounted = true;
        }
        return () => {};
      },
    },
  };
  client.apply(ctx);
  window.__V2EX_HARNESS__ = { mounted, cleanup() {
    for (const cleanup of cleanups.reverse()) cleanup();
    root.unmount();
  } };
});
