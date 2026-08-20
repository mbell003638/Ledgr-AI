import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type SyncPrincipal = {
  subject: string;
  issuer?: string;
  scopes: ReadonlySet<string>;
  /** Optional explicit book membership claim. A wildcard grants all books. */
  books: ReadonlySet<string>;
  claims: JWTPayload;
};

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = "not authorized for this book") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface Authenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<SyncPrincipal>;
}

export interface Authorizer {
  authorize(principal: SyncPrincipal, bookId: string, action: "pull" | "push"): void | Promise<void>;
}

/** Development-only authenticator. Production entrypoints select OIDC when configured. */
export class AnonymousAuthenticator implements Authenticator {
  async authenticate(_headers: IncomingHttpHeaders): Promise<SyncPrincipal> {
    return { subject: "anonymous", scopes: new Set(["sync:*"]), books: new Set(["*"]), claims: {} };
  }
}

export class BookMembershipAuthorizer implements Authorizer {
  authorize(principal: SyncPrincipal, bookId: string, action: "pull" | "push"): void {
    const allowed = principal.books.has("*") || principal.books.has(bookId) || principal.scopes.has("sync:*") || principal.scopes.has(`sync:${action}`);
    if (!allowed) throw new AuthorizationError(`principal is not authorized to ${action} book ${bookId}`);
  }
}

function claimStrings(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/u).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function bearer(headers: IncomingHttpHeaders): string {
  const value = headers.authorization;
  if (typeof value !== "string" || !/^Bearer\s+\S+$/iu.test(value)) throw new AuthenticationError();
  return value.replace(/^Bearer\s+/iu, "");
}

export type OidcAuthenticatorOptions = { issuer: string; audience: string; jwksUrl: string; clockToleranceSeconds?: number };

/** Verifies signed OIDC JWTs against the issuer's JWKS. Membership is read from `books`/`book_ids`. */
export class OidcAuthenticator implements Authenticator {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly options: OidcAuthenticatorOptions) {
    this.keys = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async authenticate(headers: IncomingHttpHeaders): Promise<SyncPrincipal> {
    const token = bearer(headers);
    try {
      const verified = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
      });
      const claims = verified.payload;
      if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new AuthenticationError("token subject is required");
      const scopes = new Set([...claimStrings(claims.scope), ...claimStrings(claims.scp)]);
      const books = new Set([...claimStrings(claims.books), ...claimStrings(claims.book_ids)]);
      return { subject: claims.sub, issuer: claims.iss, scopes, books, claims };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("invalid or expired access token");
    }
  }
}
