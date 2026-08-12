/**
 * Stock Watch — local server
 * ---------------------------
 * Serves a small web app (public/) with two views:
 *   1. Search — search any ticker, get a card with the last 10 daily
 *      end-of-day (EOD) price bars.
 *   2. Earnings Calendar — pick a date, see every ticker Yahoo Finance
 *      lists as reporting earnings that day, each with its current price.
 *
 * Both views pull from Yahoo Finance's public (unofficial) endpoints — no
 * official public API exists. See README.md for full caveats.
 *
 * Run locally:
 *   npm install
 *   npm start
 *   open http://localhost:3000
 */

const express = require('express');
const path = require('path');
const { getEarningsForDate } = require('./earnings');
const { getCoupons } = require('./coupons');
const {
  getTickerReport,
  getBullsBearsOnly,
  getEarningsThisMonthOnly,
  getEarningsCalendarOnly,
} = require('./benzinga');
const { analyzeEarnings, isConfigured: aiConfigured } = require('./ai');
const { httpFetch } = require('./httpClient');
const { getMacroCalendar } = require('./macro');

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Safety cap so a single "load earnings" click can't trigger hundreds of
// price lookups on very high-volume earnings days (some single days have
// 400-600+ companies reporting) — keeps response times reasonable and
// avoids hammering Yahoo. See README.md.
const MAX_EARNINGS_TICKERS = Number(process.env.MAX_EARNINGS_TICKERS || 600);
const EARNINGS_QUOTE_BATCH_SIZE = Number(process.env.EARNINGS_BATCH_SIZE || 30);

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// GET /api/stock/:ticker — 10-day EOD detail for one ticker
// ============================================================================
app.get('/api/stock/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  try {
    // range=1mo gives ~21 trading days of daily bars, comfortably covering
    // "the last 10 trading days" even across weekends/holidays.
    const result = await fetchYahooChartResult(rawTicker, '1mo');

    if (result.error) {
      return res.status(result.status || 502).json({ error: result.error });
    }

    const { meta, timestamps, quote } = result;

    const days = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quote.close ? quote.close[i] : null;
      if (close === null || close === undefined) continue; // holiday / no trade
      days.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: round2(quote.open ? quote.open[i] : null),
        high: round2(quote.high ? quote.high[i] : null),
        low: round2(quote.low ? quote.low[i] : null),
        close: round2(close),
        volume: quote.volume ? quote.volume[i] : null,
      });
    }

    const last10 = days.slice(-10);
    if (last10.length === 0) {
      return res.status(404).json({ error: `No trading-day price data found for "${rawTicker}".` });
    }

    const firstClose = last10[0].close;
    const lastClose = last10[last10.length - 1].close;
    const periodChange = firstClose !== null && lastClose !== null ? lastClose - firstClose : null;
    const periodChangePercent =
      periodChange !== null && firstClose ? (periodChange / firstClose) * 100 : null;

    res.json({
      ticker: meta.symbol || rawTicker,
      name: meta.longName || meta.shortName || rawTicker,
      currency: meta.currency || '',
      exchange: meta.fullExchangeName || meta.exchangeName || '',
      currentPrice: round2(meta.regularMarketPrice),
      days: last10,
      periodChange: round2(periodChange),
      periodChangePercent: periodChangePercent === null ? null : round2(periodChangePercent),
    });
  } catch (err) {
    console.error(`Error fetching ${rawTicker}:`, err);
    res.status(500).json({ error: `Server error fetching data for "${rawTicker}": ${err.message}` });
  }
});

// ============================================================================
// GET /api/earnings-reaction/:ticker — EPS beat/miss + pre/post-market move
// ============================================================================
app.get('/api/earnings-reaction/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  try {
    const url =
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
      encodeURIComponent(rawTicker) +
      '?modules=earningsHistory,price';

    const response = await httpFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });

    if (!response.ok) {
      return res.status(502).json({
        error: `Yahoo Finance returned HTTP ${response.status} for "${rawTicker}". It may be an invalid ticker, or Yahoo is temporarily rate-limiting requests.`,
      });
    }

    const data = await response.json();
    const result = data && data.quoteSummary && data.quoteSummary.result && data.quoteSummary.result[0];

    if (!result) {
      const errDesc = (data && data.quoteSummary && data.quoteSummary.error && data.quoteSummary.error.description) || 'No data returned.';
      return res.status(404).json({ error: `No data found for "${rawTicker}". ${errDesc}` });
    }

    const priceInfo = result.price || {};
    const history = (result.earningsHistory && result.earningsHistory.history) || [];

    // Pick the most recent quarter by "quarter" (period-end) timestamp —
    // Yahoo doesn't guarantee array order across all tickers, so we sort
    // defensively rather than assuming history[0] is newest.
    const withQuarter = history.filter((h) => h && h.quarter);
    withQuarter.sort((a, b) => toEpoch(b.quarter) - toEpoch(a.quarter));
    const latest = withQuarter[0] || null;

    const hasReported = !!latest && typeof latest.epsActual === 'number';

    // Figure out which price move is the relevant "reaction" — pre-market
    // change if we're currently in pre-market, post-market change if we're
    // in post/after-hours, otherwise the regular session's change.
    const marketState = priceInfo.marketState || 'REGULAR';
    let reactionChangePercent = null;
    let reactionLabel = 'Regular session';
    if (marketState === 'PRE' || marketState === 'PREPRE') {
      reactionChangePercent = numOrNull(priceInfo.preMarketChangePercent);
      reactionLabel = 'Pre-market';
    } else if (marketState === 'POST' || marketState === 'POSTPOST') {
      reactionChangePercent = numOrNull(priceInfo.postMarketChangePercent);
      reactionLabel = 'After-hours';
    } else {
      reactionChangePercent = numOrNull(priceInfo.regularMarketChangePercent);
      reactionLabel = 'Regular session';
    }
    // If the "obvious" session has no data (e.g. after-hours but Yahoo
    // hasn't posted a postMarket move yet), fall back through the others
    // rather than showing nothing.
    if (reactionChangePercent === null) {
      const fallbacks = [
        ['Pre-market', numOrNull(priceInfo.preMarketChangePercent)],
        ['Regular session', numOrNull(priceInfo.regularMarketChangePercent)],
        ['After-hours', numOrNull(priceInfo.postMarketChangePercent)],
      ];
      for (const [label, val] of fallbacks) {
        if (val !== null) {
          reactionChangePercent = val;
          reactionLabel = label;
          break;
        }
      }
    }

    const verdict = computeBullishBearish(hasReported, latest, reactionChangePercent);

    res.json({
      ticker: priceInfo.symbol || rawTicker,
      name: priceInfo.longName || priceInfo.shortName || rawTicker,
      marketState,
      hasReported,
      epsEstimate: hasReported ? numOrNull(latest.epsEstimate) : null,
      epsActual: hasReported ? numOrNull(latest.epsActual) : null,
      epsSurprisePercent: hasReported ? numOrNull(latest.surprisePercent) : null,
      quarterEndDate: hasReported ? isoFromEpoch(latest.quarter) : null,
      currentPrice: numOrNull(priceInfo.regularMarketPrice),
      preMarketPrice: numOrNull(priceInfo.preMarketPrice),
      preMarketChangePercent: numOrNull(priceInfo.preMarketChangePercent),
      postMarketPrice: numOrNull(priceInfo.postMarketPrice),
      postMarketChangePercent: numOrNull(priceInfo.postMarketChangePercent),
      reactionLabel,
      reactionChangePercent,
      verdict, // { label: 'Bullish' | 'Bearish' | 'Mixed' | 'Neutral' | 'Awaiting results', emoji }
    });
  } catch (err) {
    console.error(`Error fetching earnings reaction for ${rawTicker}:`, err);
    res.status(500).json({ error: `Server error fetching earnings reaction for "${rawTicker}": ${err.message}` });
  }
});

/**
 * Simple, transparent heuristic — NOT financial advice, just a readable
 * summary of two facts: did EPS beat/miss estimates, and did the price
 * move up or down in reaction. Both are shown alongside the label so you
 * can judge for yourself; "Mixed" covers the (common) case where the
 * two disagree, e.g. an EPS beat that the market still sells off on
 * because of weak guidance.
 */
function computeBullishBearish(hasReported, latest, reactionChangePercent) {
  if (!hasReported) {
    return { label: 'Awaiting results', emoji: '⏳' };
  }
  const epsActual = numOrNull(latest.epsActual);
  const epsEstimate = numOrNull(latest.epsEstimate);
  const beat = epsActual !== null && epsEstimate !== null ? epsActual > epsEstimate : null;
  const miss = epsActual !== null && epsEstimate !== null ? epsActual < epsEstimate : null;
  const priceUp = reactionChangePercent !== null ? reactionChangePercent > 0 : null;
  const priceDown = reactionChangePercent !== null ? reactionChangePercent < 0 : null;

  if (beat === null || priceUp === null) {
    return { label: 'Neutral', emoji: '⚪' };
  }
  if (beat && priceUp) return { label: 'Bullish', emoji: '🟢' };
  if (miss && priceDown) return { label: 'Bearish', emoji: '🔴' };
  if (!beat && !miss) return { label: 'Neutral', emoji: '⚪' }; // met estimate exactly
  return { label: 'Mixed', emoji: '⚠️' }; // beat-but-sold-off or miss-but-bought-up
}

function numOrNull(n) {
  return typeof n === 'number' && isFinite(n) ? n : null;
}

/** Yahoo's quoteSummary dates come back as { raw: epochSeconds, fmt: '...' } or a plain epoch number. */
function toEpoch(dateField) {
  if (dateField && typeof dateField === 'object' && typeof dateField.raw === 'number') return dateField.raw;
  if (typeof dateField === 'number') return dateField;
  return 0;
}

function isoFromEpoch(dateField) {
  const epoch = toEpoch(dateField);
  return epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
}

// ============================================================================
// GET /api/earnings?date=YYYY-MM-DD — all tickers reporting that day, priced
// ============================================================================
app.get('/api/earnings', async (req, res) => {
  const dateStr = String(req.query.date || todayYMD()).trim();
  const session = String(req.query.session || 'all').trim().toLowerCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: '"date" must be in YYYY-MM-DD format.' });
  }
  const allowedSessions = ['pre', 'post', 'other', 'all'];
  if (!allowedSessions.includes(session)) {
    return res.status(400).json({ error: `"session" must be one of: ${allowedSessions.join(', ')}` });
  }

  // Pricing is the slow part — one upstream request per ticker. Skipping it
  // returns the complete list instantly, which is what you want when the
  // goal is "show me every pre-market name" rather than "show me prices".
  const withPrices = String(req.query.prices || 'true').toLowerCase() !== 'false';

  try {
    const { entries: allEntries, diagnostics } = await getEarningsForDate(dateStr);
    let entries = allEntries;
    const totalForDate = entries.length;

    // Yahoo's calendar gives BMO/AMC/TNS directly, so the split is exact
    // here rather than inferred from a clock time.
    //   BMO = before market open  -> pre
    //   AMC = after market close  -> post
    //   TNS/TAS/N-A = time not supplied -> other
    if (session !== 'all') {
      entries = entries.filter((e) => sessionOf(e.time) === session);
    }
    const totalInSession = entries.length;

    // Without pricing there's no per-ticker upstream work, so the cap only
    // applies when prices are requested.
    let capped = false;
    if (withPrices && entries.length > MAX_EARNINGS_TICKERS) {
      entries = entries.slice(0, MAX_EARNINGS_TICKERS);
      capped = true;
    }

    let results;
    if (withPrices) {
      results = await priceEarningsEntries(entries);
      // Rank by price descending as a rough size proxy. Yahoo's calendar
      // page doesn't expose revenue, so price is the only size-ish figure
      // on this path — the Benzinga route ranks by actual revenue.
      results.sort((a, b) => {
        if (a.price === null && b.price === null) return String(a.ticker).localeCompare(String(b.ticker));
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return b.price - a.price;
      });
    } else {
      // List-only mode: every ticker, alphabetical, no upstream price calls.
      results = entries
        .map((e) => ({ ...e, price: null, name: e.ticker, currency: '' }))
        .sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
    }

    res.json({
      date: dateStr,
      session,
      totalForDate,
      totalInSession,
      returnedCount: results.length,
      capped, // true if totalInSession > MAX_EARNINGS_TICKERS — see README
      pricesIncluded: withPrices,
      sortedBy: withPrices ? 'price' : 'ticker',
      diagnostics, // pagination detail — explains a short list
      results,
    });
  } catch (err) {
    console.error(`Error fetching earnings for ${dateStr}:`, err);
    res.status(500).json({ error: `Server error fetching earnings for ${dateStr}: ${err.message}` });
  }
});

/** Maps Yahoo's BMO/AMC/TNS call-time codes to a session bucket. */
function sessionOf(time) {
  const t = String(time || '').toUpperCase();
  if (t === 'BMO') return 'pre';
  if (t === 'AMC') return 'post';
  return 'other';
}

/** Fetches current price + name for each earnings entry, in parallel batches. */
async function priceEarningsEntries(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i += EARNINGS_QUOTE_BATCH_SIZE) {
    const batch = entries.slice(i, i + EARNINGS_QUOTE_BATCH_SIZE);
    const settled = await Promise.all(
      batch.map(async (entry) => {
        try {
          const result = await fetchYahooChartResult(entry.ticker, '5d');
          if (result.error || typeof result.meta.regularMarketPrice !== 'number') {
            return { ...entry, price: null, name: entry.ticker, currency: '', error: result.error || 'Price unavailable' };
          }
          return {
            ...entry,
            price: round2(result.meta.regularMarketPrice),
            name: result.meta.longName || result.meta.shortName || entry.ticker,
            currency: result.meta.currency || '',
          };
        } catch (e) {
          return { ...entry, price: null, name: entry.ticker, currency: '', error: e.message };
        }
      })
    );
    out.push(...settled);
  }
  return out;
}

// ============================================================================
// GET /api/bulls-bears/:ticker — just the bull & bear cases (card button)
// ============================================================================
// Deliberately hits only the bulls_bears_say endpoint. Fast, and unaffected
// by whether other Benzinga datasets are in your licence.
app.get('/api/bulls-bears/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  try {
    const data = await getBullsBearsOnly(rawTicker);
    res.json(data);
  } catch (err) {
    console.error(`Bulls/bears lookup failed for ${rawTicker}:`, err);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/earnings-calendar?date=YYYY-MM-DD&session=pre|post|during|all
// ============================================================================
// All companies reporting on a date, filtered by trading session and ranked
// by revenue (largest first). Benzinga-backed, so it carries real revenue
// figures — unlike the Yahoo-scraped /api/earnings route.
app.get('/api/earnings-calendar', async (req, res) => {
  const dateStr = String(req.query.date || todayYMD()).trim();
  const session = String(req.query.session || 'all').trim().toLowerCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: '"date" must be in YYYY-MM-DD format.' });
  }
  const allowed = ['pre', 'post', 'during', 'unspecified', 'all'];
  if (!allowed.includes(session)) {
    return res.status(400).json({ error: `"session" must be one of: ${allowed.join(', ')}` });
  }

  try {
    const data = await getEarningsCalendarOnly(dateStr, session);
    res.json(data);
  } catch (err) {
    console.error(`Earnings calendar failed for ${dateStr}/${session}:`, err);
    res.status(502).json({ error: err.message });
  }
});


// ============================================================================
// GET /api/macro-calendar — CPI / jobs / FOMC dates, auto-rolling
// ============================================================================
app.get('/api/macro-calendar', async (req, res) => {
  try {
    const data = await getMacroCalendar();
    res.json(data);
  } catch (err) {
    console.error('Macro calendar failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/ai-analysis/:ticker — LLM read of the earnings + bull/bear data
// ============================================================================
// Gathers the Benzinga data server-side, then asks the model to weigh it.
// The model never sees an API key and never calls out on its own — it only
// ever analyses the payload assembled here.
app.get('/api/ai-analysis/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  if (!aiConfigured()) {
    return res.json({
      configured: false,
      ticker: rawTicker,
      note:
        'ANTHROPIC_API_KEY is not set on the server. Set it on its own line ' +
        '(Windows CMD appends a trailing space with `set VAR=x && ...`):\n' +
        '    set ANTHROPIC_API_KEY=sk-ant-xxxx\n' +
        '    npm start',
    });
  }

  try {
    // Pull both datasets, tolerating either being unavailable — the prompt
    // explicitly handles missing sections and reports them as unknowns.
    const [bbResult, earningsResult] = await Promise.allSettled([
      getBullsBearsOnly(rawTicker),
      getEarningsThisMonthOnly(rawTicker),
    ]);

    const bullsBears =
      bbResult.status === 'fulfilled' && bbResult.value.found ? bbResult.value : null;

    const earningsData =
      earningsResult.status === 'fulfilled' && earningsResult.value.found
        ? earningsResult.value.entries.find((e) => e.reported) || earningsResult.value.entries[0]
        : null;

    if (!bullsBears && !earningsData) {
      return res.json({
        configured: true,
        ticker: rawTicker,
        analyzed: false,
        note: `No Benzinga earnings or bull/bear data available for ${rawTicker}, so there is nothing to analyse.`,
      });
    }

    const analysis = await analyzeEarnings(rawTicker, {
      earnings: earningsData,
      bullsBears,
    });

    res.json({
      configured: true,
      ticker: rawTicker,
      analyzed: true,
      sourcesUsed: {
        earnings: Boolean(earningsData),
        bullBearCases: Boolean(bullsBears),
      },
      analysis,
    });
  } catch (err) {
    console.error(`AI analysis failed for ${rawTicker}:`, err);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/earnings-month/:ticker — earnings in the CURRENT month only
// ============================================================================
// Date-filtered server-side to the current calendar month. A ticker with no
// earnings this month returns { found: false } — a normal state, not an error.
app.get('/api/earnings-month/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  try {
    const data = await getEarningsThisMonthOnly(rawTicker);
    res.json(data);
  } catch (err) {
    console.error(`Monthly earnings lookup failed for ${rawTicker}:`, err);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/benzinga/:ticker — full multi-dataset report (earnings, WIIM, …)
// ============================================================================
// Unlike the Yahoo-backed routes above, this uses a real licensed API.
// Each dataset reports its own ok/error so an unlicensed product degrades
// gracefully instead of failing the whole request.
app.get('/api/benzinga/:ticker', async (req, res) => {
  const rawTicker = String(req.params.ticker || '').trim().toUpperCase();

  if (!isValidTickerFormat(rawTicker)) {
    return res.status(400).json({ error: 'Please enter a valid ticker symbol.' });
  }

  try {
    const report = await getTickerReport(rawTicker);
    res.json(report);
  } catch (err) {
    console.error(`Benzinga report failed for ${rawTicker}:`, err);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/coupons?store=NAME — merchant-published promo codes for a store
// ============================================================================
// See coupons.js for why this pulls from affiliate networks rather than
// trying to "verify" codes by driving retailer checkouts (short version:
// there's no legitimate general way to do the latter).
app.get('/api/coupons', async (req, res) => {
  const store = String(req.query.store || '').trim();

  if (!store) {
    return res.status(400).json({ error: 'Please provide a store name, e.g. /api/coupons?store=nike' });
  }
  if (store.length > 60) {
    return res.status(400).json({ error: 'Store name is too long.' });
  }

  try {
    const result = await getCoupons(store);
    res.json(result);
  } catch (err) {
    console.error(`Error fetching coupons for "${store}":`, err);
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// Shared Yahoo Finance chart-endpoint helper
// ============================================================================

/**
 * Fetches https://query1.finance.yahoo.com/v8/finance/chart/{ticker} for
 * the given range and returns { meta, timestamps, quote } on success, or
 * { error, status } on failure. Used by both /api/stock and /api/earnings
 * so there's one place that knows this endpoint's response shape.
 */
async function fetchYahooChartResult(ticker, range) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) +
    '?range=' + range + '&interval=1d';

  const response = await httpFetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return {
      error: `Yahoo Finance returned HTTP ${response.status} for "${ticker}". It may be an invalid ticker, or Yahoo is temporarily rate-limiting requests.`,
      status: 502,
    };
  }

  const data = await response.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];

  if (!result) {
    const errDesc = (data && data.chart && data.chart.error && data.chart.error.description) || 'No data returned.';
    return { error: `No data found for "${ticker}". ${errDesc}`, status: 404 };
  }

  return {
    meta: result.meta || {},
    timestamps: result.timestamp || [],
    quote: (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {},
  };
}

// ============================================================================
// Utilities
// ============================================================================

function isValidTickerFormat(ticker) {
  // Real Yahoo tickers are letters/numbers plus the occasional . - = ^
  // (e.g. BRK-B, VWCE.DE, ^GSPC).
  return !!ticker && /^[A-Z0-9.\-=^]{1,15}$/.test(ticker);
}

function round2(n) {
  return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

app.listen(PORT, () => {
  console.log(`Stock Watch running at http://localhost:${PORT}`);
});
