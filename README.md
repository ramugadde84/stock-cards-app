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

- **🔥 Movers** — scans S&P 500 tickers and lists only the ones actually
  moving. **Defaults to 🌙 After-hours**, which stays pinned to the
  post-market tape whatever the clock says — so last night's earnings
  reaction is still there when you check at 9am. Switch to 🌅 Pre-market,
  ☀️ Regular, or 🕒 Auto (follow whichever session is live). Pick **Top 100**
  (~100 tickers, a few seconds) or **Full S&P 500** (~500, slower), set a
  minimum move (default 1%), and hit **Scan now**. Gainers and losers show
  side by side, biggest move first; click any row to open it in Search.
  Prints from an earlier session are labelled with their age rather than
  passed off as live. See "Movers — how the session is chosen" below.

- **🏷️ Coupons** — look up promo codes a merchant has published to an
  affiliate network, plus a local tracker for saving codes you find
  anywhere and recording whether they actually worked. See
  "Coupons — what this can and can't do" below, which is worth reading
  before you expect too much of it.

Both the stock views also have a **📊 Check Result** button on every card: it shows
the latest quarter's EPS estimate vs. actual, the surprise %, the
pre-market/after-hours/regular-session price move, and a simple
Bullish/Bearish/Mixed label based on those two facts. In the Earnings
Calendar view there's also an **Auto-refresh** toggle that polls every 2
minutes and flashes any open card the moment its result comes in — see
"Assumptions / limitations" for what "immediate" actually means here.

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
  - `GET /api/coupons?store=NAME` → looks up merchant-published promo codes
    via an affiliate network (see `coupons.js`). Returns
    `{ configured: false, note }` rather than an error when no API token is
    set, so the feature degrades gracefully.
  - `GET /api/earnings-reaction/:ticker` → calls Yahoo's `quoteSummary`
    endpoint (`earningsHistory` + `price` modules) to get the most recent
    quarter's EPS estimate/actual/surprise plus pre-market, regular, and
    after-hours price moves, and computes a Bullish/Bearish/Mixed/Neutral
    label from EPS beat-or-miss combined with the relevant session's price
    reaction.
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

## Benzinga integration (licensed data)

Every card in the Search view has a **🐂🐻 Bull / Bear (Benzinga)** button.
Unlike the Yahoo endpoints this app uses elsewhere — which are unofficial and
undocumented — Benzinga is a real licensed API, so the data is authoritative
and the response shapes are stable.

**Never hardcode your API key.** It's a billable credential. Pass it via the
environment:

```bash
# macOS / Linux
BENZINGA_API_KEY=bz.xxxxxxxx npm start

# Windows CMD
set BENZINGA_API_KEY=bz.xxxxxxxx && npm start

# Windows PowerShell
$env:BENZINGA_API_KEY="bz.xxxxxxxx"; npm start
```

The included `.gitignore` already excludes `.env`, so if you prefer a file,
put it there rather than in source. If a key ever gets pasted somewhere
public (chat, a screenshot, a commit), regenerate it immediately.

**What the panel pulls** (`GET /api/benzinga/:ticker`):

| Dataset | Endpoint | What it gives you |
|---|---|---|
| Bull / Bear cases | `/api/v1/bulls_bears_say` | Benzinga's own written bull and bear arguments |
| Earnings | `/api/v2.1/calendar/earnings` | EPS + revenue actual vs. estimate, surprise % |
| Why Is It Moving | `/api/v2/news` (WIIM channel) | One-line reasons for today's move |
| Analyst ratings | `/api/v2/calendar/ratings` | Upgrades/downgrades, price target changes |
| News | `/api/v2/news` | Recent headlines |

**Each dataset is fetched independently and reports its own `ok`/`error`.**
Benzinga licenses products individually, so one key doesn't necessarily
unlock everything — this design means an unlicensed dataset shows a note in
its own section instead of breaking the whole panel. Practical side effect:
run it once on any ticker and the panel tells you exactly which products
your key covers. A `403` in a section means "not in your license."

**About the verdict label:** it's a mechanical read of beat/miss only — EPS
vs. consensus and revenue vs. consensus, nothing more. It is not a
prediction and not advice. The Benzinga bull/bear text shown underneath is
the actual analysis; read that rather than the label.

### WebSocket tester UI (`public/ws-tool.html`)

A browser-based tester for any `wss://` endpoint. Start the server and open:

```
http://localhost:3000/ws-tool.html
```

**Why browser rather than a Node script:** Node's `fetch()` and `WebSocket`
do not use the Windows system proxy and ignore `HTTP_PROXY`. On a corporate
network that means the identical URL works in Chrome and fails from a
script. This tool uses the browser's own stack, so if the endpoint is
reachable at all, this reaches it — which makes it the fastest way to tell
"my token/licence is wrong" apart from "my local Node setup can't get out."

Features: stream presets, token field (masked, and never written to the log
or URL preview), `ping`/`replay` buttons, pretty-printed JSON log, live
message counter, and plain-English explanations of close codes.

Open it from `http://localhost:3000/...`, not by double-clicking the file —
browsers block `wss://` from `file://` origins. The tool warns you if you do.

### Real-time WebSocket streams (`bz-stream.js`)

Benzinga also pushes data over WebSocket (`wss://`) — a persistent
connection where events arrive the moment they happen, instead of polling.
`bz-stream.js` is a standalone tester for it:

```bash
# Windows CMD
set BENZINGA_API_KEY=bz.xxxx && node bz-stream.js

# optional: pick tickers and which stream
node bz-stream.js AAPL,TSLA news
```

Streams available per their docs (licence permitting): `bulls_bears_say`,
`calendar/earnings`, `calendar/ratings`, `consensus_ratings`, `news`,
`transcripts`.

**Node version note:** global `WebSocket` only exists in Node 22+. On Node
20 or older you'll get `ReferenceError: WebSocket is not defined` — the
script now falls back to the `ws` package automatically, so just run
`npm install` once and it works. It prints which implementation it's using
on startup.

**Silence is not failure.** These streams only push when an event occurs,
and bull/bear updates and earnings are infrequent. `✓ Connected` followed by
nothing means it's working. Test against `news` first — it's the busiest
stream, so it proves data is actually flowing.

**Close code 1006** on connect usually means a rejected token or a stream
your licence doesn't cover. The script explains the common codes rather than
leaving you with a bare number, and it redacts the token from its own output
so you can paste terminal logs safely.

## Movers — how the session is chosen

`movers.js` scans a ticker list and returns only names moving more than your
threshold **in the session you asked for**. That distinction is the whole
point of the module. Yahoo carries three separate change figures per ticker,
and reading the wrong one gives you a confidently wrong answer at exactly the
moment you care: at 6pm, `regularMarketChangePercent` is the 3pm close, not
the earnings reaction you opened the tab to see.

### Forcing after-hours (the default)

`session=post` pins the scan to the post-market figure **regardless of the
clock**. This is deliberate. Auto-mode is correct in the evening, but at 9am
it switches to the pre-market tape — and if what you want is "which names
moved on last night's earnings", auto quietly gives you a different number.
Forcing the session means you always know which tape you're reading.

The trade-off: if you force after-hours at 11am, most tickers have no
post-market print at all. Those are counted as `noFigure`, and the status
line says "no after-hours price yet (market is currently market open)" rather
than the misleading "nothing is moving".

**Stale prints are labelled, not hidden.** Force after-hours at 9am and the
data is real but ~14 hours old. Each row carries `ageMins`, and anything past
4 hours (`MOVERS_STALE_MINS`) gets a `⏱ 14h old` badge. Dropping those rows
would be worse — last night's move is usually the thing you're looking for —
but presenting them as live movement would be a lie.

### Session → figure mapping (`session=auto`)

Auto reads `marketState` and picks to match:

| `marketState`    | Figure used                 | Shown as      |
|------------------|-----------------------------|---------------|
| `PRE` / `PREPRE` | `preMarketChangePercent`    | pre-market    |
| `POST`/`POSTPOST`| `postMarketChangePercent`   | after-hours   |
| `REGULAR`        | `regularMarketChangePercent`| regular       |
| `CLOSED`         | most recent extended print  | after-hours   |

If Yahoo returns the prices but omits the percentage fields (it isn't
consistent about this across symbols), the move is derived from the prices
instead — extended-hours moves against the regular close, the regular move
against the previous close. Without that fallback those tickers would just
vanish from the scan, which looks identical to "it isn't moving."

**The minimum move defaults to "Any move (all)"** — every ticker that moved
at all is listed, biggest first, with no cap. Names printing exactly 0.00%
are excluded and counted separately as `flat`, because a stock that didn't
move isn't a mover; without that the list would just be the universe again.

Raise the threshold only when the list gets noisy. In quiet extended hours a
lot of names print ±0.05% on almost no volume, and at that point 1–3% makes
the real moves easier to see. Either way `quoted`, `flat` and `moversFound`
are all reported, so "0 movers" reads as a quiet tape rather than a broken
scan. If a list ever is cut short, `truncated` is set and the status line
says so — it will not silently show you a top-30 and call it everything.

**Why it takes a few seconds.** Yahoo's batch quote endpoint now generally
wants a session crumb, which is brittle to reproduce, so this uses the chart
endpoint — one request per ticker, issued 25 at a time with a short pause.
Top 100 is the default for that reason; the full 500 works but is slower.
Tune with `MOVERS_BATCH_SIZE` and `MOVERS_BATCH_PAUSE` if you want.

**The ticker list drifts.** `sp500.js` is a snapshot. Index membership changes
several times a year, so it will gradually go stale. Fine for "what's moving
tonight"; not an authoritative constituent list. Replace the array to refresh.

Endpoint:
`GET /api/movers?universe=top100|sp500&session=post|pre|regular|auto&minMove=1&limit=30`

`minMove=0` means "everything that moved"; `limit=500` means no cap.

Response fields worth knowing: `session` (what you asked for) vs
`marketState` (what's actually live), `quoted`, `noFigure` (no print for that
session), `flat` (quoted but unchanged), `moversFound`, `staleCount`,
`truncated`, `failed`.

Offline tests (no network needed): `node movers-test.js` — 64 checks covering
forced sessions, the no-data-for-this-session case, staleness flagging,
zero-threshold "all movers" behaviour, flat-ticker exclusion, truncation
reporting, session picking, the derived-percentage fallback, sorting,
partial failures, and bad input.

## Coupons — what this can and can't do

**The honest summary: there is no legitimate, general way to write code that
verifies an arbitrary promo code works on an arbitrary store.** The only real
test is running that retailer's checkout with the code applied, and that:

- is completely different on every store, so it can't be generalised;
- is explicitly prohibited by most retailers' terms of service;
- trips bot detection and rate limiting almost immediately; and
- looks identical to card-testing fraud from the retailer's side, which can
  get an IP or account blocked.

So this feature deliberately does **not** try to auto-test codes. It does the
two things that *are* legitimate and useful:

**1. Merchant-published lookup (needs a free API token).**
Retailers publish their own current promotions — with real start and end
dates — to affiliate networks. That's the merchant as the source of truth,
which is far more reliable than crowd-sourced coupon-site listings. The app
queries one of those networks and filters out anything already expired.

### Step-by-step: turning the lookup on (Rakuten, the default)

This is the only part that needs setup, and the approval step is the slow
bit — usually a few days, and applications do get rejected.

1. **Register as a publisher** at
   [signup.linkshare.com](https://signup.linkshare.com/publishers/registration/landing?ls-locale=us&host=linkshare).
   You'll be asked for the site or app that will show the offers. This is a
   real review, not a formality — "personal project" applications are
   sometimes declined, and there's no way around that from the code side.

2. **Apply to individual advertisers.** This is the part most people miss:
   an approved publisher account gets you into the network, but the coupon
   feed only ever contains merchants you have an *approved partnership with*.
   A brand-new account with zero partnerships returns an empty feed — which
   is working correctly, just empty. Apply to the specific stores you care
   about from the Advertisers tab and wait for each to approve you.

3. **Create an API credential** in the
   [Developer Portal](https://developers.rakutenadvertising.com/) →
   Account → Applications. Copy the **Client ID** and **Client Secret**.
   Then get your **SID** from the top right of the publisher dashboard —
   this is a different value from the Client ID, and mixing them up is the
   usual cause of a 401.

4. **Put all three in `.env`** next to `server.js`:

   ```
   COUPON_PROVIDER=rakuten
   COUPON_CLIENT_ID=your_client_id
   COUPON_CLIENT_SECRET=your_client_secret
   COUPON_SCOPE_ID=your_sid
   ```

   No quotes, no spaces around `=`, no trailing space (values are trimmed
   defensively anyway). Then `npm start`.

   Rakuten doesn't issue a permanent API key — those three are exchanged for
   a short-lived bearer token at `api.linksynergy.com/token`. The app does
   that automatically, caches the token, refreshes it a minute before expiry,
   collapses concurrent requests into a single exchange, and retries once if
   a token dies mid-request. You set it up once and don't think about it
   again. `COUPON_API_TOKEN` still works if you'd rather paste a token
   directly, but it will expire and can't be refreshed.

5. **Search a store** in the 🏷️ Coupons tab. If you aren't partnered with
   that merchant, the app now says so explicitly and lists the merchants you
   *do* have available, rather than showing a bare empty result.

Other supported networks: set `COUPON_PROVIDER=impact` or `awin` with the
matching token — [Impact](https://impact.com/),
[Awin](https://www.awin.com/) (which now includes ShareASale).

Without a token the app doesn't error — the lookup box just reports that it
isn't configured, and everything else keeps working.

**2. "My Saved Codes" — works immediately, no key needed.**
Save any code you find (from anywhere), with store, note, and expiry. Then
mark **✓ Worked** or **✗ Didn't work** after you try it, and it records the
date. Over time this becomes your own verified list — which is the practical
substitute for automated validation, since you're doing the one step that
can't be automated. Stored in your browser's `localStorage`, nothing leaves
your machine.

**Caveat even on published codes:** "published and unexpired" still isn't
"guaranteed to work." Codes are often restricted by product, minimum spend,
region, or first-time-customer status. The UI says this too.

### Why scraping coupon sites isn't the answer

The obvious idea is to scrape RetailMeNot, Honey, Slickdeals and so on. Worth
knowing why that's a dead end before spending a weekend on it:

- **Their terms of service prohibit it**, and the big ones sit behind
  commercial bot protection that blocks datacenter IPs and headless browsers.
- **The codes there are mostly dead anyway.** Those sites are crowd-sourced
  and monetised by traffic, so expired and never-worked codes stay up. You'd
  be scraping a pile you then still can't verify.
- **Verification is the actual hard part, and it's unsolvable in general.**
  The only true test is applying the code at that retailer's checkout — which
  is different on every store, prohibited by most, and indistinguishable from
  card-testing fraud from the retailer's security team's point of view.

The affiliate feed avoids all three: the merchant publishes it deliberately,
it comes with real start/end dates, and using it is the intended purpose.

### Implementation notes on the adapters

The Rakuten adapter is written against Rakuten's published Coupon Feed API
docs, including two things that are easy to get wrong:

- **The feed is XML, not JSON.** Their docs state it plainly ("currently
  supports only XML format, maximum 500 results"). `coupons.js` has a small
  purpose-built parser for it; `node coupons-test.js` exercises that parser
  offline against a realistic document with CDATA, escaped ampersands,
  nested category blocks, code-less promotional links and an expired offer.
- **There's no store-name search parameter.** The documented filters are
  category, promotion type, network and advertiser ID. So the app pulls the
  feed and matches on merchant name locally.
- **Auth is OAuth client-credentials, not an API key.** Covered by
  `node coupons-token-test.js` — request shape, caching, single-flight under
  concurrency, refresh before expiry, one-shot retry on a 401, and a check
  that the client secret never reaches an error message.

The Impact and Awin adapters follow their networks' docs but have **not**
been verified — a live publisher token for each is needed to exercise them,
and I don't have one. Expect to adjust field names on first run; the code
logs the raw response shape to the server console when parsing fails.

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
- **"Check Result" / Bullish-Bearish label is not financial advice and not
  guaranteed accurate.** It's a plain-English summary of two facts pulled
  straight from Yahoo (did reported EPS beat or miss the estimate, and did
  the price move up or down in the relevant session) — nothing more. Real
  market reactions depend on guidance, revenue, sector sentiment, and much
  else the label doesn't see, which is exactly why "Mixed" shows up often
  (e.g. an EPS beat the market still sells off on). Use it as a quick
  pointer to go look closer, not as a signal to act on.
- **"Immediate" means polled, not pushed.** The Auto-refresh toggle checks
  every 2 minutes while the tab stays open — there's no way to get true
  instant/real-time push notifications from an unofficial, undocumented
  data source like this without a much larger always-on backend
  (and Yahoo would likely rate-limit or block that kind of polling
  frequency anyway). Two minutes is a reasonable balance between "notice
  it quickly" and "don't get blocked." You can lower
  `AUTO_REFRESH_INTERVAL_MS` in `public/app.js` if you want to try polling
  faster, at your own risk of hitting rate limits.
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
