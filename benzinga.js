/**
 * Benzinga API integration
 * -------------------------
 * Unlike the Yahoo endpoints used elsewhere in this app, this is a real,
 * documented, licensed API — so the data is authoritative and the response
 * shapes are stable. Docs: https://docs.benzinga.com
 *
 * SECURITY: the API key is read from the BENZINGA_API_KEY environment
 * variable and is never written to disk or sent to the browser. Don't paste
 * it into source files, commit it, or share it — it's a billable credential.
 *
 *   Windows CMD:         set BENZINGA_API_KEY=bz.xxxx && npm start
 *   Windows PowerShell:  $env:BENZINGA_API_KEY="bz.xxxx"; npm start
 *   macOS/Linux:         BENZINGA_API_KEY=bz.xxxx npm start
 *
 * WHY EACH DATASET IS FETCHED SEPARATELY
 * --------------------------------------
 * Benzinga licenses each dataset individually, so one key does not
 * necessarily unlock every endpoint. Each fetch below is isolated in its own
 * try/catch and reports its own status, which means:
 *   - a dataset you aren't licensed for degrades to { ok: false, error }
 *     instead of blowing up the whole report, and
 *   - the combined report doubles as a license checker: run it once and see
 *     exactly which products your key covers.
 */

const { httpFetch } = require('./httpClient');

const BASE = 'https://api.benzinga.com';


function getApiKey() {
  return process.env.BENZINGA_API_KEY || '';
}

function isConfigured() {
  return Boolean(getApiKey());
}

/**
 * Core request helper. Benzinga defaults some endpoints to XML, so we ask
 * for JSON explicitly via the accept header.
 */
async function bzGet(path, params) {
  const token = getApiKey();
  if (!token) throw new Error('BENZINGA_API_KEY is not set.');

  const qs = new URLSearchParams({ token, ...params });
  const url = `${BASE}${path}?${qs.toString()}`;

  const response = await httpFetch(url, { headers: { accept: 'application/json' } });

  const text = await response.text();

  // Benzinga returns structured errors, so surface their message rather
  // than a bare status code where possible.
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.errors?.[0]?.value || parsed?.text || '';
    } catch (e) {
      detail = text.slice(0, 200);
    }
    if (response.status === 401) {
      throw new Error(`Auth failed (401) — key rejected. ${detail}`);
    }
    if (response.status === 403) {
      throw new Error(`Forbidden (403) — your license likely doesn't include this dataset. ${detail}`);
    }
    if (response.status === 404) {
      throw new Error(`No data found (404) for this ticker. ${detail}`);
    }
    throw new Error(`HTTP ${response.status}. ${detail}`);
  }

  if (!text.trim()) return {}; // some endpoints return empty body for "no results"

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('Benzinga returned non-JSON:', text.slice(0, 400));
    throw new Error('Response was not valid JSON — see server log.');
  }
}

/**
 * Pulls the row array out of a Benzinga response.
 *
 * Their endpoints are NOT consistent about shape:
 *   - /api/v1/bulls_bears_say  -> { "bulls_say_bears_say": [ ... ] }
 *   - /api/v2.1/calendar/earnings -> a BARE ARRAY: [ ... ]
 *
 * Assuming the object form made the earnings lookup silently return nothing
 * (`json?.earnings` is undefined on an array), which looked identical to
 * "no data" and sent us hunting a licence problem that didn't exist.
 * Accept every shape rather than trusting any single one.
 */
function extractRows(json, ...keys) {
  if (Array.isArray(json)) return json;              // bare array
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(json[k])) return json[k];      // named key
  }
  // Last resort: a single array-valued property under any name.
  const arrays = Object.values(json).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : [];
}

// ---------------------------------------------------------------------------
// Individual datasets
// ---------------------------------------------------------------------------

/**
 * Bull / bear investment cases — Benzinga's own analysts arguing both sides.
 * GET /api/v1/bulls_bears_say
 * Response key is documented inconsistently (bulls_say_bears_say vs
 * bulls-say-bears-say), so both are accepted.
 */
async function getBullsBears(ticker) {
  const json = await bzGet('/api/v1/bulls_bears_say', { symbols: ticker, pagesize: '1' });
  const list = extractRows(json, 'bulls_say_bears_say', 'bulls-say-bears-say');
  const latest = Array.isArray(list) ? list[0] : null;
  if (!latest) return null;

  const security = Array.isArray(latest.securities) ? latest.securities[0] : null;

  return {
    ticker: latest.ticker || ticker,
    companyName: security?.name || null,
    exchange: security?.exchange || null,
    bullCase: latest.bull_case || null,
    bearCase: latest.bear_case || null,
    analystFirmsReferenced: latest.analyst_firms_referenced ?? null,
    updated: latest.updated ? new Date(latest.updated * 1000).toISOString().slice(0, 10) : null,
  };
}

/**
 * Focused lookup used by the card button — hits only the bulls_bears_say
 * endpoint. Kept separate from getTickerReport() so a single unlicensed
 * dataset elsewhere can't slow down or complicate the common case.
 */
async function getBullsBearsOnly(ticker) {
  if (!isConfigured()) {
    return {
      configured: false,
      ticker,
      note:
        'BENZINGA_API_KEY is not set on the server. Start it with the key in the ' +
        'environment — on Windows CMD use two separate lines, since ' +
        '`set VAR=value && npm start` appends a trailing space to the value:\n' +
        '    set BENZINGA_API_KEY=bz.xxxx\n' +
        '    npm start',
    };
  }
  const data = await getBullsBears(ticker);
  if (!data) {
    return { configured: true, ticker, found: false };
  }
  return { configured: true, ticker, found: true, ...data };
}

/**
 * Earnings falling within the CURRENT calendar month only.
 *
 * The date window is applied server-side via date_from/date_to rather than
 * fetching everything and filtering locally — smaller responses, and no risk
 * of a neighbouring month's report sneaking in.
 *
 * Returns { found: false } when the ticker simply has no earnings this
 * month, which is the normal case for most tickers on most days — that's
 * not an error and the UI treats it as "nothing to show".
 */
async function getEarningsThisMonth(ticker) {
  // "Today" in the display timezone, not UTC — otherwise late evening in the
  // US rolls the month over early. Same bug that made the Key Dates tab show
  // tomorrow's CPI as "TODAY".
  const tz = process.env.APP_TIMEZONE || 'America/Chicago';
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const [y, m] = todayLocal.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const monthPrefix = `${y}-${pad(m)}`;
  const firstDay = `${monthPrefix}-01`;
  const lastDay = `${monthPrefix}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  // WHY THIS TRIES SEVERAL QUERIES INSTEAD OF ONE
  //
  // Observed behaviour of /api/v2.1/calendar/earnings on a live key:
  //   - No params            -> {"earnings":[...]} with data, BUT the default
  //                             window is roughly a YEAR AHEAD (2027 dates).
  //   - parameters[tickers]  -> a bare "[]" — empty. Either the param form is
  //                             wrong, or it filters within that future window
  //                             where the ticker has no row.
  //
  // So: try the documented form, then an unwrapped variant, then fall back to
  // an explicit date window (which forces it off the future default) and
  // filter by ticker locally. First strategy that yields rows wins.
  // NOTE: pagesize caps at 100 — asking for 1000 still returns 100.
  const attempts = [
    { label: 'parameters[tickers]', params: { 'parameters[tickers]': ticker, pagesize: '100' } },
    { label: 'tickers (unwrapped)', params: { tickers: ticker, pagesize: '100' } },
    {
      label: 'unwrapped date range + ticker',
      params: { tickers: ticker, date_from: firstDay, date_to: lastDay, pagesize: '100' },
    },
    {
      label: 'parameters[date] single day + ticker',
      params: { 'parameters[tickers]': ticker, 'parameters[date]': lastDay, pagesize: '100' },
    },
    {
      // Sort ascending from the start of the month — the default ordering
      // appears to begin months in the future, which is why an August query
      // came back full of October-to-July dates.
      label: 'date window sorted asc + local filter',
      params: {
        'parameters[date_from]': firstDay,
        'parameters[date_to]': lastDay,
        parameters_date_sort: 'date',
        sort: 'date:asc',
        pagesize: '100',
      },
      filterByTicker: true,
      filterByMonth: true,
    },
  ];

  let rows = [];
  let strategyUsed = 'none';
  const attemptLog = [];

  for (const attempt of attempts) {
    let candidate = [];
    try {
      const json = await bzGet('/api/v2.1/calendar/earnings', attempt.params);
      candidate = extractRows(json, 'earnings');
      if (attempt.filterByTicker) {
        candidate = candidate.filter(
          (r) => String(r.ticker || '').toUpperCase() === ticker.toUpperCase()
        );
      }
      // Only accept rows actually inside the target month. Without this a
      // strategy "succeeds" with far-future rows the API returned despite
      // the date filter, which is worse than returning nothing.
      candidate = candidate.filter((r) => String(r.date || '').startsWith(monthPrefix));
    } catch (e) {
      attemptLog.push(`${attempt.label}: error ${e.message}`);
      continue;
    }
    attemptLog.push(`${attempt.label}: ${candidate.length} in-month row(s)`);
    if (candidate.length) {
      rows = candidate;
      strategyUsed = attempt.label;
      break;
    }
  }

  // Diagnostics: distinguishes "API returned nothing at all" from "API
  // returned rows, but none in this month" — very different problems.
  const diagnostics = {
    rowsReturned: rows.length,
    datesReturned: rows.map((r) => r.date).filter(Boolean).sort(),
    monthFilter: `${firstDay} .. ${lastDay}`,
    strategyUsed,
    attempts: attemptLog,
  };
  console.log(
    `[benzinga] ${ticker}: ${rows.length} row(s) via "${strategyUsed}" ` +
    `[${attemptLog.join(' | ')}]; dates=[${diagnostics.datesReturned.join(', ')}]`
  );

  const inMonth = rows.filter((r) => String(r.date || '').startsWith(monthPrefix));

  if (!inMonth.length) {
    return {
      found: false,
      monthLabel,
      range: { from: firstDay, to: lastDay },
      diagnostics,
    };
  }

  const entries = inMonth.map((r) => ({
    date: r.date || null,
    time: r.time || null,
    period: [r.period, r.period_year].filter(Boolean).join(' ') || null,
    epsActual: numOrNull(r.eps),
    epsEstimate: numOrNull(r.eps_est),
    epsSurprisePercent: numOrNull(r.eps_surprise_percent),
    revenueActual: numOrNull(r.revenue),
    revenueEstimate: numOrNull(r.revenue_est),
    revenueSurprisePercent: numOrNull(r.revenue_surprise_percent),
    currency: r.currency || null,
    // Benzinga leaves actuals empty until the company actually reports.
    reported: numOrNull(r.eps) !== null,
  }));

  // Newest first.
  entries.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    found: true,
    monthLabel,
    range: { from: firstDay, to: lastDay },
    diagnostics,
    entries,
  };
}

/**
 * Every company reporting on a given date, split by trading session and
 * ranked by revenue (largest first).
 *
 * SESSION CLASSIFICATION
 * ----------------------
 * Benzinga returns `time` as an ET clock value (e.g. "16:05:00") rather than
 * a BMO/AMC label, so sessions are derived from the US market day:
 *   pre    — before 09:30 ET (before the open)
 *   post   — 16:00 ET or later (after the close)
 *   during — in between, i.e. released while the market is open
 * Rows with no time at all are grouped as "unspecified" rather than being
 * guessed into a session.
 *
 * RANKING
 * -------
 * Sorted by revenue descending, preferring reported revenue and falling back
 * to the estimate when a company hasn't reported yet — so upcoming and
 * already-reported names rank on a comparable basis. Rows with neither sort
 * to the bottom instead of being dropped.
 */
async function getEarningsCalendar(dateStr, session = 'all') {
  const json = await bzGet('/api/v2.1/calendar/earnings', {
    'parameters[date_from]': dateStr,
    'parameters[date_to]': dateStr,
    pagesize: '1000', // Benzinga's per-page maximum
  });

  const rows = extractRows(json, 'earnings');

  const entries = rows.map((r) => {
    const revenueActual = numOrNull(r.revenue);
    const revenueEstimate = numOrNull(r.revenue_est);
    return {
      ticker: r.ticker || null,
      name: r.name || null,
      date: r.date || null,
      time: r.time || null,
      session: classifySession(r.time),
      period: [r.period, r.period_year].filter(Boolean).join(' ') || null,
      epsActual: numOrNull(r.eps),
      epsEstimate: numOrNull(r.eps_est),
      epsSurprisePercent: numOrNull(r.eps_surprise_percent),
      revenueActual,
      revenueEstimate,
      // The figure used for ranking — actual where known, else the estimate.
      revenueForSort: revenueActual ?? revenueEstimate ?? null,
      currency: r.currency || null,
      reported: numOrNull(r.eps) !== null,
    };
  });

  const filtered = session === 'all' ? entries : entries.filter((e) => e.session === session);

  filtered.sort((a, b) => {
    // Null revenue sinks to the bottom rather than disappearing.
    if (a.revenueForSort === null && b.revenueForSort === null) {
      return String(a.ticker || '').localeCompare(String(b.ticker || ''));
    }
    if (a.revenueForSort === null) return 1;
    if (b.revenueForSort === null) return -1;
    return b.revenueForSort - a.revenueForSort;
  });

  return {
    date: dateStr,
    session,
    totalForDate: entries.length,
    count: filtered.length,
    // Benzinga caps a page at 1000; flag it rather than silently truncating.
    truncated: rows.length >= 1000,
    entries: filtered,
  };
}

/** Maps an ET clock time to a trading session. */
function classifySession(time) {
  if (!time || typeof time !== 'string') return 'unspecified';
  const t = time.slice(0, 8); // "HH:MM:SS"
  if (!/^\d{2}:\d{2}/.test(t)) return 'unspecified';
  if (t < '09:30:00') return 'pre';
  if (t >= '16:00:00') return 'post';
  return 'during';
}

/**
 * DEBUG: returns the untouched response for a Benzinga path, so we can see
 * what the API actually sends rather than inferring it from an empty result.
 *
 * Deliberately returns the raw body and the top-level keys — an empty
 * `earnings` array and a payload nested under a DIFFERENT key look identical
 * from the outside, but one is a licence problem and the other is a parser
 * bug. This tells them apart. Uses the server-side key, so nothing sensitive
 * goes in the URL.
 */
async function debugRaw(pathName, params) {
  const token = getApiKey();
  if (!token) throw new Error('BENZINGA_API_KEY is not set.');

  const qs = new URLSearchParams({ token, ...params });
  const url = `${BASE}${pathName}?${qs.toString()}`;

  const response = await httpFetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();

  let parsed = null;
  let topLevelKeys = null;
  try {
    parsed = JSON.parse(text);
    topLevelKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : null;
  } catch (e) {
    /* leave as raw text */
  }

  return {
    requestUrl: url.replace(/token=[^&]+/, 'token=***REDACTED***'),
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    topLevelKeys,
    // The shape question: which key holds the array, and how many entries?
    arrayCounts: parsed && typeof parsed === 'object'
      ? Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])
        )
      : null,
    rawBody: text.slice(0, 4000),
  };
}

/** Wrapper mirroring the other *Only helpers. */
async function getEarningsCalendarOnly(dateStr, session) {
  if (!isConfigured()) {
    return {
      configured: false,
      note:
        'BENZINGA_API_KEY is not set on the server. Set it on its own line ' +
        '(Windows CMD appends a trailing space with `set VAR=x && ...`):\n' +
        '    set BENZINGA_API_KEY=bz.xxxx\n' +
        '    npm start',
    };
  }
  const data = await getEarningsCalendar(dateStr, session);
  return { configured: true, ...data };
}

/** Wrapper used by the card button, mirroring getBullsBearsOnly(). */
async function getEarningsThisMonthOnly(ticker) {
  if (!isConfigured()) {
    return {
      configured: false,
      ticker,
      note:
        'BENZINGA_API_KEY is not set on the server. On Windows CMD set it on its own ' +
        'line — `set VAR=value && npm start` appends a trailing space to the value:\n' +
        '    set BENZINGA_API_KEY=bz.xxxx\n' +
        '    npm start',
    };
  }
  const data = await getEarningsThisMonth(ticker);
  if (data.found) return { configured: true, ticker, source: 'benzinga-calendar', ...data };

  // FAST PATH: Benzinga's news wire carries the results release minutes
  // after it crosses — well before the calendar endpoint is backfilled, and
  // typically ahead of Yahoo. Try it before falling back.
  const monthPrefix = data.range?.from?.slice(0, 7);
  try {
    const news = await getEarningsNews(ticker, { full: true, limit: 15 });
    const inMonth = news.filter((n) => {
      const d = n.created ? new Date(n.created).toISOString().slice(0, 10) : null;
      return d && (!monthPrefix || d.startsWith(monthPrefix));
    });

    if (inMonth.length) {
      console.log(`[benzinga] ${ticker}: ${inMonth.length} earnings release(s) from the news wire.`);
      return {
        configured: true,
        ticker,
        source: 'benzinga-news',
        found: true,
        monthLabel: data.monthLabel,
        range: data.range,
        diagnostics: {
          ...data.diagnostics,
          fallback: 'Benzinga news wire (calendar endpoint is forward-looking only)',
        },
        // Rendered as release headlines rather than a numbers table — the
        // wire gives the story and timestamp; parsing EPS out of free-form
        // prose reliably isn't something to fake here. The AI analysis
        // button can read the body if you want the figures extracted.
        newsReleases: inMonth.map((n) => ({
          title: n.title,
          created: n.created,
          url: n.url,
          teaser: n.teaser,
        })),
        entries: [],
      };
    }
  } catch (e) {
    console.error(`[benzinga] news-wire lookup failed for ${ticker}:`, e.message);
    data.diagnostics = { ...data.diagnostics, newsWire: `failed: ${e.message}` };
  }

  // Benzinga's calendar is forward-looking (all observed rows had an empty
  // `eps` actual), so a company that has just REPORTED won't be in it. Fall
  // back to Yahoo, which does carry actual reported EPS — the same source
  // the working "Check Result" button already uses.
  try {
    const monthPrefix = data.range?.from?.slice(0, 7);
    const yahooEntries = await getReportedEarningsFromYahoo(ticker, monthPrefix);
    if (yahooEntries.length) {
      console.log(`[benzinga] ${ticker}: falling back to Yahoo — ${yahooEntries.length} reported row(s).`);
      return {
        configured: true,
        ticker,
        source: 'yahoo-fallback',
        found: true,
        monthLabel: data.monthLabel,
        range: data.range,
        diagnostics: { ...data.diagnostics, fallback: 'Yahoo earningsHistory (Benzinga had no in-month rows)' },
        entries: yahooEntries,
      };
    }
    data.diagnostics = { ...data.diagnostics, fallback: 'Yahoo also had no rows for this month' };
  } catch (e) {
    console.error(`[benzinga] Yahoo fallback failed for ${ticker}:`, e.message);
    data.diagnostics = { ...data.diagnostics, fallback: `Yahoo fallback failed: ${e.message}` };
  }

  return { configured: true, ticker, source: 'benzinga', ...data };
}

/**
 * Earnings results from Benzinga's NEWS WIRE — the fast path.
 *
 * WHY THIS AND NOT THE CALENDAR ENDPOINT:
 * /calendar/earnings is a scheduling dataset. Every row observed had an
 * empty `eps` actual with only `eps_est`, and its dates ran months ahead —
 * it gets backfilled with actuals well after the fact.
 *
 * The speed advantage Benzinga actually sells lives in the newsfeed: the
 * earnings press release hits the wire the instant the company publishes,
 * typically minutes ahead of aggregators like Yahoo. That's the same feed
 * that carried "RADNET REPORTS SECOND QUARTER FINANCIAL RESULTS..." at
 * 4:00 PM tagged BZ Wire.
 *
 * So for "did they just report, and what were the numbers", the newsfeed is
 * both faster AND the only Benzinga source that has the actuals early.
 */
async function getEarningsNews(ticker, opts = {}) {
  const json = await bzGet('/api/v2/news', {
    tickers: ticker,
    // Body text is needed to pull EPS/revenue out of the release.
    displayOutput: opts.full ? 'full' : 'abstract',
    pageSize: String(opts.limit || 15),
  });

  const items = extractRows(json, 'news');

  // Keep only genuine earnings-results stories. Previews ("what to expect
  // ahead of earnings") and analyst notes are excluded — they're about an
  // upcoming report, not a released one.
  const RESULTS = /reports?\s+(first|second|third|fourth|q[1-4]|fy)|financial results|earnings results|\bQ[1-4]\b.*(results|earnings)|posts?\s+Q[1-4]|announces?.*(results|earnings)/i;
  const PREVIEW = /ahead of earnings|what to expect|preview|expectations|analysts? expect|options market|to report|will report|announces date/i;

  return items
    .map((n) => ({
      id: n.id ?? null,
      title: n.title || '',
      created: n.created || null,
      updated: n.updated || null,
      url: n.url || null,
      teaser: n.teaser || null,
      body: n.body || null,
      channels: Array.isArray(n.channels) ? n.channels.map((c) => c.name || c) : [],
    }))
    .filter((n) => RESULTS.test(n.title) && !PREVIEW.test(n.title));
}

/**
 * Largest options trades for a ticker — top calls and top puts.
 *
 * IMPORTANT REALITY CHECK ON "LIVE ANY TIME":
 * US equity options trade 09:30-16:00 ET only. Unlike stocks, there is no
 * pre-market or after-hours options session for retail. So outside those
 * hours this necessarily returns the MOST RECENT SESSION's activity, not
 * live quotes — the data simply doesn't exist while the market is shut.
 * Every response is stamped with its trade date/time so the age is obvious
 * rather than implied to be current.
 *
 * "Highest" is ranked by PREMIUM (cost basis = total dollars spent), which
 * is the meaningful measure of conviction — 10,000 contracts of a cheap
 * far-dated option is a smaller bet than 100 contracts of a costly one.
 * Volume and open interest are shown too so you can judge for yourself.
 */
async function getOptionsActivity(ticker, opts = {}) {
  if (!isConfigured()) {
    return {
      configured: false,
      ticker,
      note:
        'BENZINGA_API_KEY is not set on the server. Set it on its own line:\n' +
        '    set BENZINGA_API_KEY=bz.xxxx\n' +
        '    npm start',
    };
  }

  const limit = Math.min(Number(opts.limit) || 10, 50);

  // Look back far enough to always catch the last trading session, including
  // over a weekend or holiday break.
  const lookbackDays = Number(opts.lookbackDays) || 7;
  const today = new Date();
  const from = new Date(today.getTime() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  // Same defensive pattern as earnings: Benzinga's date/ticker params have
  // proven unreliable across endpoints, so try several and filter locally.
  const attempts = [
    { label: 'tickers + date range', params: {
      'parameters[tickers]': ticker, 'parameters[date_from]': from,
      'parameters[date_to]': to, pagesize: '100' } },
    { label: 'tickers only', params: { 'parameters[tickers]': ticker, pagesize: '100' } },
    { label: 'unwrapped tickers', params: { tickers: ticker, pagesize: '100' } },
  ];

  let rows = [];
  let strategyUsed = 'none';
  const attemptLog = [];

  for (const a of attempts) {
    try {
      const json = await bzGet('/api/v1/signal/option_activity', a.params);
      let candidate = extractRows(json, 'option_activity', 'signals', 'data');
      // Always confirm the ticker locally — a filter that silently doesn't
      // apply would otherwise show another company's flow.
      candidate = candidate.filter(
        (r) => String(r.ticker || r.symbol || '').toUpperCase() === ticker.toUpperCase()
      );
      attemptLog.push(`${a.label}: ${candidate.length} row(s)`);
      if (candidate.length) { rows = candidate; strategyUsed = a.label; break; }
    } catch (e) {
      attemptLog.push(`${a.label}: error ${e.message}`);
    }
  }

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const trades = rows.map((r) => ({
    ticker: r.ticker || r.symbol || ticker,
    type: String(r.put_call || r.putCall || '').toUpperCase(),   // CALL | PUT
    strike: num(r.strike_price ?? r.strike),
    expiry: r.date_expiration || r.expiration || null,
    // Total dollars in the trade — the conviction measure.
    premium: num(r.cost_basis ?? r.premium ?? r.total_value),
    volume: num(r.volume),
    openInterest: num(r.open_interest ?? r.openInterest),
    price: num(r.price ?? r.midpoint),
    underlyingPrice: num(r.underlying_price ?? r.underlyingPrice),
    // SWEEP = urgency (filled across multiple exchanges), TRADE = block.
    activityType: r.option_activity_type || r.type || null,
    sentiment: r.sentiment || null,
    date: r.date || null,
    time: r.time || null,
    description: r.description || r.description_extended || null,
  }));

  const byPremium = (a, b) => (b.premium ?? 0) - (a.premium ?? 0);
  const calls = trades.filter((t) => t.type === 'CALL').sort(byPremium).slice(0, limit);
  const puts = trades.filter((t) => t.type === 'PUT').sort(byPremium).slice(0, limit);

  // Most recent timestamp present — makes staleness explicit.
  const stamps = trades.map((t) => `${t.date || ''} ${t.time || ''}`.trim()).filter(Boolean).sort();
  const latest = stamps.length ? stamps[stamps.length - 1] : null;

  const callPremium = calls.reduce((s, t) => s + (t.premium || 0), 0);
  const putPremium = puts.reduce((s, t) => s + (t.premium || 0), 0);

  return {
    configured: true,
    ticker,
    marketOpen: isOptionsMarketOpen(),
    latestTradeStamp: latest,
    totalTrades: trades.length,
    calls,
    puts,
    // A rough skew read — more call premium than put premium, or vice versa.
    // Deliberately descriptive, not predictive.
    premiumSkew: {
      callPremium,
      putPremium,
      leaning: callPremium > putPremium * 1.2 ? 'calls'
             : putPremium > callPremium * 1.2 ? 'puts' : 'balanced',
    },
    diagnostics: { strategyUsed, attempts: attemptLog, window: `${from} .. ${to}` },
  };
}

/** True during US equity options hours (09:30-16:00 ET, weekdays). */
function isOptionsMarketOpen() {
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => et.find((p) => p.type === t)?.value;
  const day = get('weekday');
  if (['Sat', 'Sun'].includes(day)) return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= 570 && mins < 960; // 09:30 .. 16:00
}

/**
 * All recent wire news for one ticker — not just earnings.
 *
 * This is the endpoint that carries Benzinga's actual speed advantage: the
 * release hits here the moment it crosses the wire. Useful for anything
 * market-moving (M&A, guidance updates, FDA, downgrades), not only earnings.
 */
async function getTickerNews(ticker, opts = {}) {
  if (!isConfigured()) {
    return {
      configured: false,
      ticker,
      note:
        'BENZINGA_API_KEY is not set on the server. Set it on its own line:\n' +
        '    set BENZINGA_API_KEY=bz.xxxx\n' +
        '    npm start',
    };
  }

  const params = {
    tickers: ticker,
    displayOutput: 'abstract',
    pageSize: String(Math.min(Number(opts.limit) || 20, 100)),
  };
  if (opts.channels) params.channels = opts.channels;

  const json = await bzGet('/api/v2/news', params);
  const items = extractRows(json, 'news');

  const stories = items.map((n) => ({
    id: n.id ?? null,
    title: n.title || '',
    teaser: stripTags(n.teaser),
    created: n.created || null,
    updated: n.updated || null,
    url: n.url || null,
    author: n.author || null,
    channels: Array.isArray(n.channels) ? n.channels.map((c) => c.name || c).filter(Boolean) : [],
    // Wire stories are the fast ones — surfaced so the UI can badge them.
    isWire: /wire|press release|globe ?newswire|business ?wire|pr ?newswire/i.test(
      [n.author, ...(Array.isArray(n.channels) ? n.channels.map((c) => c.name || c) : [])].join(' ')
    ),
  }));

  // Newest first — the API's default ordering isn't guaranteed.
  stories.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));

  return { configured: true, ticker, count: stories.length, stories };
}

/** Removes HTML tags from teaser copy. */
function stripTags(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * Reported earnings from Yahoo, used when Benzinga has nothing.
 *
 * WHY THIS EXISTS: Benzinga's /calendar/earnings appears to be a FORWARD
 * calendar — every row observed had an empty `eps` (actual) with only
 * `eps_est` populated, and dates ran months into the future regardless of
 * the date filters. So a company that reported yesterday isn't in it.
 *
 * Yahoo's quoteSummary earningsHistory does carry actual reported EPS, and
 * the app already uses it successfully for the "Check Result" button.
 */
async function getReportedEarningsFromYahoo(ticker, monthPrefix) {
  const url =
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(ticker) + '?modules=earningsHistory';

  const res = await httpFetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status}`);

  const json = await res.json();
  const history = json?.quoteSummary?.result?.[0]?.earningsHistory?.history || [];

  const num = (v) => {
    const n = v && typeof v === 'object' ? v.raw : v;
    return typeof n === 'number' && isFinite(n) ? n : null;
  };

  return history
    .map((h) => {
      const epoch = h?.quarter && typeof h.quarter === 'object' ? h.quarter.raw : h?.quarter;
      const date = epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
      const surprise = num(h?.surprisePercent);
      return {
        date,
        time: null,
        period: h?.period || null,
        epsActual: num(h?.epsActual),
        epsEstimate: num(h?.epsEstimate),
        // Yahoo gives this as a fraction (0.0549), not a percentage.
        epsSurprisePercent: surprise !== null ? Math.round(surprise * 10000) / 100 : null,
        revenueActual: null, // not provided by this Yahoo module
        revenueEstimate: null,
        revenueSurprisePercent: null,
        currency: null,
        reported: num(h?.epsActual) !== null,
      };
    })
    .filter((e) => e.date && (!monthPrefix || e.date.startsWith(monthPrefix)));
}

/**
 * Most recent earnings result: EPS/revenue actual vs estimate + surprise.
 * GET /api/v2.1/calendar/earnings
 */
async function getEarnings(ticker) {
  const json = await bzGet('/api/v2.1/calendar/earnings', {
    'parameters[tickers]': ticker,
    pagesize: '4',
  });
  const rows = extractRows(json, 'earnings');
  if (!rows.length) return null;

  // Newest first — the API sorts ascending by date in some responses.
  const sorted = [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  // Prefer the most recent row that actually has a reported EPS.
  const reported = sorted.find((r) => numOrNull(r.eps) !== null) || sorted[0];

  return {
    date: reported.date || null,
    period: [reported.period, reported.period_year].filter(Boolean).join(' ') || null,
    time: reported.time || null,
    epsActual: numOrNull(reported.eps),
    epsEstimate: numOrNull(reported.eps_est),
    epsSurprisePercent: numOrNull(reported.eps_surprise_percent),
    revenueActual: numOrNull(reported.revenue),
    revenueEstimate: numOrNull(reported.revenue_est),
    revenueSurprisePercent: numOrNull(reported.revenue_surprise_percent),
  };
}

/**
 * "Why Is It Moving" — one-line explanations of today's price action.
 * These live in the news feed under the WIIM channel.
 */
async function getWiims(ticker) {
  const json = await bzGet('/api/v2/news', {
    tickers: ticker,
    channels: 'WIIM',
    pageSize: '3',
    displayOutput: 'abstract',
  });
  const items = extractRows(json, 'news');
  return items.slice(0, 3).map((n) => ({
    title: n.title || null,
    created: n.created || null,
    url: n.url || null,
  }));
}

/** Recent analyst ratings actions (upgrades/downgrades/PT changes). */
async function getRatings(ticker) {
  const json = await bzGet('/api/v2/calendar/ratings', {
    'parameters[tickers]': ticker,
    pagesize: '5',
  });
  const rows = extractRows(json, 'ratings');
  return rows.slice(0, 5).map((r) => ({
    date: r.date || null,
    firm: r.analyst || r.analyst_name || null,
    action: r.action_pt || r.action_company || null,
    ratingCurrent: r.rating_current || null,
    ratingPrior: r.rating_prior || null,
    ptCurrent: numOrNull(r.pt_current),
    ptPrior: numOrNull(r.pt_prior),
  }));
}

/** Latest headlines for context. */
async function getNews(ticker) {
  const json = await bzGet('/api/v2/news', {
    tickers: ticker,
    pageSize: '5',
    displayOutput: 'abstract',
  });
  const items = extractRows(json, 'news');
  return items.slice(0, 5).map((n) => ({
    title: n.title || null,
    created: n.created || null,
    url: n.url || null,
  }));
}

// ---------------------------------------------------------------------------
// Combined report
// ---------------------------------------------------------------------------

/**
 * Pulls every dataset in parallel and returns one report. Each section
 * carries its own { ok, data | error } so a dataset you're not licensed for
 * doesn't break the rest — and so you can see at a glance what your key
 * actually covers.
 */
async function getTickerReport(ticker) {
  if (!isConfigured()) {
    return {
      configured: false,
      ticker,
      note:
        'BENZINGA_API_KEY is not set on the server, so Benzinga data is off. ' +
        'Start the server with the key in the environment (see benzinga.js header).',
    };
  }

  const sections = {
    bullsBears: getBullsBears,
    earnings: getEarnings,
    wiims: getWiims,
    ratings: getRatings,
    news: getNews,
  };

  const entries = await Promise.all(
    Object.entries(sections).map(async ([name, fn]) => {
      try {
        const data = await fn(ticker);
        return [name, { ok: true, data }];
      } catch (err) {
        console.error(`Benzinga ${name} failed for ${ticker}:`, err.message);
        return [name, { ok: false, error: err.message }];
      }
    })
  );

  const report = { configured: true, ticker, ...Object.fromEntries(entries) };
  report.verdict = deriveVerdict(report);
  return report;
}

/**
 * A transparent, rules-based read of the earnings result — deliberately NOT
 * a prediction. It only states what the numbers say: did EPS and revenue
 * beat or miss consensus. Benzinga's own bull_case/bear_case text is
 * returned alongside it so you can read the actual arguments rather than
 * relying on a label.
 */
function deriveVerdict(report) {
  const e = report.earnings?.ok ? report.earnings.data : null;
  if (!e) return { label: 'No earnings data', emoji: '⚪', basis: [] };

  const basis = [];
  let score = 0;

  if (e.epsActual !== null && e.epsEstimate !== null) {
    if (e.epsActual > e.epsEstimate) {
      score++;
      basis.push(`EPS beat: ${e.epsActual} vs ${e.epsEstimate} est`);
    } else if (e.epsActual < e.epsEstimate) {
      score--;
      basis.push(`EPS miss: ${e.epsActual} vs ${e.epsEstimate} est`);
    } else {
      basis.push(`EPS in line at ${e.epsActual}`);
    }
  }

  if (e.revenueActual !== null && e.revenueEstimate !== null) {
    if (e.revenueActual > e.revenueEstimate) {
      score++;
      basis.push('Revenue beat consensus');
    } else if (e.revenueActual < e.revenueEstimate) {
      score--;
      basis.push('Revenue missed consensus');
    } else {
      basis.push('Revenue in line');
    }
  }

  if (basis.length === 0) return { label: 'Not yet reported', emoji: '⏳', basis };
  if (score >= 2) return { label: 'Bullish', emoji: '🟢', basis };
  if (score === 1) return { label: 'Lean bullish', emoji: '🟢', basis };
  if (score === 0) return { label: 'Mixed', emoji: '⚠️', basis };
  if (score === -1) return { label: 'Lean bearish', emoji: '🔴', basis };
  return { label: 'Bearish', emoji: '🔴', basis };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  getTickerReport,
  getBullsBearsOnly,
  getEarningsThisMonthOnly,
  getEarningsCalendarOnly,
  getTickerNews,
  getOptionsActivity,
  debugRaw,
  isConfigured,
};
