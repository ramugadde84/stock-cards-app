/**
 * Coupon / promo-code lookup
 * ---------------------------
 * IMPORTANT — read this before expecting magic:
 *
 * There is no legitimate, general-purpose way to programmatically verify
 * that an arbitrary promo code "works" on an arbitrary retailer's site.
 * The only real test is to run that retailer's checkout flow with the code
 * applied, which:
 *   - is different on literally every store (so it can't be generalised),
 *   - is explicitly prohibited by most retailers' terms of service,
 *   - trips bot-detection / rate limiting almost immediately, and
 *   - looks indistinguishable from card-testing fraud to their security.
 *
 * So this module deliberately does NOT try to "validate" codes by hammering
 * checkouts. Instead it does the honest version of the job:
 *
 *   1. Pulls codes that MERCHANTS THEMSELVES publish to affiliate networks
 *      (Rakuten, CJ/Commission Junction, Impact, Awin/ShareASale...). These
 *      come with real start/end dates straight from the merchant, so they
 *      are far more trustworthy than crowd-sourced coupon-site listings —
 *      the merchant is the source of truth for its own promotion.
 *   2. Filters out anything already past its end date.
 *
 * Even then, "published and unexpired" is not the same as "guaranteed to
 * work at checkout" — codes can be limited to certain products, first-time
 * customers, minimum spends, or regions. The UI is explicit about that,
 * and lets you record what actually happened when you tried a code.
 *
 * CONFIGURATION
 * -------------
 * Set these as environment variables before starting the server. If none
 * are set, the API-lookup half of the feature simply reports itself as
 * not configured, and the manual tracker still works fine.
 *
 *   COUPON_PROVIDER   'rakuten' (default) — which network to query
 *
 * For Rakuten, supply the three values from the Developer Portal + dashboard:
 *
 *   COUPON_CLIENT_ID      from Developer Portal > Account > Applications
 *   COUPON_CLIENT_SECRET  same screen (treat as a password)
 *   COUPON_SCOPE_ID       your SID, top-right of the Publisher Dashboard
 *
 * Rakuten does NOT hand out a long-lived API key. Those three are exchanged
 * for a short-lived bearer token at https://api.linksynergy.com/token, which
 * this module does automatically and refreshes before expiry — so you set
 * them once and never think about tokens again.
 *
 *   COUPON_API_TOKEN  optional. A pre-minted bearer token, used as-is.
 *                     Handy for other networks or for a quick test, but it
 *                     WILL expire and this module can't refresh it.
 *
 * You get credentials by registering as a publisher with the network (free,
 * but there is a manual approval step — see README.md).
 */

const { httpFetch } = require('./httpClient');

const PROVIDER = process.env.COUPON_PROVIDER || 'rakuten';

// Trimmed because a trailing space or a wrapping quote pasted from a
// dashboard is the single most common cause of a mystery 401.
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');

const API_TOKEN = clean(process.env.COUPON_API_TOKEN);
const CLIENT_ID = clean(process.env.COUPON_CLIENT_ID);
const CLIENT_SECRET = clean(process.env.COUPON_CLIENT_SECRET);
const SCOPE_ID = clean(process.env.COUPON_SCOPE_ID);

const TOKEN_URL = 'https://api.linksynergy.com/token';

/** True when either a ready token or a full credential set is present. */
function isConfigured() {
  return Boolean(API_TOKEN || (CLIENT_ID && CLIENT_SECRET && SCOPE_ID));
}

/**
 * Explains exactly which piece is missing. "Not configured" on its own sends
 * people back to the docs to re-read all four variables; naming the missing
 * one ends the search immediately.
 */
function configHint() {
  if (API_TOKEN) return null;
  const missing = [
    !CLIENT_ID && 'COUPON_CLIENT_ID',
    !CLIENT_SECRET && 'COUPON_CLIENT_SECRET',
    !SCOPE_ID && 'COUPON_SCOPE_ID (your SID — top right of the Publisher Dashboard)',
  ].filter(Boolean);
  return missing.length ? `Missing: ${missing.join(', ')}.` : null;
}

// --- Token cache -----------------------------------------------------------
// Rakuten's tokens are short-lived (the response says how long). Cached in
// memory and refreshed early; `inFlight` collapses concurrent requests into
// one exchange so a burst of lookups doesn't mint a token per request.
let cachedToken = null;
let tokenExpiresAt = 0;
let inFlight = null;

const REFRESH_MARGIN_MS = 60 * 1000;

async function getAccessToken() {
  if (API_TOKEN) return API_TOKEN;

  if (cachedToken && Date.now() < tokenExpiresAt - REFRESH_MARGIN_MS) {
    return cachedToken;
  }
  if (inFlight) return inFlight;

  inFlight = exchangeCredentialsForToken()
    .then((tok) => {
      inFlight = null;
      return tok;
    })
    .catch((err) => {
      inFlight = null;
      throw err;
    });

  return inFlight;
}

async function exchangeCredentialsForToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !SCOPE_ID) {
    throw new Error(`Rakuten credentials incomplete. ${configHint() || ''}`.trim());
  }

  // Rakuten expects HTTP Basic credentials base64-encoded, but sent with the
  // "Bearer" scheme on the token call specifically — an unusual combination
  // that looks like a typo and isn't.
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await httpFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'scope=' + encodeURIComponent(SCOPE_ID),
  });

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Rakuten rejected the client credentials (HTTP ${res.status}). Check COUPON_CLIENT_ID / ` +
      'COUPON_CLIENT_SECRET are copied exactly, and that COUPON_SCOPE_ID is your SID from the ' +
      'Publisher Dashboard (not the Client ID).'
    );
  }
  if (!res.ok) {
    console.error('Rakuten token endpoint error body:', text.slice(0, 400));
    throw new Error(`Rakuten token exchange failed (HTTP ${res.status}) — see server log.`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error('Rakuten token endpoint returned non-JSON:', text.slice(0, 400));
    throw new Error('Rakuten token endpoint returned a non-JSON response — see server log.');
  }

  const token = json.access_token || json.accessToken;
  if (!token) {
    console.error('Rakuten token response had no access_token. Keys:', Object.keys(json));
    throw new Error('Rakuten token response contained no access_token — see server log.');
  }

  // Trust the server's expires_in (seconds) when present; fall back to a
  // conservative hour rather than assuming the commonly-quoted 4 hours.
  const ttlSec = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
  cachedToken = token;
  tokenExpiresAt = Date.now() + ttlSec * 1000;

  console.log(`[coupons] Rakuten access token obtained, valid ~${Math.round(ttlSec / 60)} min.`);
  return token;
}

/** Test hook — clears the cached token so a fresh exchange happens. */
function _resetTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
  inFlight = null;
}

/**
 * Looks up currently-published promo codes for a store.
 * Returns { configured, provider, store, coupons: [...] }.
 * Never throws for "not configured" — that's a normal, expected state.
 */
async function getCoupons(store) {
  if (!isConfigured()) {
    return {
      configured: false,
      provider: PROVIDER,
      store,
      coupons: [],
      note:
        'Live merchant coupon lookup is off. ' + (configHint() || 'Set your affiliate credentials (see README).') +
        ' The manual tracker below works regardless.',
    };
  }

  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    throw new Error(
      `Unknown COUPON_PROVIDER "${PROVIDER}". Supported: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }

  let raw;
  try {
    raw = await provider.fetchCoupons(store, await getAccessToken());
  } catch (err) {
    // A cached token can expire between the freshness check and the call.
    // Retry exactly once with a fresh one; anything beyond that is a real
    // credential problem and should surface, not be retried in a loop.
    if (err && err.expiredToken && !API_TOKEN) {
      _resetTokenCache();
      raw = await provider.fetchCoupons(store, await getAccessToken());
    } else {
      throw err;
    }
  }
  const coupons = raw
    .map(normalizeCoupon)
    .filter((c) => c && !isExpired(c.endDate));

  return { configured: true, provider: PROVIDER, store, coupons };
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------
// Each adapter's job: call its network's API and hand back an array of raw
// coupon objects. normalizeCoupon() below flattens them into one shape so
// the frontend doesn't care which network the data came from.
//
// NOTE: these endpoints require an approved publisher account, and each
// network documents its own auth flow (most use a bearer token; some
// require exchanging a key for a short-lived token first). Because a live
// token is needed to exercise them, the request/response shapes here follow
// each network's published docs but have NOT been verified against a live
// account — expect to adjust field names on first run, and check the
// server log, which prints the raw response shape on a parse failure.

const PROVIDERS = {
  /**
   * Rakuten Advertising — Coupon Feed API.
   *
   * TWO THINGS THAT BURN PEOPLE HERE, both confirmed against Rakuten's
   * publisher docs (Coupon Feed API, last edited Sept 2025):
   *
   * 1. THE FEED IS XML, NOT JSON. The docs state plainly: "The Coupon Feed
   *    API currently supports only XML format and returns a maximum of 500
   *    results." Sending Accept: application/json changes nothing. An
   *    earlier version of this file parsed it as JSON and would have failed
   *    on every call.
   *
   * 2. THERE IS NO STORE-NAME SEARCH PARAMETER. The documented filters are
   *    category, promotiontype, network and advertiser (by ID) — not a free
   *    text keyword. So this pulls the feed and filters on `advertisername`
   *    locally. The feed only ever contains advertisers you already have an
   *    approved partnership with, so it stays small.
   *
   * Dates are GMT, and offers starting in the future return nothing until
   * they go live.
   */
  rakuten: {
    async fetchCoupons(store, token) {
      const url = 'https://api.linksynergy.com/coupon/1.0?resultsperpage=500';
      const xml = await fetchText(url, token, 'Rakuten');
      const rows = parseCouponXml(xml);

      if (!store) return rows;
      const needle = store.trim().toLowerCase();
      const matched = rows.filter((r) =>
        String(r.advertisername || '').toLowerCase().includes(needle)
      );
      // No match on the merchant name is worth distinguishing from an empty
      // feed: it usually means you aren't partnered with that advertiser.
      if (matched.length === 0 && rows.length > 0) {
        const names = [...new Set(rows.map((r) => r.advertisername).filter(Boolean))];
        const err = new Error(
          `No advertiser matching "${store}" in your Rakuten coupon feed. ` +
          `The feed only includes merchants you have an approved partnership with. ` +
          (names.length
            ? `Currently available: ${names.slice(0, 25).join(', ')}${names.length > 25 ? `, +${names.length - 25} more` : ''}.`
            : '')
        );
        err.userFacing = true;
        throw err;
      }
      return matched;
    },
  },

  /** Impact.com — Ads/Promos endpoint. */
  impact: {
    async fetchCoupons(store, token) {
      const url =
        'https://api.impact.com/Mediapartners/Ads?Query=' + encodeURIComponent(store);
      const json = await fetchJson(url, token, 'Impact');
      return toArray(json?.Ads);
    },
  },

  /** Awin (which now includes ShareASale) — promotions endpoint. */
  awin: {
    async fetchCoupons(store, token) {
      const url =
        'https://api.awin.com/publishers/promotions?advertiserName=' +
        encodeURIComponent(store);
      const json = await fetchJson(url, token, 'Awin');
      return toArray(json?.data);
    },
  },
};

async function fetchText(url, token, label, accept = 'application/xml') {
  const response = await httpFetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept,
    },
  });

  if (response.status === 401 || response.status === 403) {
    const err = new Error(
      `${label} rejected the access token (HTTP ${response.status}). If you set COUPON_API_TOKEN by hand ` +
      'it has expired — prefer COUPON_CLIENT_ID / COUPON_CLIENT_SECRET / COUPON_SCOPE_ID, which refresh automatically.'
    );
    // Flag so the caller can retry once with a freshly minted token.
    err.expiredToken = true;
    throw err;
  }
  if (response.status === 429) {
    throw new Error(`${label} rate-limited the request (HTTP 429). The coupon feed allows 100 calls/minute.`);
  }
  if (!response.ok) {
    throw new Error(`${label} API returned HTTP ${response.status}.`);
  }

  return response.text();
}

async function fetchJson(url, token, label) {
  const text = await fetchText(url, token, label, 'application/json');
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`${label} returned non-JSON response:`, text.slice(0, 500));
    throw new Error(`${label} returned a response that wasn't valid JSON — see server log.`);
  }
}

/**
 * Minimal parser for Rakuten's coupon feed XML.
 *
 * Deliberately not a general XML parser — it handles exactly the one shape
 * this feed returns, which avoids adding a dependency for a single endpoint:
 *
 *   <couponfeed>
 *     <link>
 *       <offerdescription>20% off</offerdescription>
 *       <couponcode>SAVE20</couponcode>
 *       <offerenddate>2026-08-31</offerenddate>
 *       <advertisername>Store</advertisername>
 *       <clickurl>https://click.linksynergy.com/...</clickurl>
 *       ...
 *     </link>
 *   </couponfeed>
 *
 * Nested elements (categories, promotiontypes) are skipped rather than
 * flattened — nothing downstream uses them, and half-parsing them would
 * produce misleading values.
 */
function parseCouponXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<link')) return [];

  const rows = [];
  const linkRe = /<link\b[^>]*>([\s\S]*?)<\/link>/gi;
  let m;

  while ((m = linkRe.exec(xml)) !== null) {
    const body = m[1];
    const row = {};
    // Only leaf elements: a value containing '<' is a nested block, skip it.
    const tagRe = /<([a-z0-9_]+)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let t;
    while ((t = tagRe.exec(body)) !== null) {
      const [, tag, rawVal] = t;
      // Unwrap CDATA before the nested-element check — a CDATA-wrapped value
      // contains '<' from its own delimiter and would otherwise be skipped
      // as if it were a container element.
      const unwrapped = rawVal.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      if (unwrapped.includes('<')) continue;
      const val = decodeXmlEntities(unwrapped).trim();
      if (val) row[tag.toLowerCase()] = val;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

function decodeXmlEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // last, so &amp;lt; doesn't become '<'
}

/** Wraps a single object in an array; passes arrays through; [] for null. */
function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Flattens each network's differently-shaped coupon object into one common
 * shape. Field names vary by network (and sometimes by endpoint version),
 * so each is tried in order of likelihood and falls back to null rather
 * than guessing.
 */
function normalizeCoupon(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const code = firstOf(raw, ['couponcode', 'couponCode', 'code', 'PromoCode', 'voucherCode']);
  const description = firstOf(raw, [
    'offerdescription',
    'offerDescription',
    'description',
    'Description',
    'title',
    'Name',
  ]);

  // Nothing useful to show without at least a code or a description.
  if (!code && !description) return null;

  return {
    code: code || null,
    description: description || 'No description provided by merchant.',
    merchant: firstOf(raw, ['advertisername', 'advertiserName', 'merchant', 'CampaignName', 'Name']),
    startDate: firstOf(raw, ['offerstartdate', 'startDate', 'StartDate', 'validFrom']),
    endDate: firstOf(raw, ['offerenddate', 'endDate', 'EndDate', 'validTo', 'expirationDate']),
    url: firstOf(raw, ['clickurl', 'clickUrl', 'TrackingLink', 'url', 'landingPage']),
    terms: firstOf(raw, ['couponrestriction', 'restrictions', 'terms', 'Terms', 'conditions']),
  };
}

/** Returns the first present, non-empty value among candidate keys. */
function firstOf(obj, keys) {
  for (const key of keys) {
    let v = obj[key];
    // Some feeds wrap scalars as { value: '...' } or similar.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      v = v.value ?? v._ ?? v.text ?? null;
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** True if endDate parses to a date strictly before today. */
function isExpired(endDate) {
  if (!endDate) return false; // no end date published — can't call it expired
  const t = Date.parse(endDate);
  if (Number.isNaN(t)) return false; // unparseable — don't silently drop it
  // Compare against start of today so a code expiring "today" still shows.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return t < startOfToday.getTime();
}

module.exports = {
  getCoupons,
  isConfigured,
  configHint,
  getAccessToken,
  parseCouponXml,
  normalizeCoupon,
  isExpired,
  _resetTokenCache,
};
