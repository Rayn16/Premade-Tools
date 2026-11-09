// The PDF editor: change the text, add text, pictures, a signature, drawings, highlights, shapes and white-out.
// It opens over the screen from PDF tools › Edit on the PC and the phones, and runs on the device itself (PDF.js
// draws the pages, /m/lib/pdf-edit.mjs reads and changes the PDF). Save hands the new PDF back to the PDF tools,
// which deliver it as "name (edited).pdf" like any other result. Positions are in page points (see pdf-edit.mjs).
'use strict';

ICON.edtext = '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>';
ICON.addtext = '<path d="M4 7V5h11v2M9.5 5v14M7 19h5M18 13v8M14 17h8"/>';
ICON.sign = '<path d="M3 17c3 0 4-9 6-9s0 9 2.5 9S14 12 15.5 12s1 5 2.5 5H21M3 21h18"/>';
ICON.mark = '<path d="M9 14l-2 2v3h3l2-2M9 14l7.5-7.5 3 3L12 17zM4 21h8"/>';
ICON.shape = '<rect x="3.5" y="9.5" width="10" height="10" rx="1"/><circle cx="16" cy="8" r="4.5"/>';
ICON.white = '<path d="M8 20h12M5.5 14.5l8-8 5 5-6.5 6.5H9z"/><path d="M9.5 10.5l5 5"/>';
ICON.undo = '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>';
ICON.minus = '<path d="M5 12h14"/>';

const ED_TOOLS = [['edit', 'edtext', 'Edit'], ['add', 'addtext', 'Text'], ['pic', 'photo', 'Picture'], ['sign', 'sign', 'Sign'], ['draw', 'pen', 'Draw'], ['mark', 'mark', 'Highlight'],
  ['shape', 'shape', 'Shapes'], ['white', 'white', 'White-out']];
const ED_DRAG = ['draw', 'mark', 'shape', 'white']; // tools that draw with the finger, so one finger doesn't scroll
const ED_INK = ['#111111', '#1f4fd1', '#d0222d', '#14874b'];
const ED_HI = ['#ffe14d', '#7df07d', '#ff8ad8'];
const ED_FONT = { sans: 'Helvetica,Arial,sans-serif', serif: "'Times New Roman',Times,serif", mono: "'Courier New',Courier,monospace" };
const ED = { on: false };
let EDM = null; // the engine module
const edUid = () => Math.random().toString(36).slice(2, 10);
const edEl = (sel) => ED.root.querySelector(sel);

async function pdfEditOpen(file) {
  EDM ??= await import('/m/lib/pdf-edit.mjs');
  const { PDFDocument } = await import('/m/lib/pdf-lib.min.mjs');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc, view;
  try { doc = await PDFDocument.load(bytes); } catch (e) {
    P.err = /encrypt/i.test(e.message) ? 'This PDF has a password. Remove it first with Remove password, then edit it.' : "This PDF couldn't be opened. It may be damaged.";
    return render();
  }
  try { view = await (await pdfLib()).getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; } catch (e) { P.err = "This PDF couldn't be opened. It may be damaged."; return render(); }
  Object.assign(ED, { on: true, file, bytes, doc, view, tool: 'edit', shape: 'box', ink: ED_INK[0], hi: ED_HI[0], thick: 2, tsize: 14, items: [], edits: {}, pics: {}, sel: null,
    undo: [], z: 1, busy: false, note: '', reads: {}, drawn: {}, typing: null });
  ED.pages = doc.getPages().map((p) => EDM.view(p));
  const app = document.getElementById('app');
  ED.root = Object.assign(document.createElement('div'), { className: 'pt pdfed' + (PDFAPI.touch ? ' m' : '') });
  ED.root.dataset.theme = app.dataset.theme || 'red';
  ED.root.style.setProperty('--c', app.style.getPropertyValue('--c'));
  ED.root.innerHTML = `<header class="edtop"><button type="button" class="iconbtn" data-ed="close" aria-label="Close without saving">${icon('x')}</button>
      <b class="edname clip">${esc(file.name)}</b><span class="grow"></span>
      <button type="button" class="iconbtn" data-ed="zout" aria-label="Smaller">${icon('minus')}</button><button type="button" class="iconbtn" data-ed="zin" aria-label="Bigger">${icon('plus')}</button>
      <button type="button" class="iconbtn" data-ed="undo" aria-label="Undo">${icon('undo')}</button>
      <button type="button" class="btn primary" data-ed="save">${icon('save')}Save</button></header>
    <div class="edscroll"><div class="edpages">${ED.pages.map((p, i) => `<div class="edpage" data-p="${i}" style="--w:${p.W};--h:${p.H}"><canvas></canvas>
      <svg class="edsvg" viewBox="0 0 ${p.W} ${p.H}" preserveAspectRatio="none"></svg><div class="edhtml"></div></div>`).join('')}</div></div>
    <div class="edopts"></div>
    <nav class="edtools">${ED_TOOLS.map(([id, ic, l]) => `<button type="button" data-ed="tool" data-tool="${id}">${icon(ic)}<span>${l}</span></button>`).join('')}</nav>`;
  document.body.append(ED.root);
  document.documentElement.classList.add('edopen');
  // iPhones zoom the whole screen into a small typing box; the editor has its own zoom, so that's turned off while it's open.
  const vm = document.querySelector('meta[name=viewport]');
  ED.vp = vm?.content;
  if (vm && PDFAPI.touch) vm.content = ED.vp + ',maximum-scale=1';
  edFit();
  ED.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) edShow(+e.target.dataset.p); }), { root: edEl('.edscroll'), rootMargin: '600px 0px' });
  ED.root.querySelectorAll('.edpage').forEach((n) => ED.io.observe(n));
  edBar();
}

function edClose() {
  ED.io?.disconnect();
  ED.root?.remove();
  document.documentElement.classList.remove('edopen');
  if (ED.vp) document.querySelector('meta[name=viewport]').content = ED.vp;
  try { ED.view?.destroy(); } catch (e) {}
  Object.assign(ED, { on: false, root: null, doc: null, view: null });
}

// Pixels per point: the widest page fills the screen (up to 1.5× on the PC), then the zoom buttons.
function edFit() {
  const wide = Math.max(...ED.pages.map((p) => p.W)), room = edEl('.edscroll').clientWidth - (PDFAPI.touch ? 16 : 48);
  ED.s = Math.min(room / wide, PDFAPI.touch ? 9 : 1.5) * ED.z;
  edEl('.edpages').style.setProperty('--s', ED.s);
  ED.drawn = {};
  ED.root.querySelectorAll('.edpage').forEach((n) => { const r = n.getBoundingClientRect(), sc = edEl('.edscroll').getBoundingClientRect(); if (r.bottom > sc.top - 600 && r.top < sc.bottom + 600) edShow(+n.dataset.p); });
}

// A page came into sight: draw it (sharp for this zoom) and read its text.
async function edShow(i) {
  if (!ED.reads[i]) { try { ED.reads[i] = EDM.readText(ED.doc, ED.doc.getPage(i)); } catch (e) { ED.reads[i] = { blocks: [] }; } edPaint(i); }
  const s = ED.s;
  if (ED.drawn[i] === s) return;
  ED.drawn[i] = s;
  const page = await ED.view.getPage(i + 1), dpr = Math.min(window.devicePixelRatio || 1, 3);
  const k = Math.min(s * dpr, 4096 / Math.max(ED.pages[i].W, ED.pages[i].H)); // phones refuse giant canvases
  const vp = page.getViewport({ scale: k }), cv = document.createElement('canvas');
  cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  page.cleanup();
  if (!ED.on || ED.drawn[i] !== s) return;
  ED.root.querySelector(`.edpage[data-p="${i}"] canvas`).replaceWith(cv);
}

// ---------- drawing what's added ----------
const edBox = (it) => {
  if (it.pts) { const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]), pad = (it.width || 2) + 4; return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 }; }
  if (it.type === 'text') { const lines = it.text.split('\n'); return { x: it.x, y: it.y, w: Math.max(it.size, ...lines.map((l) => edMeasure(l, it))), h: it.size * 1.2 * lines.length }; }
  return it;
};
let edCtx = null;
function edMeasure(line, it) {
  edCtx ??= document.createElement('canvas').getContext('2d');
  edCtx.font = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}100px ${ED_FONT[it.family || 'sans']}`;
  return edCtx.measureText(line).width * it.size / 100;
}

function edSvg(it) {
  const c = it.color, w = it.width || 2;
  switch (it.type) {
    case 'white': return `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="#fff"/>`;
    case 'mark': return `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="${c}" fill-opacity=".4" style="mix-blend-mode:multiply"/>`;
    case 'box': return `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
    case 'oval': return `<ellipse cx="${it.x + it.w / 2}" cy="${it.y + it.h / 2}" rx="${it.w / 2}" ry="${it.h / 2}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
    case 'pic': return `<image href="${ED.pics[it.pic].url}" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" preserveAspectRatio="none"/>`;
    case 'draw': case 'line': case 'arrow': return `<path d="${EDM.pathOf(it)}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return '';
}
const edTextCss = (it, s = it.size) => `font-size:calc(${s}px * var(--s));font-family:${ED_FONT[it.family || 'sans']};${it.bold ? 'font-weight:700;' : ''}${it.italic ? 'font-style:italic;' : ''}color:${it.color}`;
const edPos = (b) => `left:calc(${b.x}px * var(--s));top:calc(${b.y}px * var(--s));width:calc(${b.w}px * var(--s));height:calc(${b.h}px * var(--s))`;

// Redraws page i's added things, its changed lines and, with Edit, the lines you can tap.
function edPaint(i) {
  const pg = ED.root?.querySelector(`.edpage[data-p="${i}"]`);
  if (!pg) return;
  const items = ED.items.filter((it) => it.page === i), sel = ED.items.find((it) => it.id === ED.sel);
  let svg = items.filter((it) => it.type !== 'text').map(edSvg).join('');
  let html = '';
  for (const b of ED.reads[i]?.blocks || []) {
    const key = i + ':' + b.id, now = ED.edits[key], typing = ED.typing?.key === key;
    if (now === undefined && ED.tool !== 'edit') continue;
    if (now !== undefined) svg = `<rect x="${b.x - 1}" y="${b.y - 1}" width="${b.w + 2}" height="${b.h + 2}" fill="#fff"/>` + svg;
    if (typing) continue;
    html += `<div class="edblk${now !== undefined ? ' is-changed' : ''}" data-b="${key}" style="${edPos(b)}">${now !== undefined
      ? `<span style="${edTextCss(b)};top:calc(${b.oy - b.y - b.size}px * var(--s))">${esc(now)}</span>` : ''}</div>`;
  }
  for (const it of items.filter((x) => x.type === 'text' && ED.typing?.id !== x.id)) html += `<div class="edtxt" data-it="${it.id}" style="left:calc(${it.x}px * var(--s));top:calc(${it.y}px * var(--s));${edTextCss(it)}">${esc(it.text)}</div>`;
  if (sel?.page === i) {
    const b = edBox(sel);
    html += `<div class="edsel" data-grab="${sel.id}" style="${edPos(b)}">${['pic', 'white', 'mark', 'box', 'oval'].includes(sel.type) ? `<i class="edhandle" data-size="${sel.id}"></i>` : ''}</div>`;
  }
  pg.querySelector('.edsvg').innerHTML = svg;
  const h = pg.querySelector('.edhtml'), keep = h.querySelector('.edtype');
  h.innerHTML = html;
  if (keep) h.append(keep);
}
const edPaintAll = () => ED.pages.forEach((_, i) => edPaint(i));

// The options row over the tools, for the tool in use or what's picked.
function edBar() {
  ED.root.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === ED.tool));
  ED.root.querySelector('.edpages').classList.toggle('is-ink', ED_DRAG.includes(ED.tool));
  const sel = ED.items.find((it) => it.id === ED.sel);
  const dots = (list, key, cur) => `<span class="edcolors">${list.map((c) => `<button type="button" data-ed="${key}" data-c="${c}" aria-pressed="${c === cur}" style="--dot:${c}" aria-label="Colour ${c}"></button>`).join('')}</span>`;
  const seg = (key, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-ed="${key}" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;
  const sizes = [[10, 'S'], [14, 'M'], [22, 'L']], thick = [[1, 'Thin'], [2, 'Mid'], [4, 'Thick']];
  let row;
  if (sel) {
    row = `${sel.type === 'text' ? dots(ED_INK, 'ink', sel.color) + seg('tsize', sel.size, sizes) : ''}<span class="grow edhint">${sel.type === 'text' ? '' : 'Drag to move' + (['pic', 'white', 'mark', 'box', 'oval'].includes(sel.type) ? ', corner to resize.' : '.')}</span>
      <button type="button" class="btn small" data-ed="del">${icon('bin')}Delete</button><button type="button" class="btn small" data-ed="unsel">Done</button>`;
  } else if (ED.tool === 'add') row = dots(ED_INK, 'ink', ED.ink) + seg('tsize', ED.tsize, sizes) + '<span class="grow edhint">Tap where the text goes.</span>';
  else if (ED.tool === 'draw') row = dots(ED_INK, 'ink', ED.ink) + seg('thick', ED.thick, thick);
  else if (ED.tool === 'shape') row = seg('shape', ED.shape, [['box', 'Box'], ['oval', 'Circle'], ['line', 'Line'], ['arrow', 'Arrow']]) + dots(ED_INK, 'ink', ED.ink);
  else if (ED.tool === 'mark') row = dots(ED_HI, 'hi', ED.hi) + '<span class="grow edhint">Drag over what to highlight.</span>';
  else if (ED.tool === 'white') row = '<span class="grow edhint">Drag over what to hide. It\'s covered in white.</span>';
  else row = `<span class="grow edhint">${ED.note ? `${icon('info')}${esc(ED.note)}` : 'Tap any text to change it. Tap something you added to move it.'}</span>`;
  edEl('.edopts').innerHTML = row + (ED_DRAG.includes(ED.tool) && PDFAPI.touch && !sel ? '<span class="edhint edtwo">Two fingers to scroll</span>' : '');
  edEl('[data-ed="undo"]').disabled = !ED.undo.length;
}

// ---------- changes ----------
function edSnap() { ED.undo.push(JSON.stringify({ items: ED.items, edits: ED.edits })); if (ED.undo.length > 60) ED.undo.shift(); }
function edUndo() {
  edType(false);
  const s = ED.undo.pop();
  if (!s) return;
  ({ items: ED.items, edits: ED.edits } = JSON.parse(s));
  ED.sel = null; edPaintAll(); edBar();
}
function edAdd(it) { edSnap(); it.id = edUid(); ED.items.push(it); return it; }

// Where a pointer is on page i, in points.
function edAt(e, i) {
  const r = ED.root.querySelector(`.edpage[data-p="${i}"]`).getBoundingClientRect();
  return [(e.clientX - r.left) / ED.s, (e.clientY - r.top) / ED.s];
}
function edHit(i, x, y) {
  for (let k = ED.items.length - 1; k >= 0; k--) {
    const it = ED.items[k], b = edBox(it);
    if (it.page === i && x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4) return it;
  }
  return null;
}

// Typing: a box over a line of the PDF's own text (key "page:block") or over added text (id).
function edType(on, what) {
  const t = ED.typing;
  if (t) {
    ED.typing = null;
    const v = t.el.value;
    t.el.remove();
    if (t.key) {
      const [i, id] = t.key.split(':'), b = ED.reads[i].blocks[id], was = ED.edits[t.key] ?? b.text;
      if (v !== was) {
        edSnap();
        if (v === b.text) delete ED.edits[t.key]; else ED.edits[t.key] = v;
        ED.note = v && v !== b.text && !EDM.fits(b, v) ? "That line's font doesn't have every letter you typed, so it'll be saved in the closest font." : '';
      }
      edPaint(+i);
    } else {
      const it = ED.items.find((x) => x.id === t.id);
      if (it && v !== it.text) { if (!t.fresh) edSnap(); it.text = v; }
      if (it && !v.trim()) { ED.items = ED.items.filter((x) => x !== it); ED.sel = null; }
      if (it) edPaint(it.page);
    }
    edBar();
  }
  if (!on) return;
  const el = document.createElement(what.key ? 'input' : 'textarea');
  el.className = 'edtype';
  el.spellcheck = false;
  if (what.key) {
    const [i, id] = what.key.split(':'), b = ED.reads[i].blocks[id];
    el.value = ED.edits[what.key] ?? b.text;
    el.style.cssText = `${edTextCss(b)};left:calc(${b.x - 2}px * var(--s));top:calc(${b.y - 2}px * var(--s));min-width:calc(${b.w + 30}px * var(--s));height:calc(${b.h + 4}px * var(--s))`;
    ED.typing = { key: what.key, el };
    ED.root.querySelector(`.edpage[data-p="${i}"] .edhtml`).append(el);
    edPaint(+i);
  } else {
    const it = what.it;
    el.value = it.text;
    el.rows = Math.max(1, it.text.split('\n').length);
    el.style.cssText = `${edTextCss(it)};left:calc(${it.x}px * var(--s));top:calc(${it.y}px * var(--s))`;
    ED.typing = { id: it.id, el, fresh: what.fresh };
    ED.root.querySelector(`.edpage[data-p="${it.page}"] .edhtml`).append(el);
    edPaint(it.page);
  }
  const grow = () => { if (el.tagName === 'TEXTAREA') { el.rows = el.value.split('\n').length; el.style.width = `calc(${Math.max(40, ...el.value.split('\n').map((l) => edMeasure(l, what.it))) + 16}px * var(--s))`; } else el.style.width = `calc(${edMeasure(el.value, ED.reads[what.key.split(':')[0]].blocks[what.key.split(':')[1]]) + 30}px * var(--s))`; };
  el.addEventListener('input', grow);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && el.tagName === 'INPUT')) { e.preventDefault(); el.blur(); } });
  el.addEventListener('blur', () => { if (ED.typing?.el === el) edType(false); });
  grow();
  el.focus();
  if (what.fresh) el.select();
}

// Pictures and signatures come in as PNG (keeps see-through parts) or JPEG, at most 2000 pixels across.
async function edPicture(blob, sig) {
  const url = URL.createObjectURL(blob), im = new Image();
  im.src = url;
  try { await im.decode(); } catch (e) { URL.revokeObjectURL(url); ED.note = "That picture couldn't be opened."; return edBar(); }
  let w = im.naturalWidth, h = im.naturalHeight, bytes, png = blob.type === 'image/png';
  if (Math.max(w, h) > 2000 || !/^image\/(png|jpeg)$/.test(blob.type)) {
    const k = Math.min(1, 2000 / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    png = blob.type === 'image/png' || blob.type === 'image/gif' || blob.type === 'image/webp';
    blob = await new Promise((ok) => c.toBlob(ok, png ? 'image/png' : 'image/jpeg', 0.85));
  }
  bytes = new Uint8Array(await blob.arrayBuffer());
  const id = edUid();
  ED.pics[id] = { bytes, png, url: URL.createObjectURL(blob) };
  URL.revokeObjectURL(url);
  const i = edCurrentPage(), pg = ED.pages[i], bw = Math.min(pg.W * (sig ? 0.3 : 0.5), w), bh = bw * h / w;
  const sc = edEl('.edscroll'), top = (sc.scrollTop + sc.clientHeight / 2 - ED.root.querySelector(`.edpage[data-p="${i}"]`).offsetTop) / ED.s;
  const it = edAdd({ page: i, type: 'pic', pic: id, x: (pg.W - bw) / 2, y: Math.max(0, Math.min(pg.H - bh, top - bh / 2)), w: bw, h: bh });
  ED.sel = it.id; ED.tool = 'edit';
  edPaint(i); edBar();
}
function edCurrentPage() {
  const sc = edEl('.edscroll'), mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
  let best = 0, d = Infinity;
  ED.root.querySelectorAll('.edpage').forEach((n) => { const r = n.getBoundingClientRect(), k = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0; if (k < d) { d = k; best = +n.dataset.p; } });
  return best;
}
const edPicIn = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
edPicIn.style.cssText = 'position:fixed;left:-200px;width:1px;height:1px;opacity:0';
document.body.append(edPicIn);
edPicIn.addEventListener('change', () => { const f = edPicIn.files[0]; edPicIn.value = ''; if (f && ED.on) edPicture(f); });

// The signature pad. The last signature is kept on this device to use again.
function edSignPad() {
  let saved = null;
  try { saved = localStorage.getItem('pt-signature'); } catch (e) {}
  const pad = document.createElement('div');
  pad.className = 'edpad';
  pad.innerHTML = `<div class="edpadbox"><b>Sign here</b><canvas width="900" height="320"></canvas>
    <div class="edpadbar">${saved ? '<button type="button" class="btn small" data-pad="old">Use my last signature</button>' : ''}<span class="grow"></span>
    <button type="button" class="btn small" data-pad="clear">Clear</button><button type="button" class="btn small" data-pad="cancel">Cancel</button><button type="button" class="btn small primary" data-pad="done">Done</button></div></div>`;
  ED.root.append(pad);
  const cv = pad.querySelector('canvas'), g = cv.getContext('2d');
  g.lineWidth = 7; g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#111';
  let down = false, any = false;
  const xy = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  cv.addEventListener('pointerdown', (e) => { down = any = true; cv.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...xy(e)); g.lineTo(...xy(e)); g.stroke(); });
  cv.addEventListener('pointermove', (e) => { if (down) { g.lineTo(...xy(e)); g.stroke(); } });
  cv.addEventListener('pointerup', () => { down = false; });
  pad.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-pad]')?.dataset.pad;
    if (a === 'clear') { g.clearRect(0, 0, cv.width, cv.height); any = false; }
    else if (a === 'cancel') pad.remove();
    else if (a === 'old') { pad.remove(); edPicture(await (await fetch(saved)).blob(), true); }
    else if (a === 'done') {
      if (!any) return pad.remove();
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const c = document.createElement('canvas');
      c.width = x1 - x0 + 9; c.height = y1 - y0 + 9;
      c.getContext('2d').drawImage(cv, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
      try { localStorage.setItem('pt-signature', c.toDataURL('image/png')); } catch (err) {}
      pad.remove();
      edPicture(await new Promise((ok) => c.toBlob(ok, 'image/png')), true);
    }
  });
}

// ---------- the finger and the mouse ----------
const edFingers = new Map();
let edGest = null;
function edDown(e) {
  if (e.target.closest('.edtype')) return;
  const pg = e.target.closest('.edpage');
  if (!pg) return;
  if (ED.typing) { edType(false); edGest = null; return; } // a tap away from the typing box only finishes the typing
  edFingers.set(e.pointerId, [e.clientX, e.clientY]);
  if (edFingers.size > 1) { // two fingers: scroll, and drop what the first finger started
    if (edGest?.it && edGest.fresh) { ED.items = ED.items.filter((x) => x !== edGest.it); ED.undo.pop(); edPaint(edGest.i); }
    edGest = { pan: true };
    return;
  }
  const i = +pg.dataset.p, [x, y] = edAt(e, i), tool = ED.tool;
  const grab = e.target.closest('[data-grab]'), size = e.target.closest('[data-size]');
  if (size || grab) {
    const it = ED.items.find((v) => v.id === (size?.dataset.size || grab.dataset.grab));
    edSnap();
    edGest = { i, it, x, y, from: JSON.parse(JSON.stringify(it)), size: !!size, moved: false };
    pg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (ED_DRAG.includes(tool)) {
    const kind = tool === 'shape' ? ED.shape : tool;
    const it = edAdd(['draw', 'line', 'arrow'].includes(kind) ? { page: i, type: kind, pts: [[x, y], [x, y]], color: ED.ink, width: ED.thick }
      : { page: i, type: kind, x, y, w: 0, h: 0, color: kind === 'mark' ? ED.hi : ED.ink, width: ED.thick });
    edGest = { i, it, x, y, fresh: true };
    pg.setPointerCapture(e.pointerId);
    e.preventDefault();
    ED.sel = null;
    return;
  }
  edGest = { i, x, y, tap: true, cx: e.clientX, cy: e.clientY };
}
function edMove(e) {
  if (!edFingers.has(e.pointerId)) return;
  const last = edFingers.get(e.pointerId);
  edFingers.set(e.pointerId, [e.clientX, e.clientY]);
  const g = edGest;
  if (!g) return;
  if (g.pan) { const sc = edEl('.edscroll'); sc.scrollTop -= (e.clientY - last[1]) / edFingers.size; sc.scrollLeft -= (e.clientX - last[0]) / edFingers.size; return; }
  if (g.tap) { if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > 8) edGest = null; return; }
  const [x, y] = edAt(e, g.i), it = g.it, pg = ED.pages[g.i];
  if (g.from) {
    const dx = x - g.x, dy = y - g.y, f = g.from;
    g.moved = true;
    if (g.size) {
      const w = Math.max(8, f.w + dx);
      it.w = w; it.h = it.type === 'pic' ? w * f.h / f.w : Math.max(8, f.h + dy);
    } else if (it.pts) it.pts = f.pts.map(([px, py]) => [px + dx, py + dy]);
    else { it.x = Math.max(-edBox(f).w / 2, Math.min(pg.W - 10, f.x + dx)); it.y = Math.max(-10, Math.min(pg.H - 10, f.y + dy)); }
  } else if (it.type === 'draw') { const p = it.pts[it.pts.length - 1]; if (Math.hypot(x - p[0], y - p[1]) > 0.8) it.pts.push([x, y]); }
  else if (it.pts) it.pts[1] = [x, y];
  else Object.assign(it, { x: Math.min(x, g.x), y: Math.min(y, g.y), w: Math.abs(x - g.x), h: Math.abs(y - g.y) });
  edPaint(g.i);
}
function edUp(e) {
  edFingers.delete(e.pointerId);
  const g = edGest;
  if (edFingers.size || !g) { if (!edFingers.size) edGest = null; return; }
  edGest = null;
  if (g.pan) return;
  if (g.from) { if (!g.moved) ED.undo.pop(); edPaint(g.i); return; }
  if (g.fresh) {
    const it = g.it, b = edBox(it);
    if (it.type !== 'draw' && Math.max(b.w, b.h) < (it.pts ? 14 : 4)) { ED.items = ED.items.filter((x) => x !== it); ED.undo.pop(); }
    edPaint(g.i);
    return;
  }
  if (!g.tap) return;
  // A tap: pick what you added, change a line, or put new text there.
  const hit = edHit(g.i, g.x, g.y);
  if (ED.tool === 'add' && !hit) {
    const it = edAdd({ page: g.i, type: 'text', text: 'Text', x: g.x, y: g.y - ED.tsize * 0.6, size: ED.tsize, color: ED.ink, family: 'sans' });
    ED.sel = it.id;
    edBar();
    return edType(true, { it, fresh: true });
  }
  if (hit) {
    if (hit.type === 'text' && ED.sel === hit.id) return edType(true, { it: hit });
    ED.sel = hit.id;
  } else {
    const was = ED.sel;
    ED.sel = null;
    const blk = ED.tool === 'edit' && (ED.reads[g.i]?.blocks || []).find((b) => g.x >= b.x - 2 && g.x <= b.x + b.w + 2 && g.y >= b.y - 2 && g.y <= b.y + b.h + 2);
    if (blk) { if (was) edPaintAll(); edBar(); return edType(true, { key: g.i + ':' + blk.id }); }
  }
  edPaintAll(); edBar();
}

// ---------- saving ----------
// Draws a line the built-in fonts can't (Arabic, emoji…) as a sharp picture.
async function edTextPng(it, line) {
  const k = 6, c = document.createElement('canvas'), w = Math.ceil(edMeasure(line, it) + it.size * 0.2), h = Math.ceil(it.size * 1.2);
  c.width = w * k; c.height = h * k;
  const g = c.getContext('2d');
  g.font = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${it.size * k}px ${ED_FONT[it.family || 'sans']}`;
  g.fillStyle = it.color; g.textBaseline = 'alphabetic';
  g.fillText(line, 0, it.size * k);
  return { bytes: new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer()), w, h };
}

async function edSave() {
  edType(false);
  if (ED.busy) return;
  if (!ED.items.length && !Object.keys(ED.edits).length) { ED.note = 'Nothing is changed yet.'; ED.tool = 'edit'; return edBar(); }
  ED.busy = true;
  const btn = edEl('[data-ed="save"]');
  btn.innerHTML = `${icon('spin', 'spin')}Saving`;
  try {
    const { PDFDocument } = await import('/m/lib/pdf-lib.min.mjs');
    const doc = await PDFDocument.load(ED.bytes); // a fresh copy, so a failed save leaves nothing half done
    for (let i = 0; i < ED.pages.length; i++) {
      const page = doc.getPage(i), edits = {};
      for (const [k, v] of Object.entries(ED.edits)) { const [p, id] = k.split(':'); if (+p === i) edits[id] = v; }
      const extra = Object.keys(edits).length ? EDM.editText(doc, page, EDM.readText(doc, page), edits) : [];
      await EDM.drawItems(doc, page, [...extra, ...ED.items.filter((it) => it.page === i)], ED.pics, edTextPng);
    }
    const bytes = await doc.save({ useObjectStreams: true });
    const file = new File([bytes], ED.file.name, { type: 'application/pdf' });
    edClose();
    P.files = [file];
    pdfSend(); // the PDF tools save it as "name (edited).pdf", like their other results
  } catch (e) {
    ED.busy = false;
    btn.innerHTML = `${icon('save')}Save`;
    ED.note = "Couldn't save: " + (e.message || e);
    ED.tool = 'edit'; ED.sel = null;
    edBar();
  }
}

// ---------- buttons ----------
document.addEventListener('click', (e) => {
  if (!ED.on) return;
  const b = e.target.closest('[data-ed]');
  if (!b || !ED.root.contains(b)) return;
  const a = b.dataset.ed, sel = ED.items.find((it) => it.id === ED.sel);
  if (a !== 'close') ED.leaving = false;
  if (a !== 'save') edType(false);
  if (a === 'close') {
    if ((ED.items.length || Object.keys(ED.edits).length) && !ED.leaving) { // no confirm(): the S23 app's web view may not show one
      Object.assign(ED, { leaving: true, tool: 'edit', sel: null, note: 'Tap × again to close without saving.' });
      edPaintAll(); return edBar();
    }
    return edClose();
  }
  if (a === 'save') return edSave();
  if (a === 'undo') return edUndo();
  if (a === 'zin' || a === 'zout') {
    const sc = edEl('.edscroll'), f = sc.scrollTop / Math.max(1, sc.scrollHeight);
    ED.z = Math.max(0.5, Math.min(4, ED.z * (a === 'zin' ? 1.25 : 0.8)));
    edFit();
    sc.scrollTop = f * sc.scrollHeight;
    return;
  }
  if (a === 'tool') {
    const t = b.dataset.tool;
    ED.sel = null; ED.note = '';
    if (t === 'pic') { edPicIn.click(); return; }
    if (t === 'sign') return edSignPad();
    ED.tool = t;
  } else if (a === 'ink' || a === 'hi') {
    if (sel?.type === 'text') { edSnap(); sel.color = b.dataset.c; } else ED[a] = b.dataset.c;
  } else if (a === 'tsize') {
    if (sel?.type === 'text') { edSnap(); sel.size = +b.dataset.v; } else ED.tsize = +b.dataset.v;
  } else if (a === 'thick') ED.thick = +b.dataset.v;
  else if (a === 'shape') ED.shape = b.dataset.v;
  else if (a === 'del' && sel) { edSnap(); ED.items = ED.items.filter((x) => x !== sel); ED.sel = null; }
  else if (a === 'unsel') ED.sel = null;
  edPaintAll(); edBar();
});
document.addEventListener('pointerdown', (e) => { if (ED.on && ED.root.contains(e.target)) edDown(e); });
document.addEventListener('pointermove', (e) => { if (ED.on) edMove(e); });
document.addEventListener('pointerup', (e) => { if (ED.on) edUp(e); });
document.addEventListener('pointercancel', (e) => { edFingers.delete(e.pointerId); if (!edFingers.size) edGest = null; });
document.addEventListener('keydown', (e) => {
  if (!ED.on || e.target.closest?.('.edtype')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); edUndo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && ED.sel) { edSnap(); ED.items = ED.items.filter((x) => x.id !== ED.sel); ED.sel = null; edPaintAll(); edBar(); }
  else if (e.key === 'Escape' && ED.sel) { ED.sel = null; edPaintAll(); edBar(); }
});
window.addEventListener('resize', () => { if (ED.on && !ED.typing) edFit(); });
