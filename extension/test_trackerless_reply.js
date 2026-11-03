const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/sidepanel.js', 'utf8');
const engine = fs.readFileSync(__dirname + '/engine.js', 'utf8');
const names = ['buildJiraTicket', 'ingestPlan', 'ingestReportIds', 'ingestRealm', 'ingestRealms', 'mergeMatches', 'doEmailMatch', 'presentMatches', 'refreshReply', 'manualReply', 'replyOptions', 'replyRequestIds', 'updateReplyCheck', 'workflowContext', 'rememberWorkflowEvidence', 'workflowReplyText', 'persistJobEvidence', 'hydrateJobEvidence', 'runVerify', 'runReconcile', 'moniker', 'captureDeliveryEmails', 'discoverLocalFiles', 'autoDownload', 'esc', 'guessedCols', 'sheetIndexEntry', 'ensureSheetIndex', 'indexHay', 'sheetTabScores', 'matchTab', 'tabGrid', 'matchGridRow', 'switchSheetTab'];
const functions = names.map(name => {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');
function setup(id = 'comscore') {
  const elements = {};
  const element = key => elements[key] ||= {
    value: key === 'replyKind' ? 'auto' : '', innerHTML: '', textContent: '', open: false,
    classList: { hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; }, toggle() {} },
    closest() { return element('sec6'); }, addEventListener() {},
  };
  const ctx = vm.createContext({
    console, URL, Set, Map, AbortSignal,
    capturedByName: {}, lastExtras: [], lastIngestRecords: [], localDiscovery: null,
    filesEl: { value: '' }, resolveRealm: () => id, fetchRealmRecords: async () => [],
    chrome: { storage: { local: { get: (key, cb) => cb({}), set() {} } } },
    jobSlug: () => '20261028-073600-SimulMedia', modStat() {},
    fetch: async () => ({ ok: true, json: async () => ({ files: [] }) }),
    FI_ALIASES: {}, FI_BASE: '', FI_AUTH: '',
    client: { id, ingest: { tickerSuffix: id === 'comscore' ? '_t' : '_ticker' } },
    sheet: null, sheetTabs: [], sheetTabName: '', sheetSource: '',
    sheetBuf: null, sheetIndex: null, sheetIndexJob: null,
    sheetSourceTab: null, sheetGids: {},
    scoreCache: { key: '', scores: null },
    emailEl: { value: 'New Commercials Uploaded\nFile Name\np717587534861_7145.mp4' },
    idsEl: { value: '' }, emailSpots: [], emailPairs: [], detectedAdvertiser: '',
    emailSender: 'Alex', matched: null, matchedFor: '', matchCols: {},
    yangaroo: null, lastResults: null, specFails: null, replyDirty: false,
    workflowEvidence: new Map(), workflowEvidenceKey: '',
    $: element, tickerAlways: () => id === 'comscore', emailOnly: () => true,
    mergeMatches: rows => rows, selectedMatches: () => (ctx.matched || []).filter(m => !m.excluded),
    sheetRowCell: () => '', sheetRef: () => null,
    checkSpecFails: async () => false, dlChannelName: () => 'delivery service',
    stamp() {}, dbg() {}, toast() {}, setStage() {}, modStatDone() {}, updateReplyCheck() {},
  });
  vm.runInContext(engine + '\n' + functions, ctx);
  // Minimal COLS for guessedCols/sheetIndexEntry - mirrors the real
  // sidepanel COLS (vocab guess + pin), restricted to what tests index.
  ctx.COLS = [
    { key: 'id', guess: (h, rows, grp) => ctx.guessField(h, 'trackingId', rows, grp) },
    { key: 'title', guess: (h, rows, grp) => ctx.guessField(h, 'spotTitle', rows, grp) },
    { key: 'link', guess: h => ctx.guessColumn(h, /link|url|source/i) },
    { key: 'date', guess: h => ctx.guessColumn(h, /date|flight|start/i) },
  ];
  return { ctx, elements, element };
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('Jira creative list excludes the email farewell while the request copy retains it', () => {
  const { ctx } = setup('simulmedia');
  ctx.emailDate = '';
  ctx.emailEl.value = 'Please ingest:\nABC12345H\n\nThanks!\nAlex';
  ctx.emailSpots = ctx.extractSpotBlocks(ctx.emailEl.value);
  ctx.doEmailMatch();
  const ticket = ctx.buildJiraTicket();
  assert.match(ticket.split('\nIngest:')[0], /Thanks!/);
  assert.doesNotMatch(ticket.split('\nIngest:')[1], /Thanks|Alex/);
  assert.match(ticket.split('\nIngest:')[1], /ABC12345H/);
});
test('Yangaroo delivery email attaches links to requested IDs without inventing files', () => {
  const { ctx, element } = setup('simulmedia');
  ctx.emailEl.value = 'New Media Available\nQYPS0437000H Download\nQYPS0438000H Download\nThanks!\nAlex';
  ctx.doEmailMatch();
  // Yangaroo email spots carry urls; presentMatches joins them to m.yangarooUrl
  ctx.yangaroo = { spots: [
    { id: 'QYPS0437000H', title: '', url: 'https://yangaroo.example/dl/qyps0437000h' },
    { id: 'QYPS0438000H', title: '', url: 'https://yangaroo.example/dl/qyps0438000h' },
    { id: 'OTHER999H',   title: '', url: 'https://yangaroo.example/dl/other' },
  ] };
  ctx.presentMatches();
  assert.equal(ctx.matched[0].yangarooUrl, 'https://yangaroo.example/dl/qyps0437000h');
  assert.equal(ctx.matched[1].yangarooUrl, 'https://yangaroo.example/dl/qyps0438000h');
  assert(!ctx.matched.some(m => (m.yangarooUrl || '').includes('other')));
});
test('dual-silo reply lists each file with one commercial cid per realm', () => {
  const { ctx } = setup('vizio-request');
  ctx.client = { id: 'vizio-request', ingest: { cidMap: ['geniusdigital', 'vizio'], dualSilo: true } };
  const reply = ctx.buildSiloReply([
    { reportingId: 'ResidentEvil2026_Clip_01', realm: 'geniusdigital', admin_visible: { cid: 'C(^.~)c_Commercial_geniusdigital-111-aaa' } },
    { reportingId: 'ResidentEvil2026_Clip_01', realm: 'vizio', admin_visible: { cid: 'C(^.~)c_Commercial_vizio-222-bbb' } },
    { reportingId: 'ResidentEvil2026_Clip_02', realm: 'geniusdigital', admin_visible: { cid: 'C(^.~)c_Commercial_geniusdigital-333-ccc' } },
  ], ['geniusdigital', 'vizio'], 'Sarah');
  assert.match(reply, /Hi Sarah/);
  assert.match(reply, /ResidentEvil2026_Clip_01\n\nC\(\^\.\~\)c_Commercial_geniusdigital-111-aaa\n\nC\(\^\.\~\)c_Commercial_vizio-222-bbb/);
  assert.match(reply, /vizio commercial ID still pending/);
  assert.match(reply, /send the vizio ID/);
});
test('explicit row request cannot carry unrelated creatives or ticker flags from earlier sheets', () => {
  const { ctx } = setup('horizon-next');
  ctx.emailEl.value = 'Please ingest rows 13345-13543';
  ctx.matchedFor = ctx.emailEl.value;
  ctx.matched = [{ row: 2, id: 'OLD12345H', trackingId: 'OLD12345H', espn: true }];
  const fresh = [{ row: 13345, id: 'NEW12345H', trackingId: 'NEW12345H', espn: false }];
  ctx.matched = ctx.mergeMatches(fresh);
  const reply = ctx.manualReply('ingest');
  assert.equal(ctx.matched.length, 1);
  assert.match(reply, /NEW12345H/);
  assert.doesNotMatch(reply, /OLD12345H|_ticker/);
});
test('logged ComScore filename completes email match and renders a reply with no sheet', () => {
  const { ctx, element } = setup();
  assert.equal(ctx.doEmailMatch(), true);
  assert.equal(ctx.matched[0].trackingId, 'p717587534861_7145');
  assert.equal(element('replyArea').classList.hidden, false);
  assert.match(element('replyPreview').value, /p717587534861_7145/);
  assert.equal(element('sec6').open, true);
  assert.match(element('replyCheck').innerHTML, /all 1 requested ID/);
});
test('email-only auto draft acknowledges the request without claiming ingest or sheet updates', () => {
  const { ctx, element } = setup();
  ctx.doEmailMatch();
  const reply = element('replyPreview').value;
  assert.match(reply, /Confirming receipt/);
  assert.doesNotMatch(reply, /ingested|sheet|tracker/i);
});
test('redraft before Match recognizes ComScore filename IDs', () => {
  const { ctx, element } = setup();
  ctx.refreshReply(true);
  assert.match(element('replyPreview').value, /p717587534861_7145/);
  assert.equal(element('replyArea').classList.hidden, false);
});
test('explicit ingested variant uses lowercase ComScore ticker suffix without sheet language', () => {
  const { ctx, element } = setup();
  ctx.doEmailMatch();
  element('replyKind').value = 'ingest';
  ctx.refreshReply(true);
  const reply = element('replyPreview').value;
  assert.match(reply, /p717587534861_7145_t\b/);
  assert.doesNotMatch(reply, /_ticker|sheet|tracker/i);
});
test('reconciled ComScore reply respects ticker naming and no-tracker rules', () => {
  const { ctx, element } = setup();
  ctx.doEmailMatch();
  ctx.lastResults = [{ id: 'p717587534861_7145', status: 'FOUND' }];
  ctx.refreshReply(true);
  const reply = element('replyPreview').value;
  assert.match(reply, /p717587534861_7145_t\b/);
  assert.doesNotMatch(reply, /_ticker|sheet|tracker/i);
});
test('email-only match never reads hyperlinks from a stale loaded sheet', () => {
  const { ctx, element } = setup();
  ctx.sheet = { get links() { throw new Error('must not read stale tracker links'); } };
  ctx.doEmailMatch();
  assert.match(element('replyPreview').value, /p717587534861_7145/);
});
test('automatic drafting preserves user edits', () => {
  const { ctx, element } = setup();
  element('replyPreview').value = 'My reviewed reply';
  ctx.replyDirty = true;
  ctx.doEmailMatch();
  assert.equal(element('replyPreview').value, 'My reviewed reply');
  ctx.refreshReply(true);
  assert.match(element('replyPreview').value, /p717587534861_7145/);
});
test('excluded rows are not restored by the filename fallback', () => {
  const { ctx, element } = setup();
  ctx.doEmailMatch();
  ctx.matched[0].excluded = true;
  ctx.refreshReply(true);
  assert.equal(element('replyArea').classList.hidden, true);
});
for (const id of ['simulmedia', 'dataplusmath']) {
  test(id + ' drafts from email without a tracker', () => {
    const { ctx, element } = setup(id);
    ctx.emailEl.value = 'Please ingest ABCD1234000H';
    assert.equal(ctx.doEmailMatch(), true);
    assert.match(element('replyPreview').value, /ABCD1234000H/);
    assert.doesNotMatch(element('replyPreview').value, /sheet|tracker/i);
  });
}
test('all-missing delivery results do not claim files are ingested', () => {
  const { ctx, element } = setup();
  ctx.doEmailMatch();
  ctx.lastResults = [{ id: 'p717587534861_7145', status: 'MISSING' }];
  ctx.refreshReply(true);
  assert.match(element('replyPreview').value, /not.*available/i);
  assert.doesNotMatch(element('replyPreview').value, /I've ingested|we have the files/i);
});
async function asyncTest(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await asyncTest('logged SimulMedia missing results become completed after manual ingest verification', async () => {
    const { ctx, element } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H and QYPS0438000H';
    ctx.doEmailMatch();
    ctx.filesEl.value = 'UNRELATED1234.mp4';
    ctx.runReconcile();
    assert(ctx.lastResults.every(r => r.status === 'MISSING'));
    ctx.fetchRealmRecords = async () => ['QYPS0437000H', 'QYPS0438000H'].map(reportingId => ({ reportingId, status: 'DETECTION_COMPLETED', detection_result: 'pass' }));
    const records = await ctx.runVerify([{ reporting: 'QYPS0437000H' }, { reporting: 'QYPS0438000H' }]);
    assert.equal(records.length, 2);
    assert(ctx.lastResults.every(r => r.status === 'FOUND'));
    assert.match(element('replyPreview').value, /Confirmed ingest for:/);
    assert.doesNotMatch(element('replyPreview').value, /not.*available|waiting to locate/i);
    ctx.filesEl.value = 'STILLUNRELATED1234.mp4';
    ctx.runReconcile();
    assert(ctx.lastResults.every(r => r.status === 'FOUND'), 'later unsuccessful search must not erase ingest proof');
  });
  await asyncTest('failed records are not claimed as successfully ingested', async () => {
    const { ctx, element } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H';
    ctx.doEmailMatch();
    ctx.fetchRealmRecords = async () => [{ reportingId: 'QYPS0437000H', status: 'DETECTION_COMPLETED', detection_result: 'fail' }];
    await ctx.runVerify([{ reporting: 'QYPS0437000H' }]);
    assert.match(element('replyPreview').value, /reported a failure/);
    assert.doesNotMatch(element('replyPreview').value, /Confirmed ingest for/);
  });
  await asyncTest('partial verification distinguishes confirmed from still missing IDs', async () => {
    const { ctx, element } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H and QYPS0438000H';
    ctx.doEmailMatch();
    ctx.fetchRealmRecords = async () => [{ reportingId: 'QYPS0437000H', status: 'DETECTION_COMPLETED' }];
    await ctx.runVerify([{ reporting: 'QYPS0437000H' }, { reporting: 'QYPS0438000H' }]);
    assert.match(element('replyPreview').value, /Confirmed ingest for:\n  - QYPS0437000H/);
    assert.match(element('replyPreview').value, /Still waiting to locate or verify:\n  - QYPS0438000H/);
  });
  await asyncTest('late verification from another request is discarded', async () => {
    const { ctx } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H';
    ctx.doEmailMatch();
    ctx.fetchRealmRecords = async () => { ctx.emailEl.value = 'Different request QYPS0438000H'; return [{ reportingId: 'QYPS0437000H', status: 'DETECTION_COMPLETED' }]; };
    assert.equal((await ctx.runVerify([{ reporting: 'QYPS0437000H' }])).length, 0);
    assert.equal(ctx.workflowEvidence.size, 0);
  });
  await asyncTest('open Comcast delivery captures only request IDs without replacing the request', async () => {
    const { ctx } = setup('simulmedia');
    const request = 'Please ingest QYPS0437000H and QYPS0438000H';
    ctx.emailEl.value = request;
    ctx.doEmailMatch();
    ctx.grabEmailText = () => {};
    ctx.chrome.scripting = { executeScript: async () => [{ result: {
      subject: 'Delivery notification', text: 'Comcast AdDelivery',
      html: '<table>' + ['QYPS0437000H', 'QYPS0438000H', 'OTHER1234000H'].map(id => '<tr><td>' + id + '</td><td><a href="https://cad-api.comcastaddelivery.com/' + id + '"><span>Download Spot</span></a></td></tr>').join('') + '</table>' } }] };
    assert.equal(await ctx.captureDeliveryEmails([{ id: 17 }]), true);
    assert.equal(ctx.emailEl.value, request);
    assert.equal(ctx.client.id, 'simulmedia');
    assert.equal(Object.keys(ctx.capturedByName).length, 2);
    assert(ctx.lastResults.every(r => r.status === 'FOUND'));
    assert(ctx.matched.every(m => /comcastaddelivery/.test(m.link)));
  });
  await asyncTest('local Downloads discovery works without a manifest and promotes availability', async () => {
    const { ctx, element } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H';
    ctx.doEmailMatch();
    ctx.fetch = async (url, options) => {
      assert(url.endsWith('/ingest-discover'));
      assert.deepEqual(JSON.parse(options.body).ids, ['QYPS0437000H']);
      return { ok: true, json: async () => ({ files: [{ id: 'QYPS0437000H', name: 'QYPS0437000H.mp4', kind: 'standard', source: 'Downloads' }], ambiguous: [] }) };
    };
    assert.equal(await ctx.discoverLocalFiles(), true);
    assert.match(element('replyPreview').value, /Files located; ingest is not yet confirmed/);
    assert.doesNotMatch(element('replyPreview').value, /Confirmed ingest for/);
    assert.equal(ctx.lastResults[0].status, 'FOUND');
  });
  await asyncTest('Comcast parser never shifts links across an unlinked spot row', async () => {
    const { ctx } = setup();
    const html = '<table><tr><td>QYPS0437000H</td><td>No download</td></tr><tr><td>QYPS0438000H</td><td><a href="https://comcastaddelivery.com/second">Spot</a></td></tr></table>';
    const spots = ctx.comcastDeliverySpots('Delivery notification', 'Comcast AdDelivery\nQYPS0437000H First HD 00:30\nQYPS0438000H Second HD 00:30', html);
    assert.equal(spots.length, 1);
    assert.equal(spots[0].id, 'QYPS0438000H');
  });
  await asyncTest('Comcast-only search never queries ER or queues downloads', async () => {
    const { ctx, element } = setup('simulmedia');
    ctx.emailEl.value = 'Please ingest QYPS0437000H';
    ctx.doEmailMatch();
    ctx.ensureMatchRows = () => {};
    element('findSource').value = 'comcast';
    ctx.stageTabs = async () => ({ outlook: [{ id: 17 }] });
    ctx.grabEmailText = () => {};
    ctx.fetch = async () => { throw new Error('unexpected ER/local query'); };
    ctx.chrome.scripting = { executeScript: async () => [{ result: { subject: 'Comcast delivery', text: 'Comcast AdDelivery', html: '<tr><td>QYPS0437000H</td><td><a href="https://comcastaddelivery.com/asset">Download</a></td></tr>' } }] };
    await ctx.autoDownload();
    assert.equal(ctx.lastResults[0].status, 'FOUND');
  });
  await asyncTest('Run all can skip discovery and leave manual ingest/verify independent', async () => {
    const { ctx } = setup('simulmedia');
    ctx.client.workflow = { findFiles: false };
    ctx.fetchExceptions = () => {};
    ctx.stageTabs = async () => ({ outlook: [] });
    ctx.activeTab = async () => ({ id: 17 });
    ctx.pickTab = () => null;
    ctx.doMatch = async () => ctx.doEmailMatch();
    ctx.autoDownload = async () => { throw new Error('discovery was disabled'); };
    const marker = "bindUiAction('runAll', async () => {";
    const start = source.indexOf(marker) + marker.length;
    const body = source.slice(start, source.indexOf('\n});', start));
    await vm.runInContext('(async () => {' + body + '\n})()', ctx);
    assert.equal(ctx.matched.length, 1);
  });
  await asyncTest('cross-tab index scores row refs, codes, name overlap and pending', async () => {
    const { ctx } = setup('simulmedia');
    const hdr = ['Tracking ID', 'Spot Title', 'Request Date', 'Ingest Complete Date'];
    const fill = (n, prefix, date) => {
      const rows = [hdr];
      for (let i = 1; i <= n; i++) rows.push([prefix + String(i).padStart(7, '0') + 'H', 'spot ' + i, date, '']);
      return rows;
    };
    const big = [hdr];
    for (let i = 1; i <= 13600; i++) big.push(['SWLD' + String(i).padStart(7, '0') + 'H', 'SeaWorld spot ' + i, '10/20/2026', '']);
    ctx.sheetBuf = new ArrayBuffer(8);
    ctx.sheetTabs = ['2025 Archive', 'SeaWorld'];
    ctx.sheetTabName = '2025 Archive';
    ctx.readXlsxAll = async () => ({ sheetNames: ctx.sheetTabs, sheets: {
      '2025 Archive': { rows: fill(40, 'OLD', '10/20/2024'), links: {} },
      'SeaWorld': { rows: big, links: {} },
    } });
    ctx.emailEl.value = 'Please ingest the SeaWorld spots on rows 13581-13592';
    const rowsCited = [13581, 13582, 13583, 13584, 13585, 13586, 13587, 13588, 13589, 13590, 13591, 13592];
    const scores = await ctx.sheetTabScores([], rowsCited);
    const ranked = [...scores].sort((a, b) => b.hits - a.hits || b.rowHits - a.rowHits || b.score - a.score);
    assert.equal(ranked[0].name, 'SeaWorld');
    assert.equal(ranked[0].rowHits, 12);
    assert.equal(ranked[0].edgeHits, 12); // cited rows sit at the grid's live bottom edge
    assert.equal(ranked[0].nameHits, 1); // 'seaworld' is in the request text
    assert(ranked[0].recency > ranked[1].recency); // 2026 dates beat 2024
    // A code hit outranks every weaker signal: the 40-pending tab loses
    // to the one tab holding the cited ID.
    const scores2 = await ctx.sheetTabScores(['OLD0000001H']);
    const best2 = [...scores2].sort((a, b) => b.hits - a.hits || b.rowHits - a.rowHits || b.score - a.score)[0];
    assert.equal(best2.name, '2025 Archive');
    assert.equal(best2.hits, 1);
  });
  await asyncTest('index entry counts only fill-back-empty pending rows', async () => {
    const { ctx } = setup('simulmedia');
    const e = ctx.sheetIndexEntry('T', { rows: [
      ['Tracking ID', 'Spot Title', 'Request Date', 'Ingest Complete Date'],
      ['AAAA1111111H', 'a', '10/20/2026', ''],
      ['BBBB2222222H', 'b', '10/20/2026', '10/22/2026'],
      ['CCCC3333333H', 'c', '10/21/2026', ''],
    ], links: {} });
    assert.equal(e.headerRow, 0);
    assert.equal(e.pendingCount, 2);
    assert.equal(e.colMap.id, 0);
  });
  await asyncTest('match rows deref their own tab, never whatever is loaded', async () => {
    const { ctx } = setup('simulmedia');
    ctx.sheet = { allRows: [['wrong A'], ['wrong B']], links: {} };
    ctx.sheetTabName = 'Loaded';
    ctx.sheetIndex = new Map([['Sibling', { rows: [['s0'], ['s1'], ['s2'], ['s3'], ['the row']], links: {}, colMap: {} }]]);
    assert.equal(ctx.matchGridRow({ row: 5, tab: 'Sibling' })[0], 'the row');
    assert.equal(ctx.matchGridRow({ row: 2, tab: 'Loaded' })[0], 'wrong B');
    assert.equal(ctx.matchGridRow({ row: 1, tab: 'OtherTracker' }), null);
    assert.equal(ctx.matchTab({ tab: 'Sibling' }), 'Sibling');
    assert.equal(ctx.matchTab({}), 'Loaded');
  });
  await asyncTest('tab switch loads rows from the index without re-parsing', async () => {
    const { ctx } = setup('simulmedia');
    const rows = [['x']];
    ctx.sheetIndex = new Map([['B', { rows, links: {}, colMap: {} }]]);
    ctx.sheetTabName = 'A';
    ctx.readXlsx = async () => { throw new Error('must not re-parse'); };
    ctx.loadSheetRows = wb => { ctx.loaded = wb; };
    await ctx.switchSheetTab('B', 'test');
    assert.equal(ctx.sheetTabName, 'B');
    assert.equal(ctx.loaded.rows, rows);
  });
  console.log(passed + ' trackerless reply/workflow tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
