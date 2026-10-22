#!/bin/bash
# Build the PORTFOLIO snapshot: a fully scrubbed copy of the extension +
# watcher into portfolio/ - no org names, hosts, client names, or sheet
# IDs. Every rename is applied identically across all files so the code
# still parses and runs (it just points at placeholder hosts).
#
# Output: portfolio/{extension,watcher}/ + README.md - safe to push to a
# public/personal repo. dist/ingest-streamlined-v*-portfolio.zip too.
set -euo pipefail
cd "$(dirname "$0")"
VER=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
OUT=portfolio
rm -rf "$OUT"
mkdir -p "$OUT/extension" "$OUT/watcher"

FILES=(
  manifest.json
  background.js engine.js graph.js xlsx.js
  offscreen.html offscreen.js
  sidepanel.html sidepanel.js welcome.html
  icon16.png icon32.png icon48.png icon128.png
)
for f in "${FILES[@]}"; do cp "extension/$f" "$OUT/extension/$f"; done
cp extension/clients.template.js "$OUT/extension/clients.js"

cp local/ingest_watch.py local/install.command local/ticker.png "$OUT/watcher/"
cp local/espn_ticker.sh "$OUT/watcher/ticker_build.sh"

# --- Scrub map applied by Python (BSD sed has no \b and escaped-dot
# regex literals need matching too). Identifier renames run before the
# word rules so token boundaries stay consistent everywhere.
python3 - <<'PYEOF'
import re, pathlib
root = pathlib.Path('portfolio')

LITERAL = [  # host/string literals, applied to plain AND regex-escaped forms
  ('fileingest.cognet.tv', 'ingest.example.com'),
  ('portal.cognet.tv',     'portal.example.com'),
  ('cognet.tv',            'example.com'),
  ('vizio.atlassian.net',  'example.atlassian.net'),
  ('vizio.com',            'example.com'),
  ('Vizio Inscape Portal', 'the ingest portal'),
  ('Vizio_Ingestion_Form', 'Ingestion_Form'),
  ('Hearts & Science',     'SubAgency'),
  ('Warner Bros Home Entertainment', 'StudioCo Home Entertainment'),
]
IDENT = [  # identifiers first - underscores defeat \b
  ('isTatariErNotice', 'isAgencyErNotice'),
  ('espn_ticker.sh',   'ticker_build.sh'),
  ('espn_script',      'ticker_script'),
  ('ESPN_SCRIPT',      'TICKER_SCRIPT'),
  ('espn_output',      'ticker_output'),
  ('espn_done',        'ticker_done'),
  ('needs_espn',       'needs_ticker'),
  ('espnOutputName',   'tickerOutputName'),
  ('emailEspn',        'emailTicker'),
  ('extractEmailEspnFlags', 'extractEmailTickerFlags'),
  ('espnConflict',     'tickerConflict'),
  ('colEspn',          'colTicker'),
  ('espnIds',          'tickerIds'),
  ('espnMap',          'tickerMap'),
  ('nEspn',            'nTicker'),
  ('horizon-next',     'agencya-next'),
  ('horizonmedia',     'agencya'),
  ('warnermedia',      'studioco'),
  ('dataplusmath',     'dataco'),
  ('ae-media',         'airtable-client'),
]
WORD = [  # \b needed where the token can ride inside real words/ids
  (r'\bWBD\b','SCO'), (r'\bWBHE\b','SCHE'), (r'\bPHE\b','PARA'),
]
PLAIN = [  # distinctive names - plain replace survives \n/\b escape
  # contexts in regex literals where word-boundary matching fails.
  ('ESPN', 'Ticker'), ('espn', 'ticker'), ('Espn', 'Ticker'),
  ('DataPlusMath', 'DataCo'), ('dataplusmath', 'dataco'),
  ('LiveRamp', 'DataCo'), ('liveramp', 'dataco'),
  ('Horizon', 'Agency A'), ('horizon', 'agencya'),
  ('Tatari', 'Agency B'), ('tatari', 'agencyb'),
  ('InMarket', 'Agency C'), ('inmarket', 'agencyc'),
  ('Comscore', 'MetricsCo'), ('comscore', 'metricsco'),
  ('Kantar', 'ResearchCo'), ('kantar', 'researchco'),
  ('Warner', 'StudioCo'), ('warner', 'studioco'),
  ('Paramount', 'ParaCo'), ('TubeMogul', 'TubeVendor'),
  ('Adobe', 'BigVendor'), ('Turo', 'BrandA'), ('Zocdoc', 'BrandB'),
  ('INSCAPE', 'ACR'), ('Inscape', 'ACR'), ('inscape', 'acr'),
  ('Vizio', 'Acme'), ('vizio', 'acme'),
  ('ae-media', 'airtable-client'),
]
CLEAN = [  # cosmetic fixups from composed renames
  ('Ticker ticker', 'Ticker'), ('ticker ticker', 'ticker'),
  ('Agency A Media', 'Agency A'),  # "Horizon Media" -> "Agency A Media" -> tidy
]

def scrub(s):
    for a, b in LITERAL:
        s = s.replace(a.replace('.', r'\.'), b.replace('.', r'\.'))
        s = s.replace(a, b)
    for a, b in IDENT: s = s.replace(a, b)
    for a, b in WORD:  s = re.sub(a, b, s)
    for a, b in PLAIN: s = s.replace(a, b)
    for a, b in CLEAN: s = s.replace(a, b)
    return s

for p in root.rglob('*'):
    if p.suffix in ('.js', '.html', '.py', '.sh', '.command', '.json', '.md'):
        p.write_text(scrub(p.read_text()))

BANNED = re.compile(r'vizio|inscape|cognet|tatari|horizon|inmarket|'
                    r'dataplusmath|liveramp|comscore|kantar|ae-media|espn|'
                    r'warner|tubemogul|adobe\b|tim\.blair', re.I)
leaks = [f'{p}: {l}' for p in root.rglob('*') if p.is_file() and p.suffix != '.png'
         for l in p.read_text(errors='ignore').splitlines() if BANNED.search(l)]
if leaks:
    print('LEAKS:'); print('\n'.join(leaks[:30])); raise SystemExit(1)
print('scrub clean')
PYEOF

# Portfolio README - generic, no org references.
cat > "$OUT/README.md" <<'EOF'
# Ingest Streamlined

A Chrome MV3 side-panel extension + a tiny local watcher that turns ad-ops
ingest requests into a one-click pipeline:

1. Reads the request email (Outlook on the web or pasted).
2. Finds and loads the tracking sheet (link-shared Google Sheet export,
   an open sheet tab, SharePoint/OneDrive, Airtable API, or manual pick).
3. Matches the email's codes to sheet rows - with exclusion controls and
   already-ingested detection from fill-back columns.
4. Downloads the media: direct links, delivery-service search, or any
   open page listing files (Mimecast/SafeLinks/Proofpoint links unwrap
   automatically, including a hidden-tab resolver for captcha'd portals).
5. Feeds the files into your ingest portal and fills the record fields,
   with a check/preview step before anything touches the page.
6. Drafts the Jira comment and the requester reply.

The watcher (127.0.0.1 only) does the heavy lifting: downloads, ffprobe
spec checks, and automatically-built `_ticker` (text-overlay) versions.

## Layout

- `extension/` - the side panel (MV3, no build step, load unpacked)
- `watcher/` - `ingest_watch.py` + double-click `install.command`
- `extension/clients.js` - the client playbook file ships as a
  commented template; add your own clients there

## Privacy

No telemetry, no credentials in code; every token is user-entered into
Chrome local storage. See the in-app welcome page for setup.
EOF

# Syntax check the scrubbed JS (renames must not have broken anything).
cat > /tmp/pcheck.jxa <<'JXA'
const files = ["background","engine","graph","xlsx","offscreen","sidepanel","clients"];
let out = [];
for (const f of files) {
  const src = $.NSString.stringWithContentsOfFileEncodingError(
    "/Users/tim.blair/Devin/ingest-tools/portfolio/extension/" + f + ".js",
    $.NSUTF8StringEncoding, null).js;
  try { new Function(src); out.push(f + ": OK"); }
  catch(e) { out.push(f + ": FAIL " + e.message); }
}
out.join("\n");
JXA
osascript -l JavaScript /tmp/pcheck.jxa

(cd "$OUT" && zip -q -r "../dist/ingest-streamlined-v$VER-portfolio.zip" . -x '*.DS_Store')
echo "Built dist/ingest-streamlined-v$VER-portfolio.zip and portfolio/ snapshot"
