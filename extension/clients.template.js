/**
 * Client playbooks - detection + delivery + ingest requirements.
 *
 * PORTABLE BUILD TEMPLATE: this file ships empty. Add your own clients
 * following the shape below - detection priority is tracking-sheet id,
 * then email subject keywords, then sender/cc domain.
 *
 * detect:  { sheetIds, subjects, keywords, domains }  - regexes
 * delivery: 'links' | 'yangaroo' | 'extreme-reach' | 'sharepoint' |
 *           'dropbox' | 'other'  + note = the playbook step shown in-panel
 * ingest:  cidMap, fingerprint ('both'|'video'), ticker ('always'|'flagged'),
 *          retention, brandFixed, note - carried into the job manifest.
 */

// The per-customer reference sheet (Customer | Exceptions | Tracker |
// Files/share) fetched live every 15 min. Paste your own link-shared
// sheet's document id here; empty disables the feature.
var REF_SHEET_ID = '';

var CLIENTS = [
  // Example:
  // {
  //   id: 'acme',
  //   name: 'Acme Media',
  //   detect: {
  //     sheetIds: ['<google sheet doc id>'],
  //     subjects: ['Acme.*Ingest'],
  //     keywords: ['acme media'],
  //     domains:  ['acmemedia\\.com'],
  //   },
  //   delivery: 'extreme-reach',
  //   note: 'Deliveries come via Extreme Reach; tracker is link-shared.',
  //   ingest: { cidMap: ['acmemedia'], fingerprint: 'both', ticker: 'flagged' },
  // },
];

// Outlook folder name -> playbook id (your own mail rules). Empty by
// default - add rows as 'Folder Name': 'client-id' (or null to ignore).
var CLIENT_FOLDERS = {
};

function detectClient(sig) {
  sig = sig || {};
  const d = c => c.detect || {};
  // 1. sheet document id - strongest signal
  if (sig.sheetId) {
    for (const c of CLIENTS) {
      if ((d(c).sheetIds || []).includes(sig.sheetId)) return c;
    }
  }
  // 2. subject-line patterns - precise per client
  if (sig.subject) {
    for (const c of CLIENTS) {
      if ((d(c).subjects || []).some(re => re.test(sig.subject))) return c;
    }
  }
  // 3. keywords over subject+body - brand-level signal, beats domains
  const text = (sig.subject || '') + '\n' + (sig.emailText || '');
  if (text.trim()) {
    for (const c of CLIENTS) {
      if ((d(c).keywords || []).some(re => re.test(text))) return c;
    }
  }
  // 4. mail folder name - the user's own rules classified the sender
  //    (agency-level: brand keywords above still refine the umbrella)
  if (sig.folderName && CLIENT_FOLDERS[sig.folderName]) {
    const c = CLIENTS.find(x => x.id === CLIENT_FOLDERS[sig.folderName]);
    if (c) return c;
  }
  // 5. sender/cc domains - weakest signal, shared across advertisers
  if (text.trim()) {
    for (const c of CLIENTS) {
      if ((d(c).domains || []).some(re => re.test(text))) return c;
    }
  }
  return null;
}

// Advertiser name out of delivery-notification subjects:
//   "<Brand> Spot Delivery Notification for Inscape TV"   (Extreme Reach)
//   "New Media Available from <Brand>: ..."               (Yangaroo)
//   "<Brand> | Horizon Media | Creative Ingest Request"   (Horizon)
//   "InMarket/Inscape - <Brand> C7" / "Inscape x InMarket - <Brand>"  (InMarket)
//   "<Brand> Creatives added" / "Creative added, <Brand>" (Chief Media)
//   "Inscape Ingest - <Brand/Show>"                       (Millenia3)
//   "<Brand> - Creatives for (Re-)Fingerprinting"         (Optimum/a4)
//   "<Brand> Inscape (Creative )?Ingest(ion)?( Request)?" (misc agencies)
//   "<Brand> | Inscape Ingestion"                         (Spectrum Resi etc.)
// Used to aid matching and shown only when the client's ingest spec
// requires advertiser/brand metadata - the useful identity is normally
// the agency, not the brand.
function extractAdvertiser(subject) {
  return cleanAdvertiser(extractAdvertiserRaw(subject));
}

function extractAdvertiserRaw(subject) {
  const s = String(subject || '').replace(/^\s*(re|fw|fwd|\[external\])\s*:\s*/gi, '').trim();
  let m = s.match(/^(.*?)\s*Spot Delivery Notification/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/^(.*?)\s*delivery notification/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/new media available from\s+([^:]+)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/^(.*?)\s*\|\s*horizon media\s*\|/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/(?:inmarket\s*[/x]\s*inscape|inscape\s*x\s*inmarket)\s*-\s*(.+)/i);
  if (m && m[1].trim()) return m[1].replace(/\s+C\d+\s*$/i, '').trim();
  m = s.match(/^(.*?)\s+creatives?\s+added/i) || s.match(/creative added,?\s+(.+)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/inscape\s+ingest\s*-\s*(.+)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/clips for ingestion\s*[-–—:]\s*(.+)/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/^(.*?)\s*inscape\s+pod\b/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/^(.*?)\s*-\s*creatives for\s+(?:re-?)?fingerprinting/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/^(.*?)\s*\|\s*inscape\s+ingest(?:ion)?/i) ||
      s.match(/^(.*?)\s*inscape\s+(?:creative\s+)?ingest(?:ion)?(?:\s+request)?\s*$/i);
  if (m && m[1].trim()) return m[1].replace(/[\s|–—-]+$/, '').replace(/\s+x\s*$/i, '').trim();
  return '';
}

// UI chrome that leaks into grabbed subjects ("Navigation pane | Horizon
// Media | ...") must not become a job-folder advertiser.
const ADVERTISER_NOISE = /^(?:navigation|reading|preview|side)\s*pane$|sidebar|untitled/i;

function cleanAdvertiser(s) {
  s = String(s || '').trim();
  return ADVERTISER_NOISE.test(s) ? '' : s;
}

// One-line summary of the ingest block for the client note.
function ingestSummary(c) {
  const ing = c && c.ingest;
  if (!ing) return '';
  const bits = [];
  if (ing.cidMap) bits.push('cid_map=' + (Array.isArray(ing.cidMap) ? ing.cidMap.join('+') : ing.cidMap));
  if (ing.fingerprint) bits.push('fingerprint=' + ing.fingerprint);
  if (ing.ticker === 'always') bits.push('ticker required (' + (ing.tickerSuffix || '_ticker') + ')');
  if (ing.metadata) bits.push('metadata: ' + ing.metadata);
  if (ing.retention) bits.push('retention ' + ing.retention);
  if (ing.note) bits.push(ing.note);
  return bits.join(' · ');
}

// Jira: customer realm -> the epic that owns the weekly repository
// tasks ("<Client> - File Ingests - Week of MM/DD/YY"); each ingest is a
// comment on the current week's task. Clients with no epic yet simply
// have no Post-to-Jira path.
// Jira: customer realm -> the epic that owns the weekly repository
// tasks. Empty by default - add rows as realm: 'PROJ-123'.
const JIRA_EPICS = {
};
