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
  const list = json['bulls_say_bears_say'] || json['bulls-say-bears-say'] || [];
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
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const pad = (n) => String(n).padStart(2, '0');
  const firstDay = `${y}-${pad(m + 1)}-01`;
  // Day 0 of the next month is the last day of this one (handles 28/29/30/31).
  const lastDay = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const json = await bzGet('/api/v2.1/calendar/earnings', {
    'parameters[tickers]': ticker,
    'parameters[date_from]': firstDay,
    'parameters[date_to]': lastDay,
    pagesize: '10',
  });

  const rows = json?.earnings || [];
  if (!rows.length) {
    return { found: false, monthLabel, range: { from: firstDay, to: lastDay } };
  }

  const entries = rows.map((r) => ({
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

  const rows = json?.earnings || [];

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
  return { configured: true, ticker, ...data };
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
  const rows = json?.earnings || [];
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
  const items = Array.isArray(json) ? json : json?.news || [];
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
  const rows = json?.ratings || [];
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
  const items = Array.isArray(json) ? json : json?.news || [];
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
  isConfigured,
};
