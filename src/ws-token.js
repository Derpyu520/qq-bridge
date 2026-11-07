// Pure resolver for the SnowLuma OneBot WebSocket target (URL + token pair).
//
// SnowLuma keeps two different tokens per account: the HTTP access token and the WebSocket access token.
// Passing the HTTP token to the WebSocket client is rejected by the gateway (close code 1006 / unauthorized
// upgrade), so the first handshake must use a WS token **for the same endpoint**:
//   1. an explicit `snowluma.wsToken` always pins its configured `wsUrl`; discovery never rebinds that pair
//      (a discovered different endpoint is ignored with a warning);
//   2. with no explicit token and endpoint following enabled, use the discovered account pair;
//   3. with no explicit token and following disabled, accept a discovered token only when the discovered
//      endpoint matches the configured endpoint exactly (no cross-account credential reuse).
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

  // An explicit wsToken pins the configured endpoint: persisting another URL while keeping this token would
  // create a mismatched pair across heals/restarts. Discovery only supplies the token when no explicit token
  // is configured.
  if (cfgToken) {
    const mismatch = !!(discOk && cfgNorm && discNorm && discNorm !== cfgNorm);
    return {
      url: cfgUrl,
      token: cfgToken,
      source: 'config',
      warning: mismatch
        ? 'explicit wsToken pins the configured endpoint; the discovered endpoint was ignored'
        : null,
    };
  }

  if (discOk && follow) {
    return { url: discUrl, token: discToken, source: 'discovery-pair', warning: null };
  }

  if (discOk && !follow && cfgNorm && discNorm === cfgNorm) {
    return { url: cfgUrl, token: discToken, source: 'discovery-same-endpoint', warning: null };
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

// Decide what to persist after a heal. Persisting a discovered endpoint together with an *old* explicit
// token would create a mismatched pair in config.json (url=B, token=Token-A), so an explicit token keeps the
// configured endpoint authoritative in config; the runtime may still use the discovered pair.
export function planConfigUpdate({
  plan,
  followEndpoint,
  configuredWsToken,
  configuredWsUrl,
  configuredHttpUrl,
  discoveredBaseUrl,
} = {}) {
  const hasExplicitWsToken = typeof configuredWsToken === 'string' && configuredWsToken.trim() !== '';
  const persistEndpoint = followEndpoint !== false && !hasExplicitWsToken;
  if (!persistEndpoint) {
    return {
      wsUrl: configuredWsUrl,
      httpUrl: configuredHttpUrl,
      persist: {},
      warning: hasExplicitWsToken && followEndpoint !== false
        ? 'configured wsToken is explicit; keeping its configured endpoint/token pair in config and for '
          + 'runtime (the discovered endpoint is ignored)'
        : null,
    };
  }
  return {
    wsUrl: plan.url,
    httpUrl: discoveredBaseUrl || configuredHttpUrl,
    persist: { wsUrl: plan.url, httpUrl: discoveredBaseUrl },
    warning: null,
  };
}
