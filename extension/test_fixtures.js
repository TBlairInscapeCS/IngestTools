// Fixture-driven regression suite — every real tracker in examples/ and
// every email manifest format we've seen, asserted against the engine.
// Usage: cd extension && osascript -l JavaScript test_fixtures.js
// Exits non-zero on any failure so it can gate future changes.
ObjC.import('stdlib');
const env = k => { try { return $.getenv(k) || undefined; } catch (e) { return undefined; } };
const dir = env('PWD') || '.';
const EXAMPLES = dir + '/../examples/';

// SharePoint-origin exports are often latin-1/CP1252 (0xa0 nbsp) — fall
// back gracefully like FileReader.readAsText does in the panel.
function loadText(p) {
  let s = $.NSString.alloc.initWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (!s || s.js === undefined) {
    s = $.NSString.alloc.initWithContentsOfFileEncodingError(p, $.NSISOLatin1StringEncoding, null);
  }
  return s && s.js !== undefined ? s.js : null;
}
eval(loadText(dir + '/engine.js'));
eval(loadText(dir + '/clients.js'));

let pass = 0, fail = 0;
const failures = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(name + '\n    want ' + e + '\n    got  ' + a); }
}

// ---------- Sheet fixtures ----------
// Fields verified against each real tracker: id/title resolution through
// dual-'Tracking ID' layouts, fill-back detection via names + merged group
// headers, and the pending queue over non-empty rows.
const live = rows => rows.filter(r => r.some(c => {
  const v = String(c || '').trim();
  return v && !/^[_\-~.]+$/.test(v);
}));

const SHEETS = [
  { f: 'kohls_tracker.csv',            id: 5,  title: 2,  fb: 4, pending: 136 },
  { f: 'inmarket_tracker.csv',         id: 9,  title: -1, fb: 4, pending: 102 },
  { f: 'AMCN Inscape Fingerprinting Tracker - Working List.csv',      id: 18, title: 1,  fb: 2, pending: 1676 },
  { f: 'Commercial_Ingestion_Vizio_LWD.xlsx - NDR.csv',               id: 2,  title: 1,  fb: 4, pending: 0 },
  { f: 'USN ACR Metadata Tracker(USN ISCI Metadata).csv',             id: 0,  title: 2,  fb: 2, pending: 11 },
  { f: 'Vizio_Ingestion_Form_IMD(Vizio Ingestion Sheet).csv',         id: 6,  title: 1,  fb: 3, pending: 0 },
  { f: 'NFL Inscape Fingerprinting Tracker - FY24.csv',               id: 5,  title: 3,  fb: 2, pending: 218 },
  { f: 'Tatari_Inscape Creative Tracker - Sheet1.csv',                id: 1,  title: -1, fb: 2, pending: 189 },
  { f: 'Kantar Vizio Share & Feasibility Calculator - Shared with Vizio(Inscape Creative Tracker).csv', id: 4, title: 2, fb: 4, pending: 75 },
];

SHEETS.forEach(t => {
  const csv = loadText(EXAMPLES + t.f);
  if (csv === null) { fail++; failures.push(t.f + ': file unreadable'); return; }
  const p = parseInput(csv);
  const hIdx = detectHeaderRow(p.rows);
  const headers = p.rows[hIdx], data = p.rows.slice(hIdx + 1);
  const grp = hIdx > 0 ? p.rows[hIdx - 1] : null;
  eq(t.f + ' idCol', guessField(headers, 'trackingId', data, grp), t.id);
  eq(t.f + ' titleCol', guessField(headers, 'spotTitle', data, grp), t.title);
  eq(t.f + ' fillBack#', fillBackColumns(headers, grp).length, t.fb);
  eq(t.f + ' pending', pendingRowIndices(live(data), fillBackColumns(headers, grp)).length, t.pending);
});

// ---------- Email extraction fixtures ----------
// Tatari: brand_slug + code line pairs
eq('tatari codes', extractCodes('almedia_freecash\nAFCBQEV115H\nalmedia_freecash\nAFCBQEV130H\nkiwico\nKIHPTTV130H'),
  ['AFCBQEV115H', 'AFCBQEV130H', 'KIHPTTV130H']);
// Cuebiq: underscore codes
eq('cuebiq codes', extractCodes('GTC2328702\nVIA_93889\nVIA_93881'), ['GTC2328702', 'VIA_93889', 'VIA_93881']);
// Chief Media: same-line code + title
eq('chief pairs', extractCodeTitlePairs('FRGPATLRN30H          Fragrance Patricia Learn More 30\nFRGMELLRN60H         Fragrance Melissa Learn More 60'),
  [{ id: 'FRGPATLRN30H', title: 'Fragrance Patricia Learn More 30' }, { id: 'FRGMELLRN60H', title: 'Fragrance Melissa Learn More 60' }]);
// AMC: row#/title/code/link/:len per spot
eq('amc spot', extractSpotBlocks('2887\nAMC YAGA S1- Tease :10\nS02439406001\nhttps://creativehub.amcnetworks.com/Share/x\n:10'),
  [{ id: 'S02439406001', title: 'AMC YAGA S1- Tease :10', row: 2887, url: 'https://creativehub.amcnetworks.com/Share/x', len: '10' }]);
// Warner theatrical: title-line then code-line under film headers
eq('wb spots', extractSpotBlocks('Clayface\nWRCA75B3000H\nMonster Rev 30\nWRCA47B3000H').map(s => [s.id, s.title]),
  [['WRCA75B3000H', 'Clayface'], ['WRCA47B3000H', 'Monster Rev 30']]);
// USN: table row = code + short column text; link on next line
{
  const s = extractSpotBlocks('adid\ncampaign\ncreative_name\n\nNTUR3388000H 10/20 START\nhttps://v5media.dmds.com/x/y.mp4?h=1');
  eq('usn spot', s.length === 1 ? [s[0].id, s[0].title, s[0].url] : s, ['NTUR3388000H', '10/20 START', 'https://v5media.dmds.com/x/y.mp4?h=1']);
}
// NFL: title/initiative/title/link/code - link BEFORE the code
{
  const s = extractSpotBlocks('NFL SHOP STYLE BUFFET :15 HD\nSHOP\nNFL SHOP STYLE BUFFET :15 HD\n[f.mp4](https://nflit.sharepoint.com/x/f.mp4)\nCOPR1502615H');
  eq('nfl spot', s.length === 1 ? [s[0].id, s[0].title, s[0].url] : s, ['COPR1502615H', 'NFL SHOP STYLE BUFFET :15 HD', 'https://nflit.sharepoint.com/x/f.mp4']);
}
// Empire: title/code/:len/date column lines
{
  const s = extractSpotBlocks('70% OFF Flooring - :30 - OG Jingle + Contact - TV\nEMPR0158000H\n:30\n10/17/2026');
  eq('empire spot', s.length === 1 ? [s[0].id, s[0].title, s[0].len] : s, ['EMPR0158000H', '70% OFF Flooring - :30 - OG Jingle + Contact - TV', '30']);
}
// Horizon row refs: comma thousands, 'lines'/'rows' synonyms, ranges
eq('refs lines comma', extractRowRefs('NEXT tab lines 13,286-13,289'), [13286, 13287, 13288, 13289]);
eq('refs rows range', extractRowRefs('(rows 13294 - 13297)'), [13294, 13295, 13296, 13297]);
eq('refs lines', extractRowRefs('(lines 13290 - 13293)'), [13290, 13291, 13292, 13293]);
eq('refs list', extractRowRefs('rows 1857, 1860'), [1857, 1860]);
eq('refs none', extractRowRefs('please ingest these spots'), []);

// matchEmailToSheet: broadcast slot labels in the File Name column ("NEXT",
// "DDT", "LINK") must not substring-match everyday email words like
// "NEXT tab" - that false-positive used to pull whole 2021-era row blocks
// (and their dead ql.mediasilo links) into every Horizon request.
{
  const cols = { id: 5, title: 2, file: 0, link: 3, brand: 4, access: -1, espn: 6, date: 9 };
  const rows = [
    ['NEXT', 'The Oval', 'Season2 Launch Trailer', 'https://ql.mediasilo.com/ql/x', 'BET', 'ITO013:', '', ':15', 'Horizon Media', '2/12/2021'],
    ['TO230STH.mp4', 'The Oval', 'THE OVAL', 'db', 'BET', 'TO230STH', '', ':30', 'Horizon Media', '2/12/2021'],
  ];
  const horizonEmail = 'Please ingest the new Good Feet spots outlined on NEXT tab lines 13,286-13,289. XR sent the spots on 10/9.';
  const m1 = matchEmailToSheet(horizonEmail, rows, cols, { headerRow: 1 });
  eq('next fileName no false match', m1.filter(m => m.matchType === 'FILE' || m.matchType === 'ID').length, 0);
  const m2 = matchEmailToSheet('please grab TO230STH today', rows, cols, { headerRow: 1 });
  eq('code still matches', m2.filter(m => m.matchType === 'ID').map(m => m.id), ['TO230STH']);
}

// Clue-finding fallback: vague email -> pending rows scored by shared
// tokens + request date; no clues -> newest pending rows surface anyway.
{
  const cols = { id: 5, title: 2, file: 0, link: 3, brand: 4, access: -1, espn: 6, date: 9 };
  const rows = [
    ['', 'x', 'Good Feet Winter Sale :30', '', 'Good Feet', 'GFXR2026074H', '', '', '', '10/13/2026'],
    ['', 'x', 'SeaWorld Halloween :15', '', 'SeaWorld', 'VSWT6148000H', '', '', '', '10/13/2026'],
    ['', 'x', 'Old Ingested Spot', '', 'BET', 'OLDCODE01H', '', '', '', '1/1/2020'],
  ];
  const vague = 'Hi - we have new Good Feet spots for ingest, sent 10/13. Thanks';
  const g = matchEmailToSheet(vague, rows, cols, { headerRow: 1, pendingIdx: [0, 1, 2] });
  eq('guess all tagged', g.every(m => m.matchType === 'GUESS'), true);
  eq('guess best is goodfeet', g.map(m => m.id), ['GFXR2026074H']);
  const none = matchEmailToSheet('new spots ready', rows, cols, { headerRow: 1, pendingIdx: [0, 1, 2] });
  eq('no clues -> pending surface', none.length > 0 && none.every(m => m.matchType === 'GUESS'), true);
  const explicit = matchEmailToSheet('ingest GFXR2026074H', rows, cols, { headerRow: 1, pendingIdx: [0, 1, 2] });
  eq('explicit still wins', explicit.filter(m => m.matchType !== 'GUESS').map(m => m.id), ['GFXR2026074H']);
}

// latestSegment: pasted threads only extract from the newest message
{
  const thread = 'Hi Tim\nPlease ingest these.\nNEWCODE123H\n\nFrom: Tim Blair <Tim.Blair@vizio.com>\nSent: Friday\nSubject: Re: req\nIngested OLDCODE456H thanks';
  eq('segment codes', extractCodes(latestSegment(thread)), ['NEWCODE123H']);
  const g = 'body\nCODE1234H\nOn Mon, Oct 12, 2026 at 7:53 AM Tim Blair <t@vizio.com> wrote:\nOLD5678H';
  eq('segment gmail', extractCodes(latestSegment(g)), ['CODE1234H']);
  const single = 'From: nikon@iconmediadirect.com\nSubject: Vizio - Ingestion\nHi Team\nCODE7777H';
  eq('segment untouched', latestSegment(single).length, single.length);
}

// ---------- Client detection ----------
const detect = (subject, emailText) => { const h = detectClient({ subject, emailText }); return h ? h.id : null; };
eq('detect tatari', detect('[EXTERNAL] Tatari Creatives w.o 10/12/2026', 'From: daniel.tarr@tatari.tv'), 'tatari');
eq('detect good-feet', detect('[EXTERNAL] Good Feet Moore - Kinetic Dynamics Inscape Ingestion Request', 'From: tgrimes@horizonmedia.com'), 'good-feet');
eq('detect empire', detect('[EXTERNAL] RE: Empire Today New Creatives - Ingest & Fingerprint', 'From: ASime@horizon-next.com'), 'empire-today');
eq('detect seaworld', detect('[EXTERNAL] SeaWorld Inscape Ingestion Request 10/9/26', 'From: CFortmuller@horizon-next.com'), 'seaworld');
eq('detect nfl', detect('[EXTERNAL] RE: Inscape Fingerprinting - NFL FY26', 'From: Anthony.Magliaro@nfl.com'), 'nfl');
eq('detect amcn', detect('[EXTERNAL] AMCN Inscape Fingerprinting', 'From: nipatel@horizonmedia.com'), 'amcn');
eq('detect wb-theatrical', detect('[EXTERNAL] RE: WB Theatrical Spots for Inscape', 'From: naleesa.hernandez@omc.com To: Suzie.Downing@wbd.com'), 'wb-theatrical');
eq('detect wbd-usn', detect('[EXTERNAL] WBD USN X INSCAPE GRID | 10/13 REVIEW | CNN', 'From: jasmine.bocanegra@publicismedia.com To: Katie.Morrissey@wbdcontractor.com'), 'wbd-usn');
eq('detect icon', detect('[EXTERNAL] Vizio - Ingestion', 'From: nikon@iconmediadirect.com'), 'icon-media');
eq('detect sheet->umbrella', (() => { const h = detectClient({ sheetId: '1zPD9LkK_SzWYDhGYRKAwR-eWLIkS-SENRkNvWFdZugQ' }); return h ? h.id : null; })(), 'horizon-next');

// ---------- Inline code extraction (prose-embedded IDs) ----------
{
  const prose = 'Can you ingest BP569205-05 and ITO013: for the Oval? Also TO230STH thanks';
  eq('inline sep codes', extractCodes(prose), ['BP569205-05', 'ITO013', 'TO230STH']);
  eq('quarter not a code', extractCodes('the Q4-2025 report'), []);
  eq('word not a code', extractCodes('the NEXT tab lines are cited'), []);
  eq('code with colon tail', extractCodes('ingest ITO013: please'), ['ITO013']);
}

// ---------- Reconcile: partial-code degradation ----------
{
  const r = reconcile(['TO230STH'], ['TO230ST Launch :30.mp4', 'UNREL9X File.mp4']);
  eq('partial code flags possible', r.results[0].status, 'POSSIBLE MATCH');
  eq('partial code matched file', r.results[0].matched, 'TO230ST Launch :30.mp4');
  const exact = reconcile(['KARM0307000H'], ['KARM0307000H Switch Up.mp4']);
  eq('full code still found', exact.results[0].status, 'FOUND');
  const miss = reconcile(['ZZZZ9999H'], ['KARM0307000H Switch Up.mp4']);
  eq('unrelated still missing', miss.results[0].status, 'MISSING');
}

console.log('==============================');
console.log(pass + ' passed, ' + fail + ' failed');
failures.forEach(f => console.log('FAIL: ' + f));
if (fail) throw new Error(fail + ' fixture(s) failed');
