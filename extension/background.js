// Clicking the toolbar icon opens the side panel.
importScripts('engine.js', 'clients.js', 'graph.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.contextMenus.create({
    id: 'send-ids',
    title: 'Ingest Tools: use selection as tracking IDs',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'send-files',
    title: 'Ingest Tools: use selection as file list',
    contexts: ['selection'],
  });
});

// Right-click capture: stash the selection, open the panel.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const key = info.menuItemId === 'send-ids' ? 'pendingIds' : 'pendingFiles';
  chrome.storage.local.set({ [key]: info.selectionText || '' });
  if (tab && tab.id !== undefined) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// Fresh-request alert: poll every minute. A never-before-seen request-like
// unread message fires a sticky OS notification AND a double-ding service-bell chime through
// the offscreen audio doc - the badge counts what's outstanding. Silent
// no-op until the user signs in from the panel.
chrome.alarms.create('inboxPoll', { periodInMinutes: 1 });
// Watched-batch ER polling - independent of the mail scan. Deliveries
// that land with no notice email (the SeaWorld case) still trip the
// 'arrived' alert via the API.
chrome.alarms.create('erWatch', { periodInMinutes: 30 });

const ER_API = 'https://api.extremereach.com';

// Every 30 min: for each armed batch, ask /deliveries?AdId= for its
// codes. Any hit = the files arrived. Capped at 25 queries/run across
// batches and 15 codes/batch - enough signal, polite on the API.
async function erWatchTick() {
  const { watchedBatches = [], erApiKey } =
    await chrome.storage.local.get(['watchedBatches', 'erApiKey']);
  if (!erApiKey) return;
  const live = watchedBatches.filter(b => Date.now() - (b.addedAt || 0) < 14 * 864e5);
  if (!live.length) return;
  const hits = new Map();
  let budget = 25;
  outer:
  for (let bi = 0; bi < live.length; bi++) {
    const b = live[bi];
    let n = 0;
    for (const code of b.codes.slice(0, 15)) {
      if (budget-- <= 0) break outer;
      try {
        const r = await fetch(ER_API + '/deliveries?AdId=' +
          encodeURIComponent(code) + '&format=json',
          { headers: { 'X-ApiKey': erApiKey, Accept: 'application/json' } });
        if (r.status === 401) break outer; // dead key - stop the pass
        if (!r.ok) continue;
        const d = await r.json();
        const list = d.Deliveries || d.deliveries || (Array.isArray(d) ? d : []);
        if (list.length) n++;
      } catch (e) { break outer; }
    }
    if (n) hits.set(bi, n);
  }
  for (const [bi, n] of hits) await alertDeliveryArrived(live[bi], n);
  if (hits.size || live.length !== watchedBatches.length)
    await chrome.storage.local.set({
      watchedBatches: live.filter((_, i) => !hits.has(i)) });
}

let offscreenReadyResolve = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  // Wait for the doc's 'offscreen-ready' ping - sending 'play' before
  // its listener registers drops the sound silently. 1.5s cap so a wedged
  // doc can't stall the alert path forever.
  const ready = new Promise(r => {
    offscreenReadyResolve = r;
    setTimeout(r, 1500);
  });
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Audible alert when a new request email arrives.',
  });
  await ready;
}

async function alertNewRequest(c, kind) {
  const from = (c.from && c.from.emailAddress && c.from.emailAddress.name) || 'unknown sender';
  await ensureOffscreen();
  await chrome.notifications.create('req-' + c.id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: kind === 'delivery' ? 'Delivery notice' : 'New ingest request',
    message: (c.subject || '(no subject)') + '\n' + from,
    requireInteraction: true,
    priority: 2,
  });
  chrome.runtime.sendMessage({ play: kind || 'request' });
}

// A watched batch's files showed up in delivery mail - same urgency as a
// new request, but the message says what arrived and what to do next.
async function alertDeliveryArrived(b, n) {
  await ensureOffscreen();
  const name = [b.clientName, b.advertiser].filter(Boolean).join(' - ') || 'watched batch';
  await chrome.notifications.create('arrived-' + (b.addedAt || Date.now()), {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Delivery arrived: ' + name,
    message: n + ' of ' + b.codes.length + ' watched file(s) just appeared in delivery mail - re-run the sweep.',
    requireInteraction: true,
    priority: 2,
  });
  chrome.runtime.sendMessage({ play: 'arrived' });
}

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'erWatch') { await erWatchTick().catch(() => {}); return; }
  if (a.name !== 'inboxPoll') return;
  try {
    await msLoad();
    if (!MS.refreshToken) return;
    const msgs = await graphUnread(25);
    // Dedupe across service-worker restarts via storage - each message id
    // alerts once, ever. reqSenders = learned request senders.
    const { notifiedIds = [], reqSenders = {}, msSelfAddr = '', erBatchAt = 0, watchedBatches = [] } =
      await chrome.storage.local.get(['notifiedIds', 'reqSenders', 'msSelfAddr', 'erBatchAt', 'watchedBatches']);
    const selfAddr = msSelfAddr || '';
    if (!selfAddr) await graphSelfDomain().catch(() => '');
    const batchFresh = Date.now() - erBatchAt > 4 * 864e5;
    // Candidates carry a sound kind: delivery notices (Comcast manifest,
    // Yangaroo "New Media", first Tatari ER notice) are informational -
    // one soft ding; real requests keep the urgent double service-bell.
    const cands = (msgs || []).map(m => {
      const from = m.from && m.from.emailAddress && m.from.emailAddress.address;
      const body = stripHtml((m.body && m.body.content) || '');
      const deliveryNotice = parseComcastNotice(m.subject, body) ||
        (/yangaroo\.com/i.test(String(from || '')) && /new media/i.test(m.subject));
      if (deliveryNotice || (batchFresh && isTatariErNotice(m.subject, body, from)))
        return { m, kind: 'delivery' };
      if (isRequestCandidate(m.subject, body, from, reqSenders, selfAddr))
        // Replies (Chris's ingest confirmations et al.) score on quoted body
        // vocabulary but are thread context - never alert on them.
        return isReplySubject(m.subject) ? null : { m, kind: 'request' };
      return null;
    }).filter(Boolean);
    // One alert per Tatari ER batch - the ~99 notices behind it stay quiet.
    if (cands.length && batchFresh &&
        cands.some(c => isTatariErNotice(c.m.subject,
          stripHtml((c.m.body && c.m.body.content) || ''),
          c.m.from && c.m.from.emailAddress && c.m.from.emailAddress.address)))
      await chrome.storage.local.set({ erBatchAt: Date.now() });
    const seen = new Set(notifiedIds);
    const fresh = cands.filter(c => !seen.has(c.m.id));
    for (const c of fresh) { await alertNewRequest(c.m, c.kind); seen.add(c.m.id); }
    if (fresh.length)
      await chrome.storage.local.set({ notifiedIds: [...seen].slice(-200) });
    // Watched batches: the panel arms missing IDs after an empty sweep;
    // when a watched ISCI shows up in ANY unread mail's body (ER notice,
    // Comcast manifest, Yangaroo "New Media"), that's the arrival signal.
    // Notify once per batch, then un-arm.
    const live = watchedBatches.filter(b => Date.now() - (b.addedAt || 0) < 14 * 864e5);
    if (live.length) {
      const hits = new Map();
      for (const m of msgs || []) {
        const codes = new Set(detectCodes(
          stripHtml((m.body && m.body.content) || '')).map(c => c.toUpperCase()));
        if (!codes.size) continue;
        live.forEach((b, i) => {
          const n = b.codes.filter(c => codes.has(c)).length;
          if (n) hits.set(i, (hits.get(i) || 0) + n);
        });
      }
      for (const [i, n] of hits) await alertDeliveryArrived(live[i], n);
      if (hits.size || live.length !== watchedBatches.length)
        await chrome.storage.local.set({
          watchedBatches: live.filter((_, i) => !hits.has(i)) });
    }
  } catch (e) { /* offline / token expired - try next interval */ }
});

// Clicking the notification focuses the side panel (user gesture, so the
// open is allowed) and silences the chime.
chrome.notifications.onClicked.addListener(async () => {
  chrome.runtime.sendMessage({ stop: true });
  try {
    const w = await chrome.windows.getLastFocused();
    if (w) await chrome.sidePanel.open({ windowId: w.id });
  } catch (e) { /* panel open needs a real window - notification stays */ }
});

// Panel test path: same alert pipeline, one click verifies sound+banner.
// Test alert cycles through the three sound kinds so each is audible.
let testKindIdx = 0;
const TEST_KINDS = ['request', 'delivery', 'arrived'];
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'offscreen-ready' && offscreenReadyResolve) offscreenReadyResolve();
  // Panel-originated sound (e.g. a watched batch found by the sweep):
  // routed through here so the offscreen doc exists first.
  if (msg && msg.type === 'ding') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ play: msg.kind || 'request' }))
      .then(() => sendResponse(true))
      .catch(e => sendResponse(String(e)));
    return true;
  }
  if (msg && msg.type === 'test-alert') {
    const kind = TEST_KINDS[testKindIdx++ % TEST_KINDS.length];
    alertNewRequest({ id: 'test-' + Date.now(), subject: 'TEST - ' + kind + ' alert',
      from: { emailAddress: { name: 'Ingest Tools' } } }, kind)
      .then(() => sendResponse(true))
      .catch(e => sendResponse(String(e)));
    return true; // async response
  }
});
