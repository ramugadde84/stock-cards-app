/**
 * Benzinga connectivity diagnostic
 * ---------------------------------
 * The API working in your browser but not in Node is a specific, common
 * situation — and the usual cause is a corporate proxy. Chrome uses the
 * Windows system proxy automatically; Node's fetch() does NOT. So the exact
 * same URL succeeds in the browser and fails from a script.
 *
 * This script checks each link in the chain and tells you which one broke.
 *
 * RUN:
 *   set BENZINGA_API_KEY=bz.xxxx && node bz-test.js
 */

const TICKER = process.argv[2] || 'AAPL';
const token = process.env.BENZINGA_API_KEY || '';

console.log('\n=== Benzinga connectivity diagnostic ===\n');

// --- 1. Is the key actually reaching Node? -------------------------------
console.log('1. Environment');
console.log('   Node version      :', process.version);
if (!token) {
  console.log('   BENZINGA_API_KEY  : ✗ NOT SET\n');
  console.log('   This is the problem. On Windows CMD the variable must be set in the');
  console.log('   SAME command window you run node from, and `set X=y && node ...` only');
  console.log('   lasts for that one command. Try:\n');
  console.log('       set BENZINGA_API_KEY=bz.xxxx');
  console.log('       node bz-test.js\n');
  console.log('   (two separate lines, so it persists for the session)\n');
  process.exit(1);
}
console.log('   BENZINGA_API_KEY  : ✓ set (' + token.slice(0, 6) + '…' + token.slice(-4) + ', length ' + token.length + ')');

// A stray quote or trailing space from copy/paste will silently break auth.
if (/["'\s]/.test(token)) {
  console.log('   ⚠ WARNING: key contains quotes or whitespace — strip them.');
  console.log('     On Windows CMD do NOT wrap the value in quotes.');
}

// --- 2. Is a proxy configured? -------------------------------------------
console.log('\n2. Proxy environment');
const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY'];
const foundProxies = proxyVars.filter((v) => process.env[v]);
if (foundProxies.length) {
  foundProxies.forEach((v) => console.log(`   ${v} = ${process.env[v]}`));
  console.log('\n   NOTE: Node\'s built-in fetch() IGNORES these variables. Even with a');
  console.log('   proxy set, fetch() tries to connect directly and fails. See the fix');
  console.log('   printed at the end if the request below fails.');
} else {
  console.log('   No proxy environment variables set.');
  console.log('   (If your browser works via a corporate proxy configured in Windows');
  console.log('    settings rather than env vars, Node still won\'t see it.)');
}

// --- 3. Can Node reach Benzinga at all? ----------------------------------
console.log('\n3. Request to Benzinga REST API');
const url =
  'https://api.benzinga.com/api/v1/bulls_bears_say' +
  `?token=${encodeURIComponent(token)}&symbols=${encodeURIComponent(TICKER)}`;
console.log('   GET', url.replace(/token=[^&]+/, 'token=***'));

const started = Date.now();

fetch(url, { headers: { accept: 'application/json' } })
  .then(async (res) => {
    const ms = Date.now() - started;
    console.log(`   ← HTTP ${res.status} in ${ms}ms`);

    const text = await res.text();

    if (res.status === 401) {
      console.log('\n   ✗ 401 Unauthorized — the key was rejected.');
      console.log('     Check for typos, or whether the key has been rotated/revoked.\n');
      process.exit(1);
    }
    if (!res.ok) {
      console.log('\n   ✗ Non-200 response body:\n', text.slice(0, 400), '\n');
      process.exit(1);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.log('\n   ✗ Response was not JSON. First 400 chars:\n', text.slice(0, 400), '\n');
      process.exit(1);
    }

    const list = json['bulls_say_bears_say'] || json['bulls-say-bears-say'] || [];
    console.log(`   ✓ Parsed OK — ${list.length} record(s) returned.`);
    if (list[0]) {
      console.log('     ticker    :', list[0].ticker);
      console.log('     bull_case :', (list[0].bull_case || '').slice(0, 60) + '…');
      console.log('     bear_case :', (list[0].bear_case || '').slice(0, 60) + '…');
    }
    console.log('\n=== ✓ ALL GOOD — Node can reach Benzinga. ===');
    console.log('If the app still shows nothing, the key isn\'t reaching the server');
    console.log('process. Start it in the same window where you set the variable:\n');
    console.log('    set BENZINGA_API_KEY=bz.xxxx');
    console.log('    npm start\n');
  })
  .catch((err) => {
    const ms = Date.now() - started;
    console.log(`   ✗ Request failed after ${ms}ms`);
    console.log('   Error :', err.message);
    if (err.cause) console.log('   Cause :', err.cause.code || err.cause.message || err.cause);

    console.log('\n=== DIAGNOSIS ===\n');
    console.log('The browser works but Node does not, which almost always means Node');
    console.log('is not going through your corporate proxy. Chrome uses the Windows');
    console.log('system proxy automatically; Node\'s fetch() does not, and it does not');
    console.log('read HTTP_PROXY/HTTPS_PROXY either.\n');
    console.log('FIX — find your proxy address (Windows Settings → Network & Internet');
    console.log('→ Proxy, or ask IT), then install undici and route through it:\n');
    console.log('    npm install undici\n');
    console.log('Then set the proxy in your environment before starting:\n');
    console.log('    set HTTPS_PROXY=http://your-proxy-host:port\n');
    console.log('benzinga.js already checks for HTTPS_PROXY and will use it via undici');
    console.log('if the package is installed — so this is the only step you need.\n');
    console.log('If there is no proxy, then Benzinga is being blocked by a firewall');
    console.log('rule. Test from a personal network (or phone hotspot) to confirm.\n');
    process.exit(1);
  });
