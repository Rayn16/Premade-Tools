// The phone's lists (pc/ui/m/common.js): a finished row opens its buttons in a sheet. node relay/rows.test.mjs
import fs from 'node:fs';
import assert from 'node:assert';
globalThis.document = { addEventListener() {} };
globalThis.IntersectionObserver = class {}; // lazyMedia, for the videos in a list
const ui = new Function(fs.readFileSync(new URL('../pc/ui/m/common.js', import.meta.url), 'utf8')
  + '\nreturn { rowOf, byDay, more, phone: (id) => { TAPROWS = true; SHEET = id; }, sheet: () => SHEETROW };')();
const at = new Date().toISOString(), jobs = [{ id: 'a', at, live: true }, { id: 'b', at }];
const row = (j) => ui.rowOf({ id: j.id, th: '', title: j.id, pct: j.live ? 40 : -1,
  acts: j.live ? '<button data-cancel>Cancel</button>' : '<a data-save>Save</a>' + ui.more('m' + j.id, ['<button role="menuitem" data-remove>Remove</button>']) });

let html = ui.byDay(jobs, (j) => j.at, row);
assert.match(html, /data-cancel[^]*data-save[^]*data-more/, 'on the PC every row keeps its buttons');
ui.phone('b');
html = ui.byDay(jobs, (j) => j.at, row);
assert.match(html, /<div[^>]*data-lj="a"[^]*data-cancel/, 'a running row keeps Cancel');
assert.match(html, /<button type="button" data-rs="b"/, 'a finished row is one button that opens its sheet');
assert.doesNotMatch(html, /data-save/, 'its buttons wait in the sheet');
assert.match(ui.sheet(), /class="msheet"[^]*data-save[^]*data-remove/, 'the sheet: Save, then the menu laid flat');
assert.doesNotMatch(ui.sheet(), /data-more/, 'no ⋯ inside the sheet');
console.log('rows ok');
