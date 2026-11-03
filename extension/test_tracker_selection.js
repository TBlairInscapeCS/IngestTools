const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/sidepanel.js', 'utf8');
const clients = fs.readFileSync(__dirname + '/clients.js', 'utf8');
const names = ['trackerDocId', 'pickTrackerTab', 'docOwner', 'foreignDoc', 'trackerAllowed', 'cleanTrackerReferences', 'trackerDocumentTitle', 'loadSheetDoc', 'refreshSheet', 'rememberSheet'];
const functions = names.map(name => {
  const re = new RegExp('(?:async )?function ' + name + '\\(');
  const start = source.search(re);
  assert(start >= 0, name);
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end);
}).join('\n');
let passed = 0;
function setup() {
  const store = {};
  const commits = [];
  const logs = [];
  let calls = 0;
  const ctx = vm.createContext({
    console, URL, Promise, store, commits, logs,
    client: null, lastSheetRef: null, docBrandsCache: {}, sheetSourceTab: null,
    sheetBuf: null, sheetTabs: [], sheetTabName: '', scoreCache: {},
    request: 1,
    trackerContext() { return ctx.request + ':' + (ctx.client && ctx.client.id); },
    topName(c) { return c.name.split(' / ')[0].replace(/ *\(.*/, '').trim(); },
    sheetIdsFor(c) { return c && c.detect && c.detect.sheetIds || []; },
    emailSheetRefs() { return []; },
    dbg(...args) { logs.push(args); }, toast() {}, modStat() {}, setStage() {}, mineDocBrands() {},
    loadSheetRows(wb) { commits.push({ client: ctx.client.id, doc: ctx.lastSheetRef.id, wb }); },
    loadSheetText(text) { commits.push({ client: ctx.client.id, doc: ctx.lastSheetRef.id, text }); },
    fetch: async () => { calls++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'ID\nABC123' }; },
    readXlsx: async () => ({ sheetName: 'Campaign Tracker', sheetNames: ['Campaign Tracker'], rows: [] }),
    chrome: { tabs: { query: async () => [] }, storage: { local: {
      get(keys, cb) { cb(store); },
      async set(values) { Object.assign(store, values); },
      async remove(key) { delete store[key]; },
    } } },
  });
  vm.runInContext(clients + '\nthis.clients = CLIENTS;', ctx);
  vm.runInContext(functions, ctx);
  ctx.client = ctx.clients.find(c => c.id === 'inmarket');
  const horizon = ctx.clients.find(c => c.detect && (c.detect.sheetIds || []).length && /Horizon/.test(c.name));
  assert(horizon, 'Horizon fixture must use a real registered workbook');
  return { ctx, store, commits, calls: () => calls, own: ctx.client.detect.sheetIds[0], foreign: horizon.detect.sheetIds[0] };
}
async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
(async () => {
  await test('open InMarket tab beats focused Horizon and tab order', async () => {
    const { ctx, own, foreign } = setup();
    const tabs = [{ id: 1, title: 'Horizon Next Tracker', url: 'https://docs.google.com/spreadsheets/d/' + foreign },
      { id: 2, title: 'Campaign Tracker', url: 'https://docs.google.com/spreadsheets/d/' + own }];
    assert.equal(ctx.pickTrackerTab(tabs, 1).id, 2);
    assert.equal(ctx.pickTrackerTab(tabs.reverse(), 1).id, 2);
  });
  await test('shared Google host alone never qualifies unrelated tabs', async () => {
    const { ctx } = setup();
    assert.equal(ctx.pickTrackerTab([{ id: 1, title: 'Other tracker', url: 'https://docs.google.com/spreadsheets/d/unknown' }], 9), null);
  });
  await test('foreign workbook blocked before any network or commit', async () => {
    const { ctx, foreign, calls, commits } = setup();
    assert.equal(await ctx.loadSheetDoc(foreign, 0, '', 'open tab'), false);
    assert.equal(calls(), 0);
    assert.equal(commits.length, 0);
  });
  await test('correct auto-load cannot be overwritten by Horizon tab load', async () => {
    const { ctx, own, foreign, commits } = setup();
    assert.equal(await ctx.loadSheetDoc(own, 0, '', 'InMarket tracker'), true);
    assert.equal(await ctx.loadSheetDoc(foreign, 0, '', 'Horizon Next Tracker'), false);
    assert.equal(commits.length, 1);
    assert.equal(ctx.lastSheetRef.id, own);
  });
  await test('request changed during workbook parsing discards late result', async () => {
    const { ctx, own, commits } = setup();
    ctx.readXlsx = async () => { ctx.request++; return { sheetName: 'old', rows: [] }; };
    assert.equal(await ctx.loadSheetDoc(own, 0, '', 'late load'), false);
    assert.equal(commits.length, 0);
  });
  await test('client changed during fetch discards late result', async () => {
    const { ctx, own, commits } = setup();
    ctx.readXlsx = async () => { ctx.client = ctx.clients.find(c => c.id === 'comscore'); return { rows: [] }; };
    assert.equal(await ctx.loadSheetDoc(own, 0, '', 'late client'), false);
    assert.equal(commits.length, 0);
  });
  await test('cleanup removes foreign memories and cache without deleting valid refs', async () => {
    const { ctx, store, own, foreign } = setup();
    store.sheetByClient = { inmarket: [{ id: foreign }, { id: own }], comscore: { id: foreign } };
    store.msLastSheet = { id: foreign };
    store.docBrands = { [foreign]: { client: 'inmarket', brands: ['Cracker Barrel'] } };
    await ctx.cleanTrackerReferences();
    assert.equal(store.sheetByClient.inmarket.length, 1);
    assert.equal(store.sheetByClient.inmarket[0].id, own);
    assert.equal(store.sheetByClient.comscore, undefined);
    assert.equal(store.msLastSheet, undefined);
    assert.equal(store.docBrands[foreign], undefined);
  });
  await test('CSV fallback replaces prior refresh handle with the actual workbook', async () => {
    const { ctx, own, foreign, commits } = setup();
    ctx.lastSheetRef = { id: foreign };
    ctx.readXlsx = async () => { throw new Error('xlsx unavailable'); };
    assert.equal(await ctx.loadSheetDoc(own, 7, '', 'csv fallback'), true);
    assert.equal(ctx.lastSheetRef.id, own);
    assert.equal(commits[0].doc, own);
  });
  await test('Run all waits for email auto-load instead of racing an open tab', async () => {
    const { ctx, own, foreign } = setup();
    const marker = "bindUiAction('runAll', async () => {";
    const start = source.indexOf(marker) + marker.length;
    const body = source.slice(start, source.indexOf('\n});', start));
    let release;
    let grabs = 0;
    let matches = 0;
    Object.assign(ctx, {
      sheet: null,
      emailEl: { value: 'InMarket request rows 1870 - 1872' },
      fetchExceptions() {},
      stageTabs: async () => ({ outlook: [], sheet: [{ id: 1, title: 'Horizon Next Tracker', url: 'https://docs.google.com/spreadsheets/d/' + foreign }], sharepoint: [], airtable: [] }),
      activeTab: async () => ({ id: 1 }), pickTab: () => null,
      emailOnly: () => false, emailSharePointUrls: () => [],
      grabTrackerTab: async () => { grabs++; return false; }, resolveSheetLinks: async () => false,
      doMatch: async () => { matches++; assert.equal(ctx.lastSheetRef.id, own); return true; },
      selectedMatches: () => [], autoDownload: async () => {},
      trackerLoadPending: new Promise(resolve => { release = resolve; }),
    });
    const run = vm.runInContext('(async () => {' + body + '\n})()', ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(matches, 0, 'must not match before the pending tracker finishes');
    ctx.sheet = {};
    ctx.lastSheetRef = { id: own };
    release(true);
    await run;
    assert.equal(grabs, 0);
    assert.equal(matches, 1);
  });
  await test('learned Horizon brand workbook is also blocked for InMarket', async () => {
    const { ctx, calls } = setup();
    const horizon = ctx.clients.find(c => /Horizon/.test(c.name));
    ctx.docBrandsCache = { learnedHorizonBrand: { client: horizon.id, brands: ['Example'] } };
    assert.equal(await ctx.loadSheetDoc('learnedHorizonBrand', 0, '', 'brand'), false);
    assert.equal(calls(), 0);
  });
  await test('background refresh cannot reintroduce a Horizon workbook', async () => {
    const { ctx, foreign, calls, commits } = setup();
    ctx.lastSheetRef = { id: foreign, gid: 0 };
    assert.equal(await ctx.refreshSheet(true), false);
    assert.equal(calls(), 0);
    assert.equal(commits.length, 0);
  });
  await test('Horizon denied for every registered non-Horizon customer', async () => {
    const { ctx, foreign, calls } = setup();
    const owner = ctx.docOwner(foreign);
    for (const c of ctx.clients.filter(c => ctx.topName(c) !== ctx.topName(owner))) {
      ctx.client = c;
      assert.equal(await ctx.loadSheetDoc(foreign, 0, '', 'cross-client matrix'), false, c.id);
    }
    assert.equal(calls(), 0);
  });
  await test('document title comes from the exact workbook tab, not its neighbor', async () => {
    const { ctx, own, foreign } = setup();
    ctx.chrome.tabs.query = async () => [
      { title: 'Horizon Next / Inscape Creative Request Tracker - Google Sheets', url: 'https://docs.google.com/spreadsheets/d/' + foreign },
      { title: 'InMarket Creative Request Tracker - Google Sheets', url: 'https://docs.google.com/spreadsheets/d/' + own },
    ];
    assert.equal(await ctx.loadSheetDoc(own, 0, '', 'InMarket tracker'), true);
    assert.equal(ctx.lastSheetRef.documentTitle, 'InMarket Creative Request Tracker');
    assert.equal(ctx.lastSheetRef.tabName, 'Campaign Tracker');
  });
  await test('workbook title metadata is used when no browser tab is open', async () => {
    const { ctx, own } = setup();
    assert.equal(await ctx.trackerDocumentTitle(own, { documentTitle: 'InMarket workbook' }), 'InMarket workbook');
  });
  console.log(passed + ' tracker integration tests passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
