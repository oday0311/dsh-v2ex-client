import React from 'react';
import type { Copy } from './locales.js';

export interface NodeChip { name: string; title: string }

/** Nodes seen on the current tab page, offered as links into the node view. */
export function NodeChips({ nodes, onSelect, copy }: { nodes: NodeChip[]; onSelect(name: string): void; copy: Copy }) {
  if (nodes.length === 0) return null;
  return <section className="v2ex-node-chips" aria-label={copy.tabNodes}>
    <span className="v2ex-muted">{copy.tabNodes}</span>
    {nodes.map(node => <button key={node.name} type="button" onClick={() => onSelect(node.name)}>{node.title}</button>)}
  </section>;
}
