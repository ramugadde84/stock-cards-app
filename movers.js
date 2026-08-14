/**
 * Extended-hours movers scanner
 * ------------------------------
 * Scans a ticker universe and returns only the ones ACTUALLY MOVING in the
 * current session — pre-market, after-hours, or regular.
 *
 * WHICH SESSION IT READS
 * Yahoo's quote data carries three separate change figures, and picking the
 * wrong one is how you end up showing yesterday's move at 6pm. The scanner
 * reads `marketState` and uses the matching field:
 *
 *   PRE / PREPRE   -> preMarketChangePercent
 *   POST / POSTPOST-> postMarketChangePercent
 *   REGULAR        -> regularMarketChangePercent
 *   CLOSED         -> postMarketChangePercent if present, else regular
 *
 * WHY A THRESHOLD
 * In extended hours most names barely trade. Without a minimum move you get
 * 500 rows of ±0.05% noise and the two that matter are buried. Anything
 * below the threshold is counted but not listed.
 *
 * WHY THIS USES THE CHART ENDPOINT
 * Yahoo's batch quote endpoint (/v7/finance/quote) now generally requires a
 * session crumb, which is fragile to reproduce. The chart endpoint
 * (/v8/finance/chart) works without one and its `meta` block carries the
 * pre/post fields — the trade-off is one request per ticker, so requests are
 * issued in bounded parallel batches rather than all at once.
 */

const { httpFetch } = require('./httpClient');
const { SP500, TOP_100 } = require('./sp500');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Bounded concurrency — enough to be quick, not enough to look like abuse.
const BATCH_SIZE = Number(process.env.MOVERS_BATCH_SIZE || 25);
const BATCH_PAUSE_MS = Number(process.env.MOVERS_BATCH_PAUSE || 120);

async function fetchQuote(ticker) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) +
    '?range=1d&interval=1d&includePrePost=true';

  const res = await httpFetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('no meta');
  return meta;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/**
 * Percent change from `from` to `to`, or null if either is unusable.
 * Used as a fallback: Yahoo's chart `meta` block does not reliably carry the
 * *ChangePercent fields on every symbol — but when it gives the extended-hours
 * price it has also given us everything needed to work the move out. Deriving
 * it is better than dropping the ticker from the scan entirely.
 */
function pctChange(to, from) {
  if (to === null || from === null || from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * How stale an extended-hours figure can be before it's flagged.
 * A post-market print from last night is still real data — it's just not
 * tonight's. Rather than hide it, each row carries an `ageMins` and a
 * `stale` flag so the UI can say "that's last session" instead of implying
 * the stock is moving right now.
 */
const STALE_AFTER_MINS = Number(process.env.MOVERS_STALE_MINS || 240); // 4h

/**
 * Picks the change figure for a session.
 *
 * @param meta   Yahoo chart `meta` block
 * @param forced 'post' | 'pre' | 'regular' | 'auto'
 *
 * 'auto' follows Yahoo's own `marketState`. Forcing a session is the point of
 * the toggle: at 9am you may still want last night's after-hours reaction,
 * and auto-mode would hand you the pre-market tape instead.
 */
function pickSessionMove(meta, forced = 'auto') {
  const state = meta.marketState || 'REGULAR';

  const prePrice = num(meta.preMarketPrice);
  const postPrice = num(meta.postMarketPrice);
  const regPrice = num(meta.regularMarketPrice);
  const prevClose = num(meta.chartPreviousClose ?? meta.previousClose);

  // Extended-hours moves are quoted against the regular-session close; the
  // regular-session move is quoted against the PREVIOUS day's close. Using
  // the wrong baseline double-counts the day's move.
  const pre = num(meta.preMarketChangePercent) ?? pctChange(prePrice, regPrice ?? prevClose);
  const post = num(meta.postMarketChangePercent) ?? pctChange(postPrice, regPrice ?? prevClose);
  const reg = num(meta.regularMarketChangePercent) ?? pctChange(regPrice, prevClose);

  // Yahoo timestamps are epoch SECONDS.
  const preTime = num(meta.preMarketTime);
  const postTime = num(meta.postMarketTime);
  const regTime = num(meta.regularMarketTime);

  const nowSec = Date.now() / 1000;
  const age = (t) => (t === null ? null : Math.max(0, Math.round((nowSec - t) / 60)));

  const build = (session, changePct, price, at) => {
    if (changePct === null) return null;
    const ageMins = age(at);
    return {
      session,
      changePct,
      price,
      at,
      ageMins,
      // Only extended-hours figures go stale in a way that misleads; a
      // regular-session close is expected to be old outside market hours.
      stale: session !== 'regular' && ageMins !== null && ageMins > STALE_AFTER_MINS,
    };
  };

  const POST = () => build('after-hours', post, postPrice ?? regPrice, postTime);
  const PRE = () => build('pre-market', pre, prePrice ?? regPrice, preTime);
  const REG = () => build('regular', reg, regPrice, regTime);

  // Forced session: return exactly what was asked for, or nothing. Quietly
  // substituting a different session is how you end up reading the wrong
  // number without ever being told.
  if (forced === 'post') return POST();
  if (forced === 'pre') return PRE();
  if (forced === 'regular') return REG();

  if (state === 'PRE' || state === 'PREPRE') {
    const r = PRE();
    if (r) return r;
  }
  if (state === 'POST' || state === 'POSTPOST') {
    const r = POST();
    if (r) return r;
  }
  if (state === 'REGULAR') {
    const r = REG();
    if (r) return r;
  }
  // CLOSED (or a session with no figure yet): prefer the most recent
  // extended-hours print, otherwise fall back to the regular session.
  return POST() || PRE() || REG() || null;
}

const VALID_SESSIONS = ['auto', 'post', 'pre', 'regular'];

/**
 * Scans the universe and returns movers above `minMove` percent.
 * opts: {
 *   universe: 'top100'|'sp500',
 *   minMove: number,
 *   limit: number,
 *   session: 'auto'|'post'|'pre'|'regular'   // default 'auto'
 * }
 */
async function scanMovers(opts = {}) {
  const universeName = opts.universe === 'sp500' ? 'sp500' : 'top100';
  const tickers = universeName === 'sp500' ? SP500 : TOP_100;
  // minMove = 0 means "everything that moved at all" — the flat names are
  // still excluded, because a stock printing exactly 0.00% is not moving.
  const minMove = Number.isFinite(Number(opts.minMove)) ? Math.abs(Number(opts.minMove)) : 1;
  // Cap at the universe size, not an arbitrary 100 — asking for every
  // after-hours mover and silently getting the top 100 back would be wrong.
  const limit = Math.min(Number(opts.limit) || 25, SP500.length);
  const session = VALID_SESSIONS.includes(opts.session) ? opts.session : 'auto';

  const started = Date.now();
  const results = [];
  const failures = [];
  // Counted separately: when you force after-hours during the middle of the
  // trading day, most names simply have no post-market print yet. That is a
  // different situation from "not moving" and the UI needs to say so.
  let noFigure = 0;
  let marketState = null;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((t) => fetchQuote(t)));

    settled.forEach((r, idx) => {
      const ticker = batch[idx];
      if (r.status !== 'fulfilled') {
        failures.push(ticker);
        return;
      }
      const meta = r.value;
      if (!marketState) marketState = meta.marketState || null;

      const move = pickSessionMove(meta, session);
      if (!move || move.changePct === null) {
        noFigure++;
        return;
      }

      results.push({
        ticker: meta.symbol || ticker,
        name: meta.longName || meta.shortName || ticker,
        price: move.price,
        changePct: move.changePct,
        session: move.session,
        at: move.at,
        ageMins: move.ageMins,
        stale: move.stale,
        previousClose: num(meta.chartPreviousClose ?? meta.previousClose),
        regularPrice: num(meta.regularMarketPrice),
        volume: num(meta.regularMarketVolume),
        currency: meta.currency || '',
      });
    });

    if (i + BATCH_SIZE < tickers.length) {
      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  const movers = results
    .filter((r) => Math.abs(r.changePct) >= minMove && r.changePct !== 0)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  // Names that quoted fine but printed exactly flat. Reported separately so
  // "500 scanned, 120 moving" doesn't leave you wondering about the other 380.
  const flat = results.filter((r) => r.changePct === 0).length;

  const staleCount = movers.filter((m) => m.stale).length;

  return {
    universe: universeName,
    session,                      // what was asked for
    scanned: tickers.length,
    quoted: results.length,
    failed: failures.length,
    // No print for the requested session — distinct from "didn't move".
    noFigure,
    // Named explicitly so a quiet result reads as "nothing moved" rather
    // than looking like the scan broke.
    moversFound: movers.length,
    flat,
    staleCount,
    minMove,
    limit,
    // True when the list was cut short — the UI must not imply it's showing
    // everything when it isn't.
    truncated: movers.filter((m) => m.changePct > 0).length > limit ||
               movers.filter((m) => m.changePct < 0).length > limit,
    marketState,                  // what Yahoo says is live right now
    elapsedMs: Date.now() - started,
    gainers: movers.filter((m) => m.changePct > 0).slice(0, limit),
    losers: movers.filter((m) => m.changePct < 0).slice(0, limit),
    failedTickers: failures.slice(0, 20),
  };
}

module.exports = { scanMovers, pickSessionMove };
