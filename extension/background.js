// Clicking the toolbar icon opens the side panel.
importScripts('engine.js', 'graph.js');

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
// unread message fires a sticky OS notification AND a loud siren through
// the offscreen audio doc - the badge counts what's outstanding. Silent
// no-op until the user signs in from the panel.
chrome.alarms.create('inboxPoll', { periodInMinutes: 1 });

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO'],
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

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'inboxPoll') return;
  try {
    await msLoad();
    if (!MS.refreshToken) return;
    const msgs = await graphUnread(25);
    const cands = (msgs || []).filter(m =>
      looksLikeRequest(m.subject, (m.body && m.body.content) || ''));
    chrome.action.setBadgeText({ text: cands.length ? String(cands.length) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e8a13d' });
    // Dedupe across service-worker restarts via storage - each message id
    // alerts once, ever.
    const { notifiedIds = [] } = await chrome.storage.local.get('notifiedIds');
    const seen = new Set(notifiedIds);
    const fresh = cands.filter(m => !seen.has(m.id));
    for (const m of fresh) { await alertNewRequest(m); seen.add(m.id); }
    if (fresh.length)
      await chrome.storage.local.set({ notifiedIds: [...seen].slice(-200) });
  } catch (e) { /* offline / token expired - try next interval */ }
});

// Clicking the notification focuses the side panel (user gesture, so the
// open is allowed) and silences the siren.
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
