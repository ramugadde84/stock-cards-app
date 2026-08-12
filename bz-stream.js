/**
 * Benzinga WebSocket stream — standalone tester
 * ----------------------------------------------
 * `wss://` is WebSocket Secure: one persistent connection that Benzinga
 * PUSHES data down as events happen. You can't open it with curl or a
 * browser address bar — you need a WebSocket client, which is what this is.
 *
 * WEBSOCKET SUPPORT: Node 22+ has a global WebSocket built in. Node 20 and
 * below do not, so this falls back to the `ws` package (already listed in
 * package.json — just run `npm install`). Both expose the same
 * addEventListener API, so the code below is identical either way.
 *
 * RUN IT
 * ------
 *   macOS/Linux:  BENZINGA_API_KEY=bz.xxxx node bz-stream.js
 *   Windows CMD:  set BENZINGA_API_KEY=bz.xxxx && node bz-stream.js
 *   PowerShell:   $env:BENZINGA_API_KEY="bz.xxxx"; node bz-stream.js
 *
 * Optional args:
 *   node bz-stream.js AAPL,TSLA            # tickers (default AAPL,TSLA)
 *   node bz-stream.js AAPL,TSLA earnings   # which stream (default bulls_bears_say)
 *
 * Available streams (per docs.benzinga.com — your licence may not cover all):
 *   bulls_bears_say, calendar/earnings, calendar/ratings,
 *   consensus_ratings, news, transcripts
 *
 * NOTE ON QUIET STREAMS: connecting successfully but seeing no messages is
 * normal and does NOT mean it's broken. These push only when a new event
 * occurs — bull/bear updates and earnings are infrequent. "Connected" with
 * silence = working. Use the `news` stream to prove data is flowing, since
 * it's the busiest.
 */

const TOKEN = process.env.BENZINGA_API_KEY || '';
const TICKERS = process.argv[2] || 'AAPL,TSLA';
const STREAM = process.argv[3] || 'bulls_bears_say';

/**
 * Pick a WebSocket implementation:
 *   - Node 22+ : the built-in global
 *   - Node <22 : the `ws` package (same addEventListener API, so nothing
 *                downstream needs to change)
 */
function resolveWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try {
    return require('ws');
  } catch (e) {
    console.error(`\n✗ No WebSocket support on Node ${process.version}.\n`);
    console.error('  Node 22+ has one built in; you\'re on an older version, so install the');
    console.error('  `ws` package (it\'s already in package.json):\n');
    console.error('      npm install\n');
    console.error('  Then run this again. Alternatively, upgrade to Node 22+.\n');
    process.exit(1);
  }
}

const WebSocketImpl = resolveWebSocket();

if (!TOKEN) {
  console.error('\n✗ BENZINGA_API_KEY is not set.\n');
  console.error('  Windows CMD:  set BENZINGA_API_KEY=bz.xxxx && node bz-stream.js');
  console.error('  PowerShell:   $env:BENZINGA_API_KEY="bz.xxxx"; node bz-stream.js');
  console.error('  macOS/Linux:  BENZINGA_API_KEY=bz.xxxx node bz-stream.js\n');
  console.error('  Never hardcode the key into this file — it\'s a billable credential.\n');
  process.exit(1);
}

const url =
  `wss://api.benzinga.com/api/v1/${STREAM}/stream` +
  `?token=${encodeURIComponent(TOKEN)}` +
  `&tickers=${encodeURIComponent(TICKERS)}`;

// Log the URL with the token masked, so pasting your terminal output
// somewhere doesn't leak the key all over again.
console.log(`\nConnecting to: ${url.replace(/token=[^&]+/, 'token=***REDACTED***')}`);
console.log(`Stream: ${STREAM}  |  Tickers: ${TICKERS}`);
console.log(
  `Node ${process.version} — using ${typeof WebSocket !== 'undefined' ? 'built-in WebSocket' : 'ws package'}`
);
console.log('Press Ctrl+C to stop.\n');

const ws = new WebSocketImpl(url);
let messageCount = 0;

ws.addEventListener('open', () => {
  console.log('✓ Connected. Waiting for messages…');
  console.log('  (Silence is normal — these streams only push when an event occurs.)\n');
});

ws.addEventListener('message', (event) => {
  messageCount++;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n─── message #${messageCount}  ${stamp} ───`);

  // The built-in WebSocket gives a string; the `ws` package can hand back a
  // Buffer. Normalise so both print readably.
  const raw = typeof event.data === 'string' ? event.data : event.data.toString('utf8');

  try {
    // Pretty-print JSON so the field names are easy to read — you'll need
    // them to wire this into the app.
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch (e) {
    console.log(raw); // not JSON — print raw
  }
});

ws.addEventListener('error', () => {
  // The browser-style WebSocket error event carries no detail by design;
  // the close event below has the useful status code.
  console.error('✗ Connection error.');
});

ws.addEventListener('close', (event) => {
  console.log(`\n✗ Closed (code ${event.code}) ${event.reason || ''}`);
  // Map the codes you're most likely to hit to plain explanations.
  if (event.code === 1006) {
    console.log('  1006 = closed abnormally. Usually a rejected token, a stream not');
    console.log('  included in your licence, or a network/firewall block.');
  } else if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
    console.log('  Auth/policy failure — check the token is current and that your');
    console.log(`  licence covers the "${STREAM}" stream.`);
  }
  console.log(`  Received ${messageCount} message(s) this session.\n`);
  process.exit(event.code === 1000 ? 0 : 1);
});

process.on('SIGINT', () => {
  console.log('\nClosing…');
  ws.close(1000, 'client shutdown');
});
