/**
 * Stock Watch — front-end
 * ------------------------
 * Two views, switched via the top menu:
 *   1. Search — search a ticker -> fetches /api/stock/:ticker -> renders a
 *      card with current price, 10-day % change, a sparkline, and an
 *      expandable 10-day EOD table.
 *   2. Earnings Calendar — pick a date -> fetches /api/earnings?date=... ->
 *      renders one compact card per company reporting earnings that day,
 *      each with a "View 10-day chart" button that adds it to the Search
 *      view using the same loadTicker() logic.
 *
 * Both views also have a "📊 Check Result" button per card, which calls
 * /api/earnings-reaction/:ticker to show EPS estimate vs actual, the
 * surprise %, the pre/post-market price move, and a simple Bullish/
 * Bearish/Mixed label. The Earnings Calendar view additionally has an
 * "Auto-refresh" toggle that polls every 2 minutes and flashes any card
 * whose result just came in.
 *
 * Previously searched tickers are remembered in the browser's localStorage
 * so they reload automatically next time you open the page (this is a
 * normal local web app running in your own browser, not a Claude artifact,
 * so localStorage is fine here).
 */

const STORAGE_KEY = 'stockWatch.tickers';
const COUPON_STORAGE_KEY = 'stockWatch.savedCoupons';

const menuBtns = document.querySelectorAll('.menu-btn');
const views = {
  search: document.getElementById('searchView'),
  earnings: document.getElementById('earningsView'),
  movers: document.getElementById('moversView'),
  macro: document.getElementById('macroView'),
  average: document.getElementById('averageView'),
  planner: document.getElementById('plannerView'),
  coupons: document.getElementById('couponsView'),
};

const form = document.getElementById('searchForm');
const input = document.getElementById('tickerInput');
const grid = document.getElementById('cardGrid');
const statusMsg = document.getElementById('statusMsg');

const earningsDateInput = document.getElementById('earningsDate');
const loadEarningsBtn = document.getElementById('loadEarningsBtn');
const quickDateBtns = document.querySelectorAll('.quick-date-btn');
const earningsGrid = document.getElementById('earningsGrid');
const earningsStatus = document.getElementById('earningsStatus');
const autoRefreshToggle = document.getElementById('autoRefreshToggle');

// Tickers whose "Check Result" panel is currently expanded in the Earnings
// Calendar view — re-opened automatically after each reload/auto-refresh so
// you don't lose your place. Paired with the last known hasReported value so
// we can flash a card the moment a result flips from "not yet" to "reported."
const openReactionTickers = new Set();
const lastKnownReportedState = new Map(); // ticker -> boolean
let autoRefreshTimer = null;

// ============================================================================
// Menu / view switching
// ============================================================================
menuBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    menuBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.entries(views).forEach(([name, el]) => {
      el.classList.toggle('hidden', name !== btn.dataset.view);
    });
  });
});

function switchToView(name) {
  menuBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  Object.entries(views).forEach(([viewName, el]) => {
    el.classList.toggle('hidden', viewName !== name);
  });
}

// ============================================================================
// SEARCH VIEW
// ============================================================================
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;
  input.value = '';
  loadTicker(ticker, true);
});

async function loadTicker(ticker, persist) {
  if (document.getElementById('card-' + ticker)) {
    setStatus(`${ticker} is already on the board.`, true);
    return;
  }

  const card = renderLoadingCard(ticker);
  grid.prepend(card);
  setStatus('');

  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(ticker)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Failed to load ${ticker}`);
    }
    renderCard(card, data);
    if (persist) addTickerToStorage(data.ticker);
    return data;
  } catch (err) {
    renderErrorCard(card, ticker, err.message);
  }
}

function getSavedTickers() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveTickers(tickers) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tickers));
}

function addTickerToStorage(ticker) {
  const tickers = getSavedTickers();
  if (!tickers.includes(ticker)) {
    tickers.push(ticker);
    saveTickers(tickers);
  }
}

function removeTickerFromStorage(ticker) {
  saveTickers(getSavedTickers().filter((t) => t !== ticker));
}

function setStatus(msg, isWarning) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status' + (isWarning ? ' warning' : '');
}

function renderLoadingCard(ticker) {
  const card = document.createElement('div');
  card.className = 'card loading';
  card.id = 'card-' + ticker;
  card.innerHTML = `<div class="card-header"><span class="ticker">${escapeHtml(ticker)}</span></div><div class="card-body">Loading…</div>`;
  return card;
}

function renderErrorCard(card, ticker, message) {
  card.className = 'card error';
  card.id = 'card-' + ticker;
  card.innerHTML = `
    <div class="card-header">
      <span class="ticker">${escapeHtml(ticker)}</span>
      <button class="remove-btn" title="Remove">✕</button>
    </div>
    <div class="error-msg">⚠️ ${escapeHtml(message)}</div>
  `;
  attachRemove(card, ticker);
}

function renderCard(card, data) {
  card.id = 'card-' + data.ticker;
  card.className = 'card';

  const pct = data.periodChangePercent;
  const changeClass = pct > 0 ? 'positive' : pct < 0 ? 'negative' : '';
  const changeSign = pct > 0 ? '+' : '';

  const rows = data.days
    .slice()
    .reverse()
    .map(
      (d) => `<tr>
        <td>${d.date}</td>
        <td>${fmt(d.open)}</td>
        <td>${fmt(d.high)}</td>
        <td>${fmt(d.low)}</td>
        <td>${fmt(d.close)}</td>
        <td>${fmtVolume(d.volume)}</td>
      </tr>`
    )
    .join('');

  const sparkline = buildSparkline(data.days.map((d) => d.close));

  card.innerHTML = `
    <div class="card-header">
      <div>
        <span class="ticker">${escapeHtml(data.ticker)}</span>
        <span class="company-name">${escapeHtml(data.name)}</span>
      </div>
      <button class="remove-btn" title="Remove">✕</button>
    </div>
    <div class="card-price-row">
      <span class="price">${escapeHtml(data.currency || '')} ${fmt(data.currentPrice)}</span>
      <span class="change ${changeClass}">${changeSign}${fmt(pct)}% (10d)</span>
    </div>
    <div class="sparkline">${sparkline}</div>
    <details class="table-toggle">
      <summary>10-day EOD detail</summary>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>
    <div class="reaction-slot"></div>
    <div class="card-footer">${escapeHtml(data.exchange || '')}</div>
  `;

  attachRemove(card, data.ticker);
  attachReactionButton(card, data.ticker, { autoTrack: false });
  attachBenzingaButton(card, data.ticker);
  attachMonthEarningsButton(card, data.ticker);
  attachNewsButton(card, data.ticker);
  attachOptionsButton(card, data.ticker);
  attachAiButton(card, data.ticker);
}

// ============================================================================
// OPTIONS FLOW — top calls & puts by premium
// ============================================================================

function attachOptionsButton(card, ticker) {
  const slot = document.createElement('div');
  slot.className = 'bz-slot';

  const btn = document.createElement('button');
  btn.className = 'bz-btn';
  btn.textContent = '⚡ Top options flow';

  card.appendChild(btn);
  card.appendChild(slot);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '⚡ Top options flow';
      return;
    }

    expanded = true;
    btn.textContent = 'Loading…';
    slot.innerHTML = '<div class="bz-box">Loading options flow…</div>';

    try {
      const res = await fetch(`/api/options/${encodeURIComponent(ticker)}?limit=10`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Request failed');
      renderOptionsFlow(slot, d);
      btn.textContent = '⚡ Hide options';
    } catch (err) {
      slot.innerHTML = `<div class="bz-box"><span class="error-msg">⚠️ ${escapeHtml(err.message)}</span></div>`;
      btn.textContent = '⚡ Hide options';
    }
  });
}

function renderOptionsFlow(slot, d) {
  if (!d.configured) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note)}</div></div>`;
    return;
  }
  if (!d.totalTrades) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">No options activity found for ${escapeHtml(d.ticker)} in the last week.</div></div>`;
    return;
  }

  // Be explicit about freshness. Options don't trade outside 09:30-16:00 ET,
  // so outside those hours this is necessarily the last session's flow.
  const freshness = d.marketOpen
    ? '<span class="live-dot">● LIVE</span> options market open'
    : `market closed — showing last session${d.latestTradeStamp ? ' (' + escapeHtml(d.latestTradeStamp) + ')' : ''}`;

  const side = (list, kind) => {
    if (!list.length) return `<div class="bz-note">No ${kind}s.</div>`;
    return list
      .map((t, i) => {
        const sweep = /sweep/i.test(t.activityType || '')
          ? '<span class="sweep-badge">SWEEP</span>' : '';
        return `
          <div class="opt-row">
            <span class="opt-rank">#${i + 1}</span>
            <span class="opt-strike">$${fmt(t.strike)}</span>
            <span class="opt-exp">${escapeHtml(t.expiry || '')}</span>
            <span class="opt-prem">${fmtBig(t.premium)}</span>
            <span class="opt-vol">v${t.volume ?? '—'}/oi${t.openInterest ?? '—'}</span>
            ${sweep}
          </div>`;
      })
      .join('');
  };

  const skew = d.premiumSkew || {};
  const skewLabel =
    skew.leaning === 'calls' ? '<span class="pos">call-heavy</span>'
    : skew.leaning === 'puts' ? '<span class="neg">put-heavy</span>'
    : 'balanced';

  slot.innerHTML = `
    <div class="bz-box">
      <div class="bz-meta">${freshness}</div>
      <div class="reaction-row">
        <span>Premium skew</span>
        <span>${skewLabel} · calls ${fmtBig(skew.callPremium)} vs puts ${fmtBig(skew.putPremium)}</span>
      </div>

      <div class="bz-section-title" style="margin-top:10px;">🟢 Top calls by premium</div>
      ${side(d.calls, 'call')}

      <div class="bz-section-title" style="margin-top:10px;">🔴 Top puts by premium</div>
      ${side(d.puts, 'put')}

      <div class="reaction-disclaimer">
        Ranked by premium (total dollars), not contract count — a big-dollar trade signals
        more conviction than many cheap contracts. Large flow shows what someone bet, not
        whether they were right, and could equally be a hedge. Not advice.
      </div>
    </div>`;
}

// ============================================================================
// BENZINGA WIRE NEWS — per ticker
// ============================================================================
// The wire is where Benzinga's speed advantage lives: stories land here the
// moment they cross, ahead of aggregators like Yahoo.

function attachNewsButton(card, ticker) {
  const slot = document.createElement('div');
  slot.className = 'bz-slot';

  const btn = document.createElement('button');
  btn.className = 'bz-btn';
  btn.textContent = '📰 Latest news (wire)';

  card.appendChild(btn);
  card.appendChild(slot);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '📰 Latest news (wire)';
      return;
    }

    expanded = true;
    btn.textContent = 'Loading…';
    slot.innerHTML = '<div class="bz-box">Loading wire news…</div>';

    try {
      const res = await fetch(`/api/news/${encodeURIComponent(ticker)}?limit=15`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Request failed');

      if (!d.configured) {
        slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note)}</div></div>`;
      } else if (!d.stories.length) {
        slot.innerHTML = `<div class="bz-box"><div class="bz-note">No recent news for ${escapeHtml(ticker)}.</div></div>`;
      } else {
        slot.innerHTML = `
          <div class="bz-box">
            <div class="bz-meta">${d.count} recent stor${d.count === 1 ? 'y' : 'ies'}</div>
            ${d.stories.map(newsRow).join('')}
          </div>`;
      }
      btn.textContent = '📰 Hide news';
    } catch (err) {
      slot.innerHTML = `<div class="bz-box"><span class="error-msg">⚠️ ${escapeHtml(err.message)}</span></div>`;
      btn.textContent = '📰 Hide news';
    }
  });
}

function newsRow(n) {
  const when = n.created
    ? new Date(n.created).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '';
  // Wire stories are the fast ones — badge them so it's obvious which
  // arrived straight off the newswire versus a written-up article.
  const wire = n.isWire ? '<span class="wire-badge">WIRE</span>' : '';
  const chans = n.channels?.length
    ? `<span class="news-chan">${escapeHtml(n.channels.slice(0, 2).join(' · '))}</span>`
    : '';

  return `
    <div class="bz-earn-entry">
      <div class="bz-earn-head">${escapeHtml(when)} ${wire} ${chans}</div>
      <div class="coupon-meta">${escapeHtml(n.title)}</div>
      ${n.teaser ? `<div class="news-teaser">${escapeHtml(n.teaser.slice(0, 220))}${n.teaser.length > 220 ? '…' : ''}</div>` : ''}
      ${n.url ? `<div class="card-footer"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">Read →</a></div>` : ''}
    </div>`;
}

// ============================================================================
// AI ANALYSIS — LLM weighs the earnings + bull/bear data
// ============================================================================

function attachAiButton(card, ticker) {
  const slot = document.createElement('div');
  slot.className = 'bz-slot';

  const btn = document.createElement('button');
  btn.className = 'bz-btn ai';
  btn.textContent = '🤖 AI analysis';

  card.appendChild(btn);
  card.appendChild(slot);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '🤖 AI analysis';
      return;
    }

    expanded = true;
    btn.textContent = 'Analysing…';
    slot.innerHTML = '<div class="bz-box">Gathering data and analysing… this takes a few seconds.</div>';

    try {
      const res = await fetch(`/api/ai-analysis/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      renderAiAnalysis(slot, data);
      btn.textContent = '🤖 Hide analysis';
    } catch (err) {
      slot.innerHTML = `<div class="bz-box"><span class="error-msg">⚠️ ${escapeHtml(err.message)}</span></div>`;
      btn.textContent = '🤖 Hide analysis';
    }
  });
}

function renderAiAnalysis(slot, d) {
  if (!d.configured || !d.analyzed) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note || 'Nothing to analyse.')}</div></div>`;
    return;
  }

  const a = d.analysis;
  const v = (a.verdict || '').toLowerCase();
  const cls = v.includes('bull') ? 'bullish' : v.includes('bear') ? 'bearish' : 'mixed';
  const emoji = v.includes('bull') ? '🟢' : v.includes('bear') ? '🔴' : v.includes('mixed') ? '⚠️' : '⚪';

  const list = (items, className) =>
    items && items.length
      ? `<ul class="ai-list ${className}">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : '';

  // Show which datasets actually fed the analysis — an opinion formed from
  // half the picture should be visibly labelled as such.
  const src = d.sourcesUsed || {};
  const srcLabel = [
    src.earnings ? 'earnings figures' : null,
    src.bullBearCases ? 'analyst bull/bear cases' : null,
  ]
    .filter(Boolean)
    .join(' + ') || 'limited data';

  slot.innerHTML = `
    <div class="bz-box">
      <div class="bz-verdict ${cls}">${emoji} ${escapeHtml(a.verdict)}
        <span class="ai-conf">confidence: ${escapeHtml(a.confidence)}</span>
      </div>
      ${a.summary ? `<p class="ai-summary">${escapeHtml(a.summary)}</p>` : ''}
      ${a.bullPoints.length ? '<div class="bz-section-title">Supporting</div>' : ''}
      ${list(a.bullPoints, 'bull')}
      ${a.bearPoints.length ? '<div class="bz-section-title">Against</div>' : ''}
      ${list(a.bearPoints, 'bear')}
      ${a.unknowns.length ? '<div class="bz-section-title">Not known from this data</div>' : ''}
      ${list(a.unknowns, 'unknown')}
      <div class="reaction-disclaimer">
        AI-generated analysis of ${escapeHtml(srcLabel)}. It assesses what the reported
        numbers show — it does <strong>not</strong> predict the share price, and it isn't
        financial advice. Beats and price moves often diverge.
      </div>
    </div>
  `;
}

// ============================================================================
// EARNINGS THIS MONTH — Benzinga, filtered to the current calendar month
// ============================================================================

function attachMonthEarningsButton(card, ticker) {
  const slot = document.createElement('div');
  slot.className = 'bz-slot';

  const btn = document.createElement('button');
  btn.className = 'bz-btn';
  btn.textContent = '📆 Earnings this month';

  card.appendChild(btn);
  card.appendChild(slot);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '📆 Earnings this month';
      return;
    }

    expanded = true;
    btn.textContent = 'Loading…';
    slot.innerHTML = '<div class="bz-box">Checking this month…</div>';

    try {
      const res = await fetch(`/api/earnings-month/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      renderMonthEarnings(slot, data);
      btn.textContent = '📆 Hide earnings';
    } catch (err) {
      slot.innerHTML = `<div class="bz-box"><span class="error-msg">⚠️ ${escapeHtml(err.message)}</span></div>`;
      btn.textContent = '📆 Hide earnings';
    }
  });
}

function renderMonthEarnings(slot, d) {
  if (!d.configured) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note)}</div></div>`;
    return;
  }

  // No earnings this month is normal for most tickers — but "the API
  // returned nothing at all" and "the API returned rows, just not this
  // month" are very different problems, so distinguish them rather than
  // showing one ambiguous message.
  if (!d.found) {
    const g = d.diagnostics || {};
    let detail = '';
    if (g.rowsReturned === 0) {
      detail =
        `<div class="bz-note" style="margin-top:6px;">Benzinga returned no earnings rows at all for this ticker — ` +
        `that usually means the earnings dataset isn't in your licence, or the symbol isn't covered.</div>`;
    } else if (g.datesReturned?.length) {
      detail =
        `<div class="bz-note" style="margin-top:6px;">Benzinga returned ${g.rowsReturned} row(s), but dated ` +
        `${escapeHtml(g.datesReturned.join(', '))} — none inside ${escapeHtml(g.monthFilter || '')}.</div>`;
    }
    slot.innerHTML =
      `<div class="bz-box"><div class="bz-note">No earnings for ${escapeHtml(d.ticker)} in ${escapeHtml(d.monthLabel)}.</div>${detail}</div>`;
    if (g.rowsReturned !== undefined) console.log(`[earnings-month] ${d.ticker} diagnostics:`, g);
    return;
  }

  // Benzinga news-wire path: the release itself, which lands minutes after
  // the wire crosses — the fastest source available here.
  if (d.source === 'benzinga-news' && d.newsReleases?.length) {
    const items = d.newsReleases
      .map((n) => {
        const when = n.created
          ? new Date(n.created).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })
          : '';
        return `
          <div class="bz-earn-entry">
            <div class="bz-earn-head">${escapeHtml(when)} <span class="wire-badge">BZ WIRE</span></div>
            <div class="coupon-meta">${escapeHtml(n.title)}</div>
            ${n.url ? `<div class="card-footer"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">Read release →</a></div>` : ''}
          </div>`;
      })
      .join('');
    slot.innerHTML = `
      <div class="bz-box">
        <div class="bz-meta">${escapeHtml(d.monthLabel)} · from Benzinga's news wire</div>
        ${items}
        <div class="reaction-disclaimer">
          The calendar endpoint only carries scheduled dates and estimates, so results come
          from the wire instead — that's also the fastest source. Use <strong>🤖 AI analysis</strong>
          to pull the EPS and revenue figures out of the release.
        </div>
      </div>`;
    return;
  }

  const rows = d.entries
    .map((e) => {
      const surprise =
        e.epsSurprisePercent === null
          ? ''
          : ` <span class="${e.epsSurprisePercent >= 0 ? 'pos' : 'neg'}">(${e.epsSurprisePercent > 0 ? '+' : ''}${fmt(e.epsSurprisePercent)}%)</span>`;

      return `
        <div class="bz-earn-entry">
          <div class="bz-earn-head">
            ${escapeHtml(e.date || '')}${e.time ? ' · ' + escapeHtml(e.time) : ''}${e.period ? ' · ' + escapeHtml(e.period) : ''}
            ${e.reported ? '' : '<span class="pending">upcoming</span>'}
          </div>
          <div class="reaction-row"><span>EPS actual / est</span><span>${fmt(e.epsActual)} / ${fmt(e.epsEstimate)}${surprise}</span></div>
          <div class="reaction-row"><span>Revenue actual / est</span><span>${fmtBig(e.revenueActual)} / ${fmtBig(e.revenueEstimate)}</span></div>
        </div>`;
    })
    .join('');

  slot.innerHTML = `
    <div class="bz-box">
      <div class="bz-meta">${escapeHtml(d.monthLabel)} · ${d.entries.length} report(s)</div>
      ${rows}
    </div>
  `;
}

// ============================================================================
// BENZINGA PANEL — licensed data: bull/bear cases, earnings, WIIM, ratings
// ============================================================================
// Only meaningful if the server was started with BENZINGA_API_KEY set. If it
// wasn't, the API says so plainly and the panel explains rather than erroring.

function attachBenzingaButton(card, ticker) {
  const slot = document.createElement('div');
  slot.className = 'bz-slot';

  const btn = document.createElement('button');
  btn.className = 'bz-btn';
  btn.textContent = '🐂🐻 Bull / Bear (Benzinga)';

  card.appendChild(btn);
  card.appendChild(slot);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '🐂🐻 Bull / Bear (Benzinga)';
      return;
    }

    expanded = true;
    btn.textContent = 'Loading…';
    slot.innerHTML = '<div class="bz-box">Loading bull &amp; bear cases…</div>';

    try {
      const res = await fetch(`/api/bulls-bears/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      renderBullBearBox(slot, data);
      btn.textContent = '🐂🐻 Hide Bull / Bear';
    } catch (err) {
      slot.innerHTML = `<div class="bz-box"><span class="error-msg">⚠️ ${escapeHtml(err.message)}</span></div>`;
      btn.textContent = '🐂🐻 Hide Bull / Bear';
    }
  });
}

/** Renders just the bull and bear cases from Benzinga. */
function renderBullBearBox(slot, d) {
  if (!d.configured) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note)}</div></div>`;
    return;
  }
  if (!d.found) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">No bull/bear case published for ${escapeHtml(d.ticker)}.</div></div>`;
    return;
  }

  const header = [d.companyName, d.exchange].filter(Boolean).join(' · ');

  slot.innerHTML = `
    <div class="bz-box">
      ${header || d.updated ? `<div class="bz-meta">${escapeHtml(header)}${d.updated ? ` · updated ${escapeHtml(d.updated)}` : ''}</div>` : ''}
      ${d.bullCase ? `<div class="bz-case bull"><strong>🐂 Bull case</strong><p>${escapeHtml(d.bullCase)}</p></div>` : ''}
      ${d.bearCase ? `<div class="bz-case bear"><strong>🐻 Bear case</strong><p>${escapeHtml(d.bearCase)}</p></div>` : ''}
      <div class="reaction-disclaimer">Source: Benzinga. Both sides are presented deliberately — read them rather than looking for a single verdict.</div>
    </div>
  `;
}

function renderBenzingaBox(slot, d) {
  if (!d.configured) {
    slot.innerHTML = `<div class="bz-box"><div class="bz-note">${escapeHtml(d.note)}</div></div>`;
    return;
  }

  const parts = [];
  const v = d.verdict || {};

  // Verdict — derived only from beat/miss, and labelled as such.
  if (v.label) {
    const cls = v.label.toLowerCase().includes('bull')
      ? 'bullish'
      : v.label.toLowerCase().includes('bear')
      ? 'bearish'
      : 'mixed';
    parts.push(`
      <div class="bz-verdict ${cls}">${v.emoji || ''} ${escapeHtml(v.label)}</div>
      ${(v.basis || []).map((b) => `<div class="bz-basis">• ${escapeHtml(b)}</div>`).join('')}
    `);
  }

  // Earnings numbers.
  if (d.earnings?.ok && d.earnings.data) {
    const e = d.earnings.data;
    parts.push(`
      <div class="bz-section">
        <div class="bz-section-title">Earnings ${e.period ? '· ' + escapeHtml(e.period) : ''} ${e.date ? '· ' + escapeHtml(e.date) : ''}</div>
        <div class="reaction-row"><span>EPS actual / est</span><span>${fmt(e.epsActual)} / ${fmt(e.epsEstimate)}</span></div>
        <div class="reaction-row"><span>EPS surprise</span><span>${e.epsSurprisePercent === null ? '—' : fmt(e.epsSurprisePercent) + '%'}</span></div>
        <div class="reaction-row"><span>Revenue actual / est</span><span>${fmtBig(e.revenueActual)} / ${fmtBig(e.revenueEstimate)}</span></div>
      </div>
    `);
  } else if (d.earnings && !d.earnings.ok) {
    parts.push(sectionError('Earnings', d.earnings.error));
  }

  // Benzinga's own bull and bear cases — the actual arguments.
  if (d.bullsBears?.ok && d.bullsBears.data) {
    const bb = d.bullsBears.data;
    parts.push(`
      <div class="bz-section">
        <div class="bz-section-title">Benzinga bull / bear case ${bb.updated ? '· ' + escapeHtml(bb.updated) : ''}</div>
        ${bb.bullCase ? `<div class="bz-case bull"><strong>🐂 Bull:</strong> ${escapeHtml(bb.bullCase)}</div>` : ''}
        ${bb.bearCase ? `<div class="bz-case bear"><strong>🐻 Bear:</strong> ${escapeHtml(bb.bearCase)}</div>` : ''}
      </div>
    `);
  } else if (d.bullsBears && !d.bullsBears.ok) {
    parts.push(sectionError('Bull/Bear cases', d.bullsBears.error));
  }

  // Why Is It Moving.
  if (d.wiims?.ok && d.wiims.data?.length) {
    parts.push(`
      <div class="bz-section">
        <div class="bz-section-title">Why is it moving</div>
        ${d.wiims.data.map((w) => `<div class="bz-basis">• ${escapeHtml(w.title || '')}</div>`).join('')}
      </div>
    `);
  } else if (d.wiims && !d.wiims.ok) {
    parts.push(sectionError('WIIM', d.wiims.error));
  }

  // Analyst ratings actions.
  if (d.ratings?.ok && d.ratings.data?.length) {
    parts.push(`
      <div class="bz-section">
        <div class="bz-section-title">Recent analyst actions</div>
        ${d.ratings.data
          .map(
            (r) =>
              `<div class="reaction-row"><span>${escapeHtml(r.date || '')} ${escapeHtml(r.firm || '')}</span><span>${escapeHtml(
                [r.ratingPrior && r.ratingCurrent ? `${r.ratingPrior}→${r.ratingCurrent}` : r.ratingCurrent, r.ptCurrent ? `PT ${r.ptCurrent}` : '']
                  .filter(Boolean)
                  .join(' · ')
              )}</span></div>`
          )
          .join('')}
      </div>
    `);
  } else if (d.ratings && !d.ratings.ok) {
    parts.push(sectionError('Ratings', d.ratings.error));
  }

  parts.push(
    '<div class="reaction-disclaimer">Verdict is a mechanical beat/miss read, not advice. ' +
      'The bull/bear text above is Benzinga\'s analysis — read it rather than the label.</div>'
  );

  slot.innerHTML = `<div class="bz-box">${parts.join('')}</div>`;
}

/** A dataset your key may simply not be licensed for — say so plainly. */
function sectionError(name, message) {
  return `<div class="bz-section"><div class="bz-section-title">${escapeHtml(name)}</div><div class="bz-note">⚠️ ${escapeHtml(message || 'Unavailable')}</div></div>`;
}

/** Formats large currency figures (revenue) compactly. */
function fmtBig(n) {
  if (typeof n !== 'number') return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

function attachRemove(card, ticker) {
  const btn = card.querySelector('.remove-btn');
  btn.addEventListener('click', () => {
    card.remove();
    removeTickerFromStorage(ticker);
  });
}

function buildSparkline(closes) {
  const valid = closes.filter((c) => typeof c === 'number');
  if (valid.length < 2) return '';
  const w = 260;
  const h = 50;
  const pad = 4;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const step = (w - pad * 2) / (valid.length - 1);
  const points = valid
    .map((c, i) => {
      const x = pad + i * step;
      const y = h - pad - ((c - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const trendUp = valid[valid.length - 1] >= valid[0];
  return `<svg viewBox="0 0 ${w} ${h}" class="spark ${trendUp ? 'up' : 'down'}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke-width="2" />
  </svg>`;
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : '—';
}

function fmtVolume(v) {
  if (typeof v !== 'number') return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ============================================================================
// EARNINGS CALENDAR VIEW
// ============================================================================

/**
 * Today's date in the LOCAL timezone, as YYYY-MM-DD.
 *
 * Deliberately not toISOString() — that returns UTC, so from early evening
 * onwards in US Central it reports tomorrow's date. That made the earnings
 * date default to the wrong day every evening. en-CA formats as YYYY-MM-DD.
 */
function todayYMD(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

quickDateBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    quickDateBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    earningsDateInput.value = todayYMD(Number(btn.dataset.offset));
    loadEarnings();
  });
});

loadEarningsBtn.addEventListener('click', () => {
  quickDateBtns.forEach((b) => b.classList.remove('active'));
  loadEarnings();
});

// ---------------------------------------------------------------------------
// Session buttons — Benzinga-backed, ranked by revenue
// ---------------------------------------------------------------------------
// Separate from loadEarnings() below, which scrapes Yahoo. This path uses the
// licensed Benzinga calendar, so it has real revenue figures to rank by.

document.querySelectorAll('.session-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.session-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadSessionEarnings(btn.dataset.session);
  });
});

const SESSION_LABELS = {
  pre: 'Pre-market (BMO)',
  post: 'After-market (AMC)',
  during: 'During market hours',
  other: 'Time not supplied',
  all: 'All sessions',
};

async function loadSessionEarnings(session) {
  const dateStr = earningsDateInput.value || todayYMD(0);
  const useBenzinga = document.getElementById('useBenzingaToggle')?.checked;
  earningsGrid.innerHTML = '';
  setEarningsStatus(
    `Loading ${SESSION_LABELS[session] || session} earnings for ${dateStr} via ${useBenzinga ? 'Benzinga' : 'Yahoo'}…`
  );

  try {
    if (useBenzinga) {
      await loadBenzingaSession(dateStr, session);
    } else {
      await loadYahooSession(dateStr, session);
    }
  } catch (err) {
    setEarningsStatus(`⚠️ ${err.message}`, true);
  }
}

/** Benzinga path — real revenue figures, needs a licensed key. */
async function loadBenzingaSession(dateStr, session) {
  const res = await fetch(
    `/api/earnings-calendar?date=${encodeURIComponent(dateStr)}&session=${encodeURIComponent(session)}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');

  if (!data.configured) {
    setEarningsStatus(data.note, true);
    return;
  }
  if (data.count === 0) {
    setEarningsStatus(
      `No ${SESSION_LABELS[session] || session} earnings on ${dateStr}` +
        (data.totalForDate ? ` (${data.totalForDate} reporting that day in other sessions).` : '.')
    );
    return;
  }

  let msg = `${data.count} company(s) — ${SESSION_LABELS[session]} on ${dateStr}, ranked by revenue (Benzinga).`;
  if (data.truncated) msg += ' Note: hit the 1000-row page limit, so the list may be incomplete.';
  setEarningsStatus(msg, data.truncated);

  data.entries.forEach((e, i) => earningsGrid.appendChild(renderSessionCard(e, i + 1)));
}

/** Yahoo path — free, and the BMO/AMC split is exact since Yahoo labels it. */
async function loadYahooSession(dateStr, session) {
  const skipPrices = document.getElementById('skipPricesToggle')?.checked;

  const res = await fetch(
    `/api/earnings?date=${encodeURIComponent(dateStr)}&session=${encodeURIComponent(session)}` +
      (skipPrices ? '&prices=false' : '')
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');

  if (data.results.length === 0) {
    setEarningsStatus(
      `No ${SESSION_LABELS[session] || session} earnings found on ${dateStr}` +
        (data.totalForDate ? ` (${data.totalForDate} reporting that day across all sessions).` : '.')
    );
    return;
  }

  let msg = `${data.totalInSession} ${SESSION_LABELS[session]} on ${dateStr} · ${data.totalForDate} that day in total`;
  msg += data.pricesIncluded ? ', ranked by price.' : ' (fast mode — no prices, alphabetical).';

  let warn = false;
  if (data.capped) {
    msg += ` Showing the first ${data.returnedCount} — tick "Fast mode" to get all of them.`;
    warn = true;
  }

  // A short list is far more often a pagination failure than a quiet day, so
  // say which it was rather than leaving it ambiguous.
  const diag = data.diagnostics;
  if (diag?.paginationLikelyBroken) {
    msg +=
      ` ⚠ Only ${diag.pagesFetched} page of results was reachable — Yahoo appears to be ` +
      `ignoring the pagination parameter, so this is a partial list for the day.`;
    warn = true;
  }
  setEarningsStatus(msg, warn);
  if (diag) console.log('[earnings] pagination diagnostics:', diag);

  data.results.forEach((e, i) => earningsGrid.appendChild(renderYahooSessionCard(e, i + 1)));
}

/** Yahoo cards carry price rather than revenue — labelled so it's not confused. */
function renderYahooSessionCard(entry, rank) {
  const card = document.createElement('div');
  card.className = 'card compact';

  const hasPrice = typeof entry.price === 'number';

  card.innerHTML = `
    <div class="card-header">
      <div>
        <span class="rank">#${rank}</span>
        <span class="ticker">${escapeHtml(entry.ticker)}</span>
        <span class="time-badge">${escapeHtml(entry.time || 'N/A')}</span>
        <span class="company-name">${escapeHtml(entry.name || entry.ticker)}</span>
      </div>
    </div>
    <div class="card-price-row">
      <span class="price">${hasPrice ? `${escapeHtml(entry.currency || '')} ${fmt(entry.price)}` : `⚠️ ${escapeHtml(entry.error || 'Price unavailable')}`}</span>
    </div>
    <button class="view-detail-btn" ${hasPrice ? '' : 'disabled'}>+ Add 10-day chart to Search</button>
  `;

  const btn = card.querySelector('.view-detail-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    await loadTicker(entry.ticker, true);
    switchToView('search');
  });

  return card;
}

function renderSessionCard(e, rank) {
  const card = document.createElement('div');
  card.className = 'card compact';

  const rev = e.revenueActual ?? e.revenueEstimate;
  const revLabel = e.revenueActual !== null ? 'Revenue' : 'Revenue (est)';

  const surprise =
    e.epsSurprisePercent === null
      ? ''
      : ` <span class="${e.epsSurprisePercent >= 0 ? 'pos' : 'neg'}">(${e.epsSurprisePercent > 0 ? '+' : ''}${fmt(e.epsSurprisePercent)}%)</span>`;

  card.innerHTML = `
    <div class="card-header">
      <div>
        <span class="rank">#${rank}</span>
        <span class="ticker">${escapeHtml(e.ticker || '')}</span>
        ${e.reported ? '' : '<span class="pending">upcoming</span>'}
        <span class="company-name">${escapeHtml(e.name || '')}</span>
      </div>
    </div>
    <div class="reaction-row"><span>${revLabel}</span><span><strong>${fmtBig(rev)}</strong></span></div>
    <div class="reaction-row"><span>EPS actual / est</span><span>${fmt(e.epsActual)} / ${fmt(e.epsEstimate)}${surprise}</span></div>
    <div class="reaction-row"><span>Time (ET)</span><span>${escapeHtml(e.time || 'n/a')}${e.period ? ' · ' + escapeHtml(e.period) : ''}</span></div>
    <button class="view-detail-btn">+ Add 10-day chart to Search</button>
  `;

  const btn = card.querySelector('.view-detail-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    await loadTicker(e.ticker, true);
    switchToView('search');
  });

  return card;
}

async function loadEarnings() {
  const dateStr = earningsDateInput.value || todayYMD(0);
  earningsGrid.innerHTML = '';
  setEarningsStatus(`Loading earnings for ${dateStr}… this scans Yahoo Finance's calendar and can take a little while.`);

  try {
    const res = await fetch(`/api/earnings?date=${encodeURIComponent(dateStr)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Failed to load earnings for ${dateStr}`);
    }

    if (data.results.length === 0) {
      setEarningsStatus(`No earnings found for ${dateStr}.`);
      return;
    }

    let summary = `${data.totalFound} companies reporting on ${dateStr}`;
    if (data.capped) {
      summary += ` — showing the first ${data.returnedCount} (capped to keep load times reasonable; see README).`;
    } else {
      summary += ` — showing all ${data.returnedCount}.`;
    }
    setEarningsStatus(summary);

    data.results.forEach((entry) => renderEarningsCard(entry));
  } catch (err) {
    setEarningsStatus(`⚠️ ${err.message}`, true);
  }
}

function setEarningsStatus(msg, isWarning) {
  earningsStatus.textContent = msg;
  earningsStatus.className = 'status' + (isWarning ? ' warning' : '');
}

function renderEarningsCard(entry) {
  const card = document.createElement('div');
  card.className = 'card compact';

  const hasPrice = typeof entry.price === 'number';
  const priceLine = hasPrice
    ? `${escapeHtml(entry.currency || '')} ${fmt(entry.price)}`
    : `⚠️ ${escapeHtml(entry.error || 'Price unavailable')}`;

  card.innerHTML = `
    <div class="card-header">
      <div>
        <span class="ticker">${escapeHtml(entry.ticker)}</span>
        <span class="time-badge">${escapeHtml(entry.time || 'N/A')}</span>
        <span class="company-name">${escapeHtml(entry.name || entry.ticker)}</span>
      </div>
    </div>
    <div class="card-price-row">
      <span class="price">${priceLine}</span>
    </div>
    <button class="view-detail-btn" ${hasPrice ? '' : 'disabled'}>+ Add 10-day chart to Search</button>
    <div class="reaction-slot"></div>
  `;

  const detailBtn = card.querySelector('.view-detail-btn');
  detailBtn.addEventListener('click', async () => {
    detailBtn.disabled = true;
    detailBtn.textContent = 'Adding…';
    await loadTicker(entry.ticker, true);
    switchToView('search');
  });

  earningsGrid.appendChild(card);
  attachReactionButton(card, entry.ticker, { autoTrack: true });

  // If this ticker's panel was open before the last refresh, silently
  // re-open and re-fetch it now so auto-refresh doesn't lose your place.
  if (openReactionTickers.has(entry.ticker)) {
    const btn = card.querySelector('.reaction-btn');
    if (btn) btn.click();
  }
}

// ============================================================================
// EARNINGS REACTION — EPS beat/miss + pre/post-market move, on any card
// ============================================================================

/**
 * Adds a "📊 Check Result" button (+ empty slot for the result panel) to a
 * card. Works on both Search-view cards (which already have a
 * `.reaction-slot` div from renderCard) and Earnings-view cards.
 * `autoTrack: true` means this card lives in the Earnings Calendar view, so
 * its open/closed state is remembered across reloads and auto-refresh.
 */
function attachReactionButton(card, ticker, { autoTrack }) {
  let slot = card.querySelector('.reaction-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'reaction-slot';
    card.appendChild(slot);
  }

  const btn = document.createElement('button');
  btn.className = 'reaction-btn';
  btn.textContent = '📊 Check Result';
  slot.before(btn);

  let expanded = false;

  btn.addEventListener('click', async () => {
    if (expanded) {
      // Collapse.
      expanded = false;
      slot.innerHTML = '';
      btn.textContent = '📊 Check Result';
      if (autoTrack) openReactionTickers.delete(ticker);
      return;
    }

    expanded = true;
    btn.textContent = 'Loading…';
    slot.innerHTML = '<div class="reaction-box">Loading…</div>';
    if (autoTrack) openReactionTickers.add(ticker);

    try {
      const res = await fetch(`/api/earnings-reaction/${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to load result for ${ticker}`);

      renderReactionBox(slot, data);
      btn.textContent = '📊 Hide Result';

      if (autoTrack) {
        const prev = lastKnownReportedState.get(ticker);
        if (prev === false && data.hasReported === true) {
          card.classList.add('flash');
          setTimeout(() => card.classList.remove('flash'), 4000);
        }
        lastKnownReportedState.set(ticker, data.hasReported);
      }
    } catch (err) {
      slot.innerHTML = `<div class="reaction-box">⚠️ ${escapeHtml(err.message)}</div>`;
      btn.textContent = '📊 Hide Result';
    }
  });
}

function renderReactionBox(slot, data) {
  const v = data.verdict || { label: 'Neutral', emoji: '⚪' };
  const verdictClass = v.label.toLowerCase().split(' ')[0]; // 'bullish' | 'bearish' | 'mixed' | 'neutral' | 'awaiting'

  if (!data.hasReported) {
    slot.innerHTML = `
      <div class="reaction-box">
        <div class="reaction-verdict ${verdictClass}">${v.emoji} ${escapeHtml(v.label)}</div>
        <div class="reaction-row"><span>Latest quarter EPS not reported yet</span></div>
      </div>
    `;
    return;
  }

  const rows = [
    ['EPS Estimate', fmt(data.epsEstimate)],
    ['EPS Actual', fmt(data.epsActual)],
    ['Surprise', data.epsSurprisePercent === null ? '—' : `${data.epsSurprisePercent > 0 ? '+' : ''}${fmt(data.epsSurprisePercent)}%`],
    [`Price move (${escapeHtml(data.reactionLabel || 'session')})`, data.reactionChangePercent === null ? '—' : `${data.reactionChangePercent > 0 ? '+' : ''}${fmt(data.reactionChangePercent)}%`],
  ];

  slot.innerHTML = `
    <div class="reaction-box">
      <div class="reaction-verdict ${verdictClass}">${v.emoji} ${escapeHtml(v.label)}</div>
      ${rows.map(([label, val]) => `<div class="reaction-row"><span>${label}</span><span>${val}</span></div>`).join('')}
      <div class="reaction-disclaimer">Automated read of EPS beat/miss + price reaction — not financial advice.</div>
    </div>
  `;
}

// ============================================================================
// COUPONS VIEW
// ============================================================================
// Two halves:
//   1. Look up codes a merchant has published to an affiliate network
//      (needs a server-side API token — see coupons.js / README).
//   2. "My Saved Codes" — a purely local tracker where you record codes and
//      whether they actually worked. This half needs no API key and is the
//      honest substitute for automated validation, which isn't possible in
//      any general, legitimate way across arbitrary retailers.

const couponForm = document.getElementById('couponForm');
const storeInput = document.getElementById('storeInput');
const couponGrid = document.getElementById('couponGrid');
const couponStatus = document.getElementById('couponStatus');
const saveCouponForm = document.getElementById('saveCouponForm');
const savedGrid = document.getElementById('savedGrid');

/**
 * Show the lookup box only when the server actually has a token. Offering a
 * search that can only ever answer "not configured" reads as a broken app —
 * it isn't broken, it just has no data source, and the UI should say which.
 */
async function initCouponLookup() {
  const lookup = document.getElementById('couponLookup');
  const setup = document.getElementById('couponSetup');
  try {
    const res = await fetch('/api/coupons/status');
    const { configured } = await res.json();
    lookup.classList.toggle('hidden', !configured);
    setup.classList.toggle('hidden', configured);
  } catch (e) {
    // Server unreachable: show the explainer rather than a dead search box.
    lookup.classList.add('hidden');
    setup.classList.remove('hidden');
  }
}
initCouponLookup();

couponForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const store = storeInput.value.trim();
  if (!store) return;

  couponGrid.innerHTML = '';
  setCouponStatus(`Looking up published codes for "${store}"…`);

  try {
    const res = await fetch(`/api/coupons?store=${encodeURIComponent(store)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');

    if (!data.configured) {
      setCouponStatus(data.note, true);
      return;
    }
    if (data.coupons.length === 0) {
      setCouponStatus(`No currently-published codes found for "${store}" on ${data.provider}.`);
      return;
    }

    setCouponStatus(`${data.coupons.length} published code(s) for "${store}" via ${data.provider}.`);
    data.coupons.forEach((c) => couponGrid.appendChild(renderCouponCard(c)));
  } catch (err) {
    setCouponStatus(`⚠️ ${err.message}`, true);
  }
});

function setCouponStatus(msg, isWarning) {
  couponStatus.textContent = msg;
  couponStatus.className = 'status' + (isWarning ? ' warning' : '');
}

function renderCouponCard(c) {
  const card = document.createElement('div');
  card.className = 'card';

  card.innerHTML = `
    <div class="card-header">
      <span class="ticker">${escapeHtml(c.merchant || 'Merchant')}</span>
    </div>
    ${c.code ? `<div class="coupon-code"><code>${escapeHtml(c.code)}</code><button class="copy-btn">Copy</button></div>` : ''}
    <div class="coupon-meta">${escapeHtml(c.description)}</div>
    <div class="coupon-meta">${renderExpiry(c.endDate)}</div>
    ${c.terms ? `<div class="coupon-terms">${escapeHtml(c.terms)}</div>` : ''}
    ${c.url ? `<div class="card-footer"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">Open store →</a></div>` : ''}
  `;

  const copyBtn = card.querySelector('.copy-btn');
  if (copyBtn) attachCopy(copyBtn, c.code);
  return card;
}

/** Renders an expiry line, colour-coded by urgency. */
function renderExpiry(endDate) {
  if (!endDate) return 'No expiry date published.';
  const t = Date.parse(endDate);
  if (Number.isNaN(t)) return `Expires: ${escapeHtml(endDate)}`;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.round((t - startOfToday.getTime()) / 86400000);
  const dateStr = new Date(t).toISOString().slice(0, 10);

  if (days < 0) return `<span class="expiry expired">Expired ${dateStr}</span>`;
  if (days === 0) return `<span class="expiry soon">Expires today (${dateStr})</span>`;
  if (days <= 7) return `<span class="expiry soon">Expires in ${days} day(s) — ${dateStr}</span>`;
  return `<span class="expiry">Expires ${dateStr}</span>`;
}

function attachCopy(btn, code) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = 'Copied!';
    } catch (e) {
      // Clipboard API needs a secure context (https or localhost); if it's
      // unavailable just tell the user rather than failing silently.
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
}

// --------------------------- Saved codes (local) ---------------------------

saveCouponForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = {
    id: String(Date.now()),
    store: document.getElementById('saveStore').value.trim(),
    code: document.getElementById('saveCode').value.trim(),
    note: document.getElementById('saveNote').value.trim(),
    expiry: document.getElementById('saveExpiry').value || null,
    status: null, // 'worked' | 'failed' | null
    triedOn: null,
  };
  if (!entry.store || !entry.code) return;

  const saved = getSavedCoupons();
  saved.unshift(entry);
  setSavedCoupons(saved);
  saveCouponForm.reset();
  renderSavedCoupons();
});

function getSavedCoupons() {
  try {
    return JSON.parse(localStorage.getItem(COUPON_STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function setSavedCoupons(list) {
  localStorage.setItem(COUPON_STORAGE_KEY, JSON.stringify(list));
}

function updateSavedCoupon(id, changes) {
  const saved = getSavedCoupons().map((c) => (c.id === id ? { ...c, ...changes } : c));
  setSavedCoupons(saved);
  renderSavedCoupons();
}

function renderSavedCoupons() {
  const saved = getSavedCoupons();
  savedGrid.innerHTML = '';

  if (saved.length === 0) {
    savedGrid.innerHTML =
      '<p class="status">Nothing saved yet — add a code above to start tracking which ones actually work.</p>';
    return;
  }

  saved.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <span class="ticker">${escapeHtml(c.store)}</span>
        <button class="remove-btn" title="Delete">✕</button>
      </div>
      <div class="coupon-code"><code>${escapeHtml(c.code)}</code><button class="copy-btn">Copy</button></div>
      ${c.note ? `<div class="coupon-meta">${escapeHtml(c.note)}</div>` : ''}
      <div class="coupon-meta">${renderExpiry(c.expiry)}</div>
      <div class="status-row">
        <button class="status-btn worked ${c.status === 'worked' ? 'active' : ''}">✓ Worked</button>
        <button class="status-btn failed ${c.status === 'failed' ? 'active' : ''}">✗ Didn't work</button>
      </div>
      ${c.triedOn ? `<div class="tried-note">Last tried ${escapeHtml(c.triedOn)}</div>` : ''}
    `;

    attachCopy(card.querySelector('.copy-btn'), c.code);

    card.querySelector('.remove-btn').addEventListener('click', () => {
      setSavedCoupons(getSavedCoupons().filter((x) => x.id !== c.id));
      renderSavedCoupons();
    });

    const today = new Date().toISOString().slice(0, 10);
    card.querySelector('.status-btn.worked').addEventListener('click', () => {
      // Clicking the active state again clears it.
      const next = c.status === 'worked' ? null : 'worked';
      updateSavedCoupon(c.id, { status: next, triedOn: next ? today : null });
    });
    card.querySelector('.status-btn.failed').addEventListener('click', () => {
      const next = c.status === 'failed' ? null : 'failed';
      updateSavedCoupon(c.id, { status: next, triedOn: next ? today : null });
    });

    savedGrid.appendChild(card);
  });
}

// ============================================================================
// Auto-refresh (Earnings Calendar view only)
// ============================================================================
// Not true real-time push — it's a periodic poll while this tab stays open,
// bounded by the same rate-limit-friendly caps as everything else here (see
// README). Good enough to notice a result landing within a couple of
// minutes without you having to keep hitting reload.
const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

autoRefreshToggle.addEventListener('change', () => {
  if (autoRefreshToggle.checked) {
    autoRefreshTimer = setInterval(loadEarnings, AUTO_REFRESH_INTERVAL_MS);
  } else if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

// ============================================================================
// MACRO EVENTS BAR — CPI / jobs / FOMC, auto-rolling
// ============================================================================
// Always visible above the views. Past dates drop off automatically and the
// next month rolls in, so it never needs manual maintenance.

const KIND_ICON = { cpi: '📈', jobs: '👷', fomc: '🏛️' };

/** Renders one event row. */
function macroRow(e, isPast) {
  const when = isPast
    ? `${Math.abs(e.daysAway)}d ago`
    : e.daysAway === 0
    ? 'TODAY'
    : e.daysAway === 1
    ? 'TOMORROW'
    : `in ${e.daysAway}d`;
  const urgent = !isPast && e.daysAway <= 1;

  // 'estimated' entries are rule-derived, not from an official calendar —
  // flagged so a guess is never mistaken for a published date.
  const est =
    e.certainty === 'estimated'
      ? `<span class="macro-est" title="${escapeHtml(e.note || '')}">approx</span>`
      : '';

  const vals = [
    e.actual != null ? `actual <b>${escapeHtml(String(e.actual))}</b>` : null,
    e.consensus != null ? `est ${escapeHtml(String(e.consensus))}` : null,
    e.prior != null ? `prior ${escapeHtml(String(e.prior))}` : null,
  ].filter(Boolean).join(' · ');

  const dateLabel = new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });

  // Both zones in the tooltip — the source publishes ET, the UI shows CT.
  const tip = [e.note, e.timeET ? `(${e.timeET})` : null].filter(Boolean).join(' ');

  return `
    <div class="macro-item ${urgent ? 'urgent' : ''} ${isPast ? 'past' : ''}" title="${escapeHtml(tip)}">
      <span class="macro-icon">${KIND_ICON[e.kind] || '•'}</span>
      <span class="macro-when ${urgent ? 'urgent' : ''}">${when}</span>
      <span class="macro-name">${escapeHtml(e.name)}${est}</span>
      <span class="macro-date">${escapeHtml(dateLabel)}${e.time ? ' · ' + escapeHtml(e.time) : ''}</span>
      ${vals ? `<span class="macro-vals">${vals}</span>` : ''}
    </div>`;
}

async function loadMacroCalendar() {
  const list = document.getElementById('macroList');
  const pastList = document.getElementById('macroPast');
  const srcEl = document.getElementById('macroSource');
  list.textContent = 'Loading…';

  try {
    const res = await fetch('/api/macro-calendar');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to load');

    srcEl.textContent = d.source === 'benzinga' ? 'live · Benzinga' : 'built-in schedule';
    srcEl.title = d.sourceNote || '';

    list.innerHTML = d.upcoming.length
      ? d.upcoming.map((e) => macroRow(e, false)).join('')
      : '<span class="bz-note">No upcoming events found.</span>';

    if (pastList) {
      pastList.innerHTML = (d.recentlyPassed || []).length
        ? d.recentlyPassed.map((e) => macroRow(e, true)).join('')
        : '<span class="bz-note">Nothing recent.</span>';
    }
  } catch (err) {
    list.innerHTML = `<span class="error-msg">⚠️ ${escapeHtml(err.message)}</span>`;
  }
}

document.getElementById('macroRefresh').addEventListener('click', loadMacroCalendar);

// ============================================================================
// AVERAGE-DOWN CALCULATOR
// ============================================================================
// Pure arithmetic, entirely client-side. Nothing leaves the browser.
//
// THE MATH
//   You hold N shares at average cost C.  You buy X more at price P.
//   New average  A = (N·C + X·P) / (N + X)
//   Solving for X given a target average T:
//       T(N + X) = N·C + X·P
//       X(T − P) = N(C − T)
//       X = N(C − T) / (T − P)
//
// THE IMPORTANT PROPERTY: as T approaches P, the denominator approaches zero
// and X goes to INFINITY. You can never average all the way down to the
// current price by buying at that price — only get asymptotically closer.
// That's why the tool refuses impossible targets instead of printing a
// gigantic number, and why it also shows a table of realistic buy sizes.

const avgEls = {
  ticker: document.getElementById('avgTicker'),
  shares: document.getElementById('avgShares'),
  cost: document.getElementById('avgCost'),
  price: document.getElementById('avgPrice'),
  target: document.getElementById('avgTarget'),
  result: document.getElementById('avgResult'),
  fetchPrice: document.getElementById('avgFetchPrice'),
};

['shares', 'cost', 'price', 'target'].forEach((k) => {
  avgEls[k]?.addEventListener('input', renderAverageCalc);
});

// Convenience: pull the live price straight from the app's own stock route.
avgEls.fetchPrice?.addEventListener('click', async () => {
  const t = (avgEls.ticker.value || '').trim().toUpperCase();
  if (!t) return;
  avgEls.fetchPrice.textContent = '…';
  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(t)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Lookup failed');
    if (typeof d.currentPrice === 'number') {
      avgEls.price.value = d.currentPrice;
      renderAverageCalc();
    }
  } catch (e) {
    avgEls.result.innerHTML = `<div class="calc-warn">⚠️ ${escapeHtml(e.message)}</div>`;
  } finally {
    avgEls.fetchPrice.textContent = 'Use live price';
  }
});

function renderAverageCalc() {
  const N = parseFloat(avgEls.shares.value);
  const C = parseFloat(avgEls.cost.value);
  const P = parseFloat(avgEls.price.value);
  const Traw = parseFloat(avgEls.target.value);

  if (!(N > 0) || !(C > 0) || !(P > 0)) {
    avgEls.result.innerHTML =
      '<div class="calc-hint">Enter shares owned, your average cost, and the current price.</div>';
    return;
  }

  const currentValue = N * P;
  const currentCost = N * C;
  const unrealised = currentValue - currentCost;
  const unrealisedPct = (unrealised / currentCost) * 100;

  const parts = [];

  parts.push(`
    <div class="calc-block">
      <div class="calc-block-title">Position now</div>
      <div class="reaction-row"><span>${N} shares @ avg</span><span>$${fmt(C)}</span></div>
      <div class="reaction-row"><span>Cost basis</span><span>$${fmt(currentCost)}</span></div>
      <div class="reaction-row"><span>Market value @ $${fmt(P)}</span><span>$${fmt(currentValue)}</span></div>
      <div class="reaction-row"><span>Unrealised</span>
        <span class="${unrealised >= 0 ? 'pos' : 'neg'}">
          ${unrealised >= 0 ? '+' : ''}$${fmt(unrealised)} (${unrealised >= 0 ? '+' : ''}${fmt(unrealisedPct)}%)
        </span></div>
    </div>`);

  // --- Target-average solve -------------------------------------------------
  if (Number.isFinite(Traw) && Traw > 0) {
    if (P >= C) {
      parts.push(`<div class="calc-warn">
        The current price ($${fmt(P)}) is at or above your average ($${fmt(C)}), so buying more
        would raise your average, not lower it.</div>`);
    } else if (Traw <= P) {
      // The asymptote. Worth explaining rather than just rejecting.
      parts.push(`<div class="calc-warn">
        <strong>That target isn't reachable.</strong> Buying at $${fmt(P)} can only pull your average
        <em>toward</em> $${fmt(P)}, never to it or below — the required share count grows without
        limit as the target approaches the purchase price.
        Pick a target above $${fmt(P)} (and below your current $${fmt(C)}).</div>`);
    } else if (Traw >= C) {
      parts.push(`<div class="calc-warn">
        Your average is already $${fmt(C)}, which is below that target — nothing to do.</div>`);
    } else {
      // Always whole shares, rounded UP — so the resulting average lands
      // slightly below the target rather than above it.
      const X = (N * (C - Traw)) / (Traw - P);
      const shares = Math.ceil(X);
      const cost = shares * P;
      const actualAvg = (N * C + shares * P) / (N + shares);

      parts.push(`
        <div class="calc-block highlight">
          <div class="calc-block-title">To reach a $${fmt(Traw)} average</div>
          <div class="calc-big">Buy ${shares.toLocaleString()} shares</div>
          <div class="reaction-row"><span>Cost to buy @ $${fmt(P)}</span><span>$${fmt(cost)}</span></div>
          <div class="reaction-row"><span>Your new average</span><span>$${fmt(actualAvg)}</span></div>
          <div class="reaction-row"><span>Total position</span><span>${(N + shares).toLocaleString()} shares · $${fmt(currentCost + cost)}</span></div>
        </div>`);
    }
  }

  // --- "What if I buy X" table ---------------------------------------------
  // More useful than a single target in practice: shows what your money
  // actually buys you, and makes the diminishing returns obvious.
  if (P < C) {
    const steps = [
      Math.ceil(N * 0.25), Math.ceil(N * 0.5), N,
      N * 2, N * 3, N * 5, N * 10,
    ].filter((v, i, a) => v > 0 && a.indexOf(v) === i);

    const rows = steps
      .map((x) => {
        const newAvg = (N * C + x * P) / (N + x);
        const spend = x * P;
        const dropPct = ((C - newAvg) / C) * 100;
        return `<tr>
          <td>${x.toLocaleString()}</td>
          <td>$${fmt(spend)}</td>
          <td>$${fmt(newAvg)}</td>
          <td class="pos">−${fmt(dropPct)}%</td>
          <td>${(N + x).toLocaleString()}</td>
        </tr>`;
      })
      .join('');

    parts.push(`
      <div class="calc-block">
        <div class="calc-block-title">If you buy… (at $${fmt(P)})</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Buy</th><th>Costs</th><th>New avg</th><th>Avg drop</th><th>Total shares</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="calc-note">Notice the diminishing returns — each additional block of shares
        moves the average less than the one before, because the average can only approach
        $${fmt(P)} asymptotically.</div>
      </div>`);
  }

  parts.push(`<div class="reaction-disclaimer">
    Arithmetic only — it shows what the numbers do, not whether buying more is a good idea.
    Averaging down increases your exposure to a position that has fallen, which raises both
    the potential gain and the potential loss. Not financial advice.
  </div>`);

  avgEls.result.innerHTML = parts.join('');
}

// ============================================================================
// TRADE PLANNER — position sizing from risk
// ============================================================================
// WHY SIZE FROM RISK RATHER THAN FROM BUDGET
//
// "How many shares should I buy" has no answer from the price alone. The
// number that actually determines it is how much you're prepared to lose if
// the trade goes against you:
//
//     risk per share = entry − stop
//     shares         = (max $ you'll risk) / (risk per share)
//
// A tight stop lets you buy more shares for the same dollar risk; a wide stop
// forces fewer. That's the whole mechanism, and it's why the stop price is a
// required input rather than an afterthought.

const pEls = {
  ticker: document.getElementById('pTicker'),
  entry: document.getElementById('pEntry'),
  up: document.getElementById('pTargetUp'),
  stop: document.getElementById('pStop'),
  risk: document.getElementById('pRisk'),
  budget: document.getElementById('pBudget'),
  result: document.getElementById('plannerResult'),
  fetchPrice: document.getElementById('pFetchPrice'),
};

['entry', 'up', 'stop', 'risk', 'budget'].forEach((k) => {
  pEls[k]?.addEventListener('input', renderPlanner);
});

pEls.fetchPrice?.addEventListener('click', async () => {
  const t = (pEls.ticker.value || '').trim().toUpperCase();
  if (!t) return;
  pEls.fetchPrice.textContent = '…';
  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(t)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Lookup failed');
    if (typeof d.currentPrice === 'number') {
      pEls.entry.value = d.currentPrice;
      renderPlanner();
    }
  } catch (e) {
    pEls.result.innerHTML = `<div class="calc-warn">⚠️ ${escapeHtml(e.message)}</div>`;
  } finally {
    pEls.fetchPrice.textContent = 'Use live price';
  }
});

function renderPlanner() {
  const E = parseFloat(pEls.entry.value);
  const U = parseFloat(pEls.up.value);
  const S = parseFloat(pEls.stop.value);
  const R = parseFloat(pEls.risk.value);
  const B = parseFloat(pEls.budget.value);

  if (!(E > 0)) {
    pEls.result.innerHTML = '<div class="calc-hint">Enter an entry price to begin.</div>';
    return;
  }

  const parts = [];

  // Sanity checks — these catch inputs that would produce nonsense.
  if (Number.isFinite(S) && S >= E) {
    parts.push(`<div class="calc-warn">Your stop ($${fmt(S)}) must be <em>below</em> your
      entry ($${fmt(E)}) — otherwise it isn't a stop loss.</div>`);
  }
  if (Number.isFinite(U) && U <= E) {
    parts.push(`<div class="calc-warn">Your target ($${fmt(U)}) must be <em>above</em> your
      entry ($${fmt(E)}) for a long position.</div>`);
  }

  const validStop = Number.isFinite(S) && S > 0 && S < E;
  const validUp = Number.isFinite(U) && U > E;

  if (validStop) {
    const riskPerShare = E - S;
    const rewardPerShare = validUp ? U - E : null;

    // --- Size from risk ----------------------------------------------------
    if (R > 0) {
      let shares = Math.floor(R / riskPerShare);
      let cappedBy = null;

      // A budget cap can bind before the risk limit does.
      if (B > 0 && shares * E > B) {
        shares = Math.floor(B / E);
        cappedBy = 'budget';
      }

      if (shares < 1) {
        parts.push(`<div class="calc-warn">
          At $${fmt(riskPerShare)} of risk per share, a $${fmt(R)} limit doesn't cover even one
          share. Either widen the risk limit, or move the stop closer to your entry.</div>`);
      } else {
        const cost = shares * E;
        const maxLoss = shares * riskPerShare;
        const maxGain = rewardPerShare !== null ? shares * rewardPerShare : null;

        parts.push(`
          <div class="calc-block highlight">
            <div class="calc-block-title">Position size</div>
            <div class="calc-big">Buy ${shares.toLocaleString()} shares</div>
            <div class="reaction-row"><span>Cost at $${fmt(E)}</span><span>$${fmt(cost)}</span></div>
            <div class="reaction-row"><span>Risk per share</span><span>$${fmt(riskPerShare)} (entry − stop)</span></div>
            <div class="reaction-row"><span>Max loss if stopped at $${fmt(S)}</span><span class="neg">−$${fmt(maxLoss)}</span></div>
            ${maxGain !== null ? `<div class="reaction-row"><span>Gain if target $${fmt(U)} hits</span><span class="pos">+$${fmt(maxGain)}</span></div>` : ''}
            ${cappedBy ? `<div class="calc-note">Limited by your $${fmt(B)} spend cap, not the risk
              limit — actual risk here is only $${fmt(maxLoss)}.</div>` : ''}
          </div>`);
      }
    } else {
      parts.push(`<div class="calc-hint">Add "Max you'll risk ($)" to get a share count.</div>`);
    }

    // --- Risk / reward -----------------------------------------------------
    if (validUp) {
      const rr = (U - E) / (E - S);
      // With a reward:risk of R, you need to win more than 1/(1+R) of the
      // time just to break even. This is the number most people skip.
      const breakevenWin = (1 / (1 + rr)) * 100;
      const rrClass = rr >= 2 ? 'pos' : rr >= 1 ? '' : 'neg';

      parts.push(`
        <div class="calc-block">
          <div class="calc-block-title">Risk / reward</div>
          <div class="reaction-row"><span>Upside to $${fmt(U)}</span><span class="pos">+$${fmt(U - E)}/share (+${fmt(((U - E) / E) * 100)}%)</span></div>
          <div class="reaction-row"><span>Downside to $${fmt(S)}</span><span class="neg">−$${fmt(E - S)}/share (−${fmt(((E - S) / E) * 100)}%)</span></div>
          <div class="reaction-row"><span>Reward : risk</span><span class="${rrClass}"><strong>${fmt(rr)} : 1</strong></span></div>
          <div class="reaction-row"><span>Win rate needed to break even</span><span>${fmt(breakevenWin)}%</span></div>
          <div class="calc-note">
            At ${fmt(rr)}:1, you'd need to be right more than <strong>${fmt(breakevenWin)}%</strong> of the
            time for this setup to make money over many trades. A good ratio doesn't help if the
            target is unrealistic — the ratio is only as honest as the two prices you picked.
          </div>
        </div>`);
    }
  }

  // --- Outcome grid --------------------------------------------------------
  if (validStop && R > 0) {
    const shares = Math.max(1, Math.floor((B > 0 ? Math.min(R / (E - S), B / E) : R / (E - S))));
    const lo = validUp ? S : E * 0.8;
    const hi = validUp ? U : E * 1.2;
    const points = [lo, lo + (E - lo) / 2, E, E + (hi - E) / 2, hi];

    const rows = points
      .map((p) => {
        const pl = shares * (p - E);
        const pct = ((p - E) / E) * 100;
        return `<tr>
          <td>$${fmt(p)}</td>
          <td class="${pct >= 0 ? 'pos' : 'neg'}">${pct >= 0 ? '+' : ''}${fmt(pct)}%</td>
          <td class="${pl >= 0 ? 'pos' : 'neg'}">${pl >= 0 ? '+' : '−'}$${fmt(Math.abs(pl))}</td>
          <td>$${fmt(shares * p)}</td>
        </tr>`;
      })
      .join('');

    parts.push(`
      <div class="calc-block">
        <div class="calc-block-title">If the price ends up at… (${shares.toLocaleString()} shares)</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Price</th><th>Move</th><th>P&amp;L</th><th>Position value</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }

  parts.push(`<div class="reaction-disclaimer">
    Arithmetic only. It sizes the position from the numbers you supply — it can't tell you
    whether your target or stop are realistic, and that's the part that decides whether the
    trade works. Stops can also be skipped through on gaps, so the "max loss" is not
    guaranteed. Not financial advice.
  </div>`);

  pEls.result.innerHTML = parts.join('');
}

// ============================================================================
// MOVERS SCANNER
// ============================================================================

let moversUniverse = 'top100';
// After-hours by default — that's the session most worth scanning, since
// earnings land there and the move is already visible before the next open.
let moversSession = 'post';

document.querySelectorAll('.universe-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.universe-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    moversUniverse = b.dataset.universe;
  });
});

document.querySelectorAll('.msession-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.msession-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    moversSession = b.dataset.session;
  });
});

document.getElementById('moversScan')?.addEventListener('click', scanMoversUI);

const SESSION_TEXT = {
  PRE: 'pre-market', PREPRE: 'pre-market',
  POST: 'after-hours', POSTPOST: 'after-hours',
  REGULAR: 'market open', CLOSED: 'market closed',
};

const SESSION_ASKED = {
  post: 'after-hours', pre: 'pre-market', regular: 'regular session', auto: 'auto',
};

async function scanMoversUI() {
  const btn = document.getElementById('moversScan');
  const status = document.getElementById('moversStatus');
  const up = document.getElementById('moversUp');
  const down = document.getElementById('moversDown');
  const minMove = document.getElementById('moversMinMove').value;

  up.innerHTML = '';
  down.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  const count = moversUniverse === 'sp500' ? '~500' : '100';
  status.className = 'status';
  status.textContent = `Scanning ${count} tickers for ${SESSION_ASKED[moversSession]} moves… takes a few seconds (one request per ticker).`;

  try {
    const res = await fetch(
      `/api/movers?universe=${encodeURIComponent(moversUniverse)}` +
      `&session=${encodeURIComponent(moversSession)}` +
      // limit=500 = the whole universe. "Show me everything moving" has to
      // actually mean everything, not a quiet top-30.
      `&minMove=${encodeURIComponent(minMove)}&limit=500`
    );
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Scan failed');

    const live = SESSION_TEXT[d.marketState] || d.marketState || 'unknown';
    document.getElementById('moversSession').textContent =
      d.session === 'auto'
        ? `auto → ${live}`
        : `${SESSION_ASKED[d.session]} · market now: ${live}`;

    // Three different "no results" causes, and they need different fixes:
    // nothing moved (lower the threshold), no post-market print exists yet
    // (wrong time of day), or the requests failed (rate limiting).
    const thresh = d.minMove > 0 ? `moving ≥${d.minMove}%` : 'moving at all';
    let msg = `${d.quoted} of ${d.scanned} quoted · ${d.moversFound} ${thresh} · ${(d.elapsedMs / 1000).toFixed(1)}s`;
    if (d.flat) msg += ` · ${d.flat} flat`;
    if (d.failed) msg += ` · ${d.failed} failed`;
    if (d.staleCount) msg += ` · ${d.staleCount} from an earlier session`;
    if (d.truncated) msg += ` · list capped at ${d.limit} per side`;

    if (d.moversFound === 0) {
      if (d.noFigure > d.scanned * 0.5 && d.session !== 'auto') {
        msg += ` — ${d.noFigure} tickers have no ${SESSION_ASKED[d.session]} price yet` +
               ` (market is currently ${live}). Try Auto, or scan again after the close.`;
      } else if (d.minMove > 0) {
        msg += ' — nothing moved that much. Set "Any move" to see everything.';
      } else {
        msg += ' — every quoted ticker printed flat.';
      }
    }
    status.textContent = msg;
    if (d.failed > d.scanned * 0.3) {
      status.className = 'status warning';
      status.textContent += ' ⚠ High failure rate — Yahoo may be rate-limiting.';
    }

    document.getElementById('moversUpHead').textContent =
      `🟢 Up (${d.gainers.length})`;
    document.getElementById('moversDownHead').textContent =
      `🔴 Down (${d.losers.length})`;

    up.innerHTML = d.gainers.length
      ? d.gainers.map(moverRow).join('')
      : '<span class="bz-note">Nothing up.</span>';
    down.innerHTML = d.losers.length
      ? d.losers.map(moverRow).join('')
      : '<span class="bz-note">Nothing down.</span>';

    // Clicking a mover pulls it into the Search view for a closer look.
    document.querySelectorAll('.mover-item').forEach((el) => {
      el.addEventListener('click', async () => {
        await loadTicker(el.dataset.ticker, true);
        switchToView('search');
      });
    });
  } catch (err) {
    status.className = 'status warning';
    status.textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan now';
  }
}

function moverRow(m) {
  const cls = m.changePct >= 0 ? 'pos' : 'neg';
  const sign = m.changePct >= 0 ? '+' : '';
  // A stale flag matters: an after-hours print from last night is real data,
  // but presenting it as "moving now" would be a lie by omission.
  const stale = m.stale
    ? `<span class="mover-stale" title="Last print was ${ageText(m.ageMins)} ago — earlier session, not live">⏱ ${ageText(m.ageMins)} old</span>`
    : '';
  return `
    <div class="macro-item mover-item${m.stale ? ' is-stale' : ''}" data-ticker="${escapeHtml(m.ticker)}" title="Click to open in Search">
      <span class="mover-tick">${escapeHtml(m.ticker)}</span>
      <span class="mover-chg ${cls}">${sign}${fmt(m.changePct)}%</span>
      <span class="mover-name">${escapeHtml(m.name)}${stale}</span>
      <span class="macro-date">$${fmt(m.price)}<span class="mover-sess">${escapeHtml(m.session)}</span></span>
    </div>`;
}

function ageText(mins) {
  if (typeof mins !== 'number') return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ============================================================================
// Startup
// ============================================================================
(function init() {
  earningsDateInput.value = todayYMD(0);
  renderSavedCoupons();
  loadMacroCalendar();

  const saved = getSavedTickers();
  if (saved.length === 0) {
    setStatus('Search a ticker above to add your first card (e.g. AAPL, MSFT, TSLA), or switch to "Earnings Calendar" to browse by date.');
  } else {
    saved.forEach((t) => loadTicker(t, false));
  }
})();
