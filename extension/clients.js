/**
 * Client playbooks — detection + delivery + ingest requirements.
 *
 * Detection priority:
 *   1. tracking-sheet document id (strongest - one tracker per client)
 *   2. keyword in the email subject/body
 *   3. sender/cc domain anywhere in the email text
 *
 * detect: { sheetIds, subjects, keywords, domains }  - regexes
 *   subjects are tested against the email subject only (most precise,
 *   e.g. 'Kantar/Vizio Fingerprinting Request:'); keywords/domains run
 *   over subject+body.
 * delivery: 'links' | 'yangaroo' | 'extreme-reach' | 'sharepoint' |
 *           'dropbox' | 'other'  + note = the playbook step shown in-panel
 * ingest (optional) - what the downstream ingest needs, carried into
 *   manifest.json and report.json so it surfaces next to the files:
 *   cidMap        - customer name(s) to map, or 'sheet' = values live in
 *                   the client sheet
 *   fingerprint   - 'both' (audio+video) | 'video'
 *   ticker        - 'always' (every file gets a ticker) | 'flagged'
 *   tickerSuffix  - '_ticker' (default) | '_t' (Comscore)
 *   metadata      - short label of required metadata fields
 *   nameTitle     - true: the ingest spec includes the spot title, so
 *                   downloaded files are renamed "<tracking id> <title>.ext"
 *                   (fields the spec doesn't name are never added)
 *   advertiser    - true: advertiser/brand is required ingest metadata, so
 *                   the brand extracted from notification subjects is shown
 *   retention     - e.g. '3-6 months'
 *   note          - conditional rules that don't fit fields
 *
 * inactive: true - keeps detection rules (old threads still surface the
 *   playbook, flagged "(inactive)") but hides the client from the manual
 *   dropdown. Add it when a client is ruled inactive; remove to restore.
 *
 * umbrella: true  - a master tracker covering every brand under the agency
 *   (e.g. the Horizon master sheet). Detection via its sheetId proves the
 *   agency; the email's brand keyword then refines which "Agency / Brand"
 *   profile actually applies.
 *
 * BRANDS vs AGENCIES: ingests are done FOR the agency; advertiser brands
 *   live under the agency umbrella. Brand profiles are named
 *   "Agency / Brand" and carry the agency's cidMap - the delivery channel
 *   and spot naming are per-brand, the ingest customer is per-agency.
 */
var CLIENTS = [
  {
    id: 'inmarket',
    name: 'InMarket',
    detect: {
      sheetIds: ['1f8gES1wBV9gMLDsmmJXuW81uP_DuLJ6E1_79_HYy25U'],
      keywords: [/inmarket/i],
      domains: [/inmarket\.com/i],
    },
    delivery: 'links',
    note: 'Sheet link cells carry Drive folder links under display text - the XLSX grab resolves them and Download picks the matching file in each folder.',
    ingest: {
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser / Vertical / Brand; Title = Reporting ID',
      cidMap: 'inmarket',
      note: 'Their dictated spot title is the ingest anchor, not an ISCI-style ID - title == reporting ID, so the filename is the title alone. Rightmost columns are our fill-back (final tracking ID/title, ingest date, ingester name).',
    },
  },
  {
    id: 'horizon-kohls',
    name: "Horizon / Kohl's",
    detect: {
      keywords: [/kohl'?s/i],
      domains: [/horizonmedia\.com|horizon-next\.com/i],
    },
    delivery: 'yangaroo',
    note: "Files arrive via Yangaroo - open the 'ADVERTISING DELIVERY' email and Grab it for per-spot download links.",
    ingest: {
      cidMap: 'horizonmedia',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser/Brand/Vertical + Title from sheet when filled out',
      note: 'Horizon Next requests: cid_map to both horizonnext and horizonmedia.',
    },
  },
  {
    id: 'horizon-bdf',
    name: "Horizon / Bob's Discount Furniture",
    detect: {
      keywords: [/bob'?s discount/i],
      domains: [/horizon-next\.com/i],
    },
    delivery: 'links',
    note: 'Files arrive via a Dropbox link in the email - the sheet has ISCI codes; reconcile catches extras/missing.',
    ingest: { cidMap: ['horizonnext', 'horizonmedia'], advertiser: true, nameTitle: true },
  },
  {
    id: 'credit-karma',
    name: 'Horizon / Credit Karma',
    detect: {
      subjects: [/credit karma.*ingest|ingest.*credit karma/i],
      keywords: [/credit karma|\bKARM\d{4}/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'horizon' },   // confirmed: Trafficked By "Horizon Media, Inc."
    note: 'Credit Karma creatives deliver via Extreme Reach (KARM codes on Spot Deliveries) - grab the list, reconcile, Download found files.',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'fisher-investments',
    name: 'Horizon / Fisher Investments',
    detect: {
      subjects: [/fisher investments/i],
      keywords: [/fisher investments/i],
    },
    delivery: 'other',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'empire-today',
    name: 'Horizon / Empire Today',
    detect: {
      subjects: [/empire today/i],
      keywords: [/empire today/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'horizon' },   // ER detail shows Trafficked By Horizon Media
    note: "Requests come via Horizon Next ('Ingest & Fingerprint'); deliveries arrive on ER as 'Empire Today-Horizon DR'. Email lists Spot Title/Ad-ID/Length/Start Date per line and cites '(rows #####-#####)' - refs into the master sheet's NEXT tab.",
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'spectrum',
    name: 'Horizon / Spectrum',
    detect: {
      subjects: [/spectrum.*inscape|inscape.*spectrum/i],
      keywords: [/spectrum resi/i],
    },
    delivery: 'other',
    note: 'Spectrum Resi ingest requests via Horizon Next - delivery channel not yet confirmed (check the email for a link).',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'seaworld',
    name: 'Horizon / SeaWorld',
    detect: {
      subjects: [/seaworld/i],
      keywords: [/seaworld/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'horizon' },
    note: "Delivers on ER as 'SeaWorld Parks & Entertainment'. Emails cite '(lines #####-#####)' - row refs into the master sheet's NEXT tab; no inline manifest, the sheet is the spec.",
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'amcn',
    name: 'Horizon / AMC Networks',
    detect: {
      subjects: [/amcn.*(inscape|fingerprint)/i],
      keywords: [/\bamcn\b/i],
      domains: [/amcnetworks\.com/i],
    },
    delivery: 'links',
    note: "Email is an inline manifest: sheet row# + spot title + ISCI + creativehub share link per spot. Shares are viewer pages (open to download); tracker 'Working List' tab is the Bible.",
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'good-feet',
    name: 'Horizon / Good Feet (Kinetic Dynamics)',
    detect: {
      subjects: [/good ?feet|kinetic dynamics/i],
      keywords: [/good ?feet|kinetic dynamics/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'horizon' },
    note: "Requests via Horizon Media naming both brands; delivers on ER as 'Kinetic Dynamics' ('XR sent the spots' = Extreme Reach). Emails cite 'NEXT tab lines 13,286-13,289' - row refs into the Horizon master sheet's NEXT tab.",
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'horizon-next',
    name: 'Horizon (other advertisers)',
    umbrella: true,  // sheet proves the agency; email keywords refine the brand
    detect: {
      sheetIds: ['1zPD9LkK_SzWYDhGYRKAwR-eWLIkS-SENRkNvWFdZugQ'],
      subjects: [/ingest(ion)? request|\| horizon media \|/i],
      keywords: [/horizon ?next/i],
      domains: [/horizon-next\.com|horizonmedia\.com/i],
    },
    delivery: 'other',
    er: { sender: 'horizon' },   // most Horizon-brand ER deliveries traffic as Horizon Media
    note: 'Horizon agency umbrella - check the subject for the advertiser; delivery varies (Yangaroo/Dropbox/Extreme Reach).',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'yangaroo-delivery',
    name: 'Yangaroo delivery email',
    detect: {
      subjects: [/new media available/i],
      domains: [/yangaroo\.com/i],
    },
    delivery: 'yangaroo',
    note: 'Delivery notification, not a request - the email itself carries per-spot Download links. Grab it, then match to the client sheet.',
  },
  {
    id: 'nfl',
    name: 'Horizon / NFL',
    detect: {
      subjects: [/inscape fingerprinting.*nfl|nfl.*inscape/i],
      keywords: [/\bnfl\b/i],
      domains: [/nfl\.com/i],
    },
    delivery: 'links',
    note: "'Inscape Fingerprinting - NFL' requests land under the Horizon umbrella even when sent from @nfl.com. Email is a per-spot manifest: title / initiative / title / nflit.sharepoint.com mp4 link / ISCI. Files nominally live in the OneDrive 'inscape doc' - check the current FY folder (spots have landed in last year's by mistake).",
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true, ticker: 'flagged' },
  },
  {
    id: 'ae-media',
    name: 'Horizon / A+E Global Media',
    detect: {
      subjects: [/promos are ready for ingestion/i],
      keywords: [/a\+e (global )?media/i],
      domains: [/airtableemail\.com/i],
    },
    delivery: 'links',
    note: 'Airtable automation emails carry ISCI/Campaign/Spot Title rows with per-spot aenetworks.files.com download links; the Airtable link is the tracker for confirming ingestion.',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
  },
  {
    id: 'kantar-files',
    name: 'Kantar (file arrival)',
    detect: {
      subjects: [/was added to documents/i],
      domains: [/kantarm365notifications@kantar\.com/i],
    },
    delivery: 'sharepoint',
    note: "SharePoint arrival notice - 'new files added to Documents'. Filenames may or may not appear in the subject; the tracking sheet remains the source of truth for IDs.",
  },
  {
    id: 'kantar',
    name: 'Kantar',
    detect: {
      keywords: [/kantar|doordash|capital one/i],
      domains: [/kantar\.com/i],
    },
    delivery: 'sharepoint',
    note: 'Tracker is SharePoint Excel; files via the SharePoint doc library or an Extreme Reach account share (Spot Deliveries page).',
    ingest: {
      nameTitle: true,
      metadata: 'Reporting ID and Spot Title must exactly reflect the tracking sheet (ISCI = Reporting ID)',
    },
  },
  {
    id: 'adobe',
    name: 'Adobe (TubeMogul)',
    inactive: true,
    detect: { keywords: [/adobe|tubemogul/i], domains: [/tubemogul\.com/i] },
    delivery: 'other',
    ingest: { cidMap: ['tubemogul', 'tubemogul2'] },
  },
  {
    id: 'amobee',
    name: 'Amobee',
    inactive: true,
    detect: { keywords: [/amobee/i], domains: [/amobee\.com/i] },
    delivery: 'other',
    ingest: { cidMap: 'amobee2' },
  },
  {
    id: 'chief-media',
    name: 'Chief Media',
    detect: {
      keywords: [/chief media/i],
      domains: [/chiefmedia\.com/i],
    },
    delivery: 'links',
    note: "Email lists 'CODE  Title' pairs inline (titles feed ingest naming when the sheet lacks a title column); files live in their linked folder + tracking document.",
    ingest: {
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser/Brand/Vertical required; Spot Title and Reporting ID are distinct',
    },
  },
  {
    id: 'comscore',
    name: 'Comscore',
    detect: {
      subjects: [/BSLWeb|New Commercials Uploaded/i],
      keywords: [/comscore|bslweb/i],
      domains: [/comscore\.com/i],
    },
    delivery: 'other',
    note: 'Files arrive via the BSLWeb upload portal ("New Commercials Uploaded" emails) - open the portal link, grab the file list, reconcile, Download found.',
    ingest: {
      ticker: 'always',
      tickerSuffix: '_t',
      fingerprint: 'video',
      note: 'Every request needs a ticker version (Reporting ID ends "_t") ingested via File Ingest GUI with fingerprint=video.',
    },
  },
  {
    id: 'cuebiq',
    name: 'Cuebiq',
    detect: { keywords: [/cuebiq/i], domains: [/cuebiq\.com/i] },
    delivery: 'links',
    note: 'Email carries the inline ID list (mixed formats incl. VIA_#####) + a tracking-doc link; files are in the linked doc/drive.',
    ingest: { fingerprint: 'both' },
  },
  {
    id: 'dativa',
    name: 'Dativa',
    inactive: true,
    detect: { keywords: [/dativa|essence ?global/i] },
    delivery: 'other',
    ingest: { cidMap: 'geniusdigital', note: 'Files originating from Essence Global via the Dativa team map to geniusdigital.' },
  },
  {
    id: 'dataplusmath',
    name: 'DataPlusMath',
    detect: { keywords: [/data ?plus ?math/i], domains: [/liveramp\.com/i] },
    delivery: 'other',
    ingest: { fingerprint: 'both', note: 'Requests usually come from @liveramp.com addresses.' },
  },
  {
    id: 'digitalremedy',
    name: 'DigitalRemedy',
    detect: { keywords: [/digital ?remedy/i] },
    delivery: 'other',
    ingest: {
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser/Vertical/Brand all set to the same value (e.g. Burger King); Spot Title=Title, Tracking ID=Reporting ID',
    },
  },
  {
    // Active - sits under the Warner umbrella. Before Discovery: an H&S
    // email about HBO content should detect the agency, not the brand.
    id: 'hearts-science',
    name: 'Warner / Hearts & Science',
    detect: { keywords: [/hearts ?(&|and) ?science/i], domains: [/hearts-science\.com/i] },
    delivery: 'other',
    ingest: { note: 'HBO content ingests for Discovery + Genius Digital customers.' },
  },
  {
    // Active - WB theatrical spots under the Warner umbrella. Trafficked
    // by Naleesa at Omnicom (omc.com - too broad to detect on) for the
    // wbd.com team: "spots will arrive today via ER". Email lists
    // title-line/code-line pairs under film-name headers (Clayface, The
    // Cat in the Hat); tracker is the Theatrical ACR Doc on SharePoint.
    id: 'wb-theatrical',
    name: 'Warner / WB Theatrical',
    detect: {
      subjects: [/theatrical/i],
      domains: [/wbd\.com|warnermedia\.sharepoint\.com/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'omnicom' },  // trafficked by Omnicom per the playbook note
    ingest: {
      fingerprint: 'both',
      note: 'Theatrical ACR Doc lives on warnermedia.sharepoint.com; spots deliver same-day via ER.',
    },
  },
  {
    // Active - WBD US Networks promos (CNN midterms etc.) trafficked by
    // Starcom / Publicis for wbd.com + wbdcontractor.com. Email carries an
    // inline adid/campaign/creative_name manifest with a direct DMDS
    // (Yangaroo) mp4 link; tracker is "USN ACR Metadata Tracker.xlsx".
    id: 'wbd-usn',
    name: 'Warner / WBD USN',
    detect: {
      subjects: [/wbd usn|inscape grid/i],
      keywords: [/wbd usn|usn acr metadata/i],
      domains: [/wbdcontractor\.com/i],
    },
    delivery: 'links',
    ingest: {
      fingerprint: 'both',
      nameTitle: true,
      advertiser: true,
      metadata: 'adid + creative_name; network col is the advertiser (DSC/HGTV/CNN)',
      note: 'Starcom/Publicis traffic desk; request email itself carries direct dmds.com mp4 links. Tracker: USN ACR Metadata Tracker - their cols end at "Promoted App"; Date Ingested/Ingested By are ours.',
    },
  },
  {
    id: 'discovery',
    name: 'Discovery',
    inactive: true,
    detect: { keywords: [/discovery|\bhbo\b|\bmax\b|\btlc\b|warner/i] },
    delivery: 'other',
    ingest: {
      fingerprint: 'both',
      retention: '3-6 months',
      cidMap: 'discovery',
      note: 'Dual-ingest: also to geniusdigital or horizonmedia depending on the CC recipients in the request email.',
    },
  },
  {
    id: 'emx',
    name: 'EMX Digital',
    detect: {
      sheetIds: ['D3D24E07-DB92-4F40-813F-707E5A1F1D38'],
      keywords: [/\bemx\b/i],
    },
    delivery: 'sharepoint',
    note: 'Tracker is SharePoint Excel (enginedrive.sharepoint.com).',
  },
  {
    id: 'icon-media',
    name: 'Icon Media Direct',
    detect: {
      subjects: [/vizio - ingestion/i],
      keywords: [/icon media/i],
      domains: [/iconmediadirect\.com/i],
    },
    delivery: 'links',
    note: 'Standalone client with their own tracking sheet - not under an agency umbrella. Request email carries an Egnyte folder link (+ password) for files and the Vizio_Ingestion_Form_IMD.xlsx link; brand varies per request ("this time for Crepe Erase").',
    ingest: {
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser/Brand/Program from their spreadsheet; Title ID and Reporting ID must match the sheet',
    },
  },
  {
    id: 'lwd',
    name: 'LWD Direct',
    detect: { keywords: [/\blwd\b|lw ?direct/i] },
    delivery: 'extreme-reach',
    ingest: {
      fingerprint: 'both', advertiser: true, nameTitle: true,
      metadata: 'Advertiser/Brand/Vertical + Title from their spreadsheet',
      note: 'Commercial_Ingestion_Vizio_LWD workbook, one tab per brand (NDR = National Debt Relief). Merged "LWDirect to Complete / Inscape to Complete" groups - the FIRST Tracking ID col is theirs (source), the second is ours (fill-back). Link to File holds direct ER download URLs.',
    },
  },
  {
    id: 'marketing-evolution',
    name: 'Marketing Evolution',
    inactive: true,
    detect: { keywords: [/marketing evolution/i] },
    delivery: 'other',
    ingest: { cidMap: 'sheet', note: 'cid_map values come from the Google Sheet they maintain (e.g. Lexus campaign doc).' },
  },
  {
    id: 'mediamath',
    name: 'MediaMath',
    inactive: true,  // platform shut down (2023 bankruptcy)
    detect: { keywords: [/media ?math/i] },
    delivery: 'other',
    ingest: { cidMap: 'mediamath2' },
  },
  {
    id: 'mediaiq',
    name: 'MediaIQ',
    detect: { keywords: [/media ?iq/i] },
    delivery: 'other',
    note: 'Google Drive files require the inscapeCS download account (credentials in the client notes sheet, not in this tool).',
  },
  {
    id: 'ninth-decimal',
    name: 'Ninth Decimal',
    inactive: true,
    detect: { keywords: [/ninth ?decimal/i] },
    delivery: 'other',
    ingest: { cidMap: 'geniusdigital' },
  },
  {
    id: 'omnicom',
    name: 'Omnicom / OMD',
    inactive: true,
    detect: { keywords: [/omnicom|\bomd\b|annalect/i], domains: [/annalect\.com/i] },
    delivery: 'other',
    ingest: { cidMap: 'videoamp' },
  },
  {
    id: 'tatari',
    name: 'Tatari',
    detect: {
      sheetIds: ['1qVjlD7WJky6f5s7MJNwROLkIpynEdnAKIbhQeDrAvJ8'],
      keywords: [/tatari/i],
      domains: [/tatari\.tv|tatari\.com/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'tatari', days: 14 },  // Trafficked By "Tatari LLC", weekly cadence
    note: "Weekly batch email carries brand_slug + ISCI pairs inline - 'use as requested IDs' seeds the list. Files deliver on ER per-brand (the ER long-tail IS Tatari's roster); group the job by agency, not brand.",
    ingest: {
      ticker: 'always',
      note: 'Every file needs a ticker version (ESPN). Ticker ingested fingerprint=video; non-ticker fingerprint=both.',
    },
  },
  {
    id: 'tvadsync',
    name: 'TVadSync',
    inactive: true,
    detect: { keywords: [/tvadsync|tvad/i] },
    delivery: 'other',
    ingest: { note: 'Content ID must start with TVAS_: C(^.~)c_Commercial_TVAS_<filename-base>.' },
  },
  {
    id: 'sony',
    name: 'Sony Pictures',
    inactive: true,
    detect: { keywords: [/sony/i] },
    delivery: 'other',
    ingest: { ticker: 'always', note: 'Assume all ad clips need ESPN ticker versions unless told otherwise.' },
  },
  {
    id: 'viant',
    name: 'Viant',
    inactive: true,
    detect: { keywords: [/viant/i] },
    delivery: 'other',
    ingest: { note: 'cid_map = filename minus extension and trailing descriptors (WALG2349000H_30s_final.mp4 -> WALG2349000H).' },
  },
  {
    id: 'videoamp',
    name: 'VideoAmp',
    detect: { keywords: [/video ?amp/i], domains: [/videoamp\.com/i] },
    delivery: 'other',
    ingest: { cidMap: 'sheet', note: 'cid_map syntax comes from their shared Google Sheet (e.g. vgame_destiny2_v2 for game files).' },
  },
  {
    id: 'wwe',
    name: 'WWE',
    inactive: true,  // believed a one-off request
    detect: {
      subjects: [/wwe/i],
      keywords: [/\bwwe\b/i],
    },
    delivery: 'other',
    note: 'Seen only as an internal thread ("Creative files for ingest - WWE Measurement") - believed a one-off.',
  },
  {
    id: 'er-notify',
    name: 'Extreme Reach delivery notice',
    detect: {
      subjects: [/spot delivery notification for inscape/i],
      domains: [/extremereach\.com/i],
    },
    delivery: 'extreme-reach',
    note: 'Delivery CONFIRMATION, not the ingest trigger - files are ingested only when a client request references them. The subject names the advertiser; a known brand here is a heads-up that the owning agency will send a request shortly.',
  },
  {
    id: 'extreme-reach',
    name: 'Extreme Reach (generic)',
    detect: { keywords: [/extreme ?reach/i], domains: [] },
    delivery: 'extreme-reach',
    note: 'Files arrive via Extreme Reach - open Spot Deliveries, Grab file list, Reconcile, then Download found files.',
  },
];

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
    // 4. sender/cc domains - weakest signal, shared across advertisers
    for (const c of CLIENTS) {
      if ((d(c).domains || []).some(re => re.test(text))) return c;
    }
  }
  return null;
}

// Advertiser name out of delivery-notification subjects:
//   "<Brand> Spot Delivery Notification for Inscape TV"  (Extreme Reach)
//   "New Media Available from <Brand>: ..."              (Yangaroo)
// Used to aid matching and shown only when the client's ingest spec
// requires advertiser/brand metadata - the useful identity is normally
// the agency, not the brand.
function extractAdvertiser(subject) {
  const s = String(subject || '').replace(/^\s*(re|fw|fwd|\[external\])\s*:\s*/gi, '').trim();
  let m = s.match(/^(.*?)\s*Spot Delivery Notification/i);
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/new media available from\s+([^:]+)/i);
  if (m && m[1].trim()) return m[1].trim();
  return '';
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
