// Clicking the toolbar icon opens the side panel.
importScripts('engine.js', 'graph.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create('inboxPoll', { periodInMinutes: 15 });

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

// Fresh-request badge: every 15 min, count unread inbox messages that
// look like delivery requests. Silent no-op until the user signs in from
// the panel - the badge is how a new request finds the user instead of
// the other way around.
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'inboxPoll') return;
  try {
    await msLoad();
    if (!MS.refreshToken) return;
    const msgs = await graphUnread(25);
    const n = (msgs || []).filter(m =>
      looksLikeRequest(m.subject, (m.body && m.body.content) || '')).length;
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e8a13d' });
  } catch (e) { /* offline / token expired - try next interval */ }
});
