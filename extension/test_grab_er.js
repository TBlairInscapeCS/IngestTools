// Runs the REAL grabExtremeReach() from sidepanel.js against the saved
// Spot Deliveries page in examples/, behind a minimal DOM shim — proves
// the row/cell/link/pager logic against production markup without Chrome.
// Usage: cd extension && osascript -l JavaScript test_grab_er.js
ObjC.import('stdlib');
const dir = $.getenv('PWD').js || '.';

function loadText(p) {
  let s = $.NSString.alloc.initWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (!s || s.js === undefined) s = $.NSString.alloc.initWithContentsOfFileEncodingError(p, $.NSISOLatin1StringEncoding, null);
  return s.js;
}

const panelSrc = loadText(dir + '/sidepanel.js');
const html = loadText(dir + '/../examples/Spot Deliveries - Broadcast Operations - Extreme Reach.html');

// Pull just the function under test out of the panel script.
const fnSrc = panelSrc.slice(
  panelSrc.indexOf('function grabExtremeReach'),
  panelSrc.indexOf('// Inside any page: collect'));

// ---- DOM shim -------------------------------------------------------------
// innerText: strip tags + decode the handful of entities ER pages use.
const innerText = frag => frag
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').trim();

const trShims = (html.match(/<tr[\s>][\s\S]*?<\/tr>/g) || []).map(row => {
  const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])
    .map(td => ({ innerText: innerText(td.replace(/^<td[^>]*>|<\/td>$/g, '')) }));
  const dlHref = (row.match(/href="([^"]*\/Delivery\/Download\/[^"]*)"/) || [])[1];
  return {
    querySelectorAll: sel => sel === 'td' ? cells : [],
    querySelector: sel => sel === 'a[href*="/Delivery/Download/"]' && dlHref ? { href: dlHref } : null,
  };
});

globalThis.document = {
  querySelectorAll: sel => sel === 'tr' ? trShims : [],
  querySelector: sel =>
    sel === 'a[title="Go to next page"]'
      ? (html.includes('title="Go to next page"') ? {} : null)
      : null,
};

eval(fnSrc);

// ---- assertions ------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + label); } };

const result = grabExtremeReach();
ok(result.files.length === 20, 'should find 20 delivery rows, got ' + result.files.length);
ok(result.hasMore === true, 'next-page link present -> hasMore true');
ok(result.files.every(f => /\/Delivery\/Download\//.test(f.url)), 'every file carries a /Delivery/Download/ URL');
ok(result.files.every(f => !/\/Media\/Download\//.test(f.url)), 'no low-res Media/Download URLs leaked');
ok(result.files.every(f => /^[A-Z0-9]{7,14}\b/.test(f.name)), 'names lead with the Ad-ID');
ok(result.files[0].name === 'KARM0307000H Switch Up', 'row 1 name, got "' + result.files[0].name + '"');
ok(result.files[0].brand === 'Credit Karma', 'row 1 advertiser, got "' + result.files[0].brand + '"');
const wb = result.files.find(f => f.name.indexOf('WRCH6105000H') === 0);
ok(wb && /^Warner Bros/.test(wb.brand) && wb.name.indexOf('One of Those Days') > -1,
  'WB row: brand + title, got ' + JSON.stringify(wb && { name: wb.name, brand: wb.brand }));
ok(result.files.every(f => /\d{1,2}\/\d{1,2}\/\d{4}/.test(f.line)), 'each line carries the delivery date for date filtering');
const urls = new Set(result.files.map(f => f.url));
ok(urls.size === 20, 'all 20 delivery URLs are unique');

// ---- merge/dedupe simulation (the panel's multi-page accumulate) ------------
// Page 2 = same 20 rows + 3 fresh ones -> merged total must be 23.
const page2 = result.files.slice(0).concat([
  { name: 'FAKE111111H New Spot A', url: 'https://app.extremereach.com/Delivery/Download/X1' },
  { name: 'FAKE222222H New Spot B', url: 'https://app.extremereach.com/Delivery/Download/X2' },
  { name: 'FAKE333333H New Spot C', url: 'https://app.extremereach.com/Delivery/Download/X3' },
]);
let existing = result.files.map(f => f.name);
const seen = new Set(existing);
let added = 0;
page2.forEach(e => { if (!seen.has(e.name) && seen.add(e.name)) added++; });
ok(added === 3, 'page-2 merge adds only the 3 new rows, got ' + added);
ok(seen.size === 23, 'merged batch = 23 unique files, got ' + seen.size);

// hasMore=false on a final page (no next-page link in markup)
globalThis.document.querySelector = sel =>
  sel === 'a[title="Go to next page"]' ? null : null;
ok(grabExtremeReach().hasMore === false, 'last page -> hasMore false');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) $.exit(1);
