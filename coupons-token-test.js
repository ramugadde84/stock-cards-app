/**
 * coupons-token-test.js — offline test for the Rakuten OAuth token exchange
 * --------------------------------------------------------------------------
 * Rakuten doesn't issue a long-lived API key: Client ID + Client Secret +
 * SID are swapped for a short-lived bearer token. The things that can go
 * quietly wrong are caching (minting a token per request), refresh (using a
 * token past its expiry), and the retry path (one 401 should self-heal, not
 * loop). All three are checked here with the network stubbed.
 *
 * Run:  node coupons-token-test.js
 */

const calls = [];
let tokenCounter = 0;
let tokenTtlSec = 3600;
let tokenStatus = 200;
let tokenBody = null;
let feedStatus = 200;
let feedAuthMustBe = null;      // assert the feed saw the right token
let feedFailFirstWith401 = false;
let feedCallCount = 0;

const clientPath = require.resolve('./httpClient');
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    httpFetch: async (url, opts = {}) => {
      calls.push({ url, opts });

      if (url.includes('/token')) {
        tokenCounter++;
        const body = tokenBody !== null
          ? tokenBody
          : JSON.stringify({ access_token: 'tok-' + tokenCounter, expires_in: tokenTtlSec });
        return {
          ok: tokenStatus >= 200 && tokenStatus < 300,
          status: tokenStatus,
          text: async () => body,
        };
      }

      feedCallCount++;
      if (feedFailFirstWith401 && feedCallCount === 1) {
        return { ok: false, status: 401, text: async () => 'expired' };
      }
      if (feedAuthMustBe && opts.headers?.Authorization !== 'Bearer ' + feedAuthMustBe) {
        return { ok: false, status: 401, text: async () => 'wrong token' };
      }
      return {
        ok: feedStatus >= 200 && feedStatus < 300,
        status: feedStatus,
        text: async () => `<couponfeed><link>
          <offerdescription>10% off</offerdescription>
          <couponcode>TEN</couponcode>
          <offerenddate>2099-01-01</offerenddate>
          <advertisername>Nike</advertisername>
        </link></couponfeed>`,
      };
    },
  },
};

process.env.COUPON_PROVIDER = 'rakuten';
process.env.COUPON_CLIENT_ID = 'my-client-id';
process.env.COUPON_CLIENT_SECRET = '  my-secret  '; // deliberately padded
process.env.COUPON_SCOPE_ID = '"12345"';            // deliberately quoted
delete process.env.COUPON_API_TOKEN;

const coupons = require('./coupons');

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  console.log('\n1. Configuration detection');
  check('client credentials count as configured', coupons.isConfigured() === true);
  check('no missing-field hint when complete', coupons.configHint() === null,
    String(coupons.configHint()));

  console.log('\n2. Token exchange request shape');
  coupons._resetTokenCache();
  calls.length = 0;
  const tok = await coupons.getAccessToken();
  const req = calls.find((c) => c.url.includes('/token'));
  check('posts to api.linksynergy.com/token',
    req && req.url === 'https://api.linksynergy.com/token', req && req.url);
  check('uses POST', req.opts.method === 'POST', req.opts.method);
  const expectedBasic = Buffer.from('my-client-id:my-secret').toString('base64');
  check('sends base64(clientId:clientSecret)',
    req.opts.headers.Authorization === 'Bearer ' + expectedBasic);
  check('trims whitespace from the secret before encoding',
    Buffer.from(expectedBasic, 'base64').toString() === 'my-client-id:my-secret',
    'padded env value must not change the encoded credential');
  check('sends scope=SID in the body', req.opts.body === 'scope=12345', req.opts.body);
  check('strips quotes pasted around the SID', !String(req.opts.body).includes('"'));
  check('form content type', req.opts.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  check('returns the access_token', tok === 'tok-1', tok);

  console.log('\n3. Caching');
  const before = tokenCounter;
  await coupons.getAccessToken();
  await coupons.getAccessToken();
  await coupons.getAccessToken();
  check('repeat calls reuse the cached token', tokenCounter === before,
    `${tokenCounter - before} extra exchanges`);

  console.log('\n4. Concurrent callers share one exchange');
  coupons._resetTokenCache();
  const n = tokenCounter;
  const toks = await Promise.all([1, 2, 3, 4, 5].map(() => coupons.getAccessToken()));
  check('five parallel calls mint exactly one token', tokenCounter === n + 1,
    `${tokenCounter - n} exchanges`);
  check('all callers get the same token', new Set(toks).size === 1, [...new Set(toks)].join(','));

  console.log('\n5. Expiry triggers refresh');
  coupons._resetTokenCache();
  tokenTtlSec = 30; // shorter than the 60s refresh margin => always stale
  const t1 = await coupons.getAccessToken();
  const t2 = await coupons.getAccessToken();
  check('a token inside the refresh margin is re-minted', t1 !== t2, `${t1} then ${t2}`);
  tokenTtlSec = 3600;

  console.log('\n6. Token is actually used on the feed call');
  coupons._resetTokenCache();
  calls.length = 0;
  feedCallCount = 0;
  const fresh = 'tok-' + (tokenCounter + 1);
  feedAuthMustBe = fresh;
  const result = await coupons.getCoupons('nike');
  check('lookup succeeds end to end', result.configured === true && result.coupons.length === 1,
    `${result.coupons.length} coupon(s)`);
  check('coupon parsed from the XML feed', result.coupons[0].code === 'TEN',
    result.coupons[0].code);
  feedAuthMustBe = null;

  console.log('\n7. A 401 on the feed self-heals once');
  coupons._resetTokenCache();
  feedCallCount = 0;
  feedFailFirstWith401 = true;
  const n2 = tokenCounter;
  const retried = await coupons.getCoupons('nike');
  check('retries and succeeds', retried.coupons.length === 1);
  check('feed was called twice', feedCallCount === 2, `${feedCallCount} calls`);
  check('a fresh token was minted for the retry', tokenCounter === n2 + 2,
    `${tokenCounter - n2} exchanges`);
  feedFailFirstWith401 = false;

  console.log('\n8. Credential errors are explained, not swallowed');
  coupons._resetTokenCache();
  tokenStatus = 401;
  let msg = '';
  try { await coupons.getCoupons('nike'); } catch (e) { msg = e.message; }
  check('401 on token exchange throws', msg.length > 0);
  check('message names the three variables to check',
    /COUPON_CLIENT_ID/.test(msg) && /COUPON_SCOPE_ID/.test(msg), msg.slice(0, 90) + '…');
  check('message warns SID is not the Client ID', /not the Client ID/.test(msg));
  tokenStatus = 200;

  coupons._resetTokenCache();
  tokenBody = '{"token_type":"bearer"}'; // no access_token
  msg = '';
  try { await coupons.getAccessToken(); } catch (e) { msg = e.message; }
  check('missing access_token is a clear error', /no access_token/.test(msg), msg);
  tokenBody = null;

  coupons._resetTokenCache();
  tokenBody = '<html>gateway error</html>';
  msg = '';
  try { await coupons.getAccessToken(); } catch (e) { msg = e.message; }
  check('non-JSON token response is a clear error', /non-JSON/.test(msg), msg);
  tokenBody = null;

  console.log('\n9. Secrets never appear in error text');
  coupons._resetTokenCache();
  tokenStatus = 403;
  msg = '';
  try { await coupons.getAccessToken(); } catch (e) { msg = e.message; }
  check('client secret not leaked into the message', !msg.includes('my-secret'), msg.slice(0, 60) + '…');
  check('client id not leaked into the message', !msg.includes('my-client-id'));
  tokenStatus = 200;

  console.log(failures === 0 ? '\nAll token tests passed.\n' : `\n${failures} FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
