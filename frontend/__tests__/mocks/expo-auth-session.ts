export const ResponseType = { Code: 'code' } as const;
export const fetchDiscoveryAsync = async () => ({ authorizationEndpoint: '', tokenEndpoint: '' });
export const makeRedirectUri = ({ scheme, path }: { scheme: string; path: string }) => `${scheme}://${path}`;
export class AuthRequest {
  codeVerifier = 'test-code-verifier';
  constructor(_config: unknown) {}
  async promptAsync(_discovery: unknown) { return { type: 'cancel' as const, params: {} }; }
}
export const exchangeCodeAsync = async () => ({ accessToken: 'test-access-token', expiresIn: 300 });
export const refreshAsync = async () => ({ accessToken: 'test-refreshed-access-token', expiresIn: 300 });
