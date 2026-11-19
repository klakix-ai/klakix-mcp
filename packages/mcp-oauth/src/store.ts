import type { ClientAuthMethod } from "./rules.js";

/*
 * Storage contract. The server never stores a token, authorization code or
 * client secret in plain text: every lookup key below is a hex SHA-256 hash
 * (see `hashToken`). All times are milliseconds since the Unix epoch.
 */

/** A registered OAuth client. */
export interface ClientRecord {
  /** `client_id`: a generated ID (dynamic registration) or a metadata document URL. */
  id: string;
  /** How the client came to exist. Only `dynamic` clients are removed by cleanup. */
  registrationType: "dynamic" | "metadata_document";
  /** Display name (already sanitized). */
  name: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  /** SHA-256 of the client secret; `null` for public clients. */
  secretHash: string | null;
  clientUri: string | null;
  logoUri: string | null;
  /** `software_id` and `software_version`, for display. */
  software: string | null;
  grantTypes: string[];
  createdAt: number;
  updatedAt: number;
}

/** A pending or used authorization code. */
export interface AuthorizationCodeRecord {
  /** SHA-256 of the code. */
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  /** S256 PKCE challenge. */
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
  /** When the code was exchanged; `null` while unused. */
  usedAt: number | null;
  createdAt: number;
}

/**
 * A grant: the connection between one user and one client, created when a code
 * is exchanged. It holds the current access and refresh token hashes; refresh
 * rotates both. Revoking the grant ends the connection.
 */
export interface GrantRecord {
  /** Grant ID, derived from the authorization code it came from. */
  id: string;
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  accessTokenHash: string;
  accessTokenExpiresAt: number;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
  /** Hash of the refresh token that was rotated away; used to detect reuse. */
  previousRefreshTokenHash: string | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** New token hashes written by {@link OAuthStore.rotateGrantTokens}. */
export interface GrantTokenUpdate {
  accessTokenHash: string;
  accessTokenExpiresAt: number;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
  previousRefreshTokenHash: string;
  updatedAt: number;
}

/** Cut-off times for {@link OAuthStore.deleteExpired}. */
export interface CleanupCutoffs {
  /** Current time. */
  now: number;
  /** Delete authorization codes whose `expiresAt` is before this time. */
  codesExpiredBefore: number;
  /** Delete grants revoked before this time, or whose refresh token expired before it. */
  grantsEndedBefore: number;
  /**
   * Delete `dynamic` clients created before this time that have no grant (of any
   * state) and no unexpired authorization code.
   */
  unusedClientsCreatedBefore: number;
}

/** Numbers of records removed by {@link OAuthStore.deleteExpired}. */
export interface CleanupResult {
  codes: number;
  grants: number;
  clients: number;
}

/**
 * Persistence used by the authorization server. Implement it on any database;
 * {@link MemoryStore} is the reference implementation.
 *
 * Two methods must be atomic compare-and-set operations, because they are what
 * makes codes single-use and refresh tokens rotate safely under concurrency:
 * {@link OAuthStore.markAuthorizationCodeUsed} and {@link OAuthStore.rotateGrantTokens}.
 */
export interface OAuthStore {
  /** Returns a client by ID, or `null`. */
  getClient(id: string): Promise<ClientRecord | null>;
  /** Inserts or replaces a client (metadata document clients are refreshed this way). */
  saveClient(client: ClientRecord): Promise<void>;

  /** Stores a new authorization code. */
  saveAuthorizationCode(code: AuthorizationCodeRecord): Promise<void>;
  /** Returns a code by hash, used or not, or `null`. */
  getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null>;
  /**
   * Atomically sets `usedAt` if and only if it is still `null`. Returns `true`
   * when this call marked the code, `false` when it was already used or missing.
   * SQL: `UPDATE codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL`.
   */
  markAuthorizationCodeUsed(codeHash: string, usedAt: number): Promise<boolean>;

  /** Stores a new grant. */
  createGrant(grant: GrantRecord): Promise<void>;
  /** Returns a grant by ID, or `null`. */
  getGrant(id: string): Promise<GrantRecord | null>;
  /** Returns the grant whose current access token has this hash, or `null`. */
  findGrantByAccessTokenHash(hash: string): Promise<GrantRecord | null>;
  /** Returns the grant whose current refresh token has this hash, or `null`. */
  findGrantByRefreshTokenHash(hash: string): Promise<GrantRecord | null>;
  /** Returns the grant whose previous (rotated) refresh token has this hash, or `null`. */
  findGrantByPreviousRefreshTokenHash(hash: string): Promise<GrantRecord | null>;
  /**
   * Atomically replaces the token hashes if the grant is not revoked and its
   * current refresh token hash still equals `expectedRefreshTokenHash`. Returns
   * `true` on success, `false` when another request rotated it first.
   */
  rotateGrantTokens(grantId: string, expectedRefreshTokenHash: string, update: GrantTokenUpdate): Promise<boolean>;
  /** Sets `revokedAt` if the grant exists and is not revoked yet. Idempotent. */
  revokeGrant(grantId: string, revokedAt: number): Promise<void>;

  /**
   * Removes expired data; see {@link CleanupCutoffs} for the exact rules. Delete
   * codes and grants before evaluating clients, so a client whose last grant was
   * just removed can go in the same pass.
   */
  deleteExpired(cutoffs: CleanupCutoffs): Promise<CleanupResult>;
}

/**
 * In-memory {@link OAuthStore} for tests, examples and single-process
 * development. Data is lost on restart and not shared between processes.
 */
export class MemoryStore implements OAuthStore {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly grants = new Map<string, GrantRecord>();

  async getClient(id: string): Promise<ClientRecord | null> {
    return copy(this.clients.get(id));
  }

  async saveClient(client: ClientRecord): Promise<void> {
    this.clients.set(client.id, structuredClone(client));
  }

  async saveAuthorizationCode(code: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(code.codeHash, structuredClone(code));
  }

  async getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    return copy(this.codes.get(codeHash));
  }

  async markAuthorizationCodeUsed(codeHash: string, usedAt: number): Promise<boolean> {
    const c = this.codes.get(codeHash);
    if (!c || c.usedAt !== null) return false;
    c.usedAt = usedAt;
    return true;
  }

  async createGrant(grant: GrantRecord): Promise<void> {
    if (this.grants.has(grant.id)) throw new Error("grant already exists");
    this.grants.set(grant.id, structuredClone(grant));
  }

  async getGrant(id: string): Promise<GrantRecord | null> {
    return copy(this.grants.get(id));
  }

  async findGrantByAccessTokenHash(hash: string): Promise<GrantRecord | null> {
    return copy(this.find((g) => g.accessTokenHash === hash));
  }

  async findGrantByRefreshTokenHash(hash: string): Promise<GrantRecord | null> {
    return copy(this.find((g) => g.refreshTokenHash === hash));
  }

  async findGrantByPreviousRefreshTokenHash(hash: string): Promise<GrantRecord | null> {
    return copy(this.find((g) => g.previousRefreshTokenHash === hash));
  }

  async rotateGrantTokens(grantId: string, expectedRefreshTokenHash: string, update: GrantTokenUpdate): Promise<boolean> {
    const g = this.grants.get(grantId);
    if (!g || g.revokedAt !== null || g.refreshTokenHash !== expectedRefreshTokenHash) return false;
    Object.assign(g, update);
    return true;
  }

  async revokeGrant(grantId: string, revokedAt: number): Promise<void> {
    const g = this.grants.get(grantId);
    if (g && g.revokedAt === null) {
      g.revokedAt = revokedAt;
      g.updatedAt = revokedAt;
    }
  }

  async deleteExpired(c: CleanupCutoffs): Promise<CleanupResult> {
    const result: CleanupResult = { codes: 0, grants: 0, clients: 0 };
    for (const [k, code] of this.codes) {
      if (code.expiresAt < c.codesExpiredBefore) {
        this.codes.delete(k);
        result.codes++;
      }
    }
    for (const [k, g] of this.grants) {
      if ((g.revokedAt !== null && g.revokedAt < c.grantsEndedBefore) || g.refreshTokenExpiresAt < c.grantsEndedBefore) {
        this.grants.delete(k);
        result.grants++;
      }
    }
    for (const [k, client] of this.clients) {
      if (client.registrationType !== "dynamic" || client.createdAt >= c.unusedClientsCreatedBefore) continue;
      const hasGrant = [...this.grants.values()].some((g) => g.clientId === k);
      const hasLiveCode = [...this.codes.values()].some((code) => code.clientId === k && code.expiresAt > c.now);
      if (!hasGrant && !hasLiveCode) {
        this.clients.delete(k);
        result.clients++;
      }
    }
    return result;
  }

  private find(pred: (g: GrantRecord) => boolean): GrantRecord | undefined {
    for (const g of this.grants.values()) if (pred(g)) return g;
    return undefined;
  }
}

function copy<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}
