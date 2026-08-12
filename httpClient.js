/**
 * Shared proxy-aware fetch
 * -------------------------
 * THE PROBLEM THIS SOLVES
 * Chrome uses the Windows system proxy automatically. Node's built-in
 * fetch() does not — and it ignores HTTP_PROXY/HTTPS_PROXY too. On a
 * corporate network the result is that a URL loads fine in your browser but
 * every request from the app dies with a bare "fetch failed".
 *
 * Every outbound request in this app goes through httpFetch() below, so the
 * proxy is configured once here rather than in five different modules.
 *
 * SETUP (only needed if you're behind a proxy)
 *   npm install undici
 *   set HTTPS_PROXY=http://your-proxy-host:port
 *
 * Find your proxy on Windows with:
 *   netsh winhttp show proxy
 * or Settings → Network & Internet → Proxy.
 *
 * With no proxy set this is a transparent pass-through to normal fetch().
 */

/**
 * HEADER SIZE — why this matters
 * Node caps response headers at 16KB by default and throws
 * UND_ERR_HEADERS_OVERFLOW past that. Yahoo Finance routinely exceeds it
 * (huge Set-Cookie and consent headers), so requests fail even though the
 * connection succeeded and the network is perfectly fine. Browsers have no
 * such limit, which is why the same URL loads there.
 *
 * Raising this to 128KB fixes it without needing a --max-http-header-size
 * CLI flag, so `npm start` just works.
 */
const MAX_HEADER_SIZE = 128 * 1024;

let dispatcher = null;
let proxyUrl = null;
let warnedMissingUndici = false;

(function init() {
  proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    null;

  let undici;
  try {
    undici = require('undici');
  } catch (e) {
    // undici absent: fall back to plain fetch. Header overflow may still
    // occur on Yahoo — the error message below explains the remedy.
    if (proxyUrl) {
      warnedMissingUndici = true;
      console.warn(
        `[http] ${proxyUrl} is set, but the "undici" package isn't installed so Node ` +
        'cannot route through it. Run:  npm install undici'
      );
    } else {
      console.warn(
        '[http] "undici" is not installed, so the response-header limit cannot be raised. ' +
        'Yahoo Finance may fail with UND_ERR_HEADERS_OVERFLOW. Run:  npm install undici'
      );
    }
    return;
  }

  if (proxyUrl) {
    dispatcher = new undici.ProxyAgent({ uri: proxyUrl, maxHeaderSize: MAX_HEADER_SIZE });
    console.log(`[http] Proxy enabled: ${proxyUrl} (max header ${MAX_HEADER_SIZE / 1024}KB)`);
  } else {
    // No proxy, but still install an Agent purely to raise the header limit.
    dispatcher = new undici.Agent({ maxHeaderSize: MAX_HEADER_SIZE });
    console.log(`[http] Direct connection (max header ${MAX_HEADER_SIZE / 1024}KB)`);
  }
})();

/**
 * Drop-in replacement for fetch() that honours the proxy when configured
 * and turns opaque network failures into messages that say what to do.
 */
async function httpFetch(url, options = {}) {
  const opts = { ...options };
  if (dispatcher) opts.dispatcher = dispatcher;

  try {
    return await fetch(url, opts);
  } catch (err) {
    // Node's "fetch failed" is uselessly vague; add the likely cause.
    const cause = err.cause?.code || err.cause?.message || '';
    let hint;

    if (cause === 'UND_ERR_HEADERS_OVERFLOW') {
      // Connection succeeded — the response headers were just too large.
      hint =
        `the server's response headers exceeded Node's limit. This is NOT a network ` +
        `problem. Ensure "undici" is installed (npm install undici) so the limit can be ` +
        `raised to ${MAX_HEADER_SIZE / 1024}KB, or start with: ` +
        `node --max-http-header-size=131072 server.js`;
    } else if (proxyUrl && warnedMissingUndici) {
      hint = `a proxy is set (${proxyUrl}) but "undici" isn't installed — run: npm install undici`;
    } else if (proxyUrl) {
      hint = `check the proxy address is correct (currently ${proxyUrl})`;
    } else {
      hint =
        'no proxy is configured. If this URL works in your browser but not here, ' +
        'you are probably behind a corporate proxy — run "netsh winhttp show proxy", ' +
        'then: npm install undici && set HTTPS_PROXY=http://host:port';
    }

    const host = (() => {
      try { return new URL(url).host; } catch (e) { return url; }
    })();

    throw new Error(`Could not reach ${host}${cause ? ` (${cause})` : ''} — ${hint}`);
  }
}

/** True when a proxy env var is set (whether or not undici is present). */
function isProxyConfigured() {
  return Boolean(proxyUrl);
}

module.exports = { httpFetch, isProxyConfigured };
