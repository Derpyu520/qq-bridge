// Pure resolver for the SnowLuma OneBot WebSocket target (URL + token pair).
//
// SnowLuma keeps two different tokens per account: the HTTP access token and the WebSocket access token.
// Passing the HTTP token to the WebSocket client is rejected by the gateway (close code 1006 / unauthorized
// upgrade), so the first handshake must use a WS token **for the same endpoint**:
//   1. endpoint following disabled: use the configured URL/token; accept a discovered token only when the
//      discovered endpoint matches the configured one exactly (no cross-account credential reuse);
//   2. endpoint following enabled: use the discovered account pair, unless the configured endpoint matches
//      the discovered endpoint and an explicit token is configured (explicit wins for the same account).
// The HTTP token is only a flagged compatibility fallback; the resolver never claims WS auth success.

function normalizeUrl(value) {
  try {
    return new URL(String(value)).href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function resolveWsTarget({
  configuredWsUrl,
  configuredWsToken,
  httpToken,
  discovered,
  followEndpoint,
} = {}) {
  const cfgUrl = String(configuredWsUrl || '').trim();
  const cfgNorm = normalizeUrl(cfgUrl);
  const cfgToken = typeof configuredWsToken === 'string' ? configuredWsToken.trim() : '';
  const follow = followEndpoint !== false;
  const discOk = !!(discovered
    && discovered.ok
    && typeof discovered.wsUrl === 'string'
    && typeof discovered.wsToken === 'string'
    && discovered.wsToken.trim());
  const discUrl = discOk ? String(discovered.wsUrl) : '';
  const discNorm = discOk ? normalizeUrl(discUrl) : null;
  const discToken = discOk ? discovered.wsToken.trim() : '';

  if (discOk && follow) {
    if (cfgToken && cfgNorm && discNorm === cfgNorm) {
      return { url: cfgUrl || discUrl, token: cfgToken, source: 'config', warning: null };
    }
    const warning = cfgToken
      ? 'endpoint following is enabled; using the discovered account WS endpoint/token pair and ignoring the '
        + 'configured wsToken'
      : null;
    return { url: discUrl, token: discToken, source: 'discovery-pair', warning };
  }

  if (discOk && !follow && cfgNorm && discNorm === cfgNorm) {
    if (cfgToken) return { url: cfgUrl, token: cfgToken, source: 'config', warning: null };
    return { url: cfgUrl, token: discToken, source: 'discovery-same-endpoint', warning: null };
  }

  if (cfgToken) {
    return {
      url: cfgUrl,
      token: cfgToken,
      source: 'config',
      warning: discOk
        ? 'discovered WS endpoint differs and endpoint following is disabled; using the configured endpoint/token'
        : null,
    };
  }

  const http = typeof httpToken === 'string' ? httpToken.trim() : '';
  if (http) {
    return {
      url: cfgUrl,
      token: http,
      source: 'http-fallback',
      warning: 'no WS token available; falling back to the HTTP token (WS authentication may fail)',
    };
  }

  return {
    url: cfgUrl,
    token: undefined,
    source: 'none',
    warning: 'no compatible SnowLuma WS token available; the WS connection cannot authenticate',
  };
}

// Shared URL/token pair plan for startup and self-heal. Both call sites must use this function so the
// endpoint-follow policy and the explicit-token precedence cannot drift apart; `current` is the WS client's
// present state and only drives `changed`, never the selection itself.
export function planWsPairUpdate({
  configuredWsUrl,
  configuredWsToken,
  httpToken,
  discovered,
  followEndpoint,
  currentUrl,
  currentToken,
} = {}) {
  const target = resolveWsTarget({
    configuredWsUrl,
    configuredWsToken,
    httpToken,
    discovered,
    followEndpoint,
  });
  return {
    url: target.url,
    token: target.token,
    source: target.source,
    warning: target.warning,
    changed: currentUrl !== target.url || currentToken !== target.token,
  };
}
