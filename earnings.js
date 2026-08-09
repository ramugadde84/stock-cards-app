/**
 * Earnings calendar scraper
 * --------------------------
 * Fetches "which tickers report earnings on date X" from Yahoo Finance's
 * earnings-calendar page (finance.yahoo.com/calendar/earnings). Yahoo does
 * not offer a clean JSON API for this, so — same technique used in the
 * companion Google Apps Script version of this project — the page's HTML
 * is scraped with a scoped regular expression rather than a full DOM
 * parser, since Yahoo's markup isn't valid XML and changes over time.
 *
 * See README.md for the full list of caveats (best-effort pagination,
 * unofficial/undocumented endpoint, etc).
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_MAX_PAGES = 6;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Returns an array of { ticker, date, time } for the given date
 * (YYYY-MM-DD). Pages through results (best-effort, see header comment)
 * until a page returns nothing new or maxPages is reached.
 */
async function getEarningsForDate(dateStr, opts = {}) {
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
  const pageSize = opts.pageSize || DEFAULT_PAGE_SIZE;

  const results = [];
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    let html;
    try {
      html = await fetchCalendarPageHtml(dateStr, offset, pageSize);
    } catch (e) {
      if (page === 0) {
        // The very first page failing is a real problem (network issue,
        // Yahoo blocking us, etc.) — surface it rather than silently
        // reporting "zero earnings", which would be misleading. Later
        // pages failing is treated as best-effort pagination simply
        // running out, so we just stop there instead.
        throw new Error(`Could not reach Yahoo Finance's earnings calendar for ${dateStr}: ${e.message}`);
      }
      console.error(`Calendar fetch failed for ${dateStr} offset ${offset}:`, e.message);
      break;
    }
    if (!html) {
      if (page === 0) {
        throw new Error(`Yahoo Finance's earnings calendar did not return usable content for ${dateStr}.`);
      }
      break;
    }

    const rows = parseEarningsRowsFromHtml(html, dateStr);
    let newCount = 0;
    for (const row of rows) {
      if (!seen.has(row.ticker)) {
        seen.add(row.ticker);
        results.push(row);
        newCount++;
      }
    }

    // Stop once a "page" brings nothing new — either we've reached the end
    // of the real results, or the offset/size params aren't actually
    // paginating (in which case every page would be identical).
    if (newCount === 0) break;
  }

  return results;
}

async function fetchCalendarPageHtml(dateStr, offset, pageSize) {
  const url =
    'https://finance.yahoo.com/calendar/earnings?day=' +
    encodeURIComponent(dateStr) +
    '&size=' + pageSize +
    '&offset=' + offset;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return await response.text();
}

/**
 * Scopes the search to (roughly) just the earnings table region of the
 * page, so we don't pick up unrelated ticker links from sidebar widgets
 * like "Trending tickers" / "Top gainers" / "Top losers".
 */
function scopeToEarningsTable(html) {
  const startMarker = 'Earnings On';
  const endMarker = 'Rows per page';
  const startIdx = html.indexOf(startMarker);
  const endIdx = startIdx !== -1 ? html.indexOf(endMarker, startIdx) : -1;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return html.substring(startIdx, endIdx);
  }
  // Markers not found (page layout changed) — fall back to the whole page.
  return html;
}

function parseEarningsRowsFromHtml(html, dateStr) {
  const scoped = scopeToEarningsTable(html);

  const tickerLinkPattern = /\/quote\/([A-Za-z0-9.\-]{1,15})\/?["'#?]/g;
  const matches = [];
  let m;
  while ((m = tickerLinkPattern.exec(scoped)) !== null) {
    matches.push({ ticker: m[1].toUpperCase(), index: m.index });
  }

  const rows = [];
  const seen = new Set();
  for (let i = 0; i < matches.length; i++) {
    const ticker = matches[i].ticker;
    if (!isPlausibleTicker(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);

    const chunkStart = matches[i].index;
    const chunkEnd = i + 1 < matches.length ? matches[i + 1].index : Math.min(scoped.length, chunkStart + 4000);
    const chunk = scoped.substring(chunkStart, chunkEnd);

    const timeMatch = chunk.match(/\b(BMO|AMC|TNS|TAS)\b/);

    rows.push({
      ticker,
      date: dateStr,
      time: timeMatch ? timeMatch[1] : 'N/A',
    });
  }

  return rows;
}

function isPlausibleTicker(ticker) {
  if (!ticker) return false;
  if (ticker.length > 12) return false;
  return /^[A-Z0-9.\-]+$/.test(ticker);
}

module.exports = { getEarningsForDate };
