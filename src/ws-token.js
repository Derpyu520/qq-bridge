// Pure resolver for the SnowLuma OneBot WebSocket token.
//
// SnowLuma keeps two different tokens per account: the HTTP access token and the WebSocket access token.
// Passing the HTTP token to the WebSocket client is rejected by the gateway (close code 1006 / unauthorized
// upgrade), so the bridge must use a WS token for the first handshake as well:
//   1. an explicit `snowluma.wsToken` from config (recommended for isolated lanes),
//   2. the WS token discovered from the account's SnowLuma config,
//   3. the HTTP token only as a flagged compatibility fallback (may fail authentication).
// The resolver never invents a success claim; `warning` is non-null whenever the fallback is used.

export function resolveWsToken({ configuredWsToken, discovered, httpToken } = {}) {
  const cfg = typeof configuredWsToken === 'string' ? configuredWsToken.trim() : '';
  if (cfg) return { token: cfg, source: 'config', warning: null };

  const disc = discovered && discovered.ok && typeof discovered.wsToken === 'string'
    ? discovered.wsToken.trim()
    : '';
  if (disc) return { token: disc, source: 'discovery', warning: null };

  const http = typeof httpToken === 'string' ? httpToken.trim() : '';
  if (http) {
    return {
      token: http,
      source: 'http-fallback',
      warning: 'SnowLuma WS token not found; falling back to the HTTP token (WS authentication may fail)',
    };
  }

  return {
    token: undefined,
    source: 'none',
    warning: 'No SnowLuma WS token and no HTTP token available; the WS connection cannot authenticate',
  };
}
