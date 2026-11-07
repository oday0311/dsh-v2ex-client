import React, { useEffect, useState } from 'react';
import { Save, SlidersHorizontal } from 'lucide-react';
import type { PluginSettings } from '../contract.js';
import type { ClientErrorCode } from './http.js';
import type { Copy } from './locales.js';

export function SettingsView({ settings, loading, error, copy, onSave }: {
  settings: PluginSettings | null; loading: boolean; error: ClientErrorCode | null; copy: Copy;
  onSave(settings: PluginSettings): void;
}) {
  const [draft, setDraft] = useState<PluginSettings | null>(settings);
  const [nodes, setNodes] = useState(settings?.scannedNodes.join(', ') ?? '');
  const [validation, setValidation] = useState(false);
  useEffect(() => { setDraft(settings); setNodes(settings?.scannedNodes.join(', ') ?? ''); setValidation(false); }, [settings]);
  if (!draft) return <section className="v2ex-workflow" aria-label={copy.settings}>{error ? <p className="v2ex-error" role="alert">{copy.errors[error]}</p> : <p className="v2ex-muted">{copy.loading}</p>}</section>;
  const number = (key: 'refreshIntervalMinutes' | 'pagesPerNode' | 'aiCandidateBudget' | 'maxModelCallsPerRefresh', value: string) =>
    setDraft(current => current ? { ...current, [key]: Number(value) } : current);
  const submit = () => {
    const scannedNodes = nodes.split(',').map(value => value.trim()).filter(Boolean);
    const valid = Number.isInteger(draft.refreshIntervalMinutes) && draft.refreshIntervalMinutes >= 1 && draft.refreshIntervalMinutes <= 1440 &&
      Number.isInteger(draft.pagesPerNode) && draft.pagesPerNode >= 1 && draft.pagesPerNode <= 2 &&
      Number.isInteger(draft.aiCandidateBudget) && draft.aiCandidateBudget >= 0 && draft.aiCandidateBudget <= 100 &&
      Number.isInteger(draft.maxModelCallsPerRefresh) && draft.maxModelCallsPerRefresh >= 0 && draft.maxModelCallsPerRefresh <= 10 &&
      draft.notificationThreshold >= 0 && draft.notificationThreshold <= 1 && scannedNodes.length <= 100 &&
      scannedNodes.every(value => /^[a-zA-Z0-9_-]{1,64}$/.test(value)) && (!draft.quietHours ||
        /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.quietHours.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.quietHours.end) && (() => {
          try { new Intl.DateTimeFormat('en-US', { timeZone: draft.quietHours!.timeZone }).format(); return true; } catch { return false; }
        })());
    if (!valid) { setValidation(true); return; }
    setValidation(false); onSave({ ...draft, scannedNodes });
  };
  const quiet = draft.quietHours;
  return <section className="v2ex-workflow" aria-label={copy.settings}>
    <div className="v2ex-section-heading"><SlidersHorizontal size={17} aria-hidden="true" /><h2>{copy.settings}</h2></div>
    <div className="v2ex-form-grid">
      <label>{copy.refreshInterval}<input type="number" min="1" max="1440" value={draft.refreshIntervalMinutes} onChange={event => number('refreshIntervalMinutes', event.target.value)} /></label>
      <label>{copy.pagesPerNode}<input type="number" min="1" max="2" value={draft.pagesPerNode} onChange={event => number('pagesPerNode', event.target.value)} /></label>
      <label>{copy.candidateBudget}<input type="number" min="0" max="100" value={draft.aiCandidateBudget} onChange={event => number('aiCandidateBudget', event.target.value)} /></label>
      <label>{copy.modelCallBudget}<input type="number" min="0" max="10" value={draft.maxModelCallsPerRefresh} onChange={event => number('maxModelCallsPerRefresh', event.target.value)} /></label>
      <label className="v2ex-full-row">{copy.scannedNodes}<input value={nodes} onChange={event => setNodes(event.target.value)} /></label>
      <label className="v2ex-full-row">{copy.notificationThresholdTemplate.replace('{value}', String(Math.round(draft.notificationThreshold * 100)))}
        <input type="range" min="0" max="1" step="0.05" value={draft.notificationThreshold}
          onChange={event => setDraft({ ...draft, notificationThreshold: Number(event.target.value) })} /></label>
    </div>
    <fieldset className="v2ex-fieldset"><legend>{copy.quietHours}</legend>
      <label className="v2ex-check"><input type="checkbox" checked={quiet !== null} onChange={event => setDraft({ ...draft,
        quietHours: event.target.checked ? { start: '22:00', end: '07:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } : null })} />{copy.enableQuietHours}</label>
      {quiet && <div className="v2ex-form-grid">
        <label>{copy.quietStart}<input type="time" value={quiet.start} onChange={event => setDraft({ ...draft, quietHours: { ...quiet, start: event.target.value } })} /></label>
        <label>{copy.quietEnd}<input type="time" value={quiet.end} onChange={event => setDraft({ ...draft, quietHours: { ...quiet, end: event.target.value } })} /></label>
        <label className="v2ex-full-row">{copy.timeZone}<input value={quiet.timeZone} onChange={event => setDraft({ ...draft, quietHours: { ...quiet, timeZone: event.target.value } })} /></label>
      </div>}
    </fieldset>
    {(validation || error) && <p className="v2ex-error" role="alert">{validation ? copy.invalidSettings : copy.errors[error!]}</p>}
    <button type="button" className="v2ex-primary-action" disabled={loading} onClick={submit}><Save size={15} aria-hidden="true" />{loading ? copy.saving : copy.saveSettings}</button>
  </section>;
}
