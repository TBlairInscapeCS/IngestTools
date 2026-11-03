const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const engine = fs.readFileSync(__dirname + '/engine.js', 'utf8');
const source = fs.readFileSync(__dirname + '/sidepanel.js', 'utf8');
const html = fs.readFileSync(__dirname + '/sidepanel.html', 'utf8');
const model = vm.createContext({});
vm.runInContext(engine, model);
const baseline = { request: true, customer: true, emailOnly: true, tracker: false, ids: 2, expected: 2,
  located: 0, local: 0, downloaded: 0, completed: 0, failed: 0, records: 0, fed: 0,
  fillsApplied: false, previewReady: false, skipDiscovery: false };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function decision(overrides) { return model.jobJourneyState({ ...baseline, ...overrides }); }
function setup() {
  const nodes = {}, ancestors = {}, stack = [];
  const voids = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track']);
  let ctx;
  class Element {
    constructor(id, tag, attrs) {
      this.id = id; this.tagName = tag.toUpperCase(); this.attrs = attrs;
      this.value = ''; this.textContent = ''; this.innerHTML = ''; this.disabled = false;
      this.hidden = /\bhidden(?:\s|>)/.test(attrs); this.checked = /\bchecked(?:\s|>)/.test(attrs);
      this.open = /\bopen(?:\s|>)/.test(attrs); this.dataset = {}; this.events = {}; this.style = {};
      const step = attrs.match(/data-step="([^"]+)"/); if (step) this.dataset.step = step[1];
      const classes = new Set(((attrs.match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/));
      this.classList = { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key),
        toggle: (key, on) => { if (on === undefined) on = !classes.has(key); if (on) classes.add(key); else classes.delete(key); } };
      this.attributes = {};
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, cb) { (this.events[type] ||= []).push(cb); }
    async emit(type, event = {}) { await Promise.all((this.events[type] || []).map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
    closest(selector) { return selector === 'button[data-step]' && this.dataset.step ? this : null; }
    scrollIntoView() { ctx.scrolled = this.id; }
    focus() { ctx.focused = this.id; }
  }
  const body = new Element('body', 'body', '');
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const token = match[0], tag = match[1].toLowerCase();
    if (token.startsWith('</')) { assert.equal(stack.pop().tag, tag, 'balanced markup: ' + token); continue; }
    const id = (token.match(/\bid="([^"]+)"/) || [])[1];
    const parent = [...stack].reverse().find(entry => entry.node);
    let node;
    if (id) {
      assert(!nodes[id], 'unique ID: ' + id);
      node = nodes[id] = new Element(id, tag, token);
      node.parentElement = parent ? parent.node : body;
      ancestors[id] = stack.map(entry => entry.id).filter(Boolean);
    }
    if (!voids.has(tag) && !token.endsWith('/>')) stack.push({ tag, id, node });
  }
  assert.equal(stack.length, 0, 'all markup closed');
  const rows = [{ id: 'QYPS0437000H', trackingId: 'QYPS0437000H', matchType: 'EMAIL' }, { id: 'QYPS0438000H', trackingId: 'QYPS0438000H', matchType: 'EMAIL' }];
  const calls = [];
  ctx = vm.createContext({
    console, Map, Set, document: { body }, $: id => nodes[id], calls,
    client: { id: 'simulmedia', name: 'SimulMedia' }, emailEl: nodes.email,
    selectedMatches: () => rows.filter(r => !r.excluded), ingestReportIds: () => rows.filter(r => !r.excluded).map(r => ({ reporting: r.trackingId })),
    rows, sheet: null, workflowEvidence: new Map(), workflowEvidenceKey: '',
    workflowContext: () => (ctx.client && ctx.client.id || '') + '\n' + nodes.email.value,
    emailOnly: () => true, localDiscovery: null, dlDone: 0, dlFailed: 0, ourDlIds: new Set(), dlRunIds: [], dlQueueActive: false, dlStop: false,
    lastResults: null, capturedByName: {}, uiBusy: null, uiFillsContext: '', journeyStep: 'request',
    ensureMatchRows: () => calls.push('identify'), discoverLocalFiles: async () => { calls.push('local'); return true; },
    portalTab: async () => ({ id: 17 }),
    chrome: { tabs: { update: async () => calls.push('activate portal') }, scripting: { executeScript: async () => [{ result: { ready: true } }] } },
    setInterval() {}, queueMicrotask() {}, dbg() {},
  });
  nodes.email.value = 'Please ingest QYPS0437000H and QYPS0438000H';
  vm.runInContext(engine, ctx);
  const start = source.indexOf('function currentDownloadCount()');
  const end = source.indexOf('const NEXT_STEPS =', start);
  assert(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, nodes, rows, calls, ancestors };
}
function portalHarness() {
  const rows = [], observers = [];
  const ctx = vm.createContext({ window: {}, Event: class {},
    document: { querySelectorAll: () => rows, querySelector: () => ({}), getElementById: () => ({}) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
  });
  const start = source.indexOf('function portalFill(');
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  const add = name => {
    const cells = {};
    for (const key of ['name', 'reporting', 'title', 'comm_advertiser', 'comm_brand', 'comm_vertical', 'fingerprint'])
      cells['td.file_' + key] = { textContent: key === 'name' ? name : '', style: {}, dispatchEvent() {} };
    const row = { dataset: {}, querySelector: selector => cells[selector] };
    rows.push(row);
    return { row, cells };
  };
  return { ctx, rows, observers, add };
}
(async () => {
  await test('portal fills metadata using the tracker filename when it differs from ID and title', () => {
    const { ctx, add } = portalHarness();
    const { cells } = add('Source_Master_30.mp4');
    ctx.portalFill({ rows: [{ id: 'NEW12345H', title: 'Holiday Sale', fileName: 'Source_Master_30.mp4', brand: 'Campaign' }], opts: { advertiser: true, nameTitle: true } });
    assert.equal(cells['td.file_reporting'].textContent, 'NEW12345H');
    assert.equal(cells['td.file_comm_brand'].textContent, 'Campaign');
  });
  await test('a new accepted plan replaces the live observer instead of restoring stale metadata', () => {
    const { ctx, add, observers } = portalHarness();
    const plan = brand => ({ rows: [{ id: 'NEW12345H', title: '', brand }], opts: { advertiser: true } });
    ctx.portalFill(plan('Old Campaign'));
    ctx.portalFill(plan('New Campaign'));
    const { cells } = add('NEW12345H.mp4');
    const active = observers.filter(o => !o.disconnected);
    assert.equal(active.length, 1);
    active[0].callback();
    assert.equal(cells['td.file_comm_advertiser'].textContent, 'New Campaign');
  });
  await test('ambiguous filename aliases never fill an arbitrary creative', () => {
    const { ctx, add } = portalHarness();
    const { cells } = add('Shared_Master.mp4');
    ctx.portalFill({ rows: ['FIRST123H', 'SECOND123H'].map(id => ({ id, fileName: 'Shared_Master.mp4', brand: 'Campaign' })), opts: { advertiser: true } });
    assert.equal(cells['td.file_reporting'].textContent, '');
  });
  await test('portal retries a row when metadata cells arrive after its filename', () => {
    const { ctx, add, observers } = portalHarness();
    const { row, cells } = add('NEW12345H.mp4');
    const advertiser = cells['td.file_comm_advertiser'];
    delete cells['td.file_comm_advertiser'];
    ctx.portalFill({ rows: [{ id: 'NEW12345H', brand: 'Campaign' }], opts: { advertiser: true } });
    assert.notEqual(row.dataset.ingestFilled, 'ok');
    cells['td.file_comm_advertiser'] = advertiser;
    observers[0].callback();
    assert.equal(advertiser.textContent, 'Campaign');
    assert.equal(row.dataset.ingestFilled, 'ok');
  });
  await test('portal fill reports actual filled and unmatched counts, not just queue size', () => {
    const { ctx, add } = portalHarness();
    add('NEW12345H.mp4'); add('UNKNOWN123H.mp4');
    const result = ctx.portalFill({ rows: [{ id: 'NEW12345H' }], opts: {} });
    assert.equal(result.queued, 2);
    assert.equal(result.filled, 1);
    assert.deepEqual(Array.from(result.unmatched), ['UNKNOWN123H.mp4']);
  });
  await test('portal verification resolves filename aliases and checks all three metadata fields', () => {
    const { ctx, nodes } = setup();
    ctx.ingestPlan = () => ({ rows: [{ id: 'NEW12345H', title: '', fileName: 'Master30.mp4', brand: 'Campaign' }], opts: { advertiser: true } });
    ctx.esc = String;
    const start = source.indexOf('function renderIngestVerify(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
    const result = ctx.renderIngestVerify({ rows: [{ name: 'Master30.mp4', reporting: 'NEW12345H', title: 'NEW12345H', advertiser: '', brand: '', vertical: '', fingerprint: 'both' }] });
    assert.equal(result.miss, 0);
    assert.equal(result.diff, 1);
    assert.match(nodes.ingestPreviewBox.innerHTML, /advertiser brand vertical/);
  });
  for (const [name, overrides, expected] of [
    ['empty run loads a request', { request: false, ids: 0 }, 'request'],
    ['unknown customer is confirmed first', { customer: false }, 'customer'],
    ['trackerless request identifies email IDs', { ids: 0 }, 'match'],
    ['tracker-backed request loads its tracker', { ids: 0, emailOnly: false }, 'tracker'],
    ['loaded tracker can match', { ids: 0, emailOnly: false, tracker: true }, 'match'],
    ['sheet-first rows can proceed without email', { request: false }, 'find'],
    ['identified IDs can find files', {}, 'find'],
    ['delivery links do not imply downloaded or ingested', { located: 2 }, 'reviewFiles'],
    ['local files can be fed without a download step', { local: 2 }, 'feed'],
    ['completed downloads can be fed', { downloaded: 2 }, 'feed'],
    ['feeding files leads to preview, not posting', { fed: 2 }, 'preview'],
    ['preview is reviewed before fills', { previewReady: true }, 'fills'],
    ['applied fills lead to records, not success claims', { fillsApplied: true }, 'verify'],
    ['processing records do not imply completed ingest', { records: 2 }, 'progress'],
    ['partial verification is not completion', { records: 1, completed: 1 }, 'progress'],
    ['all required records allow review of confirmation', { records: 2, completed: 2 }, 'confirm'],
    ['required ticker variants must also be verified', { expected: 4, records: 2, completed: 2 }, 'progress'],
    ['failure wins over an apparently completed count', { records: 2, failed: 1, completed: 2 }, 'issues'],
    ['manual client workflow suggests local discovery', { skipDiscovery: true }, 'local'],
  ]) await test(name, () => assert.equal(decision(overrides).action, expected));
  await test('four-step markup separates portal fills from confirmation and preserves advanced source override', () => {
    const { ancestors } = setup();
    assert(ancestors.match.includes('journeyRequest'));
    assert(ancestors.feedPortal.includes('journeyIngest'));
    assert(ancestors.postJira.includes('journeyConfirm'));
    assert(!ancestors.postJira.includes('sec5'));
    assert(ancestors.trackerMode.includes('journeyRequest'));
    assert(!ancestors.trackerMode.includes('sec2'));
  });
  await test('folder tabs are ordered, unnumbered, and color-matched to their pages', () => {
    const tabs = [...html.matchAll(/<button id="nav(\w+)" class="tab-(\w+)"[^>]*>([^<]+)<\/button>/g)];
    assert.deepEqual(tabs.map(t => t[3]), ['Request', 'Files', 'Ingest', 'Confirm']);
    tabs.forEach(([, id, color, label]) => {
      assert.equal(color, id.toLowerCase());
      assert.doesNotMatch(label, /\d/);
      const tabColor = html.match(new RegExp('\\.tab-' + color + ' \\{ --tab: (#[0-9a-f]+)'))[1];
      const pageColor = color === 'request' ? html.match(/\.journey-panel \{ --page: (#[0-9a-f]+)/)[1]
        : html.match(new RegExp('#journey' + id + ' \\{ --page: (#[0-9a-f]+)'))[1];
      assert.equal(tabColor, pageColor);
    });
    assert.match(html, /#journeyNav button \{[^}]*font-weight: 700/);
  });
  await test('trackerless UI hides the tracker without hiding its override', () => {
    const { ctx, nodes } = setup();
    ctx.renderJourneyUI();
    assert.equal(nodes.sec2.hidden, true);
    assert.equal(nodes.journeyRequest.hidden, false);
    ctx.emailOnly = () => false;
    ctx.renderJourneyUI();
    assert.equal(nodes.sec2.hidden, false);
  });
  await test('navigation permits jumping straight to confirmation without prior module completion', () => {
    const { ctx, nodes } = setup();
    ctx.showJourneyStep('confirm', 'secReport');
    assert.equal(nodes.journeyConfirm.hidden, false);
    assert.equal(nodes.journeyFiles.hidden, true);
    assert.equal(nodes.navConfirm.getAttribute('aria-pressed'), 'true');
  });
  await test('advanced view reveals all steps but still omits an unneeded tracker', () => {
    const { ctx, nodes } = setup();
    nodes.showAllSteps.checked = true;
    ctx.renderJourneyUI();
    assert(['Request', 'Files', 'Ingest', 'Confirm'].every(name => !nodes['journey' + name].hidden));
    assert.equal(nodes.sec2.hidden, true);
  });
  await test('manual records can show verified completion with no extension downloads', () => {
    const { ctx, nodes } = setup();
    ctx.workflowEvidenceKey = ctx.workflowContext();
    ctx.rows.forEach(row => ctx.workflowEvidence.set(ctx.normalizeName(row.id).replace(/ /g, ''), { id: row.id, stage: 'complete', source: 'verified records' }));
    ctx.renderJourneyUI();
    assert.equal(nodes.jobNext.dataset.action, 'confirm');
    assert.match(nodes.jobCounts.innerHTML, /Verified: <strong>2\/2/);
    assert.match(nodes.jobCounts.innerHTML, /Downloaded this run: <strong>0/);
  });
  await test('an earlier request cannot contribute evidence to the summary', () => {
    const { ctx, nodes } = setup();
    ctx.workflowEvidenceKey = 'other request';
    ctx.workflowEvidence.set(ctx.normalizeName('QYPS0437000H').replace(/ /g, ''), { stage: 'complete' });
    ctx.renderJourneyUI();
    assert.equal(nodes.jobNext.dataset.action, 'find');
    assert.match(nodes.jobCounts.innerHTML, /Verified: <strong>0\/2/);
  });
  await test('already-ingested shortcut checks records without posting or claiming success', async () => {
    const { nodes, calls } = setup();
    nodes.verifyIngest.addEventListener('click', () => calls.push('verify'));
    nodes.jiraApprove.addEventListener('click', () => calls.push('post'));
    await nodes.alreadyIngested.click();
    assert.deepEqual(calls, ['verify']);
    assert.equal(nodes.journeyConfirm.hidden, false);
  });
  await test('already-have-files shortcut only discovers local media', async () => {
    const { nodes, calls } = setup();
    await nodes.alreadyHaveFiles.click();
    assert.deepEqual(calls, ['identify', 'local']);
    assert.equal(nodes.findSource.value, 'local');
    assert.equal(nodes.journeyFiles.hidden, false);
  });
  await test('portal picker shortcut removed - users pick files in the portal page itself', () => {
    assert.equal(html.includes('portalManualFiles'), false);
  });
  await test('next action navigates to located files but never downloads automatically', async () => {
    const { ctx, nodes, calls } = setup();
    ctx.lastResults = [{ id: 'QYPS0437000H', status: 'FOUND' }];
    nodes.downloadMedia.addEventListener('click', () => calls.push('download'));
    ctx.renderJourneyUI();
    await nodes.jobNext.click();
    assert.equal(nodes.journeyFiles.hidden, false);
    assert.deepEqual(calls, []);
  });
  await test('next action can never approve Jira or accept portal fills', async () => {
    const { ctx, nodes, calls } = setup();
    nodes.ingestPush.classList.remove('hidden');
    nodes.ingestPush.addEventListener('click', () => calls.push('fill'));
    nodes.jiraApprove.addEventListener('click', () => calls.push('post'));
    ctx.renderJourneyUI();
    await nodes.jobNext.click();
    assert.equal(ctx.focused, 'ingestPush');
    assert.deepEqual(calls, []);
  });
  await test('busy guard prevents repeated or competing operations and restores controls', async () => {
    const { ctx, nodes } = setup();
    nodes.grabSheet.disabled = true;
    let release, calls = 0;
    const pending = ctx.runUiAction('grabAndDl', async () => { calls++; await new Promise(resolve => { release = resolve; }); });
    assert.equal(nodes.jobNext.disabled, true);
    assert.equal(nodes.grabAndDl.getAttribute('aria-busy'), 'true');
    await ctx.runUiAction('feedPortal', async () => { calls++; });
    assert.equal(calls, 1);
    release(); await pending;
    assert.equal(ctx.uiBusy, null);
    assert.equal(nodes.grabAndDl.disabled, false);
    assert.equal(nodes.grabSheet.disabled, true);
  });
  await test('operation failure is actionable and unlocks controls', async () => {
    const { ctx, nodes } = setup();
    await ctx.runUiAction('feedPortal', async () => { throw new Error('Watcher unavailable'); });
    assert.match(nodes.operationNotice.textContent, /Watcher unavailable/);
    assert(nodes.operationNotice.classList.contains('error'));
    assert.equal(nodes.feedPortal.disabled, false);
  });
  await test('active downloads disable duplicate download and new-request actions, not Stop', () => {
    const { ctx, nodes } = setup();
    ctx.ourDlIds.add(17); ctx.dlRunIds.push(17);
    ctx.renderJourneyUI();
    assert.equal(nodes.downloadMedia.disabled, true);
    assert.equal(nodes.clearAll.disabled, true);
    assert.equal(nodes.jobNext.disabled, true);
    assert.equal(nodes.stopDl.disabled, false);
  });
  await test('Stop stays available in the header while the queue is resolving links', async () => {
    const { ctx, nodes, calls } = setup();
    ctx.dlQueueActive = true;
    nodes.stopDl.addEventListener('click', () => calls.push('stop'));
    ctx.renderJourneyUI();
    assert.equal(nodes.jobStop.hidden, false);
    await nodes.jobStop.click();
    assert.deepEqual(calls, ['stop']);
  });
  await test('unrelated extension downloads do not block the current request', () => {
    const { ctx, nodes } = setup();
    ctx.ourDlIds.add(99);
    ctx.renderJourneyUI();
    assert.equal(nodes.jobNext.disabled, false);
    assert.equal(nodes.jobStop.hidden, true);
  });
  for (const stopDuring of ['resolve', 'download']) {
    await test('direct download queue honors Stop during ' + stopDuring, async () => {
      const { ctx } = setup();
      const downloads = [], canceled = [];
      Object.assign(ctx, {
        jobs: [{ url: 'https://example.com/a', file: 'a.mp4' }, { url: 'https://example.com/b', file: 'b.mp4' }],
        updateDlStatus() {}, htmlRejects: [], dlTotal: 0, dlFailAlerted: false,
        resolveDlUrl: async url => { if (stopDuring === 'resolve') ctx.dlStop = true; return url; },
      });
      ctx.chrome.downloads = {
        download: async options => { downloads.push(options); ctx.dlStop = true; return 17; },
        cancel: async id => { canceled.push(id); },
      };
      const start = source.indexOf('  dlTotal = jobs.length;');
      const end = source.indexOf('\n  dlQueueActive = false;', start) + '\n  dlQueueActive = false;'.length;
      assert(start >= 0 && end > start);
      await vm.runInContext('(async () => {' + source.slice(start, end) + '\n})()', ctx);
      assert.equal(downloads.length, stopDuring === 'resolve' ? 0 : 1);
      assert.deepEqual(canceled, stopDuring === 'resolve' ? [] : [17]);
      assert.equal(ctx.dlQueueActive, false);
    });
  }
  for (const current of [false, true]) {
    await test((current ? 'current' : 'background') + ' download completion updates only its own job counters', async () => {
      const { ctx } = setup();
      ctx.ourDlIds.add(17);
      if (current) ctx.dlRunIds.push(17);
      Object.assign(ctx, { dlKeys: new Map(), queuedUrls: new Set(), htmlRejects: [], updateDlStatus() {}, esc: text => text });
      ctx.chrome.downloads = { search: async () => [{ filename: 'QYPS0437000H.mpg', mime: 'video/mpeg' }] };
      const marker = 'chrome.downloads.onChanged.addListener(async delta => {';
      const start = source.indexOf(marker) + marker.length;
      const body = source.slice(start, source.indexOf('\n});', start));
      ctx.delta = { id: 17, state: { current: 'complete' } };
      await vm.runInContext('(async () => {' + body + '\n})()', ctx);
      assert.equal(ctx.dlDone, current ? 1 : 0);
    });
  }
  await test('new request clears download totals, evidence, and the previous fill approval', () => {
    const { ctx, nodes } = setup();
    Object.assign(ctx, { trackerEpoch: 0, idsEl: nodes.ids, filesEl: nodes.files,
      queuedUrls: new Set(), dlKeys: new Map(), portalFailAlerted: new Set(),
      disarmDeliveryWatch() {}, modStatOff() {}, stopPortalLive() {}, setStage() {}, saveInputs() {},
      dlTotal: 2, dlDone: 2, dlFailed: 1, dlQueueActive: true, dlStop: true,
      uiFillsContext: ctx.workflowContext(), localDiscovery: { files: [{ name: 'old.mp4' }] } });
    nodes.ingestPush.classList.remove('hidden');
    nodes.alertBox.innerHTML = 'Previous ingest failed';
    nodes.alertBox.classList.remove('hidden');
    nodes.toast.textContent = 'Old download error'; nodes.toast.style.display = 'block'; nodes.toast._timer = 17;
    nodes.dbgTools.open = true;
    nodes.operationNotice.textContent = 'Old operation failed'; nodes.operationNotice.classList.add('error');
    ctx.dbgLog = [{ msg: 'Previous ingest failed' }];
    ctx.clearTimeout = timer => { ctx.clearedTimer = timer; };
    ctx.workflowEvidence.set('old', { stage: 'complete' });
    const start = source.indexOf('function resetRun()');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
    ctx.resetRun();
    assert.equal(ctx.dlDone, 0);
    assert.equal(ctx.dlFailed, 0);
    assert.equal(ctx.dlQueueActive, false);
    assert.equal(ctx.workflowEvidence.size, 0);
    assert.equal(ctx.uiFillsContext, '');
    assert.equal(ctx.localDiscovery, null);
    assert(nodes.ingestPush.classList.contains('hidden'));
    assert(nodes.alertBox.classList.contains('hidden'));
    assert.equal(nodes.alertBox.innerHTML, '');
    assert.equal(nodes.toast.textContent, '');
    assert.equal(nodes.toast.style.display, 'none');
    assert.equal(ctx.clearedTimer, 17);
    assert.equal(nodes.dbgTools.open, false);
    assert.equal(nodes.operationNotice.textContent, '');
    assert(!nodes.operationNotice.classList.contains('error'));
    assert.equal(ctx.dbgLog[0].msg, 'Previous ingest failed');
  });
  await test('Clear all label replaces New request without a fresh popup', () => {
    assert.match(html, /id="clearAll"[^>]*>Clear all<\/button>/);
    const start = source.indexOf('function clearAll()');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert(body.includes('resetRun()'));
    assert(!body.includes("toast('Cleared"));
  });
  await test('late alert remains logged but cannot reopen after request reset', async () => {
    const { ctx, calls } = setup();
    let resolve;
    ctx.trackerEpoch = 1;
    ctx.chrome.windows = { getCurrent: () => new Promise(done => { resolve = done; }) };
    ctx.showAlertBox = () => calls.push('alert');
    ctx.dbg = () => calls.push('logged');
    const start = source.indexOf('async function alertSound(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
    const pending = ctx.alertSound('fail', 'old failure', 'Old failure');
    ctx.trackerEpoch++;
    resolve({ focused: false });
    await pending;
    assert.deepEqual(calls, ['logged']);
  });
  await test('Clear all finishes silently even on an already empty request', async () => {
    const { ctx, nodes } = setup();
    await ctx.runUiAction('clearAll', async () => {});
    assert.equal(nodes.operationNotice.textContent, '');
  });
  await test('old operation error is logged without appearing on a new request', async () => {
    const { ctx, nodes, calls } = setup();
    ctx.dbg = () => calls.push('logged');
    await ctx.runUiAction('match', async () => {
      nodes.email.value = 'Different request';
      throw new Error('Old request failed');
    });
    assert.equal(nodes.operationNotice.textContent, '');
    assert(!nodes.operationNotice.classList.contains('error'));
    assert(calls.includes('logged'));
  });
  console.log(passed + ' journey UI tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
