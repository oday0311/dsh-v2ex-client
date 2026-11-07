import React from 'react';
import type { NodeInfo } from '../contract.js';
import type { ClientErrorCode } from './http.js';
import type { Copy } from './locales.js';

/**
 * Common V2EX nodes read from the public node catalog (`/api/nodes/all.json`).
 * The list is bounded by the Host and filtered locally.
 */
export function NodeCatalog({ nodes, loading, error, filter, onFilter, onSelect, copy }:
  { nodes: NodeInfo[] | null; loading: boolean; error: ClientErrorCode | null; filter: string;
    onFilter(value: string): void; onSelect(name: string): void; copy: Copy }) {
  const query = filter.trim().toLocaleLowerCase();
  const items: NodeInfo[] = (nodes ?? []).filter(node => query === '' ||
    node.name.toLocaleLowerCase().includes(query) || node.title.toLocaleLowerCase().includes(query));
  return <section className="v2ex-node-catalog" aria-label={copy.nodeCatalog}>
    <div className="v2ex-section-heading"><h2>{copy.nodeCatalog}</h2>{loading && <span role="status">{copy.loading}</span>}</div>
    <label>{copy.nodeSearch}<input value={filter} onChange={event => onFilter(event.target.value)} /></label>
    {error && <p className="v2ex-error" role="alert">{copy.errors[error]}</p>}
    {!loading && !error && nodes === null && <p role="status">{copy.loading}</p>}
    {!loading && items.length === 0 && nodes !== null && <p className="v2ex-muted">{copy.nodesEmpty}</p>}
    <ul className="v2ex-node-list">{items.map(node => <li key={node.name}>
      <button type="button" onClick={() => onSelect(node.name)}>{node.title}
        {node.topicCount !== null && <span className="v2ex-meta">{copy.topicCountTemplate.replace('{count}', String(node.topicCount))}</span>}
      </button>
    </li>)}</ul>
  </section>;
}
