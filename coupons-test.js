/**
 * coupons-test.js — offline test for the Rakuten coupon feed parser
 * ------------------------------------------------------------------
 * The feed is XML (Rakuten's docs: "currently supports only XML format"),
 * so the parser is the part most likely to be wrong. This exercises it
 * against a realistic document with the awkward bits included: CDATA,
 * escaped ampersands, nested <categories>/<promotiontypes> blocks, a
 * promotional link with no coupon code, and an expired offer.
 *
 * Run:  node coupons-test.js
 */

const { parseCouponXml, normalizeCoupon, isExpired } = require('./coupons');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<couponfeed>
  <TotalMatches>4</TotalMatches>
  <TotalPages>1</TotalPages>
  <PageNumberRequested>1</PageNumberRequested>
  <link type="TEXT">
    <categories><category id="1">Apparel</category></categories>
    <promotiontypes><promotiontype id="11">Percentage off</promotiontype></promotiontypes>
    <offerdescription>20% off sitewide</offerdescription>
    <offerstartdate>2026-08-01</offerstartdate>
    <offerenddate>2099-08-31</offerenddate>
    <couponcode>SAVE20</couponcode>
    <couponrestriction>Excludes sale items &amp; gift cards</couponrestriction>
    <clickurl>https://click.linksynergy.com/fs-bin/click?id=abc&amp;offerid=123</clickurl>
    <advertiserid>1234</advertiserid>
    <advertisername>Nike</advertisername>
    <network id="1">US Network</network>
  </link>
  <link type="TEXT">
    <offerdescription><![CDATA[Free shipping over $50]]></offerdescription>
    <offerenddate>2099-12-31</offerenddate>
    <couponcode>SHIP50</couponcode>
    <advertisername>Nike Factory Store</advertisername>
    <clickurl>https://click.linksynergy.com/x</clickurl>
  </link>
  <link type="TEXT">
    <offerdescription>Summer sale — no code needed</offerdescription>
    <offerenddate>2099-09-30</offerenddate>
    <advertisername>Adidas</advertisername>
    <clickurl>https://click.linksynergy.com/y</clickurl>
  </link>
  <link type="TEXT">
    <offerdescription>Old promo</offerdescription>
    <offerenddate>2020-01-01</offerenddate>
    <couponcode>DEAD10</couponcode>
    <advertisername>Adidas</advertisername>
  </link>
</couponfeed>`;

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

console.log('\n1. XML parsing');
const rows = parseCouponXml(SAMPLE);
check('found all four <link> blocks', rows.length === 4, `${rows.length} rows`);

const first = rows[0];
check('reads couponcode', first.couponcode === 'SAVE20', first.couponcode);
check('reads advertisername', first.advertisername === 'Nike', first.advertisername);
check('reads offerenddate', first.offerenddate === '2099-08-31', first.offerenddate);
check('decodes &amp; in restrictions',
  first.couponrestriction === 'Excludes sale items & gift cards', first.couponrestriction);
check('decodes &amp; inside URLs (would break the link otherwise)',
  first.clickurl === 'https://click.linksynergy.com/fs-bin/click?id=abc&offerid=123',
  first.clickurl);

// Nested blocks must not be half-parsed into junk values.
check('skips nested <categories> container', first.categories === undefined);
check('skips nested <promotiontypes> container', first.promotiontypes === undefined);
check('does not invent a value for the parent tag',
  !('category' in first) || first.category === 'Apparel',
  'leaf <category> may be read, container must not');

check('unwraps CDATA', rows[1].offerdescription === 'Free shipping over $50',
  rows[1].offerdescription);

console.log('\n2. Feed-level metadata is not mistaken for a coupon');
check('TotalMatches not treated as a link', !rows.some((r) => r.totalmatches));

console.log('\n3. Normalisation');
const norm = rows.map(normalizeCoupon).filter(Boolean);
check('all four normalise', norm.length === 4, `${norm.length}`);
check('code carried through', norm[0].code === 'SAVE20');
check('restrictions map to terms', norm[0].terms === 'Excludes sale items & gift cards');
check('merchant carried through', norm[0].merchant === 'Nike');
check('code-less promo still kept, with null code',
  norm[2].code === null && !!norm[2].description,
  `"${norm[2].description}"`);

console.log('\n4. Expiry filtering');
check('past end date is expired', isExpired('2020-01-01') === true);
check('future end date is not', isExpired('2099-12-31') === false);
check('missing end date is not treated as expired', isExpired(null) === false);
check('unparseable end date is not silently dropped', isExpired('whenever') === false);
const live = norm.filter((c) => !isExpired(c.endDate));
check('expired promo filtered out of the list', live.length === 3 &&
  !live.some((c) => c.code === 'DEAD10'), `${live.length} live`);

console.log('\n5. Store matching is substring, case-insensitive');
const match = (needle) =>
  rows.filter((r) => String(r.advertisername || '').toLowerCase().includes(needle.toLowerCase()));
check('"nike" matches both Nike entries', match('nike').length === 2);
check('"NIKE" matches regardless of case', match('NIKE').length === 2);
check('"adidas" matches its two', match('adidas').length === 2);
check('unknown store matches nothing', match('walmart').length === 0);

console.log('\n6. Malformed input does not throw');
for (const bad of [null, undefined, '', '<html>404</html>', '{"json":true}', '<couponfeed/>']) {
  let ok = true;
  try { parseCouponXml(bad); } catch (e) { ok = false; }
  check(`handles ${JSON.stringify(String(bad).slice(0, 20))}`, ok);
}
check('empty feed returns []', parseCouponXml('<couponfeed/>').length === 0);

console.log(failures === 0 ? '\nAll coupon tests passed.\n' : `\n${failures} FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
