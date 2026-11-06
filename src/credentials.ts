import { createHash } from 'node:crypto';
import type { AccountStatus, CredentialVault } from './contract.js';
import { V2exError } from './errors.js';
import type { V2exApi } from './v2ex-api.js';

export const TOKEN_REF = 'V2EX_PERSONAL_ACCESS_TOKEN';

export interface CredentialProvider {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
}

export type { CredentialVault } from './contract.js';

export class DshCredentialVault implements CredentialVault {
  constructor(private readonly provider: CredentialProvider) {}
  async resolve(): Promise<string | undefined> { return (await this.provider.resolve(TOKEN_REF))?.value; }
  async set(value: string): Promise<void> { await this.provider.set(TOKEN_REF, value); }
  async clear(): Promise<void> { await this.provider.unset(TOKEN_REF); }
  async describe(): Promise<{ configured: boolean; writable: boolean }> {
    const info = await this.provider.describe(TOKEN_REF);
    return { configured: info.configured, writable: info.writable };
  }
}

export class AuthService {
  private verifiedUsername: string | null = null;
  private verifiedCredentialDigest: string | null = null;
  constructor(
    private readonly api: V2exApi,
    private readonly vault: CredentialVault,
    private readonly clearPersonalData: () => Promise<void> = async () => {},
  ) {}

  async status(): Promise<AccountStatus> {
    const token = await this.vault.resolve();
    const { writable } = await this.vault.describe();
    if (!token) {
      this.verifiedUsername = null;
      this.verifiedCredentialDigest = null;
      return { authenticated: false, writable, username: null, tokenScope: null, expiresAt: null };
    }
    const status = await this.validate(token, writable);
    this.verifiedUsername = status.username;
    this.verifiedCredentialDigest = createHash('sha256').update(token).digest('hex');
    return status;
  }

  async login(candidate: string): Promise<AccountStatus> {
    if (typeof candidate !== 'string' || candidate.length < 1 || candidate.length > 4096 || /[\r\n]/.test(candidate)) {
      throw new V2exError('invalid_request');
    }
    const { writable } = await this.vault.describe();
    const status = await this.validate(candidate, writable);
    await this.vault.set(candidate);
    this.verifiedUsername = status.username;
    this.verifiedCredentialDigest = createHash('sha256').update(candidate).digest('hex');
    return status;
  }

  async account(): Promise<string> {
    const token = await this.vault.resolve();
    if (!token) {
      this.verifiedUsername = null;
      this.verifiedCredentialDigest = null;
      throw new V2exError('not_authenticated');
    }
    const digest = createHash('sha256').update(token).digest('hex');
    if (this.verifiedUsername && this.verifiedCredentialDigest === digest) return this.verifiedUsername;
    const status = await this.status();
    if (!status.authenticated || !status.username) throw new V2exError('not_authenticated');
    return status.username;
  }

  async logout(clearPersonalData: boolean): Promise<void> {
    await this.vault.clear();
    this.verifiedUsername = null;
    this.verifiedCredentialDigest = null;
    if (clearPersonalData) await this.clearPersonalData();
  }

  private async validate(token: string, writable: boolean): Promise<AccountStatus> {
    const info = await this.api.readToken(token);
    const member = await this.api.readMember(token);
    return {
      authenticated: true,
      writable,
      username: member.username,
      tokenScope: info.scope ?? null,
      expiresAt: info.expiration ? new Date(info.expiration * 1000).toISOString() : null,
    };
  }
}
