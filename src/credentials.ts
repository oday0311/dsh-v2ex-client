import { createHash } from 'node:crypto';
import type { AccountStatus, CredentialVault } from './contract.js';
import { V2exError } from './errors.js';
import type { V2exApi } from './v2ex-api.js';
import { accountScope } from './account-scope.js';

export const TOKEN_REF = 'V2EX_PERSONAL_ACCESS_TOKEN';

export interface CredentialProvider {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
}

export type { CredentialVault } from './contract.js';

export interface IdentityLease {
  readonly account: string;
  readonly scope: string;
  readonly credentialFingerprint: string;
  readonly generation: number;
}

export interface IdentityLeaseProvider {
  withRead<T>(operation: (lease: IdentityLease) => Promise<T>): Promise<T>;
  withMutation<T>(operation: (lease: IdentityLease, guard: IdentityMutationGuard) => Promise<T>, expected?: IdentityLease): Promise<T>;
  withCachedMutation?<T>(operation: (lease: IdentityLease, guard: IdentityMutationGuard) => Promise<T>,
    expected?: IdentityLease): Promise<T | undefined>;
}

export interface IdentityMutationGuard {
  readonly lease: IdentityLease;
  run<T>(operation: (lease: IdentityLease) => Promise<T>): Promise<T>;
}

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
  private authGeneration = 0;
  private fence: Promise<void> = Promise.resolve();
  constructor(
    private readonly api: V2exApi,
    private readonly vault: CredentialVault,
    private readonly clearPersonalData: (account: string | null) => Promise<void> = async () => {},
  ) {}

  private invalidate(clearIdentity = true): void {
    this.authGeneration++;
    if (clearIdentity) { this.verifiedUsername = null; this.verifiedCredentialDigest = null; }
  }

  private fenced<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.fence.then(operation);
    this.fence = task.then(() => {}, () => {});
    return task;
  }

  private sameLease(left: IdentityLease, right: IdentityLease): boolean {
    return left.generation === right.generation && left.scope === right.scope &&
      left.credentialFingerprint === right.credentialFingerprint && left.account === right.account;
  }

  private cachedLeaseUnlocked(): IdentityLease | undefined {
    if (!this.verifiedUsername || !this.verifiedCredentialDigest) return undefined;
    return { account: this.verifiedUsername, scope: accountScope(this.verifiedUsername),
      credentialFingerprint: this.verifiedCredentialDigest, generation: this.authGeneration };
  }

  status(): Promise<AccountStatus> { return this.fenced(() => this.statusUnlocked()); }

  private async statusUnlocked(): Promise<AccountStatus> {
    const token = await this.vault.resolve();
    const { writable } = await this.vault.describe();
    if (!token) {
      if (this.verifiedUsername !== null || this.verifiedCredentialDigest !== null) this.invalidate();
      return { authenticated: false, writable, username: null, tokenScope: null, expiresAt: null };
    }
    const digest = createHash('sha256').update(token).digest('hex');
    if (this.verifiedCredentialDigest !== null && this.verifiedCredentialDigest !== digest) this.invalidate();
    const generation = this.authGeneration;
    const status = await this.validate(token, writable);
    const current = await this.vault.resolve();
    if (!current || createHash('sha256').update(current).digest('hex') !== digest || generation !== this.authGeneration) {
      this.invalidate();
      throw new V2exError('not_authenticated');
    }
    this.verifiedUsername = status.username;
    this.verifiedCredentialDigest = digest;
    return status;
  }

  login(candidate: string): Promise<AccountStatus> { return this.fenced(async () => {
    this.invalidate(false);
    if (typeof candidate !== 'string' || candidate.length < 1 || candidate.length > 4096 || /[\r\n]/.test(candidate)) {
      throw new V2exError('invalid_request');
    }
    const generation = this.authGeneration;
    const digest = createHash('sha256').update(candidate).digest('hex');
    const { writable } = await this.vault.describe();
    const status = await this.validate(candidate, writable);
    if (generation !== this.authGeneration) throw new V2exError('not_authenticated');
    await this.vault.set(candidate);
    const current = await this.vault.resolve();
    if (!current || createHash('sha256').update(current).digest('hex') !== digest || generation !== this.authGeneration) {
      this.invalidate();
      throw new V2exError('not_authenticated');
    }
    this.invalidate();
    this.verifiedUsername = status.username;
    this.verifiedCredentialDigest = digest;
    return status;
  }); }

  async account(): Promise<string> {
    return this.withRead(async lease => lease.account);
  }

  lease(): Promise<IdentityLease> { return this.withRead(async lease => lease); }

  private async leaseUnlocked(): Promise<IdentityLease> {
    const token = await this.vault.resolve();
    if (!token) {
      if (this.verifiedUsername !== null || this.verifiedCredentialDigest !== null) this.invalidate();
      throw new V2exError('not_authenticated');
    }
    const digest = createHash('sha256').update(token).digest('hex');
    if (!this.verifiedUsername || this.verifiedCredentialDigest !== digest) {
      if (this.verifiedCredentialDigest !== null && this.verifiedCredentialDigest !== digest) this.invalidate();
      const status = await this.statusUnlocked();
      if (!status.authenticated || !status.username) throw new V2exError('not_authenticated');
    }
    return { account: this.verifiedUsername!, scope: accountScope(this.verifiedUsername!),
      credentialFingerprint: digest, generation: this.authGeneration };
  }

  async assertLease(lease: IdentityLease): Promise<void> {
    await this.withRead(async current => { if (!this.sameLease(current, lease)) throw new V2exError('not_authenticated'); });
  }

  withRead<T>(operation: (lease: IdentityLease) => Promise<T>): Promise<T> {
    return this.fenced(async () => {
      const lease = await this.leaseUnlocked(); const result = await operation(lease);
      const current = await this.leaseUnlocked();
      if (!this.sameLease(current, lease)) throw new V2exError('not_authenticated');
      return result;
    });
  }

  withMutation<T>(operation: (lease: IdentityLease, guard: IdentityMutationGuard) => Promise<T>, expected?: IdentityLease): Promise<T> {
    return this.fenced(async () => {
      const lease = await this.leaseUnlocked();
      if (expected && !this.sameLease(lease, expected)) throw new V2exError('not_authenticated');
      let active = true;
      const guard: IdentityMutationGuard = { lease, run: async nested => {
        if (!active) throw new V2exError('not_authenticated'); return nested(lease);
      } };
      try {
        const result = await operation(lease, guard); const current = await this.leaseUnlocked();
        if (!this.sameLease(current, lease)) throw new V2exError('not_authenticated');
        return result;
      } finally { active = false; }
    });
  }

  withCachedMutation<T>(operation: (lease: IdentityLease, guard: IdentityMutationGuard) => Promise<T>,
    expected?: IdentityLease): Promise<T | undefined> {
    return this.fenced(async () => {
      const lease = this.cachedLeaseUnlocked();
      if (!lease) return undefined;
      if (expected && !this.sameLease(lease, expected)) throw new V2exError('not_authenticated');
      let active = true;
      const guard: IdentityMutationGuard = { lease, run: async nested => {
        if (!active) throw new V2exError('not_authenticated'); return nested(lease);
      } };
      try {
        const result = await operation(lease, guard); const current = this.cachedLeaseUnlocked();
        if (!current || !this.sameLease(current, lease)) throw new V2exError('not_authenticated');
        return result;
      } finally { active = false; }
    });
  }

  logout(clearPersonalData: boolean): Promise<void> { return this.fenced(async () => {
    this.invalidate(false);
    let account: string | null = null;
    if (clearPersonalData) {
      try { account = (await this.leaseUnlocked()).account; } catch { account = null; }
    }
    await this.vault.clear();
    this.invalidate();
    if (clearPersonalData) await this.clearPersonalData(account);
  }); }

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
