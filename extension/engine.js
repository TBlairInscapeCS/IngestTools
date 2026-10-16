/**
 * Reconciliation engine — platform-agnostic.
 * Pure functions, no DOM or Chrome APIs. Shared by the side panel.
 */

// Lowercase, strip a trailing extension, collapse separators to single spaces.
function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Dice coefficient over character bigrams.
function similarity(a, b) {
  a = a.replace(/ /g, '');
  b = b.replace(/ /g, '');
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = {};
  for (let i = 0; i < a.length - 1; i++) grams[a.substr(i, 2)] = true;
  let overlap = 0;
  for (let j = 0; j < b.length - 1; j++) {
    const g = b.substr(j, 2);
    if (grams[g]) { overlap++; delete grams[g]; }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function extractBasename(s) {
  s = String(s).trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname.split('/').pop() || s);
    }
  } catch (e) { /* keep raw */ }
  return s;
}

/**
 * Reconcile requested IDs against available file names.
 * @param {string[]} ids      - requested tracking IDs (raw, may contain dupes)
 * @param {string[]} fileNames - file names or URLs present on the delivery side
 * @returns {{results: Array, counts: Object}}
 */
function reconcile(ids, fileNames) {
  const files = fileNames
    .map(extractBasename)
    .filter(Boolean)
    .map(name => ({
      name,
      norm: normalizeName(name),
      haystack: normalizeName(name).replace(/ /g, ''),
    }));

  const results = [];
  const seen = new Map(); // normalized ID -> first occurrence index

  for (const raw of ids) {
    const id = String(raw).trim();
    const res = { id, status: '', matched: '', notes: '' };

    if (!id) {
      res.status = 'BLANK';
      res.notes = 'Empty ID';
      results.push(res);
      continue;
    }

    const norm = normalizeName(id);
    const needle = norm.replace(/ /g, '');

    if (seen.has(norm)) {
      res.status = 'DUPLICATE';
      res.notes = 'Duplicate of "' + seen.get(norm) + '"';
      results.push(res);
      continue;
    }
    seen.set(norm, id);

    const exact = [];
    const candidates = [];
    for (const f of files) {
      // Either direction of containment: the request may carry a full
      // filename while the file list shows just its leading code.
      if (f.haystack.includes(needle) ||
          (f.haystack.length >= 8 && needle.includes(f.haystack))) {
        exact.push(f);
      } else {
        const score = similarity(norm, f.norm);
        if (score >= 0.55) candidates.push({ f, score });
      }
    }
    // Get less specific: strip trailing chars of the code (min 6 left) -
    // delivery pages often carry the code minus a suffix (:30H -> :30,
    // -05 dropped, V2 appended). Flagged as close-but-not-exact below.
    if (!exact.length && needle.length >= 8) {
      for (let k = needle.length - 1; k >= 6 && k >= needle.length - 4; k--) {
        const part = needle.slice(0, k);
        for (const f of files) {
          if (f.haystack.includes(part) && !candidates.some(c => c.f === f)) {
            candidates.push({ f, score: 0.9 - (needle.length - k) * 0.02 });
          }
        }
        if (candidates.length) break;
      }
    }

    if (exact.length === 1) {
      res.status = 'FOUND';
      res.matched = exact[0].name;
      exact[0].used = true;
    } else if (exact.length > 1) {
      res.status = 'AMBIGUOUS';
      res.matched = exact.map(f => f.name).join(' | ');
      res.notes = exact.length + ' files match this ID';
      exact.forEach(f => (f.used = true));
    } else if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 3);
      res.status = 'POSSIBLE MATCH';
      res.matched = top.map(c => c.f.name).join(' | ');
      res.notes = 'No exact match - verify filename manually';
    } else {
      res.status = 'MISSING';
      res.notes = 'No matching file';
    }
    results.push(res);
  }

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  // Files no requested ID claimed - the "it was in the folder but not
  // listed" case from real requests.
  const extras = files.filter(f => !f.used).map(f => f.name);
  if (extras.length) counts.EXTRA = extras.length;
  return { results, counts, fileCount: files.length, extras };
}

// ---------- Input parsing ----------

// Minimal CSV/TSV parser (handles quoted fields).
function parseDelimited(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, delim = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (delim === null && (ch === '\t' || ch === ',')) delim = ch;
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); // keep blank rows so sheet row numbers stay accurate
      row = [];
      delim = null;
      continue;
    }
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * Turn pasted text (plain list, TSV, or CSV) into { headers, rows, isTable }.
 * Plain newline lists come back as a single-column table with no header.
 */
function parseInput(text) {
  text = String(text || '').trim();
  if (!text) return { headers: [], rows: [], isTable: false };
  const rows = parseDelimited(text);
  const isTable = rows.length > 0 && rows[0].length > 1;
  const maxCols = Math.max(...rows.map(r => r.length));
  const headers = isTable ? rows[0] : [];
  return { headers, rows, isTable, maxCols };
}

// Guess which column holds the IDs: header containing "id"/"ids".
// "Spot Titles/Tracking IDs" (client-filled) wins over a bare "Tracking ID"
// output column because it sorts earlier and both are 'preferred'.
function guessIdColumn(headers) {
  const preferred = /track|creative|ad|spot/i;
  let fallback = -1;
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c]);
    if (/\bids?\b/i.test(h)) {
      if (preferred.test(h)) return c;
      if (fallback < 0) fallback = c;
    }
  }
  return fallback;
}

// Find the header row in the first N rows: the one with the most
// "header-like" cells (banners like "Required Fields by Inscape" are skipped).
function detectHeaderRow(rows) {
  const headerish = /ingest|campaign|brand|agency|flight|link|file|title|tracking|espn|date|status|length|access|completed/i;
  let best = 0, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    let score = 0;
    for (const c of rows[i]) if (headerish.test(String(c))) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : 0;
}

// ---------- Email drafts ----------

// Sender's first name for reply greetings: accepts raw email text (picks
// the first From: line) or a bare display name/address. "Anthony Cruz
// <a@b>" -> "Anthony"; "Cruz, Anthony" -> "Anthony"; bare addresses and
// empty input yield '' (nothing to greet).
function senderFirstName(text) {
  const first = s => {
    const tok = (String(s || '').trim().match(/[A-Za-zÀ-ÿ'-]+/) || [])[0] || '';
    return tok ? tok[0].toUpperCase() + tok.slice(1) : '';
  };
  let s = String(text || '');
  const m = s.match(/^from:\s*(.+)$/im);
  if (m) {
    s = m[1].replace(/<[^>]*>/g, '').replace(/"/g, '')
      .replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (s.includes(',')) s = s.split(',')[1]; // "Cruz, Anthony"
    const n = first(s);
    if (n && !/^[^\s]+@/.test(s)) return n;
  } else if (s.length <= 60 && !/\r?\n/.test(s) && /[A-ZÀ-Þ]/.test(s)) {
    return first(s); // bare display name passed directly
  }
  // Signature: the sender's sign-off sits at the tail of the FIRST message
  // segment (earlier replies are quoted below it and aren't the sender).
  const head = s.split(/\r?\n(?:from:|sent:|to:|cc:|subject:|on .{0,60}wrote:|-{2,}\s*original|\s*>)/i)[0];
  // Wide window: corporate footers (contact blocks, legal disclaimers)
  // routinely push the sign-off 10+ lines off the end.
  const tail = head.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-18);
  const SIGNOFF = /^(thank you|best regards|warm regards|kind regards|best wishes|respectfully|sincerely|thanks|best|regards|cheers|talk soon|see you|thx|ty|appreciated),?\s*(.*)$/i;
  for (let i = tail.length - 1; i >= 0; i--) {
    const sm = tail[i].match(SIGNOFF);
    if (!sm) continue;
    const sameLine = first(sm[2] && sm[2].replace(/^[,\s]+/, ''));
    if (sameLine) return sameLine;
    if (i + 1 < tail.length) {
      const n = first(tail[i + 1]);
      // a name-ish line: starts with a capital, no address/url/digits
      if (n && /^[A-ZÀ-Þ]/.test(tail[i + 1]) && tail[i + 1].length < 40 && !/[@:\/\d]/.test(tail[i + 1]))
        return n;
    }
    // Deepest sign-off yielded no name - try an earlier one rather than
    // giving up (footers/disclaimers can sit between sign-off and end).
  }
  return '';
}

function greet(sender) {
  return 'Hi' + (sender ? ' ' + sender : '') + ',';
}

function buildExceptionEmail(results, sender) {
  const missing = [], possible = [], ambiguous = [], dupes = [];
  for (const r of results) {
    if (r.status === 'MISSING') missing.push(r.id);
    else if (r.status === 'POSSIBLE MATCH')
      possible.push(r.id + '  (closest file: ' + r.matched.split(' | ')[0] + ')');
    else if (r.status === 'AMBIGUOUS') ambiguous.push(r.id);
    else if (r.status === 'DUPLICATE') dupes.push(r.id + ' (' + r.notes + ')');
  }
  if (!missing.length && !possible.length && !ambiguous.length && !dupes.length) {
    return null;
  }
  const lines = [
    greet(sender), '',
    'Thanks for sending these over. While processing the request I ran into a few issues - could you take a look?', '',
  ];
  if (missing.length) {
    lines.push('The following tracking IDs have no matching file:');
    missing.forEach(id => lines.push('  - ' + id));
    lines.push('');
  }
  if (possible.length) {
    lines.push('I could not match these IDs to a filename - please confirm which files they correspond to (or rename the files to include the ID):');
    possible.forEach(p => lines.push('  - ' + p));
    lines.push('');
  }
  if (ambiguous.length) {
    lines.push('Multiple files matched these IDs - please let me know which to use:');
    ambiguous.forEach(id => lines.push('  - ' + id));
    lines.push('');
  }
  if (dupes.length) {
    lines.push('These IDs were listed more than once (I\'ll process each once unless you tell me otherwise):');
    dupes.forEach(d => lines.push('  - ' + d));
    lines.push('');
  }
  lines.push('Thanks!');
  return lines.join('\n');
}

// ---------- Confirmation phrasing variants ----------
// Replies get templated fast when the same sentences go out weekly. Each
// builder picks phrasing deterministically from a hash of the request
// content - the same job always drafts the same wording (no re-render
// shuffle), while different clients/weeks get different phrasing.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const pick = (pool, seed) => pool[seed % pool.length];

const CONF_INTRO = {
  none: [
    "I've ingested those creatives to appear in the commercial reports under the following IDs:",
    "Those creatives are ingested and will report under the following IDs:",
    "Confirming those creatives are ingested - they'll appear in the commercial reports under these IDs:",
    "All set - those creatives are ingested. They'll report under the following IDs:",
    "Quick confirmation - those creatives are ingested and reporting under the following IDs:",
  ],
  one: [
    "I've ingested those creatives and a ticker version to appear in the commercial reports under the following IDs:",
    "Those creatives are ingested, ticker version included - they'll report under the following IDs:",
    "Confirming those creatives plus the ticker version are ingested, reporting under these IDs:",
  ],
  many: [
    "I've ingested those creatives and ticker versions to appear in the commercial reports under the following IDs:",
    "Those creatives are all ingested along with their ticker versions - they'll report under the following IDs:",
    "Confirming those creatives and their ticker versions are ingested, reporting under these IDs:",
  ],
};
const CONF_SHEET = [
    "I've updated the tracking sheet as well.",
    "The tracking sheet has been updated accordingly.",
    "I've updated the tracking sheet to reflect this.",
    "Tracking sheet is updated too.",
    "Sheet's updated with the ingested IDs.",
];
const CONF_MISSING = {
  one: [
    'Did not ingest this one as it was not in the linked folder:',
    'This one was not in the linked folder, so I did not ingest it:',
    'I skipped this file - it was not in the linked folder:',
  ],
  many: [
    'Did not ingest these as they were not in the linked folder:',
    'These were not in the linked folder, so I did not ingest them:',
    'I skipped these - they were not in the linked folder:',
  ],
};
const CONF_COUNT = [
  (i, r) => "I've ingested " + i + ' of the ' + r + ' requested files',
  (i, r) => i + ' of the ' + r + ' requested files are ingested',
  (i, r) => 'Ingested ' + i + ' of the ' + r + ' files you sent over',
];

// Confirmation built from matched sheet rows, in the format actually used:
// "I've ingested those creatives ... under the following IDs:" + titles.
// Phrasing rotates per request (seeded by the ID list) so replies don't
// read like copy-paste.
function buildMatchConfirmation(matched, sender) {
  const items = [];
  let nEspn = 0;
  matched
    .filter(m => m.matchType !== 'ROW (out of range)')
    .forEach(m => {
      const base = m.trackingId || m.title || m.id;
      if (!base) return;
      items.push(base);
      if (m.espn || m.emailEspn) { items.push(base + '_ticker'); nEspn++; }
    });
  if (!items.length) return null;
  const seed = hashStr(items.join('|'));
  const intro = pick(CONF_INTRO[nEspn === 0 ? 'none' : nEspn === 1 ? 'one' : 'many'], seed);
  const lines = [greet(sender), '', intro];
  items.forEach(t => lines.push(t));
  lines.push('', pick(CONF_SHEET, seed >> 3), '', 'Thanks,');
  return lines.join('\n');
}

// Post-reconcile confirmation: found IDs claimed, missing called out.
// Page extras are deliberately excluded - delivery lists (Extreme Reach
// especially) carry other clients' files, so naming them in a reply leaks
// unrelated work and confuses the sender. They still show in the UI.
// espnIds: Set of normalized IDs that need a <id>_ticker entry.
function buildReconConfirmation(results, espnIds, sender) {
  const found = results.filter(r => r.status === 'FOUND').map(r => r.id);
  const missing = results.filter(r => r.status === 'MISSING').map(r => r.id);
  const requested = results.filter(r => r.status !== 'BLANK' && r.status !== 'DUPLICATE').length;
  if (!found.length) return null;
  const tickers = found
    .filter(id => espnIds && espnIds.has(normalizeName(id).replace(/ /g, '')))
    .map(id => id + '_ticker');
  const seed = hashStr(found.join('|') + '::' + missing.join('|'));
  const lines = [greet(sender), '',
    pick(CONF_COUNT, seed)(found.length, requested) +
    (tickers.length ? ' and ticker versions' : '') +
    ' to appear in the commercial reports:'];
  found.concat(tickers).forEach(id => lines.push(id));
  if (missing.length) {
    lines.push('', pick(CONF_MISSING[missing.length === 1 ? 'one' : 'many'], seed >> 4));
    missing.forEach(id => lines.push(id));
  }
  lines.push('', pick(CONF_SHEET, seed >> 6), '', 'Thanks,');
  return lines.join('\n');
}

function buildConfirmationEmail(results, sender) {
  const found = results.filter(r => r.status === 'FOUND');
  const reviewed = results.filter(r => r.status === 'POSSIBLE MATCH' || r.status === 'AMBIGUOUS');
  if (!found.length && !reviewed.length) return null;
  const lines = [
    greet(sender), '',
    'Confirming receipt - we have the files and are processing the following tracking IDs:', '',
  ];
  found.forEach(r => lines.push('  - ' + r.id));
  if (reviewed.length) {
    lines.push('', 'Also matched (flagged for verification):');
    reviewed.forEach(r => lines.push('  - ' + r.id + ' -> ' + r.matched.split(' | ')[0]));
  }
  lines.push('', 'Thanks!');
  return lines.join('\n');
}

// ---------- Request-email extraction ----------

// Minimal .eml reader: split headers/body, prefer the text/plain part,
// decode quoted-printable, strip HTML when that's all there is.
function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, txt) => {
      // Keep the href - tracker/sheet links live behind link text, and
      // dropping them loses the email-linked sheet path entirely.
      const t = txt.replace(/<[^>]+>/g, '').trim();
      return t && t !== url ? t + ' [' + url + ']' : ' ' + url + ' ';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}
function qpDecode(s) {
  const t = s.replace(/=\r?\n/g, '');
  try { return decodeURIComponent(t.replace(/=([0-9A-Fa-f]{2})/g, '%$1')); }
  catch (e) { return t; }
}
function mimeWord(s) {
  return String(s || '').replace(/=\?[^?]+\?([BQ])\?([^?]*)\?=/gi, (m, enc, txt) => {
    try {
      if (/b/i.test(enc)) {
        const bin = atob(txt.replace(/\s/g, ''));
        return decodeURIComponent([...bin].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      }
      return decodeURIComponent(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, '%$1'));
    } catch (e) { return txt; }
  });
}
// Does an unread message look like a delivery request? Codes in the body
// are a slam dunk; otherwise the delivery-vocabulary check catches the
// "please ingest" phrasing. Used by the Graph inbox scan and the badge.
function looksLikeRequest(subject, body) {
  if (extractCodes(body || '').length >= 2) return true;
  const t = (subject || '') + ' ' + String(body || '').slice(0, 4000);
  return /ingest|new creative|new spot|deliver(y|ed)|traffick|extreme ?reach|yangaroo|ad-?id|isci|spot (delivery|list)|tracking sheet/i.test(t);
}

function parseEml(text) {
  text = String(text || '');
  const i = text.search(/\r?\n\r?\n/);
  if (i < 0) return { subject: '', body: text };
  const headers = text.slice(0, i);
  let body = text.slice(i);
  const subject = mimeWord((headers.match(/^subject:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]*)*)/im) || [])[1] || '');
  const from = mimeWord((headers.match(/^from:\s*([^\r\n]+)/im) || [])[1] || '');
  const ct = (headers.match(/^content-type:\s*([^\r\n;]+)/im) || [])[1] || '';
  if (/multipart/i.test(ct)) {
    const b = (headers.match(/boundary="?([^"\r\n;]+)"?/i) || [])[1];
    if (b) {
      const parts = body.split(new RegExp('--' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      const stripPart = p => p.replace(/^[\s\S]*?\r?\n\r?\n/, '').replace(/\r?\n?--\s*$/, '');
      const plain = parts.find(p => /^content-type:\s*text\/plain/im.test(p));
      const html = parts.find(p => /^content-type:\s*text\/html/im.test(p));
      body = stripPart(plain || html || parts[1] || '');
      if (!plain && html) body = stripHtml(body);
      if (/quoted-printable/i.test((plain || html || '').slice(0, 600))) body = qpDecode(body);
    }
  } else if (/text\/html/i.test(ct)) {
    body = stripHtml(body);
  }
  if (/quoted-printable/i.test(headers)) body = qpDecode(body);
  return { subject: subject.trim(), body: body.trim(), from: from.trim() };
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function extractLinks(text) {
  const links = [];
  const seen = new Set();
  let m;
  while ((m = URL_RE.exec(String(text)))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    let type = 'link';
    // Mimecast/similar protection wrappers: classify by the real domain param.
    const wrapped = url.match(/[?&]domain=([a-z0-9.-]+)/i);
    const host = wrapped ? wrapped[1] : url;
    if (/drive\.google\.com|docs\.google\.com/i.test(host)) type = 'google-drive';
    else if (/extremereach\.com/i.test(host)) type = 'extreme-reach';
    else if (/dropbox\.com/i.test(host)) type = 'dropbox';
    else if (/sharepoint\.com|onedrive/i.test(host)) type = 'sharepoint';
    else if (/box\.com/i.test(host)) type = 'box';
    else if (/wetransfer|frame\.io|aspera|signiant/i.test(host)) type = 'transfer';
    else if (/yangaroo\.com|dmds/i.test(host)) type = 'yangaroo';
    else if (/creativehub\.|amcnetworks\.com/i.test(host)) type = 'creative-hub';
    else if (/egnyte\.com/i.test(host)) type = 'egnyte';
    else if (/aenetworks\.files\.com|files\.com/i.test(host)) type = 'file-share';
    else if (/youtube\.com|youtu\.be/i.test(host)) type = 'youtube';
    else type = wrapped ? 'wrapped-link' : 'link';
    links.push({ url, type });
  }
  return links;
}

function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
}

// Dates in common formats -> ISO 'YYYY-MM-DD'. Two-digit years -> 20xx.
function extractDates(text) {
  const out = new Set();
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const iso = (y, mo, d) =>
    `${y.length === 2 ? '20' + y : y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = String(text || '');
  let m;

  // 2026-10-14 / 2026/10/14
  const re1 = /\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/g;
  while ((m = re1.exec(t))) out.add(iso(m[1], +m[2], +m[3]));

  // 10/14/2026, 10-14-26
  const re2 = /\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\b/g;
  while ((m = re2.exec(t))) out.add(iso(m[3], +m[1], +m[2]));

  // Oct 14, 2026 / October 14 / 14 Oct 2026
  const mon = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const re3 = new RegExp('\\b(' + mon + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?[,\\s]+(\\d{4})\\b', 'gi');
  while ((m = re3.exec(t))) out.add(iso(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]));
  const re4 = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + mon + ')[a-z]*\\.?[,\\s]+(\\d{4})\\b', 'gi');
  while ((m = re4.exec(t))) out.add(iso(m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]));

  return [...out].sort();
}

// Keep captured file entries whose line has no date, or a date in the set.
function filterByDates(entries, dateSet) {
  if (!dateSet || !dateSet.size) return { kept: entries, dropped: [] };
  const kept = [], dropped = [];
  for (const e of entries) {
    const d = e.date;
    if (!d || dateSet.has(d)) kept.push(e);
    else dropped.push(e);
  }
  return { kept, dropped };
}

// Sheet row references in emails: "rows 1857-1859", "row 12", "rows 5, 8-10".
function extractRowRefs(text) {
  const rows = new Set();
  // 'row(s)'/'line(s)' keyword followed by numbers. Comma is both a
  // thousands separator ("NEXT tab lines 13,286-13,289") and a list
  // separator ("rows 1857, 1860") - strip thousands groups BEFORE
  // splitting on commas or a range like 13,286-13,289 explodes into
  // "13" + "286-13" + "289".
  const re = /\b(?:rows?|lines?)\s+(\d[\d,\s]*(?:(?:[-–]|\bto\b)[\d,\s]*)?)/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    const seg = m[1].replace(/(\d),(?=\d{3}\b)/g, '$1');  // 13,286 -> 13286
    seg.split(',').forEach(part => {
      const r = part.match(/(\d+)\s*(?:[-–]|to)\s*(\d+)/i);
      if (r) {
        const a = +r[1], b = +r[2];
        if (b >= a && b - a <= 500) for (let i = a; i <= b; i++) rows.add(i);
      } else {
        const n = part.match(/\d+/);
        if (n) rows.add(+n[0]);
      }
    });
  }
  return [...rows].sort((a, b) => a - b);
}

// A pasted thread drags every prior reply along - including OUR confirmed
// code lists, which would re-extract as 'new requests'. The request lives
// in the newest segment only: everything before the first older-message
// boundary (a 'From:' header, 'On ... wrote:', '----Original Message----',
// or '>'-quoted lines). A leading 'From:' header block belongs to the
// newest message itself, so the first one doesn't cut.
function latestSegment(text) {
  const lines = String(text || '').split(/\r?\n/);
  const first = lines.findIndex(l => l.trim());
  if (first < 0) return '';
  let blockOK = /^from:\s/i.test(lines[first].trim()) === false;
  for (let i = first; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^on .{0,140}wrote:/i.test(l) ||
        /^-{2,}\s*(original|forwarded) message/i.test(l) ||
        /^begin forwarded message/i.test(l) ||
        /^>/.test(l)) return lines.slice(0, i).join('\n');
    if (/^from:\s/i.test(l)) {
      if (blockOK) return lines.slice(0, i).join('\n');
      blockOK = true;
    }
  }
  return lines.join('\n');
}

// "added 3 new creatives" / "below 2x spot(s)" -> 3 / 2
// (sanity check vs matched-row count).
function extractNewCount(text) {
  const t = String(text);
  const m =
    t.match(/\b(\d+)\s*x\s*spots?/i) ||
    t.match(/\b(\d+)\s+new\b/i) ||
    t.match(/\b(\d+)\s+spots?\b/i);
  return m ? +m[1] : null;
}

// Delivery codes: Ad-ID (letters-first, e.g. YKKL0288000H), ISCI-style
// (digits-first, e.g. 0926607ZKCH), and vendor forms with one embedded
// underscore (Cuebiq VIA_93889). 7-14 alnum/underscore chars with >=1
// letter + >=1 digit - excludes phone numbers, row refs, plain words.
const CODE_RE = /\b(?=[A-Z0-9_]*[A-Z])(?=[A-Z0-9_]*\d)(?=[A-Z0-9_]{7,14}\b)[A-Z0-9]+(?:_[A-Z0-9]+)?\b/;

// Looser validity check for code-shaped tokens in running prose - catches
// separator/short forms CODE_RE misses: BP569205-05, ITO013:, VIA_93889.
// Requires >=2 letters + >=1 digit + >=6 alnum, which rejects quarters
// (Q4-2025: 1 letter), plain words, dates, and row refs.
function isCodeToken(tok) {
  const s = String(tok || '').replace(/[.:;,!?]+$/, '');
  if (!/^[A-Z0-9][A-Z0-9_\-:]*$/.test(s)) return false;
  const alnum = s.replace(/[_\-:]/g, '');
  const letters = (s.match(/[A-Z]/g) || []).length;
  if (!/\d/.test(s) || alnum.length < 6) return false;
  // >=2 letters covers Ad-ID/ISCI/vendor forms; a single leading letter
  // + long digit run covers AMC-style IDs (S02439406001). Rejects
  // quarters (Q4-2025), plain words, dates, row refs, phone numbers.
  return letters >= 2 || (letters === 1 && /^[A-Z]/.test(s) && alnum.length >= 10);
}

// All delivery-code tokens in a text (deduped, order preserved) - e.g. a
// Tatari batch email's brand_slug + ISCI line pairs (~110 codes), or a
// Horizon request's ISCIs embedded in prose. The email body itself is the
// manifest for clients that list codes inline.
function extractCodes(text) {
  const seen = new Set(), out = [];
  const re = /[A-Z0-9][A-Z0-9_\-:]{3,24}/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tok = m[0].replace(/[.:;,]+$/, '');
    if (isCodeToken(tok) && !seen.has(tok)) { seen.add(tok); out.push(tok); }
  }
  return out;
}

// Same-line code + title pairs (Chief Media style:
// "FRGPATLRN30H          Fragrance Patricia Learn More 30"). Code must sit
// left of >=2 spaces; the rest of the line is the spot title.
function extractCodeTitlePairs(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*(\S+)\s{2,}(\S.*)$/);
    if (m && isCodeToken(m[1]) && m[2].trim().length > 2) {
      out.push({ id: m[1], title: m[2].trim() });
    }
  });
  return out;
}

// Column-per-line spot manifests (AMC style):
//   <sheet row#>\n<spot title>\n<ISCI>\n<share link>\n:<len>
// For each standalone code line: title = nearest preceding text line that
// isn't a bare number / URL / duration; row = the bare-integer line above
// the title (sheet row ref); url/len = the link + ':\d+' following the code.
function extractSpotBlocks(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  const out = [];
  const isNum = l => /^\d{3,6}$/.test(l);
  const isUrl = l => /https?:\/\//.test(l);
  const isLen = l => /^:\d{1,3}$/.test(l) || /^\d{1,3}s$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    // A code alone on the line, or a table row starting with a code
    // ("NTUR3388000H 10/20 START") - a short remainder is column text
    // (campaign/creative name), not prose.
    const cm = lines[i].match(/^(\S+)(.*)$/);
    if (!cm || !isCodeToken(cm[1])) continue;
    const spot = { id: cm[1], title: '', row: 0, url: '', len: '' };
    const inline = (cm[2] || '').trim();
    if (inline && inline.length <= 40 && inline.split(/\s+/).length <= 6 &&
        !/[.!?,;:]$/.test(inline) && !isUrl(inline) && !isCodeToken(inline)) {
      spot.title = inline;
    }
    for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
      const l = lines[j];
      if (!l) break;
      // NFL blocks put the share link BEFORE the code: capture it on the
      // way up too (forward scan below handles link-after-code layouts).
      if (isUrl(l)) { if (!spot.url) spot.url = firstUrl(l) || l; continue; }
      if (isNum(l)) { if (spot.title) spot.row = +l; break; }
      if (!spot.title) spot.title = l;
      else break;  // prose above the title isn't part of this block
    }
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const l = lines[j];
      if (isCodeToken(l)) break;
      if (!spot.url && isUrl(l)) { spot.url = firstUrl(l) || l; continue; }
      if (!spot.len && isLen(l)) { spot.len = l.replace(':', ''); continue; }
      if (spot.url && spot.len) break;
    }
    out.push(spot);
  }
  return out;
}

/**
 * Inline spot tables in emails sometimes carry their own "Need ESPN
 * Version" YES/NO column. Returns Map(lowercased ID -> bool) parsed from
 * lines like "YKKL0288000H 10/18/2026 10/25/2026 YES" (single line or
 * split across consecutive lines after paste).
 */
function extractEmailEspnFlags(text) {
  const flags = new Map();
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/\b(yes|no)\b/i);
    if (!fm) continue;
    const val = fm[1].toLowerCase() === 'yes';
    // ID on the same line?
    let idm = line.match(CODE_RE);
    if (!idm) {
      // look back a few lines for the row's ID token
      for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
        idm = lines[j].match(CODE_RE);
        if (idm) break;
        if (/\S/.test(lines[j]) === false) continue;
      }
    }
    if (idm) flags.set(idm[0].toLowerCase(), val);
  }
  return flags;
}

// ---------- Email -> tracking-sheet matching ----------

function truthyFlag(v) {
  return /espn|ticker|yes|true|\by\b|x/i.test(String(v || '').trim());
}

function guessColumn(headers, re) {
  for (let c = 0; c < headers.length; c++) {
    if (re.test(String(headers[c]))) return c;
  }
  return -1;
}

// ---------- Canonical field vocabulary ----------
// Rightmost columns we fill post-ingest (ingester name, ingest date,
// confirmed IDs/titles) mark completed work. Rows where every fill-back
// cell is empty = the pending queue - for batch clients like Tatari that
// pending list IS the work order, reconciled against ER deliveries.
const FILLBACK_RE = /\binscape\b|\bconfirmed\b|\bfinal(ized)?\b|\bingest(ed)? (complete|by)\b|\bcompleted (by|date)\b|\bingested by\b|\bdate ingested\b/i;
// Headers that LOOK like ours but aren't: 'Date Spot Sent to Inscape' is
// filled by the client at request time - counting it as fill-back would
// hide exactly the sent-but-pending rows that make up the work queue.
const FILLBACK_SKIP_RE = /\bsent to inscape\b|\bsent to vizio\b/i;
// Merged group headers ("LWDirect to Complete | Inscape to Complete")
// mark which SIDE fills each column block. Our-side groups are named for
// us - 'Inscape to Complete' also marks a bare 'Tracking ID' whose own
// header is indistinguishable from the client's source column.
const GROUP_FILLBACK_RE = /\binscape\b|\bvizio\b/i;  // 'For HMI Use Only' blocks are the AGENCY's, not ours - the name has to say so

function fillBackColumns(headers, groupRow) {
  const out = [];
  let group = '';
  for (let c = 0; c < headers.length; c++) {
    // merged label propagates rightward until the next non-empty cell
    const g = groupRow ? String(groupRow[c] || '').trim() : '';
    if (g) group = g;
    const h = String(headers[c]);
    if ((!FILLBACK_SKIP_RE.test(h) && FILLBACK_RE.test(h)) || GROUP_FILLBACK_RE.test(group)) out.push(c);
  }
  return out;
}

// Indices of rows whose fill-back cells are ALL empty = not yet ingested.
function pendingRowIndices(rows, fbCols) {
  const out = [];
  rows.forEach((r, i) => {
    if (!fbCols.some(c => String(r[c] || '').trim())) out.push(i);
  });
  return out;
}

// Trackers name the two ingest-name fields colloquially. Every alias maps
// to exactly one canonical field - 'Title ID' is a trackingId, never a
// spotTitle - so no other column can leak into matching or file naming.
// exact hits win over loose hits; among equals the leftmost column wins
// (client-filled "Spot Titles/Tracking IDs" sits left of a bare
// "Tracking ID" output column).
const FIELD_VOCAB = {
  trackingId: {
    exact: /^(tracking|reporting|title|spot|creative|asset|ad|commercial)[_ ]?ids?$|^isci( codes?)?$|^ad.?ids?$|^ids?$|^codes?$|\/.*\bids?\b/i,
    loose: /\b(tracking|reporting|title|spot|creative|asset|ad|commercial)[_ ]?ids?\b|\bisci\b/i,
    // OUR fill-back columns (rightmost on every tracker): 'Inscape Tracking
    // ID', 'Confirmed/Final ...', 'Ingest Complete/By' are outputs we write
    // post-ingest, never source data - they sink below every source column.
    defer: /\binscape\b|\bconfirmed\b|\bfinal(ized)?\b|\bingest(ed)? (complete|by)\b/i,
  },
  spotTitle: {
    // slash-combined headers carry both fields and pass as exact
    exact: /^((spot|creative|asset|commercial)[_ ]?)?(titles?|names?|descriptions?)$|\btitles?\b.*\/|\/.*\btitles?\b/i,
    loose: /\b(spot|creative|asset|commercial)[_ ]?(titles?|names?)\b|\btitles?\b|\bdescriptions?\b/i,
    reject: /\bids?\b/i,  // 'Title ID' is a trackingId, never a spotTitle
    defer: /\binscape\b|\bconfirmed\b|\bfinal(ized)?\b|\bingest(ed)? (complete|by)\b/i,
  },
};

// Value-shape heuristics: a tracking ID is ISCI-shaped - letters+digits,
// no spaces, all caps (e.g. 0926607ZKCH, YKKL0288000H). A spot title is
// descriptive text - anything non-code.
function isCodeLike(v) {
  v = String(v || '').trim();
  return /^[A-Z0-9_]{5,20}$/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v);
}
function isTitleLike(v) {
  v = String(v || '').trim();
  return v.length > 2 && /[A-Za-z]/.test(v) && !isCodeLike(v);
}

// What fraction of a column's filled cells match the field's value shape?
function colLooksLike(rows, c, field) {
  const test = field === 'trackingId' ? isCodeLike : isTitleLike;
  let hits = 0, n = 0;
  for (const r of rows.slice(0, 50)) {
    const v = String(r[c] || '').trim();
    if (!v) continue;
    n++; if (test(v)) hits++;
  }
  return n > 0 && hits / n >= 0.5;
}

// Resolve a canonical field to its column: exact aliases first, then loose
// (reject-regexed columns can't be claimed; deferred fill-back columns sit
// below every source column). Among equal-strength columns, the one whose
// cell VALUES match the field shape wins - 'Title ID' holds codes,
// 'Spot Title' holds words. -1 = sheet lacks the field.
function guessField(headers, field, rows, groupRow) {
  const v = FIELD_VOCAB[field];
  if (!v) return -1;
  // Even deferred, a column must plausibly hold the field - 'Completed by'
  // and 'Ingest Complete Date' live under our fill-back block but are a
  // person-name and a date, never an ID or a title.
  const DF_NAME = {
    trackingId: /\bids?\b|\btracking\b|\breport/i,
    spotTitle: /\btitles?\b|\bnames?\b|\bdescriptions?\b|\bcopy\b/i,
  };
  const ex = [], lo = [], df = [];
  let group = '';
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c]);
    // merged group label propagates rightward - a column sitting under a
    // restricted block ('Inscape team use ONLY', 'For HMI Use Only') is a
    // reserved output col even when its own header reads like source data
    const g = groupRow ? String(groupRow[c] || '').trim() : '';
    if (g) group = g;
    if (GROUP_FILLBACK_RE.test(group) || (v.defer && v.defer.test(h))) {
      if (!DF_NAME[field] || DF_NAME[field].test(h)) df.push(c);
      continue;
    }
    if (v.reject && v.reject.test(h)) continue;
    if (v.exact.test(h)) ex.push(c);
    else if (v.loose.test(h)) lo.push(c);
  }
  const pick = cands => {
    if (!cands.length) return -1;
    if (rows && cands.length > 1) {
      const shaped = cands.filter(c => colLooksLike(rows, c, field));
      if (shaped.length) return shaped[0];
    }
    return cands[0];
  };
  // Defer is the last resort AND must still hold the field's value shape -
  // a deferred 'Ingest Complete Date' is not a spotTitle source, so when
  // nothing fits the shape the honest answer is -1 (sheet lacks the field).
  if (pick(ex) >= 0) return pick(ex);
  if (pick(lo) >= 0) return pick(lo);
  if (rows && df.length && !df.some(c => colLooksLike(rows, c, field))) return -1;
  return pick(df);
}

/**
 * Which sheet rows does this request email refer to?
 * rows: array of row arrays (header excluded). cols: {id, link, brand, espn, date, title}
 * opts: { headerRow } - 1-based index of the header row (default 1), so
 * absolute sheet row numbers can be matched against "rows 1857-1859" refs.
 * Priority: explicit row refs > ID in email > brand in email.
 */
/**
 * Which sheet rows does this request email refer to?
 * rows: array of row arrays (header excluded). cols: {id, title, file, link, access, brand, espn, date}
 * opts: { headerRow } - 1-based index of the header row (default 1), so
 * absolute sheet row numbers can be matched against "rows 1857-1859" refs.
 * Priority: row refs / IDs / filenames are explicit. Brand matches only
 * apply when the email contains nothing explicit (a brand name alone in a
 * master tracker would match hundreds of historical rows).
 */
function matchEmailToSheet(emailText, rows, cols, opts) {
  const headerRow = (opts && opts.headerRow) || 1;
  const rowRefs = new Set(extractRowRefs(emailText));
  const hay = normalizeName(emailText).replace(/ /g, '');
  const emailEspn = extractEmailEspnFlags(emailText);
  // Extracted codes are distinctive enough to check against EVERY cell in
  // a row - completed rows can carry the code only in a fill-back column
  // (Inscape Tracking ID), or the source column with extra suffix text.
  const needles = extractCodes(emailText).map(c => normalizeName(c).replace(/[\s:_-]+/g, ''));
  const matched = [];
  rows.forEach((r, i) => {
    const get = c => (c >= 0 ? String(r[c] || '').trim() : '');
    const rowNum = i + headerRow + 1;
    const id = get(cols.id);
    const fileName = get(cols.file);
    const brand = get(cols.brand);
    const title = get(cols.title);
    let matchType = '';
    if (rowRefs.has(rowNum)) matchType = 'ROW';
    else {
      const idN = normalizeName(id).replace(/ /g, '');
      const fN = normalizeName(fileName).replace(/ /g, '');
      const bN = normalizeName(brand).replace(/ /g, '');
      // Substring hits need a distinctive token: bare short words like the
      // File Name "NEXT"/"DDT"/"LINK" slot labels live inside everyday
      // email text ("NEXT tab", "link") and false-match whole row blocks.
      // Require a digit (codes all carry one) or a long distinctive word.
      const hit = n => n.length >= 4 && hay.includes(n) && (/\d/.test(n) || n.length >= 10);
      const tN = normalizeName(title).replace(/ /g, '');
      if (hit(idN)) matchType = 'ID';
      else if (needles.length && needles.some(c => c.length >= 6 &&
          normalizeName(r.join(' ')).replace(/[\s:_-]+/g, '').includes(c))) matchType = 'ID';
      else if (hit(fN)) matchType = 'FILE';
      // A spot title quoted in the email is an explicit reference too -
      // emails often name spots conversationally rather than by code.
      else if (hit(tN)) matchType = 'TITLE';
      else if (bN.length >= 4 && hay.includes(bN)) matchType = 'BRAND';
    }
    if (!matchType) return;
    // Tracking ID convention (from real sheets): Ad-ID codes pass through
    // verbatim; title-style IDs get apostrophes -> underscores.
    const trackingId = CODE_RE.test(id)
      ? id.trim()
      : String(title || id).replace(/'/g, '_').trim();
    const entry = {
      row: rowNum,
      id,
      title,
      trackingId,
      fileName,
      brand,
      matchType,
      linkText: get(cols.link),          // raw cell - may be a folder NAME not a URL
      link: firstUrl(get(cols.link)),
      access: cols.access >= 0 ? truthyFlag(get(cols.access)) : null,
      espn: cols.espn >= 0 ? truthyFlag(get(cols.espn)) : false,
      date: get(cols.date),
    };
    // Cross-check the email's own "Need ESPN Version" flag, if present.
    const rowCode = (id + ' ' + fileName).match(CODE_RE);
    const eFlag = emailEspn.get(rowCode ? rowCode[0].toLowerCase() : id.toLowerCase());
    if (eFlag !== undefined) {
      entry.emailEspn = eFlag;
      if (cols.espn < 0) entry.espn = eFlag; // email is the only source
      else if (entry.espn !== eFlag) entry.espnConflict = true;
    }
    if (matchType !== 'BRAND') matched.push(entry);
  });
  // Flag referenced rows that fell outside the loaded data.
  rowRefs.forEach(n => {
    if (!matched.some(m => m.row === n)) {
      matched.push({ row: n, id: '', title: '', trackingId: '', fileName: '', brand: '', matchType: 'ROW (out of range)', linkText: '', link: '', access: null, espn: false, date: '' });
    }
  });
  // Clue-finding fallback: nothing explicit - the request is whatever's
  // pending on the sheet (fill-back cols empty = not yet ingested, per
  // "there are new files to ingest, and that's it"). Score each candidate
  // row's identity tokens (brand / advertiser / campaign / title / ID) and
  // request date against the email; strongest scores first, newest rows
  // win ties. These come back tagged GUESS - the panel asks the user to
  // confirm before downloading.
  if (!matched.length) {
    const STOP = new Set(('ingest ingestion please these those spot spots file files have been ' +
      'sent via with from that this your will would could should when what they them then than ' +
      'also just very more some into about their there which where who whom email mail hello ' +
      'team thanks thank regard regards inscape vizio tracking sheet rows lines next request ' +
      'requesting need needs needed available deliver delivered delivery added update updated ' +
      'creatives creative commercial report reports fingerprint fingerprinting horizon media ' +
      'morgan chase morning afternoon evening').split(' '));
    const hayW = new Set(normalizeName(emailText).split(' ').filter(w => w.length >= 4 && !STOP.has(w)));
    const emailDates = extractDates(emailText);
    // Newest pending first: by the sheet's own date column when it parses,
    // else by position (bottom of the tracker = latest additions).
    const pool = (opts.pendingIdx && opts.pendingIdx.length
      ? opts.pendingIdx
      : rows.map((r, i) => i))
      .slice()
      .sort((a, b) => {
        if (cols.date >= 0) {
          const da = [...extractDates(rows[a][cols.date] || '')][0] || '';
          const db = [...extractDates(rows[b][cols.date] || '')][0] || '';
          if (da !== db) return db.localeCompare(da);
        }
        return b - a;
      });
    const scored = [];
    pool.forEach(i => {
      const r = rows[i];
      const get = c => (c >= 0 ? String(r[c] || '').trim() : '');
      const rowW = new Set(normalizeName(
        [get(cols.id), get(cols.title), get(cols.file), get(cols.brand)].join(' ')
      ).split(' ').filter(w => w.length >= 4));
      let score = 0;
      const why = [];
      rowW.forEach(w => {
        if (hayW.has(w)) { score += w.length >= 8 ? 2 : 1; why.push(w); }
      });
      if (get(cols.date) && extractDates(get(cols.date)).size &&
          [...extractDates(get(cols.date))].some(d => emailDates.has(d))) {
        score += 3; why.push('request date');
      }
      if (score > 0) scored.push({ i, score, why });
    });
    scored.sort((a, b) => b.score - a.score || b.i - a.i);
    // No clue hits at all -> surface the newest candidates ("check the
    // bottom of the sheet"): last 10 pending rows, still tagged GUESS.
    const picks = scored.length ? scored.slice(0, 15)
      : pool.slice(0, 10).map(i => ({ i, score: 0, why: ['no email clues - newest pending'] }));
    picks.forEach(({ i, score, why }) => {
      const r = rows[i];
      const get = c => (c >= 0 ? String(r[c] || '').trim() : '');
      const id = get(cols.id), title = get(cols.title);
      matched.push({
        row: i + headerRow + 1, id, title,
        // The sheet's ID column is authoritative even when it isn't ISCI
        // (Icon Media uses 5-char codes like FAL5H); title only backs it up
        // when the ID cell is empty.
        trackingId: id.trim() || String(title || id).replace(/'/g, '_').trim(),
        fileName: get(cols.file), brand: get(cols.brand),
        matchType: 'GUESS', guessScore: score, guessClues: why.slice(0, 5),
        linkText: get(cols.link), link: firstUrl(get(cols.link)),
        access: cols.access >= 0 ? truthyFlag(get(cols.access)) : null,
        espn: cols.espn >= 0 ? truthyFlag(get(cols.espn)) : false,
        date: get(cols.date),
      });
    });
  }
  matched.sort((a, b) => a.row - b.row);
  return matched;
}

// ---------- Drive folder resolution ----------

// 'drive.google.com/drive/folders/<id>' -> folder id, else null.
function driveFolderId(url) {
  const m = String(url || '').match(/drive\.google\.com\/(?:drive\/)?folders\/([\w-]+)/);
  return m ? m[1] : null;
}

// uc download link for a Drive file id. Large files may still hit Drive's
// virus-scan interstitial - the watcher flags non-media downloads.
function driveDownloadUrl(fileId) {
  return 'https://drive.google.com/uc?id=' + fileId + '&export=download&confirm=t';
}

/**
 * Pick the file in a folder listing that corresponds to a sheet row.
 * Tries exact normalized-contains on id/trackingId/title/fileName first,
 * then fuzzy. Returns {status: 'ok'|'ambiguous'|'none', file?, best?}.
 */
function pickRowFile(row, files) {
  const keys = [row.id, row.trackingId, row.title, row.fileName]
    .filter(Boolean)
    .map(s => normalizeName(s).replace(/ /g, ''))
    .filter(k => k.length >= 4);
  let best = null, second = 0;
  for (const f of files) {
    const hay = normalizeName(f.name).replace(/ /g, '');
    const fn = normalizeName(f.name);
    let score = 0;
    for (const k of keys) {
      if (hay.includes(k)) { score = 1; break; }
      score = Math.max(score, similarity(k, fn));
    }
    if (!best || score > best.score) { second = best ? best.score : 0; best = { file: f, score }; }
    else if (score > second) second = score;
  }
  if (!best) return { status: 'none' };
  if (best.score === 1 || best.score >= 0.6) {
    if (second > 0.55 && second > best.score - 0.05) {
      return { status: 'ambiguous', file: best.file };
    }
    return { status: 'ok', file: best.file, score: best.score };
  }
  return { status: 'none', best: best.file.name };
}

// ---------- Download job / manifest ----------

function downloadName(m) {
  let base = '';
  try {
    base = decodeURIComponent(new URL(m.link).pathname.split('/').pop() || '');
  } catch (e) { /* keep */ }
  if (!base || !/\.[a-z0-9]{2,5}$/i.test(base)) {
    base = (m.id ? m.id.replace(/[^\w.-]+/g, '_') : 'file') + '_row' + m.row;
  }
  return base;
}

function espnOutputName(fileName, suffix) {
  return String(fileName).replace(/\.[^.]+$/, '') + (suffix || '_ticker') + '.mp4';
}

// Ingest file naming, driven by the client rules sheet: only fields the
// client's ingest spec calls for are added to the filename - tracking ID,
// plus the spot title when ingest.nameTitle is set. A spec naming neither
// keeps the delivered filename. Title keeps spaces to match the ER
// "Ad-ID title" capture convention. Charset is deliberately tight: only
// word chars, periods, underscores, dashes, spaces - anything else
// (apostrophes, &, +, parens) is removed outright. Returns '' when
// nothing spec'd.
function ingestFileName(trackingId, title, ext) {
  const clean = s => String(s || '')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const t = clean(trackingId), s = clean(title);
  // Identical fields collapse to a single moniker - never a doubled name.
  const name = t === s ? t : [t, s].filter(Boolean).join(' ');
  return name ? name + (ext || '.mp4') : '';
}

// jobs: [{file, url, tracking_id, title, expected_name, row, needs_espn}]
// clientInfo: optional playbook ingest block (cid_map, fingerprint,
// ticker rules) - carried through to report.json for the ingest step.
function buildManifest(job, jobs, clientInfo) {
  const suffix = clientInfo && clientInfo.tickerSuffix;
  return JSON.stringify(
    {
      job,
      created: new Date().toISOString(),
      client: clientInfo || null,
      files: jobs.map(j => ({
        file: j.file,
        url: j.url,
        tracking_id: j.tracking_id,
        spot_title: j.title || '',
        expected_name: j.expected_name || '',
        row: j.row,
        needs_espn: !!j.needs_espn,
        espn_output: j.needs_espn ? espnOutputName(j.file, suffix) : null,
      })),
    },
    null,
    2
  );
}

// Results -> CSV for attaching to Jira / keeping records.
function resultsToCsv(results) {
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [['ID', 'Status', 'Matched File', 'Notes'].join(',')];
  for (const r of results) {
    rows.push([r.id, r.status, r.matched, r.notes].map(esc).join(','));
  }
  return rows.join('\n');
}
