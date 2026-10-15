/**
 * Ingest Reconciliation Tools
 * ===========================
 * !!! WARNING — WRITES TO THE HOST SHEET !!!
 * This script modifies the spreadsheet it is bound to: it writes status
 * columns, colors rows, and "Clear reconciliation columns" DELETES columns.
 * Do NOT install it into a client-owned tracking sheet.
 * The Chrome extension (extension/) performs the same reconciliation
 * read-only and supersedes this for all client-facing use.
 * ===================================================
 * Bound script for a customer tracking Google Sheet.
 *
 * Adds an "Ingest Tools" menu that:
 *   1. Lets you set the client's Google Drive folder once per sheet.
 *   2. Scans that folder (and subfolders) and reconciles every tracking ID
 *      in the sheet against the files actually present.
 *   3. Writes Status / Matched File / File URL / Notes columns and
 *      color-codes the rows.
 *   4. Drafts the "missing / mismatched files" reply email for copy-paste.
 *
 * Status values written to the sheet:
 *   FOUND           - a file on Drive matches this ID
 *   POSSIBLE MATCH  - no exact match, but a similar filename exists
 *   AMBIGUOUS       - more than one file matches this ID
 *   MISSING         - nothing on Drive matches this ID
 *   DUPLICATE       - this ID appears more than once in the sheet
 *   BLANK           - empty ID cell
 */

var PROP_FOLDER_ID = 'DRIVE_FOLDER_ID';
var PROP_FOLDER_NAME = 'DRIVE_FOLDER_NAME';

var COL_STATUS = 'Ingest Status';
var COL_MATCHED = 'Matched File';
var COL_URL = 'File URL';
var COL_NOTES = 'Recon Notes';

// Store the last reconciliation so the email drafter can use it.
var lastResults = null;

// ---------- Menu ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ingest Tools')
    .addItem('1. Set Drive folder', 'setDriveFolder')
    .addItem('2. Reconcile IDs with Drive', 'reconcile')
    .addItem('3. Draft exception email', 'draftExceptionEmail')
    .addSeparator()
    .addItem('Clear reconciliation columns', 'clearRecon')
    .addToUi();
}

// ---------- Setup ----------

function setDriveFolder() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'Set Drive folder',
    'Paste the client\'s Google Drive folder link (or folder ID):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var id = extractFolderId_(resp.getResponseText());
  if (!id) {
    ui.alert('Could not find a folder ID in that input. Paste the folder\'s share link.');
    return;
  }
  try {
    var folder = DriveApp.getFolderById(id);
    PropertiesService.getDocumentProperties()
      .setProperty(PROP_FOLDER_ID, id)
      .setProperty(PROP_FOLDER_NAME, folder.getName());
    ui.alert('Drive folder set to: ' + folder.getName());
  } catch (e) {
    ui.alert('Could not open that folder. Check the link and that you have access.\n\n' + e);
  }
}

function extractFolderId_(input) {
  input = String(input || '').trim();
  var m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  return null;
}

// ---------- Reconciliation ----------

function reconcile() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getDocumentProperties();
  var folderId = props.getProperty(PROP_FOLDER_ID);
  if (!folderId) {
    ui.alert('No Drive folder set yet. Use Ingest Tools > 1. Set Drive folder first.');
    return;
  }

  var sheet = SpreadsheetApp.getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    ui.alert('Sheet has no data rows.');
    return;
  }

  var idCol = findIdColumn_(data[0]);
  if (idCol < 0) {
    ui.alert('Could not find an ID column. Make sure a header in row 1 contains "ID".');
    return;
  }

  var cols = ensureOutputColumns_(sheet, data[0]);
  var files = indexDriveFiles_(DriveApp.getFolderById(folderId));

  var results = [];
  var seen = {}; // normalized ID -> first row index seen

  for (var r = 1; r < data.length; r++) {
    var raw = String(data[r][idCol]).trim();
    var res = { row: r + 1, id: raw, status: '', matched: '', url: '', notes: '' };

    if (!raw) {
      res.status = 'BLANK';
      res.notes = 'Empty ID cell';
      results.push(res);
      continue;
    }

    var norm = normalize_(raw);
    if (seen[norm] !== undefined) {
      res.status = 'DUPLICATE';
      res.notes = 'Duplicate of row ' + seen[norm];
      results.push(res);
      continue;
    }
    seen[norm] = r + 1;

    matchId_(res, norm, files);
    results.push(res);
  }

  writeResults_(sheet, cols, results);
  colorRows_(sheet, cols, results);
  lastResults = results;

  var counts = countBy_(results, 'status');
  ui.alert(
    'Reconciliation complete\n\n' +
      'Files indexed: ' + files.length + '\n' +
      'FOUND: ' + (counts['FOUND'] || 0) + '\n' +
      'POSSIBLE MATCH: ' + (counts['POSSIBLE MATCH'] || 0) + '\n' +
      'AMBIGUOUS: ' + (counts['AMBIGUOUS'] || 0) + '\n' +
      'MISSING: ' + (counts['MISSING'] || 0) + '\n' +
      'DUPLICATE: ' + (counts['DUPLICATE'] || 0)
  );
}

// ---------- Matching ----------

function matchId_(res, normId, files) {
  var needle = normId.replace(/ /g, '');
  var exact = [];
  var candidates = [];

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.haystack.indexOf(needle) !== -1) {
      exact.push(f);
    } else {
      var score = similarity_(normId, f.norm);
      if (score >= 0.55) candidates.push({ f: f, score: score });
    }
  }

  if (exact.length === 1) {
    res.status = 'FOUND';
    res.matched = exact[0].name;
    res.url = exact[0].url;
  } else if (exact.length > 1) {
    res.status = 'AMBIGUOUS';
    res.matched = exact.map(function (f) { return f.name; }).join(' | ');
    res.notes = exact.length + ' files match this ID';
  } else if (candidates.length) {
    candidates.sort(function (a, b) { return b.score - a.score; });
    var top = candidates.slice(0, 3);
    res.status = 'POSSIBLE MATCH';
    res.matched = top.map(function (c) { return c.f.name; }).join(' | ');
    res.url = top[0].f.url;
    res.notes = 'No exact match - verify filename manually';
  } else {
    res.status = 'MISSING';
    res.notes = 'No file found on Drive';
  }
}

function indexDriveFiles_(folder) {
  var files = [];
  var stack = [folder];
  while (stack.length) {
    var f = stack.pop();
    var it = f.getFiles();
    while (it.hasNext()) {
      var file = it.next();
      var norm = normalize_(file.getName());
      files.push({
        name: file.getName(),
        url: file.getUrl(),
        norm: norm,
        haystack: norm.replace(/ /g, ''),
      });
    }
    var subs = f.getFolders();
    while (subs.hasNext()) stack.push(subs.next());
  }
  return files;
}

// Lowercase, strip extension, collapse separators to single spaces.
function normalize_(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Dice coefficient over character bigrams. Good enough for filename fuzz.
function similarity_(a, b) {
  a = a.replace(/ /g, '');
  b = b.replace(/ /g, '');
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  var grams = {};
  for (var i = 0; i < a.length - 1; i++) grams[a.substr(i, 2)] = true;
  var overlap = 0;
  for (var j = 0; j < b.length - 1; j++) {
    var g = b.substr(j, 2);
    if (grams[g]) { overlap++; delete grams[g]; }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

// ---------- Sheet I/O ----------

function findIdColumn_(header) {
  var preferred = /track|creative|ad|spot/i;
  var fallback = -1;
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]);
    if (/\bid\b/i.test(h)) {
      if (preferred.test(h)) return c;
      if (fallback < 0) fallback = c;
    }
  }
  return fallback;
}

function ensureOutputColumns_(sheet, header) {
  var names = [COL_STATUS, COL_MATCHED, COL_URL, COL_NOTES];
  var cols = {};
  var last = sheet.getLastColumn();
  for (var c = 0; c < last; c++) {
    var h = String(header[c]).trim();
    if (names.indexOf(h) !== -1) cols[h] = c + 1;
  }
  var nextCol = last + 1;
  for (var i = 0; i < names.length; i++) {
    if (!cols[names[i]]) {
      cols[names[i]] = nextCol;
      sheet.getRange(1, nextCol).setValue(names[i]).setFontWeight('bold');
      nextCol++;
    }
  }
  return cols;
}

function writeResults_(sheet, cols, results) {
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    sheet.getRange(r.row, cols[COL_STATUS]).setValue(r.status);
    sheet.getRange(r.row, cols[COL_MATCHED]).setValue(r.matched);
    sheet.getRange(r.row, cols[COL_NOTES]).setValue(r.notes);
    var cell = sheet.getRange(r.row, cols[COL_URL]);
    cell.setValue(r.url ? '=HYPERLINK("' + r.url + '","open")' : '');
  }
}

function colorRows_(sheet, cols, results) {
  var colors = {
    'FOUND': '#d9ead3',
    'POSSIBLE MATCH': '#fff2cc',
    'AMBIGUOUS': '#fce5cd',
    'MISSING': '#f4cccc',
    'DUPLICATE': '#ead1dc',
    'BLANK': '#efefef',
  };
  var width = sheet.getLastColumn();
  for (var i = 0; i < results.length; i++) {
    var color = colors[results[i].status] || '#ffffff';
    sheet.getRange(results[i].row, 1, 1, width).setBackground(color);
  }
}

function clearRecon() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var names = [COL_STATUS, COL_MATCHED, COL_URL, COL_NOTES];
  for (var c = header.length - 1; c >= 0; c--) {
    if (names.indexOf(String(header[c]).trim()) !== -1) {
      sheet.deleteColumn(c + 1);
    }
  }
  sheet.getDataRange().setBackground(null);
  lastResults = null;
}

// ---------- Exception email ----------

function draftExceptionEmail() {
  var ui = SpreadsheetApp.getUi();
  var results = lastResults || readResultsFromSheet_();
  if (!results || !results.length) {
    ui.alert('Run "2. Reconcile IDs with Drive" first.');
    return;
  }

  var missing = [], possible = [], ambiguous = [], dupes = [];
  results.forEach(function (r) {
    if (r.status === 'MISSING') missing.push(r.id);
    else if (r.status === 'POSSIBLE MATCH') possible.push(r.id + '  (closest file: ' + r.matched.split(' | ')[0] + ')');
    else if (r.status === 'AMBIGUOUS') ambiguous.push(r.id);
    else if (r.status === 'DUPLICATE') dupes.push(r.id + ' (' + r.notes + ')');
  });

  if (!missing.length && !possible.length && !ambiguous.length && !dupes.length) {
    ui.alert('No exceptions found - everything matched. Nothing to send.');
    return;
  }

  var lines = ['Hi,', '', 'Thanks for sending these over. While processing the request I ran into a few issues - could you take a look?', ''];
  if (missing.length) {
    lines.push('The following tracking IDs have no matching file in the Drive folder:');
    missing.forEach(function (id) { lines.push('  - ' + id); });
    lines.push('');
  }
  if (possible.length) {
    lines.push('I could not match these IDs to a filename - please confirm which files they correspond to (or rename the files to include the ID):');
    possible.forEach(function (p) { lines.push('  - ' + p); });
    lines.push('');
  }
  if (ambiguous.length) {
    lines.push('Multiple files matched these IDs - please let me know which to use:');
    ambiguous.forEach(function (id) { lines.push('  - ' + id); });
    lines.push('');
  }
  if (dupes.length) {
    lines.push('These IDs were listed more than once (I\'ll process each once unless you tell me otherwise):');
    dupes.forEach(function (d) { lines.push('  - ' + d); });
    lines.push('');
  }
  lines.push('Thanks!');

  var html = '<div style="font-family:monospace;font-size:12px">' +
    '<p>Select all, copy, and paste into your reply:</p>' +
    '<textarea style="width:100%;height:380px">' +
    lines.join('\n').replace(/</g, '&lt;') +
    '</textarea></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(470), 'Exception email draft');
}

// Re-derive results from the sheet if the script restarted since reconcile().
function readResultsFromSheet_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  var idCol = findIdColumn_(data[0]);
  var statusCol = data[0].indexOf(COL_STATUS);
  var matchedCol = data[0].indexOf(COL_MATCHED);
  var notesCol = data[0].indexOf(COL_NOTES);
  if (idCol < 0 || statusCol < 0) return null;
  var results = [];
  for (var r = 1; r < data.length; r++) {
    if (!data[r][statusCol]) continue;
    results.push({
      row: r + 1,
      id: String(data[r][idCol]).trim(),
      status: data[r][statusCol],
      matched: matchedCol >= 0 ? String(data[r][matchedCol]) : '',
      notes: notesCol >= 0 ? String(data[r][notesCol]) : '',
    });
  }
  return results;
}

function countBy_(arr, key) {
  var out = {};
  arr.forEach(function (o) { out[o[key]] = (out[o[key]] || 0) + 1; });
  return out;
}
