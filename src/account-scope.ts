import { createHash } from 'node:crypto';
import { V2exError } from './errors.js';

export function accountScope(account: string): string {
  if (typeof account !== 'string' || !account || account.length > 100 || /[\u0000-\u001f\u007f]/.test(account)) {
    throw new V2exError('not_authenticated');
  }
  return `${createHash('sha256').update(account.toLocaleLowerCase('en')).digest('hex')}:`;
}

export async function resolveAccountScope(resolve: () => Promise<string>): Promise<string> {
  try { return accountScope(await resolve()); }
  catch (error) { throw error instanceof V2exError ? error : new V2exError('not_authenticated'); }
}
