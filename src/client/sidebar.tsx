import React from 'react';
import { BookOpenText } from 'lucide-react';
import { zh } from './locales.js';

export function SidebarIcon() {
  return <span role="img" aria-label={zh.title} title={zh.title}><BookOpenText size={20} strokeWidth={1.7} aria-hidden="true" /></span>;
}
