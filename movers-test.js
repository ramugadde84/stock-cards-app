/**
 * movers-test.js — offline test for the movers scanner
 * -----------------------------------------------------
 * Stubs httpClient so scanMovers() runs against fabricated Yahoo `meta`
 * blocks. The point is to prove the SESSION-PICKING logic, which is the
 * part that silently produces wrong answers: at 6pm, reading
 * regularMarketChangePercent shows you the 3pm close, not the earnings
 * reaction you actually opened the tab for.
 *
 * Run:  node movers-test.js
 */

const path = require('path');

// ---- Stub httpClient BEFORE movers.js requires it -------------------------
const STATE = { marketState: 'POST', failTickers: new Set() };

const clientPath = require.resolve('./httpClient');
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    httpFetch: async (url) => {
      const ticker = decodeURIComponent(
        url.split('/v8/finance/chart/')[1].split('?')[0]
      );
      if (STATE.failTickers.has(ticker)) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: { result: [{ meta: makeMeta(ticker) }] },
        }),
      };
    },
  },
};

// When true, the stub omits the *ChangePercent fields entirely — the case
// where Yahoo hands back prices but no precomputed percentages.
let OMIT_PCT = false;

// Sessions the stub should report NO data for, e.g. midday when no
// post-market print exists yet.
let MISSING_SESSIONS = new Set();

// Age of the post-market print, in minutes. Default is fresh.
let POST_AGE_MINS = 5;

// Tickers the stub should report as exactly unchanged (0.00%).
let FLAT_TICKERS = new Set();

// Deterministic pseudo-random so runs are comparable.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeMeta(ticker) {
  const h = hash(ticker);
  const reg = ((h % 1000) / 100 - 5);          // -5.00 .. +4.99
  const post = ((h % 733) / 50 - 7);           // deliberately different from reg
  const pre = ((h % 577) / 40 - 7);
  if (OMIT_PCT) {
    // Prices only — regular close 100, post 106 (+6%), pre 97 (-3%).
    return {
      symbol: ticker,
      longName: ticker + ' Inc.',
      marketState: STATE.marketState,
      currency: 'USD',
      chartPreviousClose: 95,
      regularMarketPrice: 100,
      postMarketPrice: 106,
      preMarketPrice: 97,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (FLAT_TICKERS.has(ticker)) {
    return {
      symbol: ticker,
      longName: ticker + ' Inc.',
      marketState: STATE.marketState,
      currency: 'USD',
      chartPreviousClose: 100,
      regularMarketPrice: 100,
      regularMarketChangePercent: 0,
      regularMarketTime: nowSec - 1800,
      postMarketPrice: 100,
      postMarketChangePercent: 0,
      postMarketTime: nowSec - 60 * POST_AGE_MINS,
      preMarketPrice: 100,
      preMarketChangePercent: 0,
      preMarketTime: nowSec - 600,
    };
  }
  const meta = {
    symbol: ticker,
    longName: ticker + ' Inc.',
    marketState: STATE.marketState,
    currency: 'USD',
    regularMarketPrice: 50 + (h % 400) / 4,
    regularMarketChangePercent: reg,
    regularMarketVolume: h % 9000000,
    regularMarketTime: nowSec - 60 * 30,
    postMarketPrice: 51 + (h % 400) / 4,
    postMarketChangePercent: post,
    postMarketTime: nowSec - 60 * POST_AGE_MINS,
    preMarketPrice: 49 + (h % 400) / 4,
    preMarketChangePercent: pre,
    preMarketTime: nowSec - 60 * 10,
    chartPreviousClose: 50,
  };
  for (const s of MISSING_SESSIONS) {
    if (s === 'post') { delete meta.postMarketPrice; delete meta.postMarketChangePercent; delete meta.postMarketTime; }
    if (s === 'pre') { delete meta.preMarketPrice; delete meta.preMarketChangePercent; delete meta.preMarketTime; }
    if (s === 'regular') { delete meta.regularMarketPrice; delete meta.regularMarketChangePercent; delete meta.chartPreviousClose; }
  }
  return meta;
}

const { scanMovers } = require('./movers');
const { SP500, TOP_100 } = require('./sp500');

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  // ---- 1. Universe integrity --------------------------------------------
  console.log('\n1. Universe lists');
  check('SP500 has no duplicates',
    new Set(SP500).size === SP500.length,
    `${SP500.length} tickers, ${new Set(SP500).size} unique`);
  check('TOP_100 has no duplicates',
    new Set(TOP_100).size === TOP_100.length,
    `${TOP_100.length} tickers`);
  const notInSp = TOP_100.filter((t) => !SP500.includes(t));
  check('every TOP_100 name is in SP500', notInSp.length === 0,
    notInSp.length ? 'missing: ' + notInSp.join(',') : 'all present');

  // ---- 2. Session picking ------------------------------------------------
  // This is the whole reason the module exists. If POST returns the regular
  // figure, the tab is quietly lying at exactly the time it matters most.
  console.log('\n2. Session picking follows marketState');
  for (const [state, expected] of [
    ['POST', 'after-hours'],
    ['PRE', 'pre-market'],
    ['REGULAR', 'regular'],
    ['CLOSED', 'after-hours'], // falls back to the most recent print
  ]) {
    STATE.marketState = state;
    const r = await scanMovers({ universe: 'top100', minMove: 0, limit: 5 });
    const all = [...r.gainers, ...r.losers];
    const wrong = all.filter((m) => m.session !== expected);
    check(`marketState=${state} -> "${expected}"`, wrong.length === 0,
      wrong.length ? `${wrong.length} rows mislabelled` : `${all.length} rows, marketState reported as ${r.marketState}`);
  }

  // Verify the VALUE differs by session, not just the label.
  STATE.marketState = 'POST';
  const postRun = await scanMovers({ universe: 'top100', minMove: 0, limit: 100 });
  STATE.marketState = 'REGULAR';
  const regRun = await scanMovers({ universe: 'top100', minMove: 0, limit: 100 });
  const find = (run, t) => [...run.gainers, ...run.losers].find((m) => m.ticker === t);
  const aP = find(postRun, 'AAPL');
  const aR = find(regRun, 'AAPL');
  check('post-market pct differs from regular pct',
    aP && aR && aP.changePct !== aR.changePct,
    aP && aR ? `AAPL post ${aP.changePct.toFixed(2)}% vs regular ${aR.changePct.toFixed(2)}%` : 'AAPL missing');
  check('post-market price used, not regular',
    aP && aR && aP.price !== aR.price,
    aP && aR ? `$${aP.price.toFixed(2)} vs $${aR.price.toFixed(2)}` : '');

  // ---- 3. Threshold filtering -------------------------------------------
  console.log('\n3. Threshold filtering');
  STATE.marketState = 'POST';
  for (const min of [0.5, 1, 3, 5]) {
    const r = await scanMovers({ universe: 'top100', minMove: min, limit: 100 });
    const all = [...r.gainers, ...r.losers];
    const under = all.filter((m) => Math.abs(m.changePct) < min);
    check(`minMove=${min} excludes smaller moves`, under.length === 0,
      `${r.moversFound} of ${r.quoted} passed`);
  }

  const loose = await scanMovers({ universe: 'top100', minMove: 0.5, limit: 100 });
  const tight = await scanMovers({ universe: 'top100', minMove: 5, limit: 100 });
  check('higher threshold returns fewer', tight.moversFound < loose.moversFound,
    `${tight.moversFound} at 5% vs ${loose.moversFound} at 0.5%`);

  // ---- 4. Sorting and splitting -----------------------------------------
  console.log('\n4. Sorting and gainer/loser split');
  const r = await scanMovers({ universe: 'top100', minMove: 1, limit: 100 });
  check('gainers all positive', r.gainers.every((m) => m.changePct > 0));
  check('losers all negative', r.losers.every((m) => m.changePct < 0));
  const gDesc = r.gainers.every((m, i, a) => i === 0 || a[i - 1].changePct >= m.changePct);
  check('gainers sorted biggest first', gDesc,
    r.gainers.length ? `top ${r.gainers[0].changePct.toFixed(2)}%` : 'none');
  const lDesc = r.losers.every((m, i, a) => i === 0 || Math.abs(a[i - 1].changePct) >= Math.abs(m.changePct));
  check('losers sorted biggest drop first', lDesc,
    r.losers.length ? `worst ${r.losers[0].changePct.toFixed(2)}%` : 'none');

  // ---- 5. limit is respected --------------------------------------------
  console.log('\n5. limit');
  const lim = await scanMovers({ universe: 'top100', minMove: 0, limit: 3 });
  check('gainers capped at limit', lim.gainers.length <= 3, `${lim.gainers.length}`);
  check('losers capped at limit', lim.losers.length <= 3, `${lim.losers.length}`);
  check('moversFound counts BEFORE the cap', lim.moversFound > 6,
    `${lim.moversFound} found, ${lim.gainers.length + lim.losers.length} shown`);

  // ---- 6. Failures are counted, not fatal --------------------------------
  // A handful of 404s (delisted, renamed, rate-limited) must not kill a scan.
  console.log('\n6. Partial failure handling');
  STATE.failTickers = new Set(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'META']);
  const f = await scanMovers({ universe: 'top100', minMove: 0, limit: 100 });
  check('scan survives failing tickers', f.quoted > 0, `${f.quoted} quoted`);
  check('failures counted', f.failed === 5, `failed=${f.failed}`);
  check('failed tickers reported', f.failedTickers.length === 5,
    f.failedTickers.join(','));
  check('failed tickers absent from results',
    ![...f.gainers, ...f.losers].some((m) => STATE.failTickers.has(m.ticker)));
  STATE.failTickers = new Set();

  // ---- 7. "Nothing moved" is distinguishable from "scan broke" -----------
  console.log('\n7. Quiet session');
  const quiet = await scanMovers({ universe: 'top100', minMove: 99, limit: 10 });
  check('quiet scan still reports quoted count', quiet.quoted === TOP_100.length,
    `quoted=${quiet.quoted}, moversFound=${quiet.moversFound}, failed=${quiet.failed}`);
  check('quiet scan reports zero movers, not an error', quiet.moversFound === 0);

  // ---- 8. Full S&P universe ---------------------------------------------
  console.log('\n8. Full S&P 500 universe');
  const full = await scanMovers({ universe: 'sp500', minMove: 2, limit: 25 });
  check('scans the whole list', full.scanned === SP500.length, `${full.scanned} tickers`);
  check('universe echoed back', full.universe === 'sp500');
  check('elapsedMs recorded', typeof full.elapsedMs === 'number' && full.elapsedMs >= 0,
    `${full.elapsedMs}ms (stubbed network)`);

  // ---- 9. Bad input defaults safely -------------------------------------
  console.log('\n9. Input hardening');
  const junk = await scanMovers({ universe: 'nonsense', minMove: 'abc', limit: 'xyz' });
  check('unknown universe falls back to top100', junk.universe === 'top100');
  check('non-numeric minMove defaults to 1', junk.minMove === 1);
  const neg = await scanMovers({ universe: 'top100', minMove: -3, limit: 5 });
  check('negative minMove treated as absolute', neg.minMove === 3);

  // ---- 10. Derived percentages when Yahoo omits them --------------------
  // Yahoo's chart meta doesn't carry *ChangePercent on every symbol. Without
  // the fallback those tickers vanish from the scan silently, which looks
  // identical to "it isn't moving" — the one thing this tab must not do.
  console.log('\n10. Derived change when *ChangePercent is missing');
  OMIT_PCT = true;

  STATE.marketState = 'POST';
  const dPost = await scanMovers({ universe: 'top100', minMove: 1, limit: 5 });
  const dp = dPost.gainers[0];
  check('post-market move derived from prices', !!dp && Math.abs(dp.changePct - 6) < 0.001,
    dp ? `${dp.changePct.toFixed(2)}% (106 vs regular close 100 = +6%)` : 'no rows');
  check('derived post uses the regular close as baseline, not prev close',
    !!dp && Math.abs(dp.changePct - 11.578) > 0.01,
    'would be +11.58% if baselined off chartPreviousClose 95');

  STATE.marketState = 'PRE';
  const dPre = await scanMovers({ universe: 'top100', minMove: 1, limit: 5 });
  const dl = dPre.losers[0];
  check('pre-market move derived from prices', !!dl && Math.abs(dl.changePct - -3) < 0.001,
    dl ? `${dl.changePct.toFixed(2)}% (97 vs 100 = -3%)` : 'no rows');

  STATE.marketState = 'REGULAR';
  const dReg = await scanMovers({ universe: 'top100', minMove: 1, limit: 5 });
  const dr = dReg.gainers[0];
  check('regular move derived off previous close', !!dr && Math.abs(dr.changePct - 5.263) < 0.01,
    dr ? `${dr.changePct.toFixed(3)}% (100 vs prev close 95)` : 'no rows');
  check('no ticker silently dropped when pct fields are absent',
    dReg.quoted === TOP_100.length, `quoted=${dReg.quoted}/${TOP_100.length}`);

  OMIT_PCT = false;

  // ---- 11. Forced session (the after-hours use case) --------------------
  // The headline requirement: "mostly what matters is after market."
  // session=post must return the post-market figure NO MATTER what time it
  // is — including at 10am, when auto-mode would hand back the regular tape.
  console.log('\n11. Forced session overrides marketState');
  for (const state of ['PRE', 'POST', 'REGULAR', 'CLOSED']) {
    STATE.marketState = state;
    const r = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 100 });
    const all = [...r.gainers, ...r.losers];
    const wrong = all.filter((m) => m.session !== 'after-hours');
    check(`session=post during marketState=${state}`, wrong.length === 0 && all.length > 0,
      `${all.length} rows, all after-hours; echoed session="${r.session}", marketState="${r.marketState}"`);
  }

  // And the value must be the post-market one, not whatever auto would pick.
  STATE.marketState = 'REGULAR';
  const forcedPost = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 100 });
  const autoReg = await scanMovers({ universe: 'top100', session: 'auto', minMove: 0, limit: 100 });
  const fp = find(forcedPost, 'AAPL');
  const ar = find(autoReg, 'AAPL');
  check('forced post returns post figure, not the regular one',
    fp && ar && fp.changePct !== ar.changePct,
    fp && ar ? `forced ${fp.changePct.toFixed(2)}% vs auto ${ar.changePct.toFixed(2)}%` : 'missing');

  for (const [s, label] of [['pre', 'pre-market'], ['regular', 'regular']]) {
    STATE.marketState = 'POST';
    const r = await scanMovers({ universe: 'top100', session: s, minMove: 0, limit: 100 });
    const all = [...r.gainers, ...r.losers];
    check(`session=${s} forces "${label}"`,
      all.length > 0 && all.every((m) => m.session === label), `${all.length} rows`);
  }

  const badSess = await scanMovers({ universe: 'top100', session: 'nonsense', minMove: 0, limit: 5 });
  check('unknown session falls back to auto', badSess.session === 'auto');

  // ---- 12. No print for the forced session -------------------------------
  // Forcing after-hours at 11am: no post-market data exists. This must read
  // as "no post-market price yet", NOT as "nothing is moving" — they call
  // for completely different responses from you.
  console.log('\n12. Forced session with no data available');
  STATE.marketState = 'REGULAR';
  MISSING_SESSIONS = new Set(['post']);
  const noPost = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 10 });
  check('returns zero movers', noPost.moversFound === 0);
  check('counts them as noFigure, not as failures',
    noPost.noFigure === TOP_100.length && noPost.failed === 0,
    `noFigure=${noPost.noFigure}, failed=${noPost.failed}, quoted=${noPost.quoted}`);
  check('auto still works when post data is absent',
    (await scanMovers({ universe: 'top100', session: 'auto', minMove: 0, limit: 10 })).moversFound > 0);
  MISSING_SESSIONS = new Set();

  // ---- 13. Staleness flag ------------------------------------------------
  // A post-market print from last night is real, but must not be presented
  // as live movement.
  console.log('\n13. Stale extended-hours prints are flagged');
  STATE.marketState = 'PRE';
  POST_AGE_MINS = 5;
  const fresh = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 10 });
  check('fresh print not flagged stale',
    fresh.staleCount === 0 && fresh.gainers.every((m) => !m.stale),
    `staleCount=${fresh.staleCount}, ageMins=${fresh.gainers[0]?.ageMins}`);

  POST_AGE_MINS = 60 * 14; // last night
  const old = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 10 });
  check('14-hour-old print flagged stale',
    old.staleCount > 0 && old.gainers.every((m) => m.stale),
    `staleCount=${old.staleCount}, ageMins=${old.gainers[0]?.ageMins}`);
  check('ageMins is reported so the UI can say how old',
    typeof old.gainers[0]?.ageMins === 'number' && old.gainers[0].ageMins >= 60 * 13,
    `${old.gainers[0]?.ageMins} minutes`);
  check('stale rows are still returned, not silently dropped',
    old.moversFound === fresh.moversFound,
    `${old.moversFound} vs ${fresh.moversFound}`);
  POST_AGE_MINS = 5;

  // ---- 14. minMove=0 — "everything that moved" --------------------------
  // The requirement is literal: don't pre-filter at 0.5%, return every name
  // that moved at all. But "moved at all" must still exclude dead-flat
  // tickers, or the list is just the universe with extra steps.
  console.log('\n14. minMove=0 returns every mover, excluding flat');
  STATE.marketState = 'POST';
  FLAT_TICKERS = new Set(['AAPL', 'MSFT', 'KO', 'PEP', 'T']);
  const all = await scanMovers({ universe: 'top100', session: 'post', minMove: 0, limit: 500 });
  const rows = [...all.gainers, ...all.losers];
  check('minMove echoed as 0', all.minMove === 0);
  check('flat tickers counted separately', all.flat === 5, `flat=${all.flat}`);
  check('flat tickers excluded from the lists',
    !rows.some((m) => FLAT_TICKERS.has(m.ticker)));
  check('every non-flat quoted ticker is listed',
    all.moversFound === all.quoted - all.flat,
    `${all.moversFound} listed, ${all.quoted} quoted, ${all.flat} flat`);
  check('rows returned uncapped at limit=500',
    rows.length === all.moversFound && !all.truncated,
    `${rows.length} rows returned`);
  const tiny = rows.filter((m) => Math.abs(m.changePct) < 0.5).length;
  check('sub-0.5% movers ARE included now', tiny > 0,
    `${tiny} rows under 0.5% that the old default would have hidden`);
  FLAT_TICKERS = new Set();

  // Full universe, no threshold — the heaviest realistic request.
  const allSp = await scanMovers({ universe: 'sp500', session: 'post', minMove: 0, limit: 500 });
  check('full S&P with no threshold returns everything',
    allSp.gainers.length + allSp.losers.length === allSp.moversFound && !allSp.truncated,
    `${allSp.moversFound} movers out of ${allSp.scanned} scanned`);

  // ---- 15. Truncation is declared, never silent -------------------------
  console.log('\n15. Truncation is reported');
  const cut = await scanMovers({ universe: 'sp500', session: 'post', minMove: 0, limit: 10 });
  check('lists capped at limit', cut.gainers.length <= 10 && cut.losers.length <= 10,
    `${cut.gainers.length} up / ${cut.losers.length} down`);
  check('truncated flag set when rows were cut', cut.truncated === true);
  check('moversFound still reports the true total', cut.moversFound > 20,
    `${cut.moversFound} found, ${cut.gainers.length + cut.losers.length} shown`);
  check('limit echoed back', cut.limit === 10);

  console.log(
    failures === 0
      ? '\nAll movers tests passed.\n'
      : `\n${failures} test(s) FAILED.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
