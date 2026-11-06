import React, { useRef, useState } from 'react';
import type { V2exClientStore } from './store.js';
import { zh } from './locales.js';

export function LoginView({ store, busy, error }: { store: V2exClientStore; busy: boolean; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = input.current?.value.trim() ?? '';
    if (!token) return;
    if (input.current) input.current.value = '';
    setWorking(true);
    try { await store.login(token); } finally { setWorking(false); }
  }
  return <section className="v2ex-login" aria-label={zh.title}>
    <h2>{zh.title}</h2>
    <form onSubmit={submit}>
      <label htmlFor="v2ex-token">{zh.loginLabel}</label>
      <input id="v2ex-token" ref={input} type="password" autoComplete="off" spellCheck={false} required disabled={busy || working} />
      {error && <p className="v2ex-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || working}>{working ? zh.loading : zh.login}</button>
    </form>
    <p className="v2ex-muted">{zh.loginHelp}</p>
  </section>;
}
