// Vault on the phone: the same screens for the Android app (inside its WebView) and the iPhone home-screen app.
'use strict';

const qs = new URLSearchParams(location.hash.slice(1));
if (qs.get('t')) { try { localStorage.setItem('vaultToken', qs.get('t')); } catch (e) {} }
const TOKEN = qs.get('t') || (() => { try { return localStorage.getItem('vaultToken'); } catch (e) { return null; } })();
const NATIVE = window.Vault || null; // Android bridge, absent on iPhone

const S = { tab: 'deleted', phone: 'all', type: 'all', q: '', sheet: null, msg: '' };
let ST = null, ITEMS = [], OFFLINE = false;
const $app = document.getElementById('app');

const ICON = {
  deleted: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  phones: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
};
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TINT = { photo: 'var(--gold)', video: 'var(--accent)', voice: 'var(--good)', file: 'var(--muted)' };
const KEEP = [['forever', 'Forever'], ['2y', '2 years'], ['1y', '1 year'], ['6m', '6 months'], ['3m', '3 months']];
const KEEPDAYS = { forever: Infinity, '2y': 730, '1y': 365, '6m': 182, '3m': 91 };
const THEMES = [['red', 'Red and black', '#d9202d'], ['league', 'League', '#c8aa6e'], ['light', 'Light', '#f2eee4'], ['purple', 'Purple', '#7c4dff'], ['green', 'Green', '#27c381'], ['mono', 'Mono', '#ffffff']];

async function api(path, body) {
  const opt = { headers: { Authorization: 'Bearer ' + TOKEN } };
  if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}

async function refresh() {
  try {
    [ST, ITEMS] = await Promise.all([api('/api/phone/state'), api('/api/phone/deleted')]);
    OFFLINE = false;
    try { localStorage.setItem('vaultCache', JSON.stringify([ST, ITEMS])); } catch (e) {}
  } catch (e) {
    OFFLINE = true;
    if (!ST) { try { [ST, ITEMS] = JSON.parse(localStorage.getItem('vaultCache')) || []; } catch (e2) {} }
  }
  render();
}

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
function dayOf(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = (t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5;
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier';
}
const whenShort = (d) => dayOf(d) === 'Earlier' ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : hm(d);
const whenLong = (d) => (dayOf(d) === 'Earlier' ? d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : dayOf(d)) + ', ' + hm(d);
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  return Math.round(s / 86400) + ' days ago';
}
function size(b) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
const phoneById = (id) => (ST?.phones || []).find((p) => p.ID === id);
const phoneName = (id) => id === ST?.me ? 'This phone' : phoneById(id)?.Name || 'Removed phone';
const view = (id, dl) => `/api/phone/view/${id}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;
const kindLabel = (it) => it.kind === 'photo' ? (/screenshot/i.test(it.folder + it.name) ? 'Screenshot' : 'Photo') : it.kind === 'video' ? 'Video' : it.kind === 'voice' ? 'Voice recording' : (it.name.split('.').pop() || 'File').toUpperCase();

function render() {
  if (!TOKEN) {
    $app.innerHTML = `<div class="body"><h1>Not paired yet</h1><p class="muted">Open Vault on your PC, choose Phones, then Pair a phone, and scan the code with this phone.</p></div>`;
    return;
  }
  const c = ST?.config || {};
  $app.dataset.theme = c.theme || 'red';
  $app.style.setProperty('--c', c.custom || '#d9202d');
  const tabs = [['deleted', 'Deleted'], ['phones', 'Phones'], ['settings', 'Settings']].map(([id, l]) =>
    `<button type="button" class="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${icon(id)}${l}</button>`).join('');
  const off = OFFLINE ? `<div class="offline">Can't reach your PC right now. ${NATIVE ? 'This phone keeps saving what you delete and sends it when you are home.' : 'This shows what was there last time.'}</div>` : '';
  $app.innerHTML = `<header class="top"><span class="brand">Premade Tools · Vault</span></header>
    <div class="body">${off}${!ST ? '<p class="muted">Loading…</p>' : S.tab === 'phones' ? phonesView() : S.tab === 'settings' ? settingsView() : deletedView()}</div>
    <nav class="tabs" aria-label="Sections">${tabs}</nav>${S.sheet ? sheetView() : ''}`;
}

function shown() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) && (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}

function deletedView() {
  const phoneOpts = [['all', 'All phones'], ...ST.phones.map((p) => [p.ID, p.ID === ST.me ? 'This phone' : p.Name])];
  const typeOpts = [['all', 'All types'], ['photo', 'Photos'], ['video', 'Videos'], ['voice', 'Voice'], ['file', 'Files']];
  const pills = (opts, key) => opts.map(([id, l]) => `<button type="button" class="pill" data-${key}="${esc(id)}" aria-pressed="${S[key] === id}">${esc(l)}</button>`).join('');
  return `<h1>Deleted</h1>
    <label class="search">${icon('search')}<span class="sr">Search deleted files</span><input type="search" id="q" value="${esc(S.q)}" placeholder="Search by name"></label>
    ${phoneOpts.length > 2 ? `<div class="pills" role="group" aria-label="Phone" style="margin-bottom:8px">${pills(phoneOpts, 'phone')}</div>` : ''}
    <div class="pills" role="group" aria-label="Type" style="margin-bottom:14px">${pills(typeOpts, 'type')}</div>
    <div id="dl">${listView()}</div>`;
}

function listView() {
  const all = shown(), items = all.filter((i) => !i.missed);
  const notes = all.filter((i) => i.missed).map((it) => `<div class="notice" role="status">${icon('alert')}<span><b>${esc(it.name)}</b> couldn't be saved. ${esc(it.note || '')}</span><button type="button" class="btn" data-dismiss="${it.id}">Dismiss</button></div>`).join('');
  if (!ITEMS.filter((i) => !i.missed).length) return notes + '<div class="card empty"><h2>Nothing deleted yet</h2><p>From now on, anything you delete shows up here, newest first.</p></div>';
  if (!items.length) return notes + '<div class="card empty">Nothing deleted matches that.</div>';
  let rows = '', last = null;
  for (const it of items) {
    const d = new Date(it.deletedAt), day = dayOf(d);
    if (day !== last) { rows += `<div class="dayh">${day}</div>`; last = day; }
    const th = it.kind === 'photo' && !/\.(dng)$/i.test(it.name) ? `<img src="${view(it.id)}" alt="" loading="lazy" onerror="this.remove()">` : icon(it.kind);
    rows += `<button type="button" class="row" data-open="${it.id}"><span class="thumb" style="--t:${TINT[it.kind]}">${th}</span>
      <span class="rowmain"><span class="name">${esc(it.name)}</span><span class="where">${esc(phoneName(it.phone))} · ${esc(it.folder)}</span></span>
      <span class="rowend"><span>${it.byTime ? 'by ' : ''}${whenShort(d)}</span><span>${size(it.size)}</span></span></button>`;
  }
  return notes + `<div class="card list">${rows}</div>`;
}

function sheetView() {
  const it = ITEMS.find((i) => i.id === S.sheet);
  if (!it) return '';
  const src = view(it.id);
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}" controls playsinline preload="metadata"></video>`
    : it.kind === 'voice' ? `<audio src="${src}" controls preload="none"></audio>` : icon('file');
  const p = phoneById(it.phone);
  const keep = ST.config.keep === 'forever' ? 'Forever' : 'Until ' + new Date(new Date(it.deletedAt).getTime() + KEEPDAYS[ST.config.keep] * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const target = it.phone === ST.me ? 'this phone' : p ? p.Name : '';
  return `<div class="sheet" data-close><div role="dialog" aria-label="${esc(it.name)}"><span class="grab"></span>
    <div class="preview">${pv}</div><h2 style="overflow-wrap:anywhere">${esc(it.name)}</h2>
    <dl class="kv"><dt>Deleted</dt><dd>${it.byTime ? 'By ' : ''}${whenLong(new Date(it.deletedAt))}</dd><dt>From</dt><dd>${esc(phoneName(it.phone))}</dd>
    <dt>Was in</dt><dd>${esc(it.folder)}</dd><dt>Type and size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd><dt>Kept</dt><dd>${keep}</dd></dl>
    <div class="acts">${p ? `<button type="button" class="btn primary" data-restore="${it.id}">${icon('restore')}Restore to ${esc(target)}</button>` : ''}
    <a class="btn" href="${view(it.id, true)}" download="${esc(it.name)}">${icon('save')}${NATIVE ? 'Download' : 'Save to Files'}</a></div>
    <div class="msg" role="status">${esc(S.msg)}</div></div></div>`;
}

function phonesView() {
  const local = NATIVE ? JSON.parse(NATIVE.status()) : null;
  const cards = ST.phones.map((p) => {
    const me = p.ID === ST.me, st = me && local ? local : (p.Status || {});
    const fresh = Date.now() - new Date(p.LastSeen) < 2 * 3600e3;
    const ok = (b, yes, no, fix) => `<li>${b ? icon('check', 'good') : icon('x', 'bad')}${b ? yes : no}${!b && me && NATIVE && fix ? ` <button type="button" class="btn" data-fix="${fix}" style="margin-left:auto;padding:6px 10px!important">Fix</button>` : ''}</li>`;
    if (p.Kind === 'iphone') return `<section class="card phone"><div class="top">${icon('phones')}<h2>${me ? 'This iPhone' : esc(p.Name)}</h2><span class="badge ${fresh ? 'good' : 'warn'}">Backs up at home</span></div>
      <dl class="kv"><dt>Last backup</dt><dd>${whenLong(new Date(p.LastSeen))}</dd><dt>Runs when</dt><dd>It joins your home Wi-Fi, and when it starts charging</dd>
      <dt>Covers</dt><dd>Photos and videos, screenshots, screen recordings, WhatsApp and Telegram media</dd></dl></section>`;
    const month = ITEMS.filter((i) => i.phone === p.ID && !i.missed && Date.now() - new Date(i.deletedAt) < 30 * 864e5).length;
    return `<section class="card phone"><div class="top">${icon('phones')}<h2>${me ? 'This phone' : esc(p.Name)}</h2><span class="badge ${fresh ? 'good' : 'warn'}">${fresh ? 'Watching the bin' : 'Not seen lately'}</span></div>
      <dl class="kv"><dt>Last check</dt><dd>${ago(p.LastSeen)}</dd><dt>How it works</dt><dd>Anything that lands in its Recycle bin is saved.</dd><dt>This month</dt><dd>${month} files saved</dd>
      ${me && local?.pending ? `<dt>Waiting to send</dt><dd>${local.pending} files, sent when the PC is reachable</dd>` : ''}</dl>
      <ul class="checks">${ok(st.allFiles, 'All files access allowed', 'All files access is off', 'files')}${ok(st.battery, 'Battery set to Unrestricted', 'Battery is not Unrestricted', 'battery')}${ok(st.binOn !== false, "Gallery's Recycle bin is on", "Gallery's Recycle bin looks off", 'bin')}</ul></section>`;
  }).join('');
  return `<h1 style="margin-bottom:14px">Phones</h1>${cards}<p class="hint">To add another phone, open Vault on your PC and choose Phones, then Pair a phone.</p>`;
}

function settingsView() {
  const c = ST.config;
  return `<h1 style="margin-bottom:14px">Settings</h1>
    <section class="card"><h2>Vault</h2>
      <div><div class="small muted" style="margin-bottom:6px">Keep deleted files</div><div class="pills" style="flex-wrap:wrap">${KEEP.map(([id, l]) => `<button type="button" class="pill" data-keep="${id}" aria-pressed="${c.keep === id}">${l}</button>`).join('')}</div>
      <p class="hint" style="margin-top:6px">Only files deleted longer ago than this are cleared.</p></div>
      <div><div class="small muted">Stored on your PC</div><div class="mono">${esc(c.vaultDir)}</div><p class="hint">You can move it from Settings on the PC.</p></div></section>
    <section class="card"><h2>Look</h2><div class="swatches">${THEMES.map(([id, l, col]) => `<button type="button" class="sw" data-theme-pick="${id}" aria-pressed="${c.theme === id}"><i style="background:${col}"></i>${l}</button>`).join('')}</div></section>
    <p class="hint">Premade Tools ${esc(ST.version)}</p>`;
}

$app.addEventListener('click', async (e) => {
  if (e.target.dataset?.close !== undefined && e.target.classList.contains('sheet')) { S.sheet = null; S.msg = ''; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.tab) { S.tab = d.tab; render(); }
    else if (d.phone) { S.phone = d.phone; render(); }
    else if (d.type) { S.type = d.type; render(); }
    else if (d.open) { S.sheet = d.open; S.msg = ''; render(); }
    else if (d.dismiss) { await api('/api/phone/dismiss/' + d.dismiss, {}); refresh(); }
    else if (d.restore) {
      await api('/api/phone/restore/' + d.restore, {});
      const it = ITEMS.find((i) => i.id === d.restore), p = phoneById(it.phone);
      S.msg = p.Kind === 'iphone' ? 'Queued. It goes back into Photos the next time the iPhone backs up.' : it.phone === ST.me ? `Coming back into ${it.folder} in a moment.` : `On its way back to the ${p.Name}, into ${it.folder}.`;
      if (it.phone === ST.me && NATIVE) NATIVE.syncNow();
      render();
    }
    else if (d.fix) { NATIVE.fix(d.fix); }
    else if (d.keep) {
      if (KEEPDAYS[d.keep] < KEEPDAYS[ST.config.keep]) {
        const p = await api('/api/phone/keep-preview?keep=' + d.keep);
        if (p.count && !confirm(`This clears ${p.count} files (${p.size}) deleted more than ${b.textContent.toLowerCase()} ago. They can't be brought back. Go ahead?`)) return;
      }
      await api('/api/phone/settings', { keep: d.keep }); refresh();
    }
    else if (d.themePick) { await api('/api/phone/settings', { theme: d.themePick }); refresh(); }
  } catch (err) { S.msg = err.message; render(); }
});
$app.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; document.getElementById('dl').innerHTML = listView(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.vaultRefresh = refresh; // the Android app calls this after it sends something
refresh();
setInterval(() => { if (!document.hidden && !S.sheet && document.activeElement?.id !== 'q') refresh(); }, 30000);
