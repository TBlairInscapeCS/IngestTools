// ---------- Microsoft Graph mail access ----------
// Device-code OAuth against a user-registered Entra app (delegated
// Mail.Read). The refresh token lives in chrome.storage.local and access
// tokens refresh silently - the one-time app registration is the only
// setup: no server, no redirect URI, no client secret.
//
// DOM-free on purpose: the background worker importScripts() this file
// for the unread-count badge alarm. Keep it to fetch + chrome.storage.

const MS = { clientId: '', tenant: '', refreshToken: '', accessToken: '', accessExp: 0 };

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

function msAuthorizeUrl(challenge, redirect) {
  return msEndpoint('authorize') + '?' + new URLSearchParams({
    client_id: MS.clientId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: 'Mail.Read offline_access',
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
async function msDeviceCode() {
  const d = await msPost('devicecode', {
    client_id: MS.clientId,
    scope: 'Mail.Read offline_access',
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
  const d = await msPost('token', {
    grant_type: 'refresh_token',
    client_id: MS.clientId,
    refresh_token: MS.refreshToken,
    scope: 'Mail.Read offline_access',
  });
  if (!d.access_token) return null;
  msStoreTokens(d);
  return MS.accessToken;
}

// Unread inbox messages, newest first, with bodies. null when not signed
// in; throws on API errors.
async function graphUnread(top) {
  const tok = await msAccessToken();
  if (!tok) return null;
  const url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages' +
    '?$filter=' + encodeURIComponent('isRead eq false') +
    '&$top=' + (top || 25) +
    '&$select=id,subject,from,receivedDateTime,body' +
    '&$count=true';
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + tok, ConsistencyLevel: 'eventual' },
  });
  if (!r.ok) throw new Error('Graph ' + r.status);
  const v = (await r.json()).value || [];
  v.sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  return v;
}
