import React, { useEffect, useState } from 'react';
import { Brain, Pause, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type { InterestProfile } from '../contract.js';
import type { ClientErrorCode } from './http.js';
import type { Copy } from './locales.js';

export interface InterestEdit {
  labels: Array<{ name: string; weight: number }>;
  preferredNodes: Array<{ name: string; weight: number }>;
  exclusions: string[];
}

function weightedText(values: Array<{ name: string; weight: number }>): string {
  return values.map(value => `${value.name}:${value.weight}`).join(', ');
}

function parseWeighted(value: string, node = false): Array<{ name: string; weight: number }> | null {
  if (!value.trim()) return [];
  const result: Array<{ name: string; weight: number }> = [];
  for (const part of value.split(',')) {
    const separator = part.lastIndexOf(':');
    const name = part.slice(0, separator).trim();
    const weight = Number(part.slice(separator + 1).trim());
    if (separator < 1 || !name || name.length > 80 || !Number.isFinite(weight) || weight < 0 || weight > 1 ||
      (node && !/^[a-zA-Z0-9_-]{1,64}$/.test(name))) return null;
    result.push({ name, weight });
  }
  return result.length <= 100 ? result : null;
}

export function InterestView({ profile, loading, error, copy, onAuthorize, onUpdate, onPause, onRelearn, onRevoke, onClear }: {
  profile: InterestProfile | null; loading: boolean; error: ClientErrorCode | null; copy: Copy;
  onAuthorize(): void; onUpdate(value: InterestEdit): void; onPause(value: boolean): void; onRelearn(): void;
  onRevoke(): void; onClear(): void;
}) {
  const [labels, setLabels] = useState('');
  const [nodes, setNodes] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [validation, setValidation] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'clear' | null>(null);
  useEffect(() => {
    setLabels(weightedText(profile?.labels ?? []));
    setNodes(weightedText(profile?.preferredNodes ?? []));
    setExclusions((profile?.exclusions ?? []).join(', '));
    setConfirm(null); setValidation(false);
  }, [profile?.updatedAt]);
  const save = () => {
    const nextLabels = parseWeighted(labels);
    const nextNodes = parseWeighted(nodes, true);
    const nextExclusions = exclusions.split(',').map(value => value.trim()).filter(Boolean);
    if (!nextLabels || !nextNodes || nextExclusions.length > 100 || nextExclusions.some(value => value.length > 100)) {
      setValidation(true); return;
    }
    setValidation(false); onUpdate({ labels: nextLabels, preferredNodes: nextNodes, exclusions: nextExclusions });
  };
  if (!profile) return <section className="v2ex-workflow" aria-label={copy.interests}>{error ? <p className="v2ex-error" role="alert">{copy.errors[error]}</p> : <p className="v2ex-muted">{copy.loading}</p>}</section>;
  return <section className="v2ex-workflow" aria-label={copy.interests}>
    <div className="v2ex-section-heading"><Brain size={17} aria-hidden="true" /><h2>{copy.interests}</h2></div>
    <p className="v2ex-muted">{copy.historyConsent}</p>
    {error && <p className="v2ex-error" role="alert">{copy.errors[error]}</p>}
    {!profile.authorized ? <button type="button" className="v2ex-primary-action" disabled={loading} onClick={onAuthorize}>
      <ShieldCheck size={15} aria-hidden="true" />{copy.authorizeHistory}</button> : <div className="v2ex-inline-actions">
      <button type="button" disabled={loading} onClick={onRelearn}><RotateCcw size={15} aria-hidden="true" />{copy.relearn}</button>
      <button type="button" disabled={loading} onClick={() => onPause(!profile.learningPaused)}>
        {profile.learningPaused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
        {profile.learningPaused ? copy.resumeLearning : copy.pauseLearning}</button>
    </div>}
    <div className="v2ex-form-grid">
      <label>{copy.interestLabels}<input value={labels} disabled={loading} onChange={event => setLabels(event.target.value)} /></label>
      <label>{copy.preferredNodes}<input value={nodes} disabled={loading} onChange={event => setNodes(event.target.value)} /></label>
      <label className="v2ex-full-row">{copy.exclusions}<input value={exclusions} disabled={loading} onChange={event => setExclusions(event.target.value)} /></label>
    </div>
    {validation && <p className="v2ex-error" role="alert">{copy.invalidInterestEdit}</p>}
    <button type="button" disabled={loading} onClick={save}>{copy.saveInterests}</button>
    <div className="v2ex-danger-zone">
      {profile.authorized && <button type="button" disabled={loading} onClick={() => confirm === 'revoke' ? onRevoke() : setConfirm('revoke')}>
        {confirm === 'revoke' ? copy.confirmRevokeHistory : copy.revokeHistory}</button>}
      <button type="button" disabled={loading} onClick={() => confirm === 'clear' ? onClear() : setConfirm('clear')}>
        <Trash2 size={15} aria-hidden="true" />{confirm === 'clear' ? copy.confirmClearInterests : copy.clearInterests}</button>
    </div>
  </section>;
}
