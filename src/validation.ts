import { V2exError } from './errors.js';

function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new V2exError('invalid_request');
  }
  return value;
}

export function assertTopicId(value: unknown): number {
  return positiveInteger(value, Number.MAX_SAFE_INTEGER);
}

export function assertNodeName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new V2exError('invalid_request');
  }
  return value;
}

export function assertPage(value: unknown): number {
  return positiveInteger(value, 1_000);
}

export function assertLimit(value: unknown): number {
  return positiveInteger(value, 100);
}
