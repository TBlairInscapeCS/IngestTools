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

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Audible alert when a new request email arrives.',
  });
}

async function alertNewRequest(c) {
  const from = (c.from && c.from.emailAddress && c.from.emailAddress.name) || 'unknown sender';
  await ensureOffscreen();
  await chrome.notifications.create('req-' + c.id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'New ingest request',
    message: (c.subject || '(no subject)') + '\n' + from,
    requireInteraction: true,
    priority: 2,
  });
  chrome.runtime.sendMessage({ play: true });
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
  chrome.runtime.sendMessage({ play: true });
}

chrome.alarms.onAlarm.addListener(async a => {
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
    const cands = (msgs || []).filter(m => {
      const from = m.from && m.from.emailAddress && m.from.emailAddress.address;
      const body = stripHtml((m.body && m.body.content) || '');
      // Delivery notices (Comcast manifest / Yangaroo "New Media") are the
      // request itself - alert on them even from no-reply senders.
      const deliveryNotice = parseComcastNotice(m.subject, body) ||
        (/yangaroo\.com/i.test(String(from || '')) && /new media/i.test(m.subject));
      return deliveryNotice || isRequestCandidate(m.subject, body, from, reqSenders, selfAddr) ||
        (batchFresh && isTatariErNotice(m.subject, body, from));
    });
    // One alert per Tatari ER batch - the ~99 notices behind it stay quiet.
    if (cands.length && batchFresh &&
        cands.some(m => isTatariErNotice(m.subject,
          stripHtml((m.body && m.body.content) || ''),
          m.from && m.from.emailAddress && m.from.emailAddress.address)))
      await chrome.storage.local.set({ erBatchAt: Date.now() });
    const seen = new Set(notifiedIds);
    const fresh = cands.filter(m => !seen.has(m.id));
    for (const m of fresh) { await alertNewRequest(m); seen.add(m.id); }
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'test-alert') {
    alertNewRequest({ id: 'test-' + Date.now(), subject: 'TEST - Vizio - Ingestion request',
      from: { emailAddress: { name: 'Ingest Tools' } } })
      .then(() => sendResponse(true))
      .catch(e => sendResponse(String(e)));
    return true; // async response
  }
});
