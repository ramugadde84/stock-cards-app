/**
 * Macro event calendar — CPI, jobs report, FOMC
 * ----------------------------------------------
 * Shows the market-moving scheduled events for the current month, and rolls
 * forward automatically: once a date passes it drops out of "upcoming", and
 * when the month runs out the next month's events are pulled in. So the
 * panel is always showing what's actually still ahead of you.
 *
 * TWO SOURCES, IN ORDER OF PREFERENCE
 * -----------------------------------
 * 1. LIVE — Benzinga's economic calendar (/api/v2.1/calendar/economics).
 *    Real published dates including consensus and prior values. Requires
 *    BENZINGA_API_KEY and that dataset being in your licence.
 *
 * 2. FALLBACK — the built-in schedule below. Used when Benzinga isn't
 *    configured or doesn't cover economics. Every entry is tagged with a
 *    `certainty` field so the UI can distinguish:
 *      'confirmed' — taken from the official published schedule
 *      'estimated' — derived from the usual release rule, not verified
 *
 * That distinction matters. The Fed publishes FOMC dates a year ahead and
 * the BLS publishes its release calendar a year ahead too, so those are
 * knowable. But a rule like "jobs report = first Friday" is only usually
 * right — it shifts around holidays. Labelling a guess as fact would be
 * worse than showing nothing, so guesses are marked as such and you're
 * pointed at the primary source to confirm.
 *
 * PRIMARY SOURCES (authoritative — check these if a date matters)
 *   FOMC : https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   CPI  : https://www.bls.gov/schedule/news_release/cpi.htm
 *   Jobs : https://www.bls.gov/schedule/news_release/empsit.htm
 */

const { httpFetch } = require('./httpClient');

const BASE = 'https://api.benzinga.com';

// ---------------------------------------------------------------------------
// Built-in fallback schedule
// ---------------------------------------------------------------------------

/**
 * FOMC 2026 — from the Fed's published calendar. Two-day meetings; the rate
 * decision lands on the SECOND day at 14:00 ET, with the press conference at
 * 14:30 ET. Meetings marked `sep: true` also publish the Summary of Economic
 * Projections (the "dot plot"), which tends to move markets more.
 */
const FOMC_2026 = [
  { start: '2026-01-27', decision: '2026-01-28', sep: false },
  { start: '2026-03-17', decision: '2026-03-18', sep: true },
  { start: '2026-04-28', decision: '2026-04-29', sep: false },
  { start: '2026-06-16', decision: '2026-06-17', sep: true },
  { start: '2026-07-28', decision: '2026-07-29', sep: false },
  { start: '2026-09-15', decision: '2026-09-16', sep: true },
  { start: '2026-10-27', decision: '2026-10-28', sep: false },
  { start: '2026-12-08', decision: '2026-12-09', sep: true },
];

/**
 * CPI release dates confirmed against the BLS schedule. Only dates actually
 * verified are listed here — the rest of the year is filled in by rule and
 * flagged 'estimated', rather than inventing precise-looking dates.
 */
const CPI_CONFIRMED_2026 = {
  '2026-08': '2026-08-12', // July 2026 data
  '2026-12': '2026-12-10', // November 2026 data
};

/** Returns YYYY-MM-DD for the nth occurrence of a weekday in a month. */
function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCMonth() !== monthIndex) return null; // month has no nth weekday
  return d.toISOString().slice(0, 10);
}

const pad = (n) => String(n).padStart(2, '0');

/** Builds the fallback event list for a given year/month. */
function buildFallbackEvents(year, monthIndex) {
  const key = `${year}-${pad(monthIndex + 1)}`;
  const events = [];

  // --- Jobs report (Employment Situation) -------------------------------
  // Rule: first Friday, 08:30 ET. Usually right, but shifts around holidays,
  // so it's never claimed as confirmed.
  const firstFriday = nthWeekdayOfMonth(year, monthIndex, 5, 1);
  if (firstFriday) {
    events.push({
      date: firstFriday,
      time: '08:30 ET',
      name: 'Jobs Report (Employment Situation)',
      kind: 'jobs',
      importance: 'high',
      certainty: 'estimated',
      note: 'Usually the first Friday — verify on the BLS schedule.',
      source: 'https://www.bls.gov/schedule/news_release/empsit.htm',
    });
  }

  // --- CPI ---------------------------------------------------------------
  const confirmedCpi = CPI_CONFIRMED_2026[key];
  if (confirmedCpi) {
    events.push({
      date: confirmedCpi,
      time: '08:30 ET',
      name: 'CPI (Consumer Price Index)',
      kind: 'cpi',
      importance: 'high',
      certainty: 'confirmed',
      note: 'Reports the previous month\'s inflation.',
      source: 'https://www.bls.gov/schedule/news_release/cpi.htm',
    });
  } else {
    // Rule of thumb: CPI lands in the second week. Deliberately vague, and
    // marked estimated, because the exact day genuinely varies.
    const secondWed = nthWeekdayOfMonth(year, monthIndex, 3, 2);
    if (secondWed) {
      events.push({
        date: secondWed,
        time: '08:30 ET',
        name: 'CPI (Consumer Price Index)',
        kind: 'cpi',
        importance: 'high',
        certainty: 'estimated',
        note: 'Approximate — CPI is released in the second week but the exact day varies. Check the BLS schedule.',
        source: 'https://www.bls.gov/schedule/news_release/cpi.htm',
      });
    }
  }

  // --- FOMC ---------------------------------------------------------------
  FOMC_2026.filter((m) => m.decision.startsWith(key)).forEach((m) => {
    events.push({
      date: m.decision,
      time: '14:00 ET',
      name: `FOMC Rate Decision${m.sep ? ' + Projections (dot plot)' : ''}`,
      kind: 'fomc',
      importance: 'high',
      certainty: 'confirmed',
      note: `Two-day meeting ${m.start} to ${m.decision}. Decision 14:00 ET, press conference 14:30 ET.` +
        (m.sep ? ' Includes the Summary of Economic Projections.' : ''),
      source: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    });
  });

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Live source — Benzinga economic calendar
// ---------------------------------------------------------------------------

/**
 * Events we care about.
 *
 * `exclude` matters as much as `match`. The economics feed is dense with
 * near-miss releases that a loose pattern happily swallows:
 *   - "ADP Employment Change" (Wed, 08:15 ET)
 *   - "Challenger Job Cuts"   (Thu, 07:30 ET)
 *   - "Initial Jobless Claims"(Thu, 08:30 ET — weekly!)
 * all look like the jobs report to a /employment|jobs/ regex, which is how
 * three "Jobs Reports" ended up on three consecutive days. Only the monthly
 * Employment Situation / Nonfarm Payrolls release is wanted here.
 */
const WANTED = [
  {
    kind: 'cpi',
    label: 'CPI (Consumer Price Index)',
    match: /consumer price index|\bcpi\b/i,
    // Core/MoM/YoY variants are the same release; PPI and import prices are not.
    exclude: /producer price|\bppi\b|import price|export price|expectations|forecast/i,
  },
  {
    kind: 'jobs',
    label: 'Jobs Report (Nonfarm Payrolls)',
    match: /non-?farm payroll|employment situation/i,
    exclude: /\badp\b|challenger|jobless claims|continuing claims|private|change in manufact/i,
  },
  {
    kind: 'fomc',
    label: 'FOMC Rate Decision',
    match: /fomc.*(rate decision|statement|announcement)|federal funds rate|interest rate decision/i,
    // Minutes, speeches and forecasts aren't the decision itself.
    exclude: /minutes|speech|speaks|testimony|forecast|projection.*only/i,
  },
];

function classify(name) {
  const n = String(name || '');
  for (const w of WANTED) {
    if (w.match.test(n) && !(w.exclude && w.exclude.test(n))) return w;
  }
  return null;
}

async function fetchBenzingaEconomics(from, to, opts = {}) {
  const token = process.env.BENZINGA_API_KEY;
  if (!token) throw new Error('BENZINGA_API_KEY not set');

  const qs = new URLSearchParams({
    token,
    'parameters[date_from]': from,
    'parameters[date_to]': to,
    'parameters[country]': 'US',
    pagesize: '1000',
  });

  const res = await httpFetch(`${BASE}/api/v2.1/calendar/economics?${qs}`, {
    headers: { accept: 'application/json' },
  });

  if (res.status === 401) throw new Error('Benzinga key rejected (401).');
  if (res.status === 403) throw new Error("Your Benzinga licence doesn't include the economic calendar (403).");
  if (!res.ok) throw new Error(`Benzinga economics returned HTTP ${res.status}.`);

  const json = await res.json();
  const rows = json?.economics || [];

  if (opts.raw) return rows; // debug passthrough

  const mapped = rows
    .map((r) => {
      const rawName = r.event_name || r.name || '';
      const hit = classify(rawName);
      if (!hit) return null;

      // The API's country filter is unreliable — the feed comes back with
      // same-named events from many countries (a "CPI" at 20:30 is not the
      // US 08:30 release). Filter on the row's own country field so only
      // genuine US events survive.
      const country = String(r.country || '').toUpperCase();
      if (country && !['US', 'USA', 'UNITED STATES'].includes(country)) return null;

      return {
        date: r.date || null,
        timeRaw: r.time ? String(r.time).slice(0, 5) : null,
        name: hit.label,
        rawName, // kept so near-duplicates can be told apart
        kind: hit.kind,
        importance: 'high',
        certainty: 'confirmed',
        actual: r.actual ?? null,
        consensus: r.consensus ?? null,
        prior: r.prior ?? null,
        note: r.description || rawName || null,
      };
    })
    .filter(Boolean);

  return dedupe(mapped).sort(byDateTime);
}

/**
 * Benzinga publishes several rows per headline release (CPI MoM, CPI YoY,
 * Core CPI, and revisions all carry the same date), which is why the panel
 * filled with repeats. Collapse to one row per date+kind, preferring the
 * entry that actually has values attached.
 */
function dedupe(events) {
  const byKey = new Map();
  for (const e of events) {
    // CPI and the jobs report are MONTHLY, so the real invariant is one per
    // calendar month — not one per date. Keying on date alone let three
    // consecutive days each keep a row. FOMC can legitimately occur twice in
    // a month, so it keys on the exact date.
    const monthly = e.kind === 'cpi' || e.kind === 'jobs';
    const key = monthly ? `${String(e.date).slice(0, 7)}|${e.kind}` : `${e.date}|${e.kind}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
      continue;
    }
    // Prefer the row with real values, then the officially-confirmed one,
    // then the earlier date (the headline release precedes revisions).
    const score = (x) =>
      (x.actual != null ? 4 : 0) +
      (x.consensus != null ? 2 : 0) +
      (x.prior != null ? 1 : 0) +
      (x.certainty === 'confirmed' ? 1 : 0);
    const a = score(e);
    const b = score(existing);
    if (a > b || (a === b && String(e.date) < String(existing.date))) byKey.set(key, e);
  }
  return [...byKey.values()];
}

function byDateTime(a, b) {
  const d = String(a.date).localeCompare(String(b.date));
  return d !== 0 ? d : String(a.timeRaw || '').localeCompare(String(b.timeRaw || ''));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the macro events to display. Starts from the current month and
 * rolls into following months until it has at least `minUpcoming` events
 * still ahead — so the panel never goes empty near month-end.
 */
/**
 * Formats an ET clock time in US Central, which is what the UI displays.
 * Central is one hour behind Eastern year-round (both observe DST), so the
 * conversion is a simple -1h — but it can roll the date backwards, and that
 * is returned so the caller can show the correct day.
 */
function etToCentral(dateStr, hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return { time: null, dateShift: 0 };
  const [h, m] = hhmm.split(':').map(Number);
  let ch = h - 1;
  let dateShift = 0;
  if (ch < 0) {
    ch += 24;
    dateShift = -1; // crossed back over midnight
  }
  const suffix = ch >= 12 ? 'PM' : 'AM';
  const h12 = ch % 12 === 0 ? 12 : ch % 12;
  return { time: `${h12}:${String(m).padStart(2, '0')} ${suffix} CT`, dateShift };
}

/**
 * "Today" in the DISPLAY timezone, not UTC.
 *
 * This matters more than it looks. `new Date().toISOString()` returns UTC,
 * and Central is UTC-5/-6 — so from ~6pm CT onwards, UTC has already rolled
 * to the next day. Using it made an event "TODAY" while the user was still
 * on the previous evening, and pushed the genuinely-today event into the
 * past. Formatting with en-CA gives YYYY-MM-DD directly.
 */
const DISPLAY_TZ = process.env.APP_TIMEZONE || 'America/Chicago';

function todayInDisplayTz() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftDate(dateStr, days) {
  if (!days) return dateStr;
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getMacroCalendar(opts = {}) {
  const minUpcoming = opts.minUpcoming || 3;
  const maxMonths = opts.maxMonths || 4;

  const now = new Date();
  // Central, not UTC — see todayInDisplayTz().
  const todayStr = todayInDisplayTz();

  let source = 'fallback';
  let sourceNote =
    'Using the built-in schedule. FOMC dates and some CPI dates are from official published ' +
    'calendars; anything marked "estimated" is derived from the usual release rule and should ' +
    'be verified against the linked source.';

  const collected = [];

  // ALWAYS build the fallback set first. The live feed has proven to return
  // a window starting weeks out — it ignored date_from and skipped the next
  // two months entirely — so the built-in schedule is what guarantees the
  // near-term dates are present. Live rows then merge over the top, adding
  // real actual/consensus values where they overlap.
  // Derive the month window from the DISPLAY-timezone date, not the
  // server's local clock — otherwise a server in another timezone (or a
  // cloud host running UTC) would build the wrong month near month-end.
  const [tYear, tMonth] = todayStr.split('-').map(Number);
  const baseYear = tYear;
  const baseMonthIdx = tMonth - 1;

  const horizonEndDate = new Date(Date.UTC(baseYear, baseMonthIdx + maxMonths, 0));
  const horizonEnd = horizonEndDate.toISOString().slice(0, 10);

  for (let i = 0; i < maxMonths; i++) {
    const d = new Date(Date.UTC(baseYear, baseMonthIdx + i, 1));
    collected.push(...buildFallbackEvents(d.getUTCFullYear(), d.getUTCMonth()));
  }

  try {
    const from = shiftDate(todayStr, -7); // a little history for "recently passed"
    const live = await fetchBenzingaEconomics(from, horizonEnd);

    // Only keep live rows inside our horizon — the feed returns dates well
    // beyond what was asked for, which is how the panel filled with events
    // 60-90 days out while today and next month were missing.
    const inWindow = live.filter((e) => e.date >= from && e.date <= horizonEnd);

    if (inWindow.length) {
      collected.push(...inWindow);
      source = 'benzinga+builtin';
      sourceNote =
        `Live Benzinga rows merged over the built-in schedule. ` +
        `${inWindow.length} of ${live.length} live rows fell inside ${from} → ${horizonEnd}; ` +
        `the rest were outside the window and dropped.`;
    } else if (live.length) {
      sourceNote =
        `Benzinga returned ${live.length} rows but none inside ${from} → ${horizonEnd}, ` +
        `so the built-in schedule is being used for the near term.`;
    }
  } catch (e) {
    console.log(`[macro] Live economic calendar unavailable (${e.message}); using built-in schedule.`);
    sourceNote += ` (Live lookup failed: ${e.message})`;
  }

  const upcoming = collected.filter((e) => e.date >= todayStr && e.date <= horizonEnd);
  const past = collected.filter((e) => e.date < todayStr);

  // Final dedupe across whichever source(s) contributed, then convert to CT.
  const finalise = (list) =>
    dedupe(list)
      .sort(byDateTime)
      .map((e) => {
        // Fallback entries carry a display string like "08:30 ET"; live ones
        // carry timeRaw "08:30". Normalise both to an HH:MM before shifting.
        const hhmm = e.timeRaw || (typeof e.time === 'string' ? e.time.slice(0, 5) : null);
        const { time: ct, dateShift } = etToCentral(e.date, hhmm);
        const displayDate = shiftDate(e.date, dateShift);
        return {
          ...e,
          date: displayDate,
          timeET: hhmm ? `${hhmm} ET` : null,
          time: ct, // Central — what the UI shows
          daysAway: daysBetween(todayStr, displayDate),
        };
      });

  return {
    today: todayStr,
    timezone: DISPLAY_TZ,
    source,
    sourceNote,
    upcoming: finalise(upcoming),
    recentlyPassed: finalise(past).reverse().slice(0, 3),
  };
}

/** Raw passthrough for debugging what Benzinga actually returns. */
async function getRawEconomics(from, to) {
  return fetchBenzingaEconomics(from, to, { raw: true });
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

module.exports = { getMacroCalendar, getRawEconomics };
