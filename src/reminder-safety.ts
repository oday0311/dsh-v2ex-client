import type { PendingReminderNotice } from './contract.js';

type ReminderFields = Pick<PendingReminderNotice, 'title' | 'node' | 'reason'>;

const unsafeExact = /(?:[0-9a-f]{8}(?:[^0-9a-f]+[0-9a-f]{4}){3}[^0-9a-f]+[0-9a-f]{12}|[0-9a-f]{32,}|(?:bearer|token|api[\s_-]*key|private[\s_-]*key)[^A-Za-z0-9]{0,8}[A-Za-z0-9_-]{8,}|(?:provider|model|api|private)[^A-Za-z0-9]{0,8}(?:error|failure|exception))/i;
const unsafeCanonical = /(?:[0-9a-f]{32,}|(?:bearer|token|apikey|privatekey)[a-z0-9]{8,}|(?:provider|model|api|private)(?:error|failure|exception))/i;

export function isWellFormedReminderText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function normalizeReminderText(value: string, maxCodePoints: number): string {
  let formed = '';
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { formed += value[index]! + value[++index]!; continue; }
      formed += '\ufffd'; continue;
    }
    formed += unit >= 0xdc00 && unit <= 0xdfff ? '\ufffd' : value[index]!;
  }
  const normalized = formed.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const bounded = Array.from(normalized).slice(0, maxCodePoints).join('');
  return validReminderField(bounded, maxCodePoints) ? bounded : '';
}

export function reminderText(fields: ReminderFields): string {
  return `V2EX recommendation:\n- ${fields.title} [${fields.node}]\n  ${fields.reason}`;
}

export function isUnsafeReminder(fields: ReminderFields): boolean {
  const exact = reminderText(fields);
  const canonical = exact.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  return unsafeExact.test(exact) || unsafeCanonical.test(canonical);
}

export function validReminderField(value: string, maxCodePoints: number): boolean {
  return value.length > 0 && isWellFormedReminderText(value) && value === value.normalize('NFKC') &&
    !/[\u0000-\u001f\u007f]/.test(value) && Array.from(value).length <= maxCodePoints &&
    Buffer.byteLength(value, 'utf8') <= maxCodePoints * 4;
}
