import React, { useRef, useState } from 'react';
import type { V2exClientStore } from './store.js';
import type { Copy } from './locales.js';

export function LoginView({ store, busy, error, copy, replacement = false, onSuccess }: { store: V2exClientStore; busy: boolean; error: string | null; copy: Copy; replacement?: boolean; onSuccess?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = input.current?.value.trim() ?? '';
    if (!token) return;
    if (input.current) input.current.value = '';
    setWorking(true);
    try { await store.login(token); if (store.getSnapshot().phase === 'ready' && !store.getSnapshot().error) onSuccess?.(); }
    finally { setWorking(false); }
  }
  return <section className="v2ex-login" aria-label={replacement ? copy.replaceToken : copy.title}>
    <h2>{replacement ? copy.replaceToken : copy.title}</h2>
    <form onSubmit={submit}>
      <label htmlFor={replacement ? 'v2ex-replacement-token' : 'v2ex-token'}>{copy.loginLabel}</label>
      <input id={replacement ? 'v2ex-replacement-token' : 'v2ex-token'} ref={input} type="password" autoComplete="off" spellCheck={false} required disabled={busy || working} />
      {error && <p className="v2ex-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || working}>{working ? copy.loading : replacement ? copy.replaceToken : copy.login}</button>
    </form>
    <p className="v2ex-muted">{copy.loginHelp}</p>
  </section>;
}
