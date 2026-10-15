/**
 * Minimal XLSX reader for Google Sheets exports.
 * Why this exists: CSV export strips cell hyperlinks, and tracking sheets
 * store the real Drive/Extreme Reach links as hyperlink relationships under
 * display text (e.g. "Applebee's C7 2026" -> drive.google.com folder).
 * XLSX preserves them.
 *
 * Uses the built-in DecompressionStream — no dependencies.
 *
 * readXlsx(arrayBuffer, sheetName, sheetId) ->
 *   { sheetName, rows: [[cell,...],...], links: { "row,col": url } }
 * rows are 0-based arrays aligned to absolute sheet rows (blanks preserved).
 * sheetId (the URL gid) is the authoritative selector - DOM tab text can
 * carry junk that silently fell back to the workbook's FIRST tab.
 */

const XLSX_RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function readXlsx(buf, sheetName, sheetId) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  // --- locate the End Of Central Directory record ---
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 70000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid xlsx (zip) file');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);

  // --- central directory ---
  const files = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    files[dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))] = {
      method: view.getUint16(off + 10, true),
      size: view.getUint32(off + 20, true),
      local: view.getUint32(off + 42, true),
    };
    off += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const f = files[name];
    if (!f) return null;
    const lh = f.local;
    const nl = view.getUint16(lh + 26, true);
    const el = view.getUint16(lh + 28, true);
    const data = bytes.subarray(lh + 30 + nl + el, lh + 30 + nl + el + f.size);
    if (f.method === 0) return dec.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return dec.decode(await new Response(stream).arrayBuffer());
  }
  const xdoc = s => new DOMParser().parseFromString(s, 'text/xml');
  const relsOf = doc => {
    const out = {};
    for (const r of doc.getElementsByTagName('Relationship')) {
      out[r.getAttribute('Id')] = r.getAttribute('Target');
    }
    return out;
  };
  const rid = el => el.getAttribute('r:id') || el.getAttributeNS(XLSX_RNS, 'id');

  // --- workbook: sheet name -> worksheet path ---
  const wb = xdoc(await read('xl/workbook.xml'));
  const wbrels = relsOf(xdoc(await read('xl/_rels/workbook.xml.rels')));
  const sheetEls = Array.from(wb.getElementsByTagName('sheet'));
  let target = null, resolvedName = sheetName;
  // The focused tab's name is what the user is actually looking at - it
  // wins over the URL gid, which can be absent or stale after tab flips.
  if (sheetName) {
    for (const s of sheetEls) {
      if (s.getAttribute('name') === sheetName) {
        target = wbrels[rid(s)]; resolvedName = s.getAttribute('name'); break;
      }
    }
  }
  if (!target && sheetId != null && sheetId !== '') {
    for (const s of sheetEls) {
      if (s.getAttribute('sheetId') === String(sheetId)) {
        target = wbrels[rid(s)]; resolvedName = s.getAttribute('name'); break;
      }
    }
  }
  if (!target && sheetEls.length) {
    target = wbrels[rid(sheetEls[0])];
    resolvedName = sheetEls[0].getAttribute('name');
  }
  if (!target) throw new Error('No worksheets found in workbook');
  const sheetPath = target.startsWith('xl/') ? target : 'xl/' + target.replace(/^\//, '');
  const relsPath = sheetPath.replace(/([^/]+)$/, '_rels/$1.rels');

  // --- shared strings ---
  const shared = [];
  const ssXml = await read('xl/sharedStrings.xml');
  if (ssXml) {
    const ss = xdoc(ssXml);
    for (const si of ss.getElementsByTagName('si')) {
      let t = '';
      for (const node of si.getElementsByTagName('t')) t += node.textContent;
      shared.push(t);
    }
  }

  // --- hyperlink rels for this sheet ---
  const relsXml = await read(relsPath);
  const hrels = relsXml ? relsOf(xdoc(relsXml)) : {};

  // --- worksheet ---
  const sd = xdoc(await read(sheetPath));
  const linkByRef = {};
  for (const h of sd.getElementsByTagName('hyperlink')) {
    const tgt = hrels[rid(h)];
    if (tgt) linkByRef[h.getAttribute('ref')] = tgt;
  }

  const colIdx = ref => {
    let n = 0;
    for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const cellText = c => {
    const t = c.getAttribute('t');
    const v = c.getElementsByTagName('v')[0];
    if (t === 's') return shared[+(v ? v.textContent : 0)] || '';
    if (t === 'b') return v && v.textContent === '1' ? 'TRUE' : 'FALSE';
    if (t === 'inlineStr') {
      let s = '';
      for (const n of c.getElementsByTagName('t')) s += n.textContent;
      return s;
    }
    return v ? v.textContent : '';
  };

  const rows = [];
  const links = {};
  for (const rowEl of sd.getElementsByTagName('row')) {
    const rNum = +rowEl.getAttribute('r');
    if (!rNum) continue;
    while (rows.length < rNum) rows.push([]);
    for (const c of rowEl.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      if (!ref) continue;
      const ci = colIdx(ref);
      rows[rNum - 1][ci] = cellText(c);
      if (linkByRef[ref]) links[(rNum - 1) + ',' + ci] = linkByRef[ref];
    }
  }

  return { sheetName: resolvedName, rows, links,
    sheetNames: sheetEls.map(s => s.getAttribute('name')) };
}

// Excel serial date -> 'M/D/YYYY' (serial 25569 = 1970-01-01).
function serialToDate(v) {
  const n = Number(v);
  if (!/^\d{5}(\.\d+)?$/.test(String(v).trim())) return String(v || '');
  const d = new Date(Math.round((n - 25569) * 86400) * 1000);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
}
