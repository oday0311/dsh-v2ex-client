import React from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { TopicAiSummary } from '../contract.js';
import type { ClientErrorCode } from './http.js';
import { formatTime, type Copy } from './locales.js';

export type SummaryMode = 'quick' | 'viewpoints' | 'full';
const modes: SummaryMode[] = ['quick', 'viewpoints', 'full'];

export function AiPanel({ summary, mode, loading, error, available = true, onMode, onGenerate, copy, locale }: {
  summary: TopicAiSummary | null; mode: SummaryMode; loading: boolean; error: ClientErrorCode | null;
  available?: boolean;
  onMode(mode: SummaryMode): void; onGenerate(): void; copy: Copy; locale: string;
}) {
  const coverage = summary?.coverage;
  return <section className="v2ex-ai-panel" aria-label={copy.aiSummary}>
    <div className="v2ex-section-heading"><Sparkles size={16} aria-hidden="true" /><h4>{copy.aiSummary}</h4></div>
    <div className="v2ex-segments" role="radiogroup" aria-label={copy.summaryMode}>
      {modes.map((value, index) => <button key={value} type="button" role="radio" tabIndex={mode === value ? 0 : -1}
        aria-checked={mode === value} disabled={loading || !available} onClick={() => onMode(value)} onKeyDown={event => {
          const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
          if (!offset) return; event.preventDefault(); const next = (index + offset + modes.length) % modes.length;
          onMode(modes[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
        }}>{copy.summaryModes[value]}</button>)}
    </div>
    <button type="button" className="v2ex-primary-action" disabled={loading || !available} onClick={onGenerate}>
      <RefreshCw size={15} aria-hidden="true" />{loading ? copy.generatingSummary : summary ? copy.regenerateSummary : copy.generateSummary}
    </button>
    {!available && <p className="v2ex-muted">{copy.errors.ai_unavailable}</p>}
    {error && <p className="v2ex-error" role="alert">{copy.errors[error]}</p>}
    {summary && <div className="v2ex-ai-result">
      <p>{summary.summary}</p>
      {summary.viewpoints.length > 0 && <ul>{summary.viewpoints.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul>}
      {summary.notableReplies.length > 0 && <p className="v2ex-meta">{copy.notableReplies}: {summary.notableReplies.join(', ')}</p>}
      <p className="v2ex-meta">{copy.generatedAt}: {formatTime(summary.generatedAt, locale)}</p>
      {coverage && <p className="v2ex-coverage">{copy.coverageTemplate.replace('{loaded}', String(coverage.loadedReplyPages)).replace('{total}', String(coverage.totalReplyPages))}</p>}
      {!coverage && <p className="v2ex-coverage">{copy.coveredPageListTemplate.replace('{pages}', summary.coveredReplyPages.join(', '))}</p>}
      {!summary.completeDiscussion && <p className="v2ex-stale">{copy.incompleteSummary}</p>}
    </div>}
  </section>;
}
