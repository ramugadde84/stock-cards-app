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
 *   COUPON_API_TOKEN  your publisher API token / bearer token
 *
 * e.g.  COUPON_PROVIDER=rakuten COUPON_API_TOKEN=abc123 npm start
 *
 * You get a token by registering as a publisher with the network (free,
 * but there is a manual approval step — see README.md).
 */

const { httpFetch } = require('./httpClient');

const PROVIDER = process.env.COUPON_PROVIDER || 'rakuten';
const API_TOKEN = process.env.COUPON_API_TOKEN || '';

/** True when an affiliate-network token has been supplied. */
function isConfigured() {
  return Boolean(API_TOKEN);
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
        'No affiliate-network API token configured, so live merchant coupon lookup is off. ' +
        'Set COUPON_API_TOKEN (see README) to enable it. The manual tracker below works regardless.',
    };
  }

  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    throw new Error(
      `Unknown COUPON_PROVIDER "${PROVIDER}". Supported: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }

  const raw = await provider.fetchCoupons(store, API_TOKEN);
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
  /** Rakuten Advertising — Coupon/Deals feed. */
  rakuten: {
    async fetchCoupons(store, token) {
      const url =
        'https://api.linksynergy.com/coupon/1.0?keyword=' + encodeURIComponent(store);
      const json = await fetchJson(url, token, 'Rakuten');
      // Rakuten's coupon feed nests under couponfeed.link
      const links = json?.couponfeed?.link;
      return toArray(links);
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

async function fetchJson(url, token, label) {
  const response = await httpFetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${label} rejected the API token (HTTP ${response.status}). Check COUPON_API_TOKEN is current — ` +
      'most networks issue short-lived tokens that need refreshing.'
    );
  }
  if (!response.ok) {
    throw new Error(`${label} API returned HTTP ${response.status}.`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`${label} returned non-JSON response:`, text.slice(0, 500));
    throw new Error(`${label} returned a response that wasn't valid JSON — see server log.`);
  }
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
    terms: firstOf(raw, ['restrictions', 'terms', 'Terms', 'conditions']),
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

module.exports = { getCoupons, isConfigured };
