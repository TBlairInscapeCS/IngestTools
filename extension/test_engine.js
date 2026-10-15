// Test harness: run under JXA — tests engine.js against real tracker CSVs.
// Usage: PWD=$PWD osascript -l JavaScript test_engine.js [kohls|inmarket]
ObjC.import('stdlib');
// $.getenv throws on missing vars in some macOS versions - wrap it.
const env = k => { try { return $.getenv(k) || undefined; } catch (e) { return undefined; } };
const dir = env('PWD');
const load = f => eval($.NSString.alloc.initWithContentsOfFileEncodingError(dir + '/' + f, $.NSUTF8StringEncoding, null).js);
load('engine.js');
const csvFile = env('TEST_CSV') || 'kohls_tracker.csv';
const csv = $.NSString.alloc.initWithContentsOfFileEncodingError(dir + '/../examples/' + csvFile, $.NSUTF8StringEncoding, null).js;

// BDF-style discrepancy scenario: 5 requested ISCI codes, one missing from
// the folder, one extra file in the folder, two ESPN-flagged spots.
if ((env('TEST_SET') || '') === 'recon') {
  const ids = ['0926525ZTNH', '0926514BNSH', '0926513ZNSH', '0926505ZNH', '0926528BTNH'];
  const files = [
    '0926525ZTNH.mp4', '0926514BNSH.mp4', '0926513ZNSH.mp4', '0926505ZNH.mov',
    '0926526BTNH.mp4',   // in the folder but never requested
  ];
  const { results, counts, fileCount, extras } = reconcile(ids, files);
  const out = [];
  results.forEach(r => out.push(`${r.id} -> ${r.status} ${r.matched}`));
  out.push('counts: ' + JSON.stringify(counts) + ' extras: ' + JSON.stringify(extras));
  const espnIds = new Set(['0926514bnsh', '0926513znsh']); // normalized keys
  out.push('--- recon confirmation ---');
  out.push(buildReconConfirmation(results, extras, espnIds));
  out.join('\n');
} else {

const emails = {
kohls: `Hello,
We have sent the below 2x spot(s) to Inscape via Yangaroo. Please see attached for the POD.
The HMI Analytics Tracker has been updated to reflect the spot(s) below. Please ensure that these spot(s) are fingerprinted for Inscape creative tracking and please confirm when complete.
Spot Title
Tracking ID
Spot Run Date
Spot End Date
Need ESPN Version
KOHLS MOM OCT LPS :15
YKKL0288000H
10/18/2026
10/25/2026
YES
MAMA KOHLS OCT LPS SPAN :15
YKKL0293000H
10/18/2026
10/25/2026
NO
Please reach out with any questions.
Thank you,
Laura Anderson`,
inmarket: `Hi Inscape team,

I just added 3 new Applebee's YouTube creatives to the shared tracker in rows 1857-1859. Can you confirm once feeds have been enabled for those?

Thanks!
Amanda`,
};
const email = emails[env('TEST_SET') || 'kohls'];
const p = parseInput(csv);
const hIdx = detectHeaderRow(p.rows);
const headers = p.rows[hIdx];
const dataRows = p.rows.slice(hIdx + 1);
const out = [];

out.push('detected header row: ' + (hIdx + 1));
const cols = {
  id:     guessField(headers, 'trackingId', dataRows),
  title:  guessField(headers, 'spotTitle', dataRows),
  file:   guessColumn(headers, /file.?name/i),
  link:   guessColumn(headers, /link|url|source|drive|extreme/i),
  access: guessColumn(headers, /access|given|permission/i),
  brand:  guessColumn(headers, /brand|advertiser|client|product/i),
  espn:   guessColumn(headers, /espn|ticker|version/i),
  date:   guessColumn(headers, /ingest.*date|request.*date|date|flight|air|start/i),
};
for (const k in cols) out.push(`col ${k}: ${cols[k]} -> ${(headers[cols[k]] || '(none)').trim().slice(0, 45)}`);

out.push('newCount: ' + extractNewCount(email));
out.push('emailEspn flags: ' + JSON.stringify([...extractEmailEspnFlags(email)]));

const m = matchEmailToSheet(email, dataRows, cols, { headerRow: hIdx + 1 });
m.forEach(r => out.push(`row ${r.row} | ${r.matchType} | id=${r.id} | trackingId=${r.trackingId} | espn=${r.espn} emailEspn=${r.emailEspn} conflict=${r.espnConflict || false} | link=${r.link || r.linkText}`));

out.push('--- confirmation ---');
out.push(buildMatchConfirmation(m) || '(none)');
out.join('\n');
}
