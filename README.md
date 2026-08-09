# Stock Watch — local server + 10-day EOD stock cards + earnings calendar

A small local web app with two views, switched from the menu at the top:

- **🔍 Search Ticker** — search any ticker and get a card with the current
  price and the last 10 daily end-of-day (EOD) price bars
  (open/high/low/close/volume), plus a mini trend sparkline. Add as many
  tickers as you want — each becomes its own card. Your searched tickers
  are remembered (in your browser) so they reload automatically next time
  you open the page.
- **📅 Earnings Calendar** — pick a date ("Today" / "Tomorrow" / any custom
  date) and see a card for every company Yahoo Finance lists as reporting
  earnings that day, each showing its current price and BMO/AMC/TNS call
  time. Click "+ Add 10-day chart to Search" on any card to pull it into
  the Search view with full 10-day detail.

## Requirements

- [Node.js](https://nodejs.org) version 18 or newer (has built-in `fetch`,
  which this app relies on). Check with `node -v`.

## Run it

```bash
cd stock-cards-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

To use a different port:

```bash
PORT=8080 npm start
```

(On Windows Command Prompt: `set PORT=8080 && npm start`; PowerShell:
`$env:PORT=8080; npm start`.)

## How it works

- `server.js` is a small Express server serving the static frontend from
  `public/`, plus two API routes:
  - `GET /api/stock/:ticker` → fetches
    `https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1mo&interval=1d`,
    keeps the most recent 10 complete trading days, and returns clean JSON
    (ticker, company name, current price, 10-day % change, and the 10
    daily bars).
  - `GET /api/earnings?date=YYYY-MM-DD` → scrapes Yahoo Finance's earnings
    calendar page for that date (see `earnings.js`), then fetches a
    current price for every ticker found and returns them all as JSON.
    Defaults to today if `date` is omitted.
- `earnings.js` handles the earnings-calendar scraping specifically —
  Yahoo doesn't expose a clean JSON API for "who's reporting today", so
  this parses the calendar page's HTML with a scoped regular expression
  (same technique used in the companion Google Apps Script version of this
  project).
- `public/index.html` + `public/app.js` + `public/style.css` are the
  frontend: a menu to switch between the Search view and the Earnings
  Calendar view, each rendering results as cards.
- Nothing is stored server-side — the only persistence is your browser's
  `localStorage`, which just remembers which tickers you searched in the
  Search view so the page repopulates them on reload. Clearing your
  browser data resets that.

## Deploying online (so you can access it from anywhere, not just localhost)

The app is already deploy-ready — it reads its port from `process.env.PORT`
(most hosts set this automatically), so no code changes are needed.
Easiest free option as of 2026 is **Render**, which has a real free tier for
small Node apps and doesn't require any command line. Steps:

**1. Put the code on GitHub (no git command line needed):**
- Create a free account at [github.com](https://github.com) if you don't
  have one.
- Click **New repository**, give it a name (e.g. `stock-watch`), keep it
  Public or Private, and create it.
- On the repo page, click **Add file → Upload files**, then drag in
  everything from the `stock-cards-app` folder *except* the
  `node_modules` folder (skip that one — it's large and Render rebuilds
  it automatically; the included `.gitignore` reminds you why it's there
  if you do use real git later). Commit the upload.

**2. Deploy it on Render:**
- Create a free account at [render.com](https://render.com) and sign in
  with GitHub.
- Click **New → Web Service**, pick the `stock-watch` repo you just
  created.
- Settings:
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Instance Type:** Free
- Click **Create Web Service**. Render installs everything and starts the
  app — after a minute or two you'll get a public URL like
  `https://stock-watch.onrender.com` that works from any device, anywhere.

**Free-tier caveat:** Render's free web services spin down after ~15
minutes of no traffic and take 30-60 seconds to "wake up" on the next
visit (you'll just see a loading page briefly, then it works normally).
If you want it always-on with no cold starts, Render's cheapest paid tier
(around $7/month) removes that, or you can self-host on any VPS.

**Alternative: your own VPS (DigitalOcean, AWS EC2, etc.)** if you want
full control:
- Copy the folder to the server, run `npm install && npm start`.
- Use a process manager like [PM2](https://pm2.keymetrics.io/) so it
  restarts automatically / survives reboots
  (`pm2 start server.js --name stock-watch`).
- Put it behind a reverse proxy (nginx/Caddy) for a domain name and HTTPS.

## Assumptions / limitations (please read)

- **Yahoo Finance has no official public API.** The chart endpoint used
  here is unofficial and undocumented — it was verified by fetching it
  live while building this app, but Yahoo can change its response shape
  or start rate-limiting/blocking requests at any time without notice.
  The server sends a realistic browser `User-Agent` header to reduce that
  risk, and every ticker request has error handling so a bad response
  shows a friendly error on that one card instead of crashing the app.
- **"10 days" means the 10 most recent trading days with data**, not
  calendar days — weekends and market holidays are automatically skipped
  since the underlying data source simply doesn't have bars for those
  days.
- **Ticker symbols must match Yahoo Finance's own symbol format**
  (e.g. `BRK-B` for Berkshire Hathaway B shares, `VWCE.DE` for a
  Germany-listed ETF, `^GSPC` for the S&P 500 index). If a ticker returns
  "No data found," double-check the symbol on
  [finance.yahoo.com](https://finance.yahoo.com) first.
- **No API key or paid data subscription required** — but also no
  guaranteed uptime/SLA, since it's built on a free unofficial source.
  For anything beyond personal/local use, consider a licensed market-data
  API instead.
- **Earnings Calendar view — pagination and volume caps.** Some single
  days have 400-600+ companies reporting earnings. Yahoo's calendar page
  only fully renders a first "page" of results server-side; the rest
  normally loads through their internal client-side UI, which isn't a
  clean API. `earnings.js` tries the classic `offset`/`size` query
  parameters to page through more results, stopping automatically once a
  "page" returns nothing new. Separately, `MAX_EARNINGS_TICKERS` in
  `server.js` (default 150) caps how many tickers get priced per request,
  to keep load times reasonable and avoid hammering Yahoo — the response
  tells you `totalFound` vs `returnedCount` so you know if it was capped.
  On very high-volume days you may only see a subset (Yahoo's default
  ordering tends to surface the largest-market-cap companies first).
  Both numbers are easy to change in `server.js`/`earnings.js` if you want
  to try to capture more.
