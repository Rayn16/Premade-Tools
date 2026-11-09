// The PDF tools' main box, shared by the PC window (pdf-ui.js) and the phones (mpdf.js), which set PDFAPI:
// { base, hdr, touch, after(), acts(job), where(job) }. Page pictures are drawn here on the device by
// PDF.js; only the finished choice goes to the PC, which does the real work.
'use strict';

ICON.pdf = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h4.5"/>';
ICON.merge = '<path d="M6 3v4c0 4 6 5 6 9v5M18 3v4c0 4-6 5-6 9"/>';
ICON.split = '<path d="M12 3v18M4 7h4M4 12h4M4 17h4M16 7h4M16 12h4M16 17h4"/>';
ICON.squeeze = '<path d="M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3M4 12h16"/>';
ICON.lock = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
ICON.unlock = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>';
ICON.turn = '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"/>';
ICON.left = '<path d="M15 6l-6 6 6 6"/>';
ICON.right = '<path d="M9 6l6 6-6 6"/>';
ICON.up = '<path d="M6 15l6-6 6 6"/>';
ICON.down = '<path d="M6 9l6 6 6-6"/>';
ICON.bin = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>';
ICON.pen = '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M13.5 6.5l4 4"/>';
const PDF_ICON = { edit: 'pen', merge: 'merge', pages: 'grid', extract: 'check', split: 'split', compress: 'squeeze', lock: 'lock', unlock: 'unlock' };
const PDF_GO = { edit: 'Open the editor', merge: 'Merge', pages: 'Save the pages', extract: 'Save these pages', split: 'Split', compress: 'Compress', lock: 'Add password', unlock: 'Remove password' };
const PDF_ONE = ['edit', 'pages', 'extract', 'split']; // one PDF at a time

let PDFST = null; // GET PDFAPI.base
const P = { op: '', files: [], pages: [], thumbs: {}, loading: false, bad: '', pw: '', showPw: false, level: 'smaller', up: -1, err: '', gen: 0, drag: -1 };

const pdfJobs = () => [...(typeof ljOf === 'function' ? ljOf('pdf') : []), ...(PDFST?.jobs || [])]; // ljOf: jobs done on the phone itself (local.js)
const pdfBusy = () => pdfJobs().some((j) => j.state === 'queued' || j.state === 'running');
const pdfIsPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const pdfOp = (id) => (PDFST?.ops || []).find((o) => o.id === id);
const pdfTitle = (j) => j.inputs.length > 1 ? `${j.inputs[0]} and ${j.inputs.length - 1} more` : j.inputs[0];
const pdfSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const pdfHue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

async function pdfRefresh() {
  try { PDFST = await api(PDFAPI.base); } catch (e) {}
}

// ---------- page pictures ----------
let pdfjs = null;
// Scanned PDFs keep their pages as JBIG2 or JPEG 2000 pictures, which PDF.js decodes with these (blank pages
// without them); the fonts stand in for ones a PDF names but doesn't carry.
const PDFJS_OPT = { isEvalSupported: false, wasmUrl: '/m/pdfjs/wasm/', standardFontDataUrl: '/m/pdfjs/standard_fonts/' };
async function pdfLib() {
  if (!pdfjs) {
    pdfjs = await import('/m/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/m/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

// Opens the one picked PDF and draws its pages small, a few at a time so the screen stays quick.
async function pdfLoad() {
  const gen = ++P.gen, f = P.files[0];
  Object.assign(P, { pages: [], thumbs: {}, bad: '', loading: true });
  render();
  let doc;
  try {
    const lib = await pdfLib();
    doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), ...PDFJS_OPT }).promise;
    if (gen !== P.gen) return;
    P.pages = Array.from({ length: doc.numPages }, (_, i) => ({ n: i + 1, rot: 0, sel: false }));
    render();
    let painted = Date.now();
    for (let i = 1; i <= doc.numPages && gen === P.gen; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / Math.max(vp1.width, vp1.height) });
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      P.thumbs[i] = cv.toDataURL('image/jpeg', 0.75);
      page.cleanup();
      if (Date.now() - painted > 300 || i === doc.numPages) { painted = Date.now(); pdfPaint(); }
    }
  } catch (e) {
    if (gen === P.gen) P.bad = e?.name === 'PasswordException' ? 'This PDF has a password. Remove it first with Remove password.' : "This PDF couldn't be opened. It may be damaged.";
  }
  if (gen === P.gen) { P.loading = false; render(); }
  try { doc?.destroy(); } catch (e) {}
}

// Fills in page pictures that are ready, without drawing the whole screen again.
function pdfPaint() {
  document.querySelectorAll('img[data-pg]:not([src])').forEach((im) => { const u = P.thumbs[im.dataset.pg]; if (u) im.src = u; });
}

// ---------- the box ----------
function pdfWhy() {
  const op = P.op, n = P.files.length;
  if (!n) return '';
  const bad = P.files.find((f) => !pdfIsPdf(f));
  if (bad) return `${bad.name} isn't a PDF. To make a PDF from pictures or documents, use the Converter.`;
  if (!op) return 'Pick what to do above.';
  if (op === 'merge' && n < 2) return 'Add at least one more PDF to merge.';
  if (PDF_ONE.includes(op) && n > 1) return 'Pick one PDF at a time for this.';
  if (P.bad) return P.bad;
  if (op === 'pages' && !P.loading && !P.pages.length) return 'Every page is deleted. Tap Reset to start again.';
  if (op === 'extract' && !P.loading && !P.pages.some((p) => p.sel)) return 'Tap the pages to keep.';
  return '';
}

const pdfReady = () => !!(P.op && P.files.length && !pdfWhy() && !P.loading && P.up < 0 && (P.pw || (P.op !== 'lock' && P.op !== 'unlock')));

const pdfSpec = () => P.op === 'pages' ? P.pages.map((p) => p.n + (p.rot ? 'r' + p.rot : '')).join(',')
  : P.op === 'extract' ? P.pages.filter((p) => p.sel).map((p) => p.n).join(',') : '';

function pdfPagesGrid() {
  if (P.loading && !P.pages.length) return `<div class="pdfwait">${icon('spin', 'spin')}Opening the PDF…</div>`;
  if (!P.pages.length) return '';
  const edit = P.op === 'pages', last = P.pages.length - 1;
  const cells = P.pages.map((p, i) => `<div class="pdfpage ${!edit && p.sel ? 'is-on' : ''} ${!edit && !p.sel ? 'is-off' : ''}" data-i="${i}" ${edit && !PDFAPI.touch ? 'draggable="true"' : ''}>
      ${edit ? '' : `<button type="button" class="pgtap" data-pdf="sel" data-i="${i}" aria-pressed="${p.sel}" aria-label="Page ${p.n}"></button>`}
      <span class="pg"><img data-pg="${p.n}" ${P.thumbs[p.n] ? `src="${P.thumbs[p.n]}"` : ''} alt="" style="--r:${p.rot}deg" class="${p.rot % 180 ? 'is-side' : ''}"><span class="pgn">${p.n}</span>${!edit && p.sel ? `<span class="pgcheck">${icon('check')}</span>` : ''}</span>
      ${edit ? `<span class="pgacts"><button type="button" class="iconbtn" data-pdf="move" data-i="${i}" data-by="-1" ${i ? '' : 'disabled'} aria-label="Move page ${p.n} earlier">${icon('left')}</button><button type="button" class="iconbtn" data-pdf="turn" data-i="${i}" aria-label="Turn page ${p.n}">${icon('turn')}</button><button type="button" class="iconbtn" data-pdf="del" data-i="${i}" aria-label="Delete page ${p.n}">${icon('bin')}</button><button type="button" class="iconbtn" data-pdf="move" data-i="${i}" data-by="1" ${i < last ? '' : 'disabled'} aria-label="Move page ${p.n} later">${icon('right')}</button></span>` : ''}
    </div>`).join('');
  const kept = P.pages.filter((p) => p.sel).length;
  const bar = edit ? `<span class="row-hint">${P.pages.length} ${P.pages.length === 1 ? 'page' : 'pages'}${PDFAPI.touch ? '' : ' · drag pages to reorder'}</span><span class="grow"></span><button type="button" class="btn small" data-pdf="reset">Reset</button>`
    : `<span class="row-hint">${kept} of ${P.pages.length} picked</span><span class="grow"></span><button type="button" class="btn small" data-pdf="all">All</button><button type="button" class="btn small" data-pdf="none">None</button>`;
  return `<div class="pdfbar">${bar}</div><div class="pdfpages scroller">${cells}</div>`;
}

// One file input that outlives every redraw: the screen redraws while jobs run, and a picker opened from an
// input that got replaced meanwhile would lose what was picked. Labels point at it (for="pdffile").
const pdfInput = Object.assign(document.createElement('input'), { type: 'file', id: 'pdffile', accept: '.pdf,application/pdf' });
pdfInput.style.cssText = 'position:fixed;left:-200px;width:1px;height:1px;opacity:0';
pdfInput.multiple = true;
document.body.append(pdfInput);
pdfInput.addEventListener('change', () => { pdfAdd(pdfInput.files, !P.addMode); pdfInput.value = ''; });

function pdfFiles() {
  if (!P.files.length) {
    return `<label class="cvdrop" id="pdfdrop" for="pdffile" data-pdf="pick">${icon('pdf')}<b>${PDFAPI.touch ? 'Pick PDFs' : 'Drop PDFs here'}</b>${PDFAPI.touch ? '' : '<span>or</span><span class="btn">Choose PDFs…</span>'}
      <small>${PDFAPI.touch ? 'From Files or anywhere on this phone' : 'Any PDF on this PC'}</small></label>`;
  }
  const total = P.files.reduce((s, f) => s + f.size, 0), last = P.files.length - 1;
  const list = P.op === 'merge'
    ? `<div class="rows pdflist">${P.files.map((f, i) => `<div class="row"><span class="pdfnum">${i + 1}</span><span class="row-text grow"><span class="row-title clip">${esc(f.name)}</span><span class="row-hint">${pdfSize(f.size)}</span></span>
        <button type="button" class="iconbtn" data-pdf="fmove" data-i="${i}" data-by="-1" ${i ? '' : 'disabled'} aria-label="Move up">${icon('up')}</button><button type="button" class="iconbtn" data-pdf="fmove" data-i="${i}" data-by="1" ${i < last ? '' : 'disabled'} aria-label="Move down">${icon('down')}</button><button type="button" class="iconbtn" data-pdf="drop" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></div>`).join('')}</div>
      <div class="pdfmore"><label class="btn small" for="pdffile" data-pdf="pick" data-add="1">${icon('plus')}Add more</label><span class="grow"></span><button type="button" class="btn small" data-pdf="clear">Start over</button></div>`
    : `<div class="cvpicked"><div class="cvchips">${P.files.slice(0, 6).map((f, i) => `<span class="cvchip">${icon('pdf')}<span>${esc(f.name)}</span><button type="button" class="iconbtn" data-pdf="drop" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></span>`).join('')}${P.files.length > 6 ? `<span class="cvchip more">+${P.files.length - 6} more</span>` : ''}</div>
      <button type="button" class="btn small" data-pdf="clear">Start over</button></div>`;
  const why = pdfWhy();
  return `${list}<div class="dlunder">${why ? `<span class="detected is-bad">${icon('alert')}<span>${esc(why)}</span></span>`
    : `<span class="detected"><i class="dotlight"></i><span><b>${P.files.length} ${P.files.length === 1 ? 'PDF' : 'PDFs'}</b> · ${pdfSize(total)}${P.pages.length && PDF_ONE.includes(P.op) ? ` · ${P.pages.length} pages` : ''}</span></span>`}</div>`;
}

function pdfOptions() {
  const op = P.op;
  if (op === 'pages' || op === 'extract') return P.files.length === 1 && !P.bad ? pdfPagesGrid() : '';
  if (op === 'compress') {
    const gs = PDFST?.gs || 'missing';
    return `<div class="cvto"><span class="group-label">How small</span><div class="seg">${[['smaller', 'Smaller'], ['smallest', 'Smallest']].map(([id, l]) => `<button type="button" data-pdf="level" data-level="${id}" aria-pressed="${P.level === id}">${l}</button>`).join('')}</div></div>
      <p class="row-hint cvhint">${P.level === 'smallest' ? 'Pictures get softer. Good for sending.' : 'Still sharp on screens and fine to print.'}</p>
      ${gs === 'ok' ? '' : `<p class="row-hint pdfnote">${icon('info')}<span>${gs === 'installing' ? 'Ghostscript is being installed on the PC, so scans shrink less this time.'
        : `Scans and photo PDFs shrink much more with Ghostscript (free) on the PC. ${PDFAPI.touch ? 'Install it on the PC in Settings.' : 'It installs the first time you compress.'}`}</span></p>`}`;
  }
  if (op === 'lock' || op === 'unlock') {
    return `<div class="pdfpw"><label class="dlinput">${icon('lock')}<span class="sr">Password</span><input id="pdfpw" type="${P.showPw ? 'text' : 'password'}" value="${esc(P.pw)}" placeholder="${op === 'lock' ? 'New password' : 'The PDF\'s password'}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <button type="button" class="btn" data-pdf="showpw">${P.showPw ? 'Hide' : 'Show'}</button></div>
      ${op === 'lock' ? '<p class="row-hint cvhint">Write it down: nobody can open the PDF without it, and the PC doesn\'t keep it.</p>' : ''}`;
  }
  return '';
}

function pdfBox() {
  const ops = (PDFST?.ops || []).map((o) => `<button type="button" class="pdfop" data-pdf="op" data-op="${o.id}" aria-pressed="${P.op === o.id}">${icon(PDF_ICON[o.id])}<b>${esc(o.label)}</b><span>${esc(o.note)}</span></button>`).join('');
  const ready = pdfReady();
  const note = PDFAPI.touch && pdfOp(P.op)?.note;
  return `<div class="pdfops">${ops}</div>${note ? `<p class="row-hint pdfopnote">${esc(note)}</p>` : ''}
    ${pdfFiles()}${P.files.length ? pdfOptions() : ''}
    ${P.files.length ? `<div class="cvopts"><span class="grow"></span><button type="button" class="btn primary" data-pdf="go" ${ready ? '' : 'disabled'}>${P.up >= 0 ? `${icon('spin', 'spin')}Sending ${P.up}%` : `${icon(PDF_ICON[P.op] || 'pdf')}${PDF_GO[P.op] || 'Go'}`}</button></div>` : ''}`;
}

// One job in a list; the frame adds where it went and its buttons.
function pdfRow(j, full) {
  const live = j.state === 'queued' || j.state === 'running';
  const n = (j.files || []).length, where = PDFAPI.where(j);
  const sizes = j.size && j.inSize ? `${pdfSize(j.inSize)} → ${pdfSize(j.size)}` : '';
  return `<div class="row" data-lj="${j.id}"><span class="thumb" style="--h:${pdfHue(j.id)}">${icon(PDF_ICON[j.target] || 'pdf')}</span>
    <div class="row-text grow"><span class="row-title clip">${esc(pdfTitle(j))}</span>
      <div class="hmeta"><span class="sitetag">${esc(pdfOp(j.target)?.label || j.target)}</span>${live ? `<span class="jobstate">${j.state === 'queued' ? 'Waiting its turn' : 'Working on it…'}</span>` : ''}
        ${full && n > 1 ? `<span>${n} files</span>` : ''}${full && sizes && j.target === 'compress' ? `<span>${sizes}</span>` : ''}<span>${hm(new Date(j.at))}${full ? ' · from ' + esc(PDFAPI.from(j)) : ''}</span>
        ${where ? `<span class="where">${icon('check')}${where}</span>` : ''}</div>
      ${live ? `<div class="prog"><i style="width:${Math.max(4, j.pct)}%"></i></div>` : ''}
      ${j.state === 'failed' ? `<div class="hmeta bad">${icon('alert')}${esc(j.note)}</div>` : j.note ? `<div class="hmeta">${esc(j.note)}</div>` : ''}</div>
    <div class="hacts">${live && !j.local ? `<button type="button" class="btn small" data-pdf="cancel" data-id="${j.id}">Cancel</button>` : PDFAPI.acts(j)}</div></div>`;
}

function pdfAdd(list, replace) {
  P.files = (replace ? [] : P.files).concat([...list]);
  P.err = '';
  if (PDF_ONE.includes(P.op)) P.files = P.files.slice(0, 1);
  pdfAfterFiles();
}

// Pages and Pick pages need the page pictures of the one PDF.
function pdfAfterFiles() {
  const f = P.files[0];
  pdfInput.multiple = !PDF_ONE.includes(P.op);
  if ((P.op === 'pages' || P.op === 'extract') && P.files.length === 1 && pdfIsPdf(f)) {
    if (P.pagesOf !== f) { P.pagesOf = f; pdfLoad(); return; }
  } else { P.pagesOf = null; P.gen++; Object.assign(P, { pages: [], thumbs: {}, bad: '', loading: false }); }
  render();
}

async function pdfSend() {
  if (PDFST?.local) return localPdf(); // the phone does it (local.js)
  P.up = 0; P.err = ''; render();
  let x;
  try {
    x = await sendForm(`${PDFAPI.base}/start?op=${P.op}&pages=${pdfSpec()}&level=${P.level}`, PDFAPI.hdr, P.files, P.op === 'lock' || P.op === 'unlock' ? { pw: P.pw } : {}, (p) => { P.up = Math.floor(p * 100); render(); });
  } catch (e) { P.up = -1; P.err = PDFAPI.touch ? e.message : "Couldn't send the files."; render(); return; }
  P.up = -1;
  if (x.status === 200) { P.gen++; Object.assign(P, { files: [], pages: [], thumbs: {}, pagesOf: null, pw: '', err: '' }); } else P.err = x.responseText.trim() || "That didn't work.";
  await pdfRefresh(); render(); PDFAPI.after();
}

function pdfMove(arr, i, to) {
  if (to < 0 || to >= arr.length || to === i) return;
  arr.splice(to, 0, arr.splice(i, 1)[0]);
}

document.getElementById('app').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pdf]');
  if (!b) return;
  const a = b.dataset.pdf, i = +b.dataset.i, pg = P.pages[i];
  try {
    if (a === 'pick') { P.addMode = !!b.dataset.add; pdfInput.multiple = !PDF_ONE.includes(P.op); return; } // the label opens the picker
    if (a === 'op') { P.op = b.dataset.op; if (PDF_ONE.includes(P.op) && P.files.length > 1) P.files = P.files.slice(0, 1); pdfAfterFiles(); }
    else if (a === 'go') P.op === 'edit' ? await pdfEditOpen(P.files[0]) : pdfSend(); // the editor sends it when you tap Save (pdf-edit.js)
    else if (a === 'clear') { P.files = []; P.err = ''; pdfAfterFiles(); }
    else if (a === 'drop') { P.files.splice(i, 1); pdfAfterFiles(); }
    else if (a === 'fmove') { pdfMove(P.files, i, i + +b.dataset.by); render(); }
    else if (a === 'move') { pdfMove(P.pages, i, i + +b.dataset.by); render(); }
    else if (a === 'turn') { pg.rot = (pg.rot + 90) % 360; render(); }
    else if (a === 'del') { P.pages.splice(i, 1); render(); }
    else if (a === 'reset') { P.pagesOf = null; pdfAfterFiles(); }
    else if (a === 'sel') { pg.sel = !pg.sel; render(); }
    else if (a === 'all' || a === 'none') { P.pages.forEach((p) => { p.sel = a === 'all'; }); render(); }
    else if (a === 'level') { P.level = b.dataset.level; render(); }
    else if (a === 'showpw') { P.showPw = !P.showPw; render(); }
    else if (a === 'cancel') { await api(`${PDFAPI.base}/cancel/${b.dataset.id}`, {}); await pdfRefresh(); render(); }
  } catch (err) { P.err = err.message; render(); }
});
document.getElementById('app').addEventListener('input', (e) => { if (e.target.id === 'pdfpw') { P.pw = e.target.value; const go = document.querySelector('[data-pdf="go"]'); if (go) go.disabled = !pdfReady(); } });
// The PC window: drag a page to move it.
document.getElementById('app').addEventListener('dragstart', (e) => { const c = e.target.closest?.('.pdfpage[draggable]'); if (c) { P.drag = +c.dataset.i; c.classList.add('is-drag'); e.dataTransfer.effectAllowed = 'move'; } });
document.getElementById('app').addEventListener('dragover', (e) => { if (P.drag >= 0 && e.target.closest?.('.pdfpage')) e.preventDefault(); });
document.getElementById('app').addEventListener('drop', (e) => {
  const c = e.target.closest?.('.pdfpage');
  if (P.drag < 0 || !c) return;
  e.preventDefault(); e.stopPropagation();
  pdfMove(P.pages, P.drag, +c.dataset.i); P.drag = -1; render();
});
document.getElementById('app').addEventListener('dragend', () => { if (P.drag >= 0) { P.drag = -1; render(); } });
