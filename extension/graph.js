// ---------- Microsoft Graph mail access ----------
// Device-code OAuth against a user-registered Entra app (delegated
// Mail.Read). The refresh token lives in chrome.storage.local and access
// tokens refresh silently - the one-time app registration is the only
// setup: no server, no redirect URI, no client secret.
//
// DOM-free on purpose: the background worker importScripts() this file
// for the unread-count badge alarm. Keep it to fetch + chrome.storage.

const MS = { clientId: '', tenant: '', refreshToken: '', accessToken: '', accessExp: 0 };
// Sign-in requests only Mail.Read - that's the scope admin consent already
// covers, and v2 consent is all-or-nothing: asking Mail.ReadWrite up front
// re-triggers the whole admin-approval flow. Write scope is incremental:
// the side panel re-runs sign-in with MS_SCOPE_WRITE only when a write
// call 403s.
const MS_SCOPE = 'Mail.Read offline_access';
const MS_SCOPE_WRITE = 'Mail.Read Mail.ReadWrite offline_access';

async function msLoad() {
  const s = await chrome.storage.local.get(['msClientId', 'msTenant', 'msRefreshToken']);
  MS.clientId = s.msClientId || MS.clientId;
  MS.tenant = s.msTenant || MS.tenant;
  MS.refreshToken = s.msRefreshToken || MS.refreshToken;
  return MS;
}

function msEndpoint(path) {
  return 'https://login.microsoftonline.com/' + (MS.tenant || 'organizations') + '/oauth2/v2.0/' + path;
}

async function msPost(path, body) {
  const r = await fetch(msEndpoint(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return r.json();
}

function msStoreTokens(d) {
  MS.accessToken = d.access_token;
  MS.accessExp = Date.now() + (d.expires_in || 3600) * 1000;
  if (d.refresh_token) {
    MS.refreshToken = d.refresh_token;
    chrome.storage.local.set({ msRefreshToken: d.refresh_token });
  }
}

// Interactive auth-code + PKCE: for tenants where Conditional Access
// blocks the device-code flow ("authentication flow restricted"). Uses
// the native-client or localhost redirect already registered on
// first-party public apps - Microsoft either shows a code page or dies
// on localhost with the code in the URL bar; the user pastes it back.
const MS_NATIVECLIENT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const MS_LOCALHOST = 'http://localhost';

async function msPkce() {
  const b64 = a => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const verifier = b64(rnd);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64(new Uint8Array(hash)) };
}

function msAuthorizeUrl(challenge, redirect, scope) {
  return msEndpoint('authorize') + '?' + new URLSearchParams({
    client_id: MS.clientId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: scope || MS_SCOPE,
    response_mode: 'query',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
}

async function msExchangeCode(code, verifier, redirect) {
  const d = await msPost('token', {
    grant_type: 'authorization_code',
    client_id: MS.clientId,
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  if (!d.access_token) throw new Error(d.error_description || d.error || 'token exchange failed');
  msStoreTokens(d);
}

// Step 1 of sign-in: ask Microsoft for a user code. Returns the device-
// code response ({user_code, verification_uri, device_code, interval}).
async function msDeviceCode(scope) {
  const d = await msPost('devicecode', {
    client_id: MS.clientId,
    scope: scope || MS_SCOPE,
  });
  if (d.error) throw new Error(d.error_description || d.error);
  return d;
}

// Step 2: poll the token endpoint until the user completes the browser
// sign-in. Throws on decline/timeout.
async function msPollForToken(deviceCode, intervalSec) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const d = await msPost('token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: MS.clientId,
      device_code: deviceCode,
    });
    if (d.access_token) { msStoreTokens(d); return true; }
    if (d.error !== 'authorization_pending')
      throw new Error(d.error_description || d.error);
    if (Date.now() > deadline) throw new Error('Sign-in timed out.');
    await wait(Math.max(3, intervalSec || 5) * 1000);
  }
}

// Valid access token or null (re-reads storage first - the background
// badge alarm can rotate the refresh token under us).
async function msAccessToken() {
  if (MS.accessToken && Date.now() < MS.accessExp - 60000) return MS.accessToken;
  await msLoad();
  if (!MS.refreshToken) return null;
  // Refresh only claims what the original consent granted - asking wider
  // than consented here would invalidate the token entirely.
  const d = await msPost('token', {
    grant_type: 'refresh_token',
    client_id: MS.clientId,
    refresh_token: MS.refreshToken,
    scope: 'Mail.Read offline_access',
  });
  if (!d.access_token) {
    // Refresh token exists but the refresh failed = dead credentials
    // (invalid_grant, revoked consent). Flag it so the panel shows a
    // "sign in" chip instead of a silently empty inbox.
    chrome.storage.local.set({ msAuthDown: Date.now(),
      msAuthErr: String(d.error || 'refresh failed').slice(0, 120) });
    return null;
  }
  msStoreTokens(d);
  chrome.storage.local.remove(['msAuthDown', 'msAuthErr']);
  return MS.accessToken;
}

// Unread messages across ALL mail folders, newest first, with bodies.
// Outlook rules file customer requests into Customers/* and delivery
// folders before they reach the inbox - an inbox-only scan misses the
// real requests. parentFolderId lets callers tag the folder/client.
// null when not signed in; throws on API errors.
async function graphUnread(top) {
  const tok = await msAccessToken();
  if (!tok) return null;
  const url = 'https://graph.microsoft.com/v1.0/me/messages' +
    '?$filter=' + encodeURIComponent('isRead eq false') +
    '&$top=' + (top || 25) +
    '&$select=id,subject,from,receivedDateTime,body,parentFolderId,conversationId' +
    '&$count=true';
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + tok, ConsistencyLevel: 'eventual' },
  });
  if (!r.ok) throw new Error('Graph ' + r.status);
  const v = (await r.json()).value || [];
  v.sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  return v;
}

// folderId -> displayName for every folder (incl. Customers/*
// grandchildren). Cached in storage - the tree rarely changes. Returns
// { map, custIds } - custIds are the folder ids under Customers, used to
// spot request-shaped mail landing in unmapped client folders.
async function graphFolderMap() {
  const map = {};
  const custIds = [];
  const top = (await graphFetch('/me/mailFolders?$top=100&$select=id,displayName,childFolderCount')).value || [];
  for (const f of top) {
    map[f.id] = f.displayName;
    if (!f.childFolderCount) continue;
    const inCust = /^customers$/i.test(f.displayName);
    const kids = (await graphFetch('/me/mailFolders/' + f.id +
      '/childFolders?$top=100&$select=id,displayName,childFolderCount')).value || [];
    for (const k of kids) {
      map[k.id] = k.displayName;
      if (inCust) custIds.push(k.id);
      if (!k.childFolderCount) continue;
      const g = (await graphFetch('/me/mailFolders/' + k.id +
        '/childFolders?$top=100&$select=id,displayName')).value || [];
      g.forEach(x => { map[x.id] = x.displayName; if (inCust) custIds.push(x.id); });
    }
  }
  chrome.storage.local.set({ msFolderMap: map, msCustomerFolderIds: custIds });
  return { map, custIds };
}

// Latest-mail timestamp per folder (Customers subfolders drive the
// "quiet client" display in the client note). ~1 call per folder; meant
// for the weekly folder-map refresh, not per poll.
async function graphFolderActivity(folderIds, map) {
  const act = {};
  for (const id of folderIds || []) {
    try {
      const r = await graphFetch('/me/mailFolders/' + id +
        '/messages?$top=1&$select=receivedDateTime&$orderby=receivedDateTime desc');
      const v = r.value || [];
      if (v.length && (map || {})[id]) act[map[id]] = v[0].receivedDateTime;
    } catch (e) { /* folder may be gone or empty */ }
  }
  chrome.storage.local.set({ msFolderActivity: act });
  return act;
}

// The reply template - "I've ingested those creatives ... under the
// following IDs:". A sent mail matching it confirms the thread was a
// real request; the thread's external senders become learned senders.
const REQ_REPLY_TMPL = /i'?ve ingested|under the following ids|commercial reports under/i;

// Sender addresses on threads that got a template reply. Scans recent
// Sent Items for the template, then pulls each thread's senders. Returns
// { senders: [...], convs: [...], scanned: n } - convs are the replied
// conversationIds so callers can mark/skip already-handled threads.
async function graphLearnedSenders(sinceIso) {
  const q = '/me/mailFolders/sentitems/messages?$top=50' +
    '&$select=subject,conversationId,body,receivedDateTime' +
    (sinceIso ? '&$filter=' + encodeURIComponent('receivedDateTime ge ' + sinceIso) : '');
  const sent = (await graphFetch(q)).value || [];
  const convIds = [...new Set(sent
    .filter(m => REQ_REPLY_TMPL.test(stripTags((m.body && m.body.content) || '')))
    .map(m => m.conversationId)
    .filter(Boolean))];
  const senders = [];
  for (const cid of convIds.slice(0, 30)) {
    try {
      const t = await graphFetch('/me/messages?$filter=' +
        encodeURIComponent("conversationId eq '" + cid + "'") +
        '&$select=from&$top=15');
      (t.value || []).forEach(m => {
        const a = m.from && m.from.emailAddress && m.from.emailAddress.address;
        if (a) senders.push(a.toLowerCase());
      });
    } catch (e) { /* skip dead threads */ }
  }
  return { senders, convs: convIds, scanned: sent.length };
}

// Minimal tag strip for body sniffing (engine's stripHtml isn't loaded
// here on purpose - graph.js stays dependency-free).
function stripTags(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ');
}

// Shared authenticated call; throws with status so callers can tell a
// consent gap (401/403) from a real error.
async function graphFetch(path, opts) {
  const tok = await msAccessToken();
  if (!tok) throw new Error('not signed in');
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, {
    ...(opts || {}),
    headers: { Authorization: 'Bearer ' + tok, ...((opts && opts.headers) || {}) },
  });
  if (!r.ok) throw new Error('Graph ' + r.status + (r.status === 401 || r.status === 403
    ? ' - re-run Sign in to consent Mail.ReadWrite' : ''));
  return r.status === 204 ? null : r.json();
}

// Attachment metadata for one message (names/types/sizes only).
async function graphAttachments(msgId) {
  return (await graphFetch('/me/messages/' + msgId + '/attachments?$select=id,name,contentType,size')).value || [];
}

// Raw bytes of a fileAttachment (contentBytes arrives base64).
async function graphAttachmentBytes(msgId, attId) {
  const d = await graphFetch('/me/messages/' + msgId + '/attachments/' + attId);
  return Uint8Array.from(atob(d.contentBytes || ''), c => c.charCodeAt(0)).buffer;
}

// createReply makes a draft threaded on the source message; PATCH fills
// the body. The user reviews and sends in Outlook - nothing auto-sends.
async function graphReplyDraft(msgId, bodyText) {
  const d = await graphFetch('/me/messages/' + msgId + '/createReply', { method: 'POST' });
  await graphFetch('/me/messages/' + d.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'text', content: bodyText } }),
  });
  return d;
}

async function graphMarkRead(msgId) {
  return graphFetch('/me/messages/' + msgId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true }),
  });
}

// The signed-in user's own address + domain - cached so request detection
// can exclude mail they sent themselves (address match only: colleagues
// on the same domain carry real request traffic).
async function graphSelfDomain() {
  const d = await graphFetch('/me?$select=mail,userPrincipalName');
  const addr = (d.mail || d.userPrincipalName || '').toLowerCase();
  const dom = (addr.split('@')[1] || '');
  if (dom) chrome.storage.local.set({ msSelfDomain: dom, msSelfAddr: addr });
  return dom;
}
