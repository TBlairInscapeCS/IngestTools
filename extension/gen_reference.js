// Seeds the customer-reference sheet from the playbooks.
//   node gen_reference.js > ../customer-reference.tsv
// Paste the output under the sheet's header row. The sheet is the live
// source at run time - this only bootstraps it (playbook edits don't
// sync back; edit the sheet for anything per-customer going forward).
const fs = require('fs');
eval(fs.readFileSync(__dirname + '/clients.js', 'utf8'));
const cell = s => String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
console.log(['Customer', 'Exceptions & rules', 'Tracker', 'Files / share'].join('\t'));
CLIENTS.forEach(c => {
  const tr = ((c.detect && c.detect.sheetIds) || [])
    .map(id => 'https://docs.google.com/spreadsheets/d/' + id).join(' ');
  console.log([cell(c.name), cell(c.note), cell(tr), ''].join('\t'));
});
