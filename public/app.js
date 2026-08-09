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
 * Previously searched tickers are remembered in the browser's localStorage
 * so they reload automatically next time you open the page (this is a
 * normal local web app running in your own browser, not a Claude artifact,
 * so localStorage is fine here).
 */

const STORAGE_KEY = 'stockWatch.tickers';

const menuBtns = document.querySelectorAll('.menu-btn');
const views = {
  search: document.getElementById('searchView'),
  earnings: document.getElementById('earningsView'),
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
    <div class="card-footer">${escapeHtml(data.exchange || '')}</div>
  `;

  attachRemove(card, data.ticker);
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

function todayYMD(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.toISOString().slice(0, 10);
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
  `;

  const detailBtn = card.querySelector('.view-detail-btn');
  detailBtn.addEventListener('click', async () => {
    detailBtn.disabled = true;
    detailBtn.textContent = 'Adding…';
    await loadTicker(entry.ticker, true);
    switchToView('search');
  });

  earningsGrid.appendChild(card);
}

// ============================================================================
// Startup
// ============================================================================
(function init() {
  earningsDateInput.value = todayYMD(0);

  const saved = getSavedTickers();
  if (saved.length === 0) {
    setStatus('Search a ticker above to add your first card (e.g. AAPL, MSFT, TSLA), or switch to "Earnings Calendar" to browse by date.');
  } else {
    saved.forEach((t) => loadTicker(t, false));
  }
})();
