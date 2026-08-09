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

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Safety cap so a single "load earnings" click can't trigger hundreds of
// price lookups on very high-volume earnings days (some single days have
// 400-600+ companies reporting) — keeps response times reasonable and
// avoids hammering Yahoo. See README.md.
const MAX_EARNINGS_TICKERS = 150;
const EARNINGS_QUOTE_BATCH_SIZE = 20;

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
// GET /api/earnings?date=YYYY-MM-DD — all tickers reporting that day, priced
// ============================================================================
app.get('/api/earnings', async (req, res) => {
  const dateStr = String(req.query.date || todayYMD()).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: '"date" must be in YYYY-MM-DD format.' });
  }

  try {
    let entries = await getEarningsForDate(dateStr);
    const totalFound = entries.length;
    let capped = false;

    if (entries.length > MAX_EARNINGS_TICKERS) {
      entries = entries.slice(0, MAX_EARNINGS_TICKERS);
      capped = true;
    }

    const priced = await priceEarningsEntries(entries);

    res.json({
      date: dateStr,
      totalFound,
      returnedCount: priced.length,
      capped, // true if totalFound > MAX_EARNINGS_TICKERS — see README
      results: priced,
    });
  } catch (err) {
    console.error(`Error fetching earnings for ${dateStr}:`, err);
    res.status(500).json({ error: `Server error fetching earnings for ${dateStr}: ${err.message}` });
  }
});

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

  const response = await fetch(url, {
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
