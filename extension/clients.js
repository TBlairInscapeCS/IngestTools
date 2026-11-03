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
 *   brandFixed    - constant Advertiser/Brand/Vertical value (NFL): fills
 *                   even when the tracking sheet carries no brand column
 *   retention     - e.g. '3-6 months'
 *   note          - conditional rules that don't fit fields
 *
 * sheetless: true - no tracking sheet exists for this client; the email's
 *   cited IDs (+ any same-line links) are the manifest. Run-all proceeds
 *   to the email match instead of stopping at step 2.
 * emailBrand: RegExp - sheetless brand source: first capture group fills
 *   Advertiser/Brand/Vertical when ingest.advertiser is set (DPM's
 *   "fingerprint for GM"). detectedAdvertiser (subject) still wins.
 * cols: per-field column pins ({id, title, file, link, brand, espn,
 *   date} -> header regex) that override auto-guessing - amcn uses the
 *   ISCI column as the source ID while 'Tracking ID' is our fill-back.
 *
 * inactive: true - keeps detection rules (old threads still surface the
 *   playbook, flagged "(inactive)") but hides the client from the manual
 *   dropdown. Add it when a client is ruled inactive; remove to restore.
 *
 * trackerBrands   - brand names mined from the doc's Client/Brand column:
 *                   an email naming one selects this tracker; learned
 *                   automatically into docBrands storage on every load too.
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
// The per-customer reference sheet (Customer | Exceptions | Tracker |
// Files/share) fetched live every 15 min. Empty = no reference sheet;
// the portable build ships this blank.
var REF_SHEET_ID = '1u4mgQQ6YfdiMMYMA6QcQHMASMv3trtassknq-Vh_kcw';

var CLIENTS = [
  {
    id: 'inmarket',
    name: 'InMarket',
    detect: {
      sheetIds: ['1f8gES1wBV9gMLDsmmJXuW81uP_DuLJ6E1_79_HYy25U'],
      subjects: [/inmarket\s*[x\/|]\s*inscape|inscape\s*[x\/|]\s*inmarket/i],
      keywords: [/inmarket/i],
      domains: [/inmarket\.com/i],
    },
    delivery: 'links',
    note: 'Sheet link cells carry Drive folder links under display text - the XLSX grab resolves them and Download picks the matching file in each folder.',
    ingest: {
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser / Vertical / Brand = InMarket Campaign Name (column D); Title = Reporting ID',
      campaignColumn: 3,
      cidMap: 'inmarket',
      note: 'Their dictated spot title is the ingest anchor, not an ISCI-style ID - title == reporting ID, so the filename is the title alone. Rightmost columns are our fill-back (final tracking ID/title, ingest date, ingester name).',
    },
  },
  {
    id: 'horizon-kohls',
    name: "Horizon / Kohl's",
    detect: {
      // "Kohl's Inscape ..." must beat horizon-next's generic /inscape pod/
      // - but stay adjacent so Yangaroo's "New Media Available from Kohl's"
      // still lands on yangaroo-delivery.
      subjects: [/kohl'?s inscape\b/i],
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
    cols: {
      // ISCI is the source ID; the 'Tracking ID' column further right is
      // OUR fill-back confirmation, not source data. 'AMCN House #
      // (Owned)', 'File Name' and 'ISCI (Paid Off Channel)' carry the
      // same code - any of them works as the ID.
      id: /isci|amcn house|file.?name/i,
    },
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
      subjects: [/ingest(ion)? request|\| horizon media \||inscape pod|creative tracking|inscape creative ingestion/i],
      keywords: [/horizon ?next/i],
      domains: [/horizon-next\.com|horizonmedia\.com/i],
    },
    delivery: 'other',
    er: { sender: 'horizon' },   // most Horizon-brand ER deliveries traffic as Horizon Media
    note: 'Horizon agency umbrella - check the subject for the advertiser; delivery varies (Yangaroo/Dropbox/Extreme Reach).',
    ingest: { cidMap: 'horizonmedia', advertiser: true, nameTitle: true },
    // Mined from the master doc's Client column: an email naming one of
    // these brands selects this tracker - and implies this umbrella when
    // no playbook detected a client (new brands land on the doc first).
    trackerBrands: [
      'A Place For Mom', 'ADT', 'ARMRA', 'AdTalem - Chamberlain', 'AdTalem - Walden',
      'Altice', 'AmeriSave', 'American Residential Services', 'Atlantis', 'Aura',
      "Bob's Discount Furniture", 'Bombas', 'Boost Infinite', 'BrightStar Care',
      'Care.com', 'Carvana', 'ChampionWindows', 'Covista (Adtalem)', 'CreditKarma',
      'Curology', 'Custom Ink', 'DISH', 'DriveTime', 'EarnIn', 'Empire Today',
      'Erie Home (Leaf Home Solutions )', 'Ernesta', 'FDUL', 'FanDuel', 'Fanatics',
      'Fisher Investments', 'Gametime', 'Good Feet Corporate', 'Good Feet Midwest',
      'Great Wolf Lodge', 'Grow Care Inc.', 'HelloFresh', 'Jenny Craig',
      'Kinetic Dynamics', 'Kooth Digital', 'Leaf Home', 'LeafFilter',
      'Little Sleepies', 'NOOM', 'Newfold Digital', 'Ninja', 'Orkin',
      'Patio Enclosures', 'Peloton', 'Poshmark', 'Poshmark (US)', 'PrizePicks',
      'Realtor', 'Redfin', 'Rover', 'Safelite', 'SeaWorld', 'Seed', 'Shark',
      'SharkNinja', 'SharkNinja Beauty', 'SiriusXM', 'Skims', 'Sleep Number',
      'Sling', 'SmileDirectClub', 'Sondermind', 'Spectrum', 'Squarespace US',
      'Stamps', 'Stamps.com', 'Stitch Fix', 'The Good Feet Store', 'ThirdLove',
      'Top Dog Law', 'Tripledot', 'Turo', 'Universal Windows', 'WBPK',
      'Warby Parker', 'Weight Watchers', 'Zocdoc', 'eharmony',
    ],
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
    note: "Advertiser/brand/vertical is always 'NFL' - the sheet never names it (fixed by playbook). Files sit behind nflit.sharepoint.com links that demand interactive 2FA - not fetchable; open the last shared link (below) or ask for a re-share. 'Inscape Fingerprinting - NFL' requests land under the Horizon umbrella even when sent from @nfl.com. Email is a per-spot manifest: title / initiative / title / nflit.sharepoint.com mp4 link / ISCI. Files nominally live in the OneDrive 'inscape doc' - check the current FY folder (spots have landed in last year's by mistake).",
    ingest: { cidMap: 'horizonmedia', advertiser: true, brandFixed: 'NFL', nameTitle: true, ticker: 'flagged' },
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
    ingest: { cidMap: 'kantar', jiraEpic: 'DD-463' },
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
      cidMap: 'kantar',
      jiraEpic: 'DD-463',
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
      subjects: [/creatives? added/i],
      keywords: [/chief media/i],
      domains: [/chiefmedia\.com/i],
    },
    delivery: 'links',
    note: "Email lists 'CODE  Title' pairs inline (titles feed ingest naming when the sheet lacks a title column); files live in their linked folder + tracking document.",
    ingest: {
      cidMap: 'chiefmedia',
      jiraEpic: 'DD-826',
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
    sheetless: true,  // no tracking sheet - the upload-portal email is the manifest
    note: 'Files arrive via the BSLWeb upload portal ("New Commercials Uploaded" emails) - open the portal link, grab the file list, reconcile, Download found.',
    ingest: {
      cidMap: 'comscore',
      jiraEpic: 'DD-631',
      ticker: 'always',
      tickerSuffix: '_t',
      fingerprint: 'video',
      note: 'Every request needs a ticker version (Reporting ID ends "_t") ingested via File Ingest GUI with fingerprint=video.',
    },
  },
  {
    id: 'simulmedia',
    name: 'SimulMedia',
    detect: { domains: [/simulmedia\.com/i], keywords: [/simul\s*media|simo\s*media/i] },
    sheetless: true,
    delivery: 'mixed',
    note: 'No tracker. Match IDs from the request email; delivery can be Comcast AdDelivery or Extreme Reach. Manually saved media can be found in Downloads/Ingest by request ID.',
    ingest: { cidMap: 'simulmedia', jiraEpic: 'DD-597', fingerprint: 'both' },
  },
  {
    id: 'cuebiq',
    name: 'Cuebiq',
    detect: {
      subjects: [/creatives to ingest/i],
      keywords: [/cuebiq/i],
      domains: [/cuebiq\.com/i],
    },
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
    detect: { keywords: [/data ?plus ?math|liveramp/i], domains: [/liveramp\.com|dataplusmath\.com/i] },
    delivery: 'links',
    sheetless: true,  // no tracking sheet - the email's IDs + direct links are the manifest
    emailBrand: /(?:fingerprint|ingest(?:ion)?)[s]?\s+for\s+([A-Za-z0-9&' .-]{1,50})/i,  // "One fingerprint for GM"
    note: "No tracking sheet: the request email's per-spot IDs and direct download links are the whole manifest. Brand comes from 'fingerprint for <X>' (GM etc). Links arrive Mimecast-wrapped - they resolve through to the dpm-share-extremereach S3 bucket on fetch. Jira logs under DD-495.",
    ingest: { cidMap: ['dataplusmath', 'liveramp'], advertiser: true, fingerprint: 'both',
      note: 'Requests usually come from @liveramp.com addresses.' },
  },
  {
    id: 'digitalremedy',
    name: 'DigitalRemedy',
    detect: {
      subjects: [/new commercial ingestion request/i],
      keywords: [/digital ?remedy/i],
      domains: [/digitalremedy\.com/i],
    },
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
    ingest: { jiraEpic: 'DD-726', cidMap: ['discovery', 'geniusdigital'],
      note: 'HBO content ingests for Discovery + Genius Digital customers.' },
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
      keywords: [/theatrical/i],  // body says "theatrical doc" even when subject/link are lost in a paste
      domains: [/wbd\.com|warnermedia\.sharepoint\.com/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'omnicom' },  // trafficked by Omnicom per the playbook note
    ingest: {
      jiraEpic: 'DD-726',
      fingerprint: 'both',
      cidMap: 'discovery',  // Warner ingests under the discovery customer
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
      jiraEpic: 'DD-726',
      fingerprint: 'both',
      cidMap: 'discovery',  // Warner ingests under the discovery customer
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
      domains: [/emxdigital\.com/i],
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
      cidMap: 'iconmedia',
      jiraEpic: 'DD-836',
      fingerprint: 'both',
      advertiser: true,
      nameTitle: true,
      metadata: 'Advertiser/Brand/Program from their spreadsheet; Title ID and Reporting ID must match the sheet',
    },
  },
  {
    id: 'lwd',
    name: 'LWD Direct',
    detect: {
      sheetIds: ['1eR7opu0NPKOCpVLgCD-pu4DpqrtvoEq_'],
      subjects: [/lwd vizio|acr links/i],
      keywords: [/\blwd\b|lw ?direct/i],
      domains: [/lwdirect\.com|attentionarc\.com/i],
    },
    delivery: 'extreme-reach',
    ingest: {
      fingerprint: 'both', advertiser: true, nameTitle: true,
      jiraEpic: 'DD-832',
      metadata: 'Advertiser/Brand/Vertical + Title from their spreadsheet',
      note: 'Commercial_Ingestion_Vizio_LWD workbook, one tab per brand (NDR = National Debt Relief). Merged "LWDirect to Complete / Inscape to Complete" groups - the FIRST Tracking ID col is theirs (source), the second is ours (fill-back). Link to File holds direct ER download URLs.',
    },
  },
  {
    id: 'vizio-request',
    name: 'Vizio (internal request)',
    detect: {
      // Vizio-internal requests follow a pattern: vizio.com sender + a
      // clip/share link + "ingest"/"ingestion" ask. All three must hit -
      // a bare @vizio.com sender alone can't claim the request (Icon
      // Media, LWD and other client requests get forwarded from Vizio).
      subjects: [/\b(ingest|ingestion)\b/i],
      keywords: [/\b(ingest|ingestion|clip|spot)\b/i],
      domains: [/vizio\.com/i],
      // Tim/Chris send the ingest CONFIRMATIONS - their own vizio.com mail
      // is a response, never a request to process.
      excludeSenders: [/chris\.roomian@vizio\.com|tim\.blair@vizio\.com/i],
    },
    sheetless: true,
    delivery: 'links',
    note: 'Internal Vizio requests (Sarah/Chris) - usually share-page clip links; every file ingests into BOTH silos.',
    ingest: {
      cidMap: ['geniusdigital', 'vizio'],
      fingerprint: 'both',
      nameTitle: true,
      dualSilo: true,
      note: 'Reporting ID = the clip filename; each file gets a record in geniusdigital AND vizio; the reply lists each file\'s commercial cid per realm.',
    },
  },
  {
    id: 'marketing-evolution',
    name: 'Marketing Evolution',
    inactive: true,
    detect: {
      sheetIds: ['1s1sXAa_xdW1DPxOn2FmTtYr23fMe7fu-nJRyEVGE7xE'],
      keywords: [/marketing evolution/i],
    },
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
      subjects: [/tatari creatives/i],
      keywords: [/tatari/i],
      domains: [/tatari\.tv|tatari\.com/i],
    },
    delivery: 'extreme-reach',
    er: { sender: 'tatari', days: 14 },  // Trafficked By "Tatari LLC", weekly cadence
    note: "Weekly batch email carries brand_slug + ISCI pairs inline - 'use as requested IDs' seeds the list. Files deliver on ER per-brand (the ER long-tail IS Tatari's roster); group the job by agency, not brand.",
    ingest: {
      cidMap: 'tatari',
      jiraEpic: 'DD-394',
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
  // ---- File-ingest clients recovered from mailbox folder rules ----
  // Domains/subjects below were mined from the Customers/* folder corpus;
  // folder names map back through CLIENT_FOLDERS.
  {
    id: 'millenia3',
    name: 'Millenia3',
    detect: {
      subjects: [/inscape ingest\b/i],
      keywords: [/millenia ?3/i],
      domains: [/millenia3\.com/i],
    },
    delivery: 'links',
    note: '"Inscape Ingest - <show>" requests; network promos trafficked as spot files.',
  },
  {
    id: 'itn',
    name: 'ITN Networks',
    detect: {
      subjects: [/itn networks isci codes/i],
      keywords: [/itn networks/i],
      domains: [/itnnetworks\.com/i],
    },
    delivery: 'links',
    note: '"ITN Networks ISCI codes" mails carry the code list inline.',
  },
  {
    id: 'adimpact',
    name: 'AdImpact',
    detect: {
      subjects: [/adimpact|creatives? for ingestion/i],
      keywords: [/adimpact/i],
      domains: [/adimpact\.com/i],
    },
    delivery: 'links',
    note: '"Ingest & Assign Creatives to AdImpact" / "Creatives for Ingestion" requests.',
  },
  {
    id: 'cadent',
    name: 'Cadent',
    detect: {
      subjects: [/commercial ingestion request/i],
      keywords: [/cadent/i],
      domains: [/cadent\.tv/i],
    },
    delivery: 'links',
    note: '"Commercial Ingestion Request" and "New Files for Download" notices.',
  },
  {
    id: 'marketcast',
    name: 'MarketCast',
    detect: {
      subjects: [/ingest(ion)? request/i],
      keywords: [/marketcast|deductive|genius ?digital/i],
      domains: [/marketcast\.com/i],
    },
    delivery: 'links',
    note: '"Lifetime IAWL Content Ingestion Request" / "Ingest Request: <brand>" - mixed with Content Feed backfill ops.',
  },
  {
    id: 'greenlight',
    name: 'Greenlight',
    detect: {
      subjects: [/new creatives from greenlight|greenlight creative ingestion/i],
      keywords: [/greenlight/i],
      domains: [/greenlight\.me/i],
    },
    delivery: 'links',
  },
  {
    id: 'broadbeam',
    name: 'Broadbeam Media',
    detect: {
      sheetIds: ['1wv6dcs0Fk_gJgguACdq3v7JRKTDnPYvN'],
      subjects: [/broadbeam/i],
      keywords: [/broadbeam/i],
      domains: [/broadbeammedia\.com/i],
    },
    delivery: 'links',
    note: '"Broadbeam Media + Inscape - TV commercials for <brand>" requests.',
  },
  {
    id: 'optimum-a4',
    name: 'Optimum / a4 / Altice',
    detect: {
      sheetIds: ['1iY7VHZR-2w7OwwUKipTmQzvkwFL4jo9UAauAkNtMA7s'],
      subjects: [/creatives for (re-?)?fingerprinting/i],
      keywords: [/a4media|altice|optimum/i],
      domains: [/optimum\.media|a4media\.com/i],
    },
    delivery: 'links',
    note: '"<Client> - Creatives for Fingerprinting" - file deliveries despite the fingerprinting subject.',
  },
  {
    id: 'pga-tour',
    name: 'PGA Tour',
    detect: {
      sheetIds: ['12qOs1UYKsJ65k3dNpakSR1r2VKpO7YeakrOi6iUQjsc'],
      subjects: [/vizio \/\/ pga|pga ?t/i],
      keywords: [/pga ?tour/i],
      domains: [/pgatourhq\.com/i],
    },
    delivery: 'links',
  },
  {
    id: 'havas',
    name: 'Havas Edge',
    inactive: true,  // last requests seen 2022
    detect: {
      subjects: [/media files for inscape/i],
      keywords: [/havas/i],
      domains: [/havasedge\.com/i],
    },
    delivery: 'links',
  },
  {
    id: 'comcast-notify',
    name: 'Comcast delivery notice',
    detect: {
      subjects: [/broadcast delivery notification|delivery notification/i],
      domains: [/comcastaddelivery\.com/i],
    },
    delivery: 'links',
    note: 'Delivery confirmation like the ER notice - a heads-up the owning agency will send the request.',
  },
  {
    id: 'cbs-notify',
    name: 'CBS delivery notice',
    detect: {
      subjects: [/inscape delivery from cbs/i],
      domains: [/cbs\.com/i],
    },
    delivery: 'links',
    note: 'Scheduled "Inscape Delivery From CBS" feed notices - confirmations, not request triggers.',
  },
  {
    id: 'vizio-ads',
    name: 'Vizio Ads (internal)',
    detect: {
      subjects: [/clips for ingestion|vizio ?ads/i],
      keywords: [/clips for ingestion|vizio ?ads|ingest as (?:commercial|clip|video)/i],
      // No domain pattern - @vizio.com senders carry every colleague
      // thread; only the subject/keyword phrasing is distinctive.
    },
    delivery: 'links',
    note: "Internal studio clip requests ('Clips for Ingestion - <studio> <title>': PHE = Paramount, WBHE = Warner Bros Home Entertainment) from @vizio.com teammates. The body names the portal customers - 'ingest as Commercial Video + Audio to geniusdigital and vizio' - so ingest to EVERY customer the email names, not just one.",
    ingest: { cidMap: ['vizioads', 'vizio', 'geniusdigital'] },
  },
];

// Outlook folder rules file customer mail before it reaches the inbox -
// the folder name is the user's own client classification. Mapped to
// playbook ids so a loaded candidate can auto-detect its client.
var CLIENT_FOLDERS = {
  'Horizon Media': 'horizon-next',
  'Icon Media': 'icon-media',
  'InMarket': 'inmarket',
  'Tatari': 'tatari',
  'Chief Media': 'chief-media',
  'Comscore': 'comscore',
  'SimulMedia': 'simulmedia',
  'Simulmedia': 'simulmedia',
  'Kantar': 'kantar',
  'Millenia3': 'millenia3',
  'ITN Networks': 'itn',
  'LWD': 'lwd',
  'DigitalRemedy': 'digitalremedy',
  'Cuebiq': 'cuebiq',
  'DataPlusMath/LiveRamp': 'dataplusmath',
  'EMX Digital': 'emx',
  'MarketCast/Deductive/GeniusDigital': 'marketcast',
  'Marketing Evolution': 'marketing-evolution',
  'MediaIQ': 'mediaiq',
  'Madhive': null,
  'Optimum/A4media/Altice': 'optimum-a4',
  'PGA Tour': 'pga-tour',
  'Simulmedia': null,
  'Sony': 'sony',
  'Viant': 'viant',
  'VideoAmp': 'videoamp',
  'Warner/Turner(Discovery)': 'wbd-usn',
  'AdImpact': 'adimpact',
  'Airtable': 'ae-media',
  'Amobee': 'amobee',
  'Broadbeam': 'broadbeam',
  'Cadent': 'cadent',
  'CBS': 'cbs-notify',
  'Greenlight': 'greenlight',
  'Havas Edge': 'havas',
  'iSpot': null,
  'Gameopedia': null,
  'Yahoo': null,
  'The Trade Desk': null,
  'Extreme Reach': 'er-notify',
  'Comcast': 'comcast-notify',
  'Experian': null,
  'Periscope': null,
};

function detectClient(sig) {
  sig = sig || {};
  const d = c => c.detect || {};
  const from = String(sig.sender || ((sig.emailText || '').match(/^from:\s*(.+)$/im) || [])[1] || '');
  // Sender exclusions: a client's own confirmation mail must not detect as
  // a request for that client, whatever the body/subject/domain say.
  const POOL = CLIENTS.filter(c => !(d(c).excludeSenders || []).some(re => re.test(from)));
  const refineEmail = c => POOL.find(x => x.name.split(' / ')[0] === c.name.split(' / ')[0] &&
    (d(x).keywords || []).some(re => re.test((sig.subject || '') + '\n' + (sig.emailText || '')))) || c;
  const folder = POOL.find(c => c.id === CLIENT_FOLDERS[sig.folderName]);
  if (folder) return refineEmail(folder);
  const domain = (from.match(/@([a-z0-9.-]+)/i) || [])[1];
  if (domain) {
    const owner = POOL.find(c => (d(c).domains || []).some(re => re.test(domain)));
    if (owner) return refineEmail(owner);
  }
  // 1. sheet document id - strongest signal
  if (sig.sheetId) {
    for (const c of POOL) {
      if ((d(c).sheetIds || []).includes(sig.sheetId)) return c;
    }
  }
  // 2. subject-line patterns - precise per client
  if (sig.subject) {
    for (const c of POOL) {
      if ((d(c).subjects || []).some(re => re.test(sig.subject))) return c;
    }
  }
  // 3. mail folder - the user's own Outlook rules already classified this
  //    sender; that deliberate sorting outranks body keywords (a Horizon
  //    person's signature inside a Comscore request must not flip it).
  //    Keywords within the SAME agency family still refine umbrella->brand.
  const text = (sig.subject || '') + '\n' + (sig.emailText || '');
  const topOf = x => x.name.split(' / ')[0].replace(/ *\(.*/, '').trim();
  if (sig.folderName && CLIENT_FOLDERS[sig.folderName]) {
    const c = POOL.find(x => x.id === CLIENT_FOLDERS[sig.folderName]);
    if (c) {
      const top = topOf(c);
      const br = text.trim() && POOL.find(x =>
        topOf(x) === top && (d(x).keywords || []).some(re => re.test(text)));
      return br || c;
    }
  }
  // 4. keywords over subject+body - brand-level signal, beats domains
  if (text.trim()) {
    for (const c of POOL) {
      if ((d(c).keywords || []).some(re => re.test(text))) return c;
    }
  }
  // 5. sender/cc domains - weakest signal, shared across advertisers
  if (text.trim()) {
    for (const c of POOL) {
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
const JIRA_EPICS = {
  horizonmedia: 'DD-657', horizonnext: 'DD-657',
  tatari: 'DD-394',
  // Warner requests log under the Discovery epic - the portal customer
  // chosen is Discovery (same parent company).
  warnermedia: 'DD-726', discovery: 'DD-726',
  kantar: 'DD-463',
  comscore: 'DD-631',
  inmarket: 'DD-800',
  chiefmedia: 'DD-826',
  // Mined from the weekly-task history: realms that already post weekly
  // "File Ingests" tasks under these epics.
  cuebiq: 'DD-604',
  lwd: 'DD-832', lwdirect: 'DD-832',
  simulmedia: 'DD-597',
  dataplusmath: 'DD-495', liveramp: 'DD-495',
  // Internal clip ingests (PHE/WBHE movie clips) log on the Vizio Ads
  // weekly task - "to geniusdigital and vizio" rides under the same epic.
  vizioads: 'DD-751', vizio: 'DD-751', geniusdigital: 'DD-751',
};
