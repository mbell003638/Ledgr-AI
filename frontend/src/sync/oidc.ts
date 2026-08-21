import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { storage } from '../utils/storage';

WebBrowser.maybeCompleteAuthSession();

const accessTokenKey = (bookId: string) => `ledgr:sync:${bookId}:access-token`;
const tokenBundleKey = (bookId: string) => `ledgr:sync:${bookId}:oidc-token-bundle`;

type OidcTokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
};

export type SyncOidcProfile = { bookId: string; oidcIssuer?: string; oidcClientId?: string; oidcScopes?: string };

function expiry(response: AuthSession.TokenResponse): number {
  const issuedAt = response.issuedAt || Math.floor(Date.now() / 1000);
  return (issuedAt + (response.expiresIn && response.expiresIn > 0 ? response.expiresIn : 5 * 60)) * 1000;
}

async function saveBundle(bookId: string, response: AuthSession.TokenResponse, retainedRefreshToken?: string): Promise<void> {
  const bundle: OidcTokenBundle = {
    accessToken: response.accessToken,
    ...(response.refreshToken || retainedRefreshToken ? { refreshToken: response.refreshToken || retainedRefreshToken } : {}),
    expiresAt: expiry(response),
    ...(response.tokenType ? { tokenType: response.tokenType } : {}),
    ...(response.scope ? { scopes: response.scope.split(/\s+/u).filter(Boolean) } : {}),
  };
  const [bundleSaved] = await Promise.all([
    storage.secureSet(tokenBundleKey(bookId), JSON.stringify(bundle)),
    storage.secureRemove(accessTokenKey(bookId)),
  ]);
  if (!bundleSaved) throw new Error('Could not store OIDC credentials in secure device storage');
}

function parseBundle(value: string | null): OidcTokenBundle | null {
  try { const parsed = value ? JSON.parse(value) : null; return parsed && typeof parsed.accessToken === 'string' ? parsed : null; } catch { return null; }
}

export async function authorizeSyncOidc(profile: SyncOidcProfile): Promise<void> {
  if (!profile.oidcIssuer || !profile.oidcClientId) throw new Error('OIDC issuer and client ID are required');
  const discovery = await AuthSession.fetchDiscoveryAsync(profile.oidcIssuer);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'ledgr', path: 'sync-oidc' });
  const scopes = (profile.oidcScopes || 'openid profile offline_access').split(/\s+/u).filter(Boolean);
  const request = new AuthSession.AuthRequest({ clientId: profile.oidcClientId, redirectUri, scopes, responseType: AuthSession.ResponseType.Code, usePKCE: true });
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || typeof result.params.code !== 'string') throw new Error(result.type === 'cancel' || result.type === 'dismiss' ? 'OIDC sign-in was cancelled' : 'OIDC provider did not return an authorization code');
  if (!request.codeVerifier) throw new Error('OIDC PKCE verifier is unavailable');
  const response = await AuthSession.exchangeCodeAsync({ clientId: profile.oidcClientId, code: result.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier } }, discovery);
  await saveBundle(profile.bookId, response);
}

export async function storeManualSyncAccessToken(bookId: string, accessToken: string): Promise<void> {
  await storage.secureRemove(tokenBundleKey(bookId));
  if (!await storage.secureSet(accessTokenKey(bookId), accessToken.trim())) throw new Error('Could not store the sync access token securely');
}

export async function clearSyncTokens(bookId: string): Promise<void> {
  await Promise.all([storage.secureRemove(accessTokenKey(bookId)), storage.secureRemove(tokenBundleKey(bookId))]);
}

export async function getValidSyncAccessToken(profile: SyncOidcProfile): Promise<string> {
  const raw = await storage.secureGet<string | null>(tokenBundleKey(profile.bookId), null);
  const bundle = parseBundle(raw);
  if (bundle?.expiresAt && bundle.expiresAt > Date.now() + 60_000) return bundle.accessToken;
  if (bundle?.refreshToken && profile.oidcIssuer && profile.oidcClientId) {
    try {
      const discovery = await AuthSession.fetchDiscoveryAsync(profile.oidcIssuer);
      const response = await AuthSession.refreshAsync({ clientId: profile.oidcClientId, refreshToken: bundle.refreshToken, scopes: (profile.oidcScopes || 'openid profile offline_access').split(/\s+/u).filter(Boolean) }, discovery);
      await saveBundle(profile.bookId, response, bundle.refreshToken);
      return response.accessToken;
    } catch { throw new Error('OIDC session expired and could not be refreshed; sign in again from Sync Settings'); }
  }
  if (bundle) throw new Error('OIDC session expired; sign in again from Sync Settings');
  const manual = await storage.secureGet<string | null>(accessTokenKey(profile.bookId), null);
  if (!manual) throw new Error('Sync access token is missing; sign in or update enrollment in Sync Settings');
  return manual;
}
