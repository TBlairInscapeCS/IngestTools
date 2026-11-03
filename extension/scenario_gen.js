// QA fixture generator: builds a randomized ingest-request scenario
// (client, email, multi-tab workbook, expected match outcome) from a
// seed, then validates it against the real engine - detectHeaderRow and
// matchEmailToSheet - so every generated fixture proves the pipeline
// resolves it. Pure engine level: no DOM, no chrome.
//
//   node scenario_gen.js            - one random scenario, human summary
//   node scenario_gen.js --seed 42  - reproducible scenario
//   node scenario_gen.js --seed 42 --json
//   node scenario_gen.js --sweep 50 - validate N seeds, print failure list
//
// The JSON shape mirrors what the stress harness consumes: workbook.tabs
// holds {rows, links} per tab, `expected` states which tab/IDs/rows the
// request should match.

const fs = require('node:fs');
const vm = require('node:vm');

// ---------- seeded rng ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const rint = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---------- ingredient pools ----------
const CLIENTS = [
  { name: 'Acme Media', brand: 'Acme', idfmt: 'isci', tick: '_t' },
  { name: 'BrandCo North', brand: 'BrandCo', idfmt: 'isci', tick: '_tk' },
  { name: 'Northstar Ads', brand: 'Northstar', idfmt: 'num', tick: '_t' },
  { name: 'Kilo Partners', brand: 'Kilo', idfmt: 'alpha', tick: '_t' },
  { name: 'Vela Group', brand: 'Vela', idfmt: 'comscore', tick: '_t' },
  { name: 'Quill Sports', brand: 'Quill', idfmt: 'qyps', tick: '_t' },
  { name: 'Sable Pics', brand: 'Sable', idfmt: 'spx', tick: '_t' },
  { name: 'Ion Trails', brand: 'Ion', idfmt: 'colon', tick: '_t' },
  { name: 'Tempo One', brand: 'Tempo', idfmt: 'mp4ish', tick: '_t' },
];
// ID shapes mirror what real trackers carry - every one fictional.
const IDMAKERS = {
  isci: r => pick(r, 'ABCDEFGHKLMNPQRSTUVWXYZ'.split('')) + pick(r, 'ABCDEFGHKLMNPQRSTUVWXYZ'.split('')) +
    pick(r, 'ABCDEFGHKLMNPQRSTUVWXYZ'.split('')) + pick(r, 'ABCDEFGHKLMNPQRSTUVWXYZ'.split('')) +
    String(rint(r, 1, 9999999)).padStart(7, '0') + 'H',
  num: r => String(rint(r, 10000000, 999999999)),
  alpha: r => 'KV' + String(rint(r, 100, 999)) + 'X' + String(rint(r, 1000, 9999)),
  comscore: r => 'p' + rint(r, 100000000000, 999999999999) + '_' + rint(r, 1000, 9999),
  qyps: r => 'QY' + pick(r, 'PSKLM'.split('')) + '0' + String(rint(r, 100000, 999999)) + 'H',
  spx: r => 'SP' + pick(r, 'XBQZ'.split('')) + '4' + String(rint(r, 100000, 999999)) + 'H',
  colon: r => pick(r, ['ITO', 'KTO', 'ZTR']) + String(rint(r, 10, 999999)) + ':',
  mp4ish: r => pick(r, ['TO', 'ZN', 'KR']) + String(rint(r, 100, 999)) + pick(r, ['ST', 'HD', 'BN']) + 'H',
};
const HEADER_SETS = [
  { id: 'Tracking ID', title: 'Spot Title', date: 'Request Date', file: 'File Name', link: 'Link', brand: 'Brand', done: 'Ingest Complete Date', by: 'Completed By' },
  { id: 'ISCI', title: 'Title', date: 'Flight Start', file: 'Filename', link: 'Drive Link', brand: 'Advertiser', done: 'Completed By', by: 'Ingest Date' },
  { id: 'Spot ID', title: 'Creative Name', date: 'Date', file: 'File', link: 'URL', brand: 'Client', done: 'Ingest Complete', by: 'Ingester' },
  { id: 'Ad ID', title: 'Spot Name', date: 'Start Date', file: 'Media File', link: 'Download', brand: 'Brand', done: 'Ingested Date', by: 'Completed By' },
];
const ID_TYPES = ['rows', 'codes', 'files', 'mixed', 'vague'];
const TITLES = ['Holiday :30', 'Spring Launch :15', 'Summer Sale :30', 'Back to School :60',
  'Q4 Brand Anthem', 'Retarget :15', 'Awareness :30', 'Local Hero :30'];

function genScenario(seed) {
  const r = rng(seed);
  const client = pick(r, CLIENTS);
  const H = pick(r, HEADER_SETS);
  const idType = pick(r, ID_TYPES);
  const sender = pick(r, ['Sam', 'Jordan', 'Priya', 'Marcus', 'Elena', 'Dev', 'Aiko', 'Ren', 'Pat', 'Quinn']);

  // --- workbook: 1-4 tabs, one holds the request ---
  const nTabs = rint(r, 1, 4);
  const tabPool = ['Master Tracker', client.brand + ' Q4 2026', client.brand + ' Q1 2025', 'Archive 2023',
    'NEXT', 'Shared ' + client.brand, '2026 Ingest', client.brand + ' Spots', 'S1 ' + client.brand];
  const tabNames = tabPool.slice(0, nTabs);
  const reqTab = tabNames[rint(r, 0, nTabs - 1)];
  const tabs = {};
  const totalRows = rint(r, 200, 4000);
  const banner = rint(r, 0, 3); // banner rows above the header
  const usedIds = new Set();
  const mkid = () => { let id; do { id = IDMAKERS[client.idfmt](r); } while (usedIds.has(id)); usedIds.add(id); return id; };
  tabNames.forEach(name => {
    const n = name === reqTab ? totalRows : rint(r, 50, 300);
    const rows = [];
    for (let b = 0; b < banner; b++) rows.push(['', '', '', '', '', '', '', '']);
    rows.push([H.id, H.title, H.date, H.file, H.link, H.brand, H.done, H.by]);
    const links = {};
    const old = name !== reqTab;
    for (let i = 1; i <= n; i++) {
      const id = mkid();
      const date = old ? '3/' + rint(r, 1, 28) + '/2024' : rint(r, 9, 10) + '/' + rint(r, 1, 30) + '/2026';
      const done = old || r() < 0.7 ? date : '';       // ~30% of live-tab rows pending
      const by = done ? 'ops' : '';
      rows.push([id, pick(r, TITLES) + ' ' + i, date, id.toLowerCase().replace(/[:;]/g, '') + '.mp4', '', client.brand, done, by]);
      if (!old && r() < 0.3) links[rows.length - 1 + ',4'] = 'https://files.example.com/dl/' + id.toLowerCase().replace(/[:;]/g, '') + '.mp4';
    }
    tabs[name] = { rows, links };
  });

  // --- the request block on the request tab ---
  const t = tabs[reqTab];
  const headerRow = banner + 1;                 // 1-based
  const liveEnd = t.rows.length;
  const nReq = rint(r, 2, 12);
  const startRow = r() < 0.7 ? Math.max(headerRow + 2, liveEnd - nReq - rint(r, 0, 20))
                             : rint(r, headerRow + 2, liveEnd - nReq);
  const reqRows = [];
  for (let i = 0; i < nReq; i++) reqRows.push(startRow + i);
  const reqIds = reqRows.map(row => t.rows[row - 1][0]);
  // mark request rows fresh + pending
  reqRows.forEach((row, i) => {
    const r_ = t.rows[row - 1];
    r_[2] = '10/' + rint(r, 28, 31) + '/2026';
    r_[6] = ''; r_[7] = '';
  });
  const stray = mkid();      // cited but on no tab
  const ghost = mkid();      // cited, on tab but outside block
  const ghostRow = rint(r, headerRow + 2, Math.max(headerRow + 3, startRow - 10));
  if (ghostRow < startRow) t.rows[ghostRow - 1][0] = ghost;

  // --- email ---
  const greet = pick(r, ['Hi Tim', 'Hey team', 'Hello', 'Hi', 'Good morning', 'Tim -']);
  const sign = 'Thanks!\n' + sender;
  const comma = n => n.toLocaleString('en-US');
  const cite = {
    rows: r() < 0.3 ? 'lines ' + comma(startRow) + '-' + comma(startRow + nReq - 1)
                    : 'rows ' + startRow + '-' + (startRow + nReq - 1),
    codes: reqIds.slice(0, Math.min(nReq, 6)).join(', '),
    files: r() < 0.5
      ? reqIds.slice(0, Math.min(nReq, 5)).map(id => id.toLowerCase().replace(/[:;]/g, '') + '.mp4').join('\n')
      : 'File Name\n' + reqIds.slice(0, Math.min(nReq, 5)).map(id => id.toLowerCase().replace(/[:;]/g, '') + '.mp4').join('\n'),
    mixed: 'rows ' + startRow + '-' + (startRow + Math.floor(nReq / 2) - 1) + ', plus ' + ghost + ' and ' + stray,
    vague: '',
  }[idType];
  const asks = {
    rows: r() < 0.3
      ? 'Please ingest the new ' + client.brand + ' spots outlined on ' + reqTab.split(' ')[0] + ' tab ' + cite + '.'
      : 'Please ingest the ' + client.brand + ' spots on ' + cite + '.',
    codes: pick(r, [
      'Please ingest: ' + cite + (r() < 0.5 ? '\nAlso ' + stray : ''),
      'New ' + client.brand + ' creatives to ingest:\n' + cite,
      'When you get a chance, ingest ' + cite,
    ]),
    files: pick(r, [
      'New files for ' + client.brand + ':\n' + cite,
      'New Commercials Uploaded\n' + cite,
      'New Media Available\n' + reqIds.slice(0, Math.min(nReq, 5)).map(id => id.toLowerCase() + '.mp4 Download').join('\n'),
    ]),
    mixed: 'Please ingest the ' + client.brand + ' spots on ' + cite + '.',
    vague: pick(r, [
      'Please ingest the new ' + client.brand + ' spots on the tracker.',
      'The ' + client.brand + ' batch is ready on the tracker - please ingest.',
      'New ' + client.brand + ' rows added, same process as usual.',
    ]),
  }[idType];
  const email = greet + ',\n\n' + asks + '\n' + sign +
    (r() < 0.25 ? '\n\nFrom: someone@' + client.brand.toLowerCase() + '.com\nSent: last week\n' + greet + ',\nold request, already done' : '');

  // --- expected outcome ---
  // Row-cited halves: 'mixed' cites only the first half of the block plus
  // the ghost code; 'vague' cites nothing (GUESS candidates, not matches).
  const rowCited = idType === 'mixed' ? Math.floor(nReq / 2) : nReq;
  const expected = {
    tab: reqTab,
    matchRows: idType === 'rows' || idType === 'mixed' ? reqRows.slice(0, rowCited) : [],
    matchIds: idType === 'codes' ? reqIds.slice(0, Math.min(nReq, 6))
      : idType === 'files' ? reqIds.slice(0, Math.min(nReq, 5))
      : idType === 'mixed' ? reqIds.slice(0, rowCited)
      : [],
    headerRow,
    citedAbsent: idType === 'mixed' || idType === 'codes' ? [stray] : [],
    citedUnmatched: idType === 'mixed' ? [ghost] : [],
  };

  return { seed, client: client.name, idType, sender, email,
    workbook: { tabs: () => undefined, sheetNames: tabNames, sheets: tabs },
    expected };
}

// ---------- validation against the real engine ----------
const model = vm.createContext({});
vm.runInContext(fs.readFileSync(__dirname + '/engine.js', 'utf8'), model);

function validate(sc) {
  const errs = [];
  const t = sc.workbook.sheets[sc.expected.tab];
  const hdrRow = model.detectHeaderRow(t.rows);           // 0-based
  if (hdrRow + 1 !== sc.expected.headerRow)
    errs.push('headerRow detected ' + (hdrRow + 1) + ' != generated ' + sc.expected.headerRow);
  const headers = t.rows[hdrRow];
  const cols = {
    id: headers.indexOf(headers.find(h => /id|isci/i.test(h))),
    title: headers.findIndex(h => /title|name/i.test(h)),
    file: headers.findIndex(h => /file|media/i.test(h)),
    link: headers.findIndex(h => /link|url|drive|download/i.test(h)),
    brand: headers.findIndex(h => /brand|advertiser|client/i.test(h)),
    date: headers.findIndex(h => /date|flight|start/i.test(h)),
    access: -1, espn: -1,
  };
  const fresh = model.matchEmailToSheet(
    model.latestSegment(sc.email), t.rows.slice(hdrRow + 1), cols, { headerRow: hdrRow + 1 });
  const gotIds = fresh.map(m => m.id).filter(Boolean);
  const gotRows = fresh.filter(m => /^ROW/.test(m.matchType || '')).map(m => m.row);
  if (sc.expected.matchIds.length) {
    const want = new Set(sc.expected.matchIds);
    const hit = gotIds.filter(id => want.has(id)).length;
    if (hit < Math.min(2, want.size)) errs.push('only ' + hit + '/' + want.size + ' expected IDs matched: ' + gotIds.slice(0, 6).join(','));
  }
  if (sc.expected.matchRows.length) {
    const want = new Set(sc.expected.matchRows);
    const hit = gotRows.filter(x => want.has(x)).length;
    if (hit < Math.min(2, want.size)) errs.push('only ' + hit + '/' + want.size + ' expected rows matched');
  }
  return errs;
}

// ---------- cli ----------
const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--sweep')) {
  const n = parseInt(arg('--sweep'), 10) || 50;
  let bad = 0;
  for (let s = 1; s <= n; s++) {
    const sc = genScenario(s);
    const errs = validate(sc);
    if (errs.length) { bad++; console.log('seed ' + s + ' [' + sc.client + '/' + sc.idType + ']: ' + errs.join('; ')); }
  }
  console.log(n + ' scenarios, ' + bad + ' failed validation');
  process.exitCode = bad ? 1 : 0;
} else {
  const seed = parseInt(arg('--seed'), 10) || Math.floor(Math.random() * 1e9);
  const sc = genScenario(seed);
  const errs = validate(sc);
  if (args.includes('--json')) {
    console.log(JSON.stringify(sc, (k, v) => k === 'tabs' ? undefined : v, 2));
  } else {
    console.log('seed ' + sc.seed + ' · ' + sc.client + ' · idType=' + sc.idType + ' · sender=' + sc.sender);
    console.log('tabs: ' + sc.workbook.sheetNames.map(n =>
      n + '(' + sc.workbook.sheets[n].rows.length + (n === sc.expected.tab ? '*' : '') + ')').join(' '));
    console.log('expected: tab="' + sc.expected.tab + '" rows=' + sc.expected.matchRows.length +
      ' ids=' + sc.expected.matchIds.length + ' hdr=' + sc.expected.headerRow +
      (sc.expected.citedAbsent.length ? ' absent=' + sc.expected.citedAbsent : '') +
      (sc.expected.citedUnmatched.length ? ' unmatched=' + sc.expected.citedUnmatched : ''));
    console.log('--- email ---\n' + sc.email);
    console.log(errs.length ? 'VALIDATION FAILED: ' + errs.join('; ') : 'validation ok');
    process.exitCode = errs.length ? 1 : 0;
  }
}
