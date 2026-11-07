import React from 'react';
import { TOPIC_TABS, type TopicTab } from '../contract.js';
import type { Copy } from './locales.js';

/**
 * The V2EX home-page topic tabs (`/?tab=tech`, `/ ?tab=jobs`, ...). Selecting a
 * tab loads that section's topic page; no tab is active outside the tab view.
 */
export function TopicTabs({ active, onSelect, copy }: { active: TopicTab | null; onSelect(tab: TopicTab): void; copy: Copy }) {
  // Outside the tab view no section is selected, so keep the strip reachable
  // from the keyboard through its first tab.
  const focusable = active ?? TOPIC_TABS[0];
  return <nav className="v2ex-tabbar" role="tablist" aria-label={copy.topicTabs}>
    {TOPIC_TABS.map((tab, index) => <button key={tab} type="button" role="tab" id={`v2ex-topic-tab-${tab}`}
      aria-selected={active === tab} tabIndex={focusable === tab ? 0 : -1}
      onClick={() => onSelect(tab)}
      onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next = (index + offset + TOPIC_TABS.length) % TOPIC_TABS.length;
        onSelect(TOPIC_TABS[next]!);
        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
      }}>{copy.tabLabels[tab]}</button>)}
  </nav>;
}
