// Vault on the phone: the same screens for the Android app (inside its WebView) and the iPhone home-screen app.
'use strict';

const qs = new URLSearchParams(location.hash.slice(1));
if (qs.get('t')) { try { localStorage.setItem('vaultToken', qs.get('t')); } catch (e) {} }
const TOKEN = qs.get('t') || (() => { try { return localStorage.getItem('vaultToken'); } catch (e) { return null; } })();
const NATIVE = window.Vault || null; // Android bridge, absent on iPhone

const S = { tab: 'deleted', phone: 'all', type: 'all', q: '', sheet: null, msg: '', ask: null, view: 'grid' };
try { S.view = localStorage.getItem('vaultView') || 'grid'; } catch (e) {}
const FLOW = {}; // file id → 'confirm', { wait: text } or { done: true, name, folder }
let ST = null, ITEMS = [], OFFLINE = false, LAST = '';
const $app = document.getElementById('app');

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
  const now = JSON.stringify([ST, ITEMS, OFFLINE]);
  if (now !== LAST || S.tab !== 'deleted') render();
  LAST = now;
}

const phoneById = (id) => (ST?.phones || []).find((p) => p.ID === id);
const phoneName = (id) => id === ST?.me ? 'This phone' : phoneById(id)?.Name || 'Removed phone';
const view = (id, dl) => `/api/phone/view/${id}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;
const fresh = (p) => Date.now() - new Date(p.LastSeen) < 2 * 3600e3;
const live = () => liveItems(ITEMS || []);
const crest = '<span class="crest"><img src="/icon.svg" alt=""></span>';
const LEDE = { deleted: 'Everything you deleted on your phones, newest first.', phones: 'The phones that send what you delete to your PC.', settings: 'How long the vault keeps things, where they sit, and how this app looks.' };

function render() {
  if (!TOKEN) {
    $app.innerHTML = `<div class="topbar">${crest}<span class="wordmark-app">Vault</span></div><div class="titlerow"><div><h1 class="pagetitle">Not paired yet</h1><p class="pagelede">Open Vault on your PC, choose Phones, then Add a phone, and scan the code with this phone.</p></div></div>`;
    return;
  }
  const keep = [...$app.querySelectorAll('.scroller')].map((n) => n.scrollTop);
  const c = ST?.config || {};
  $app.dataset.theme = c.theme || 'red';
  $app.style.setProperty('--c', c.custom || '#d9202d');
  const tabs = [['deleted', 'Deleted'], ['phones', 'Phones'], ['settings', 'Settings']].map(([id, l]) =>
    `<button type="button" class="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${l}</span></button>`).join('');
  const off = OFFLINE ? `<div class="offline">Can't reach your PC right now. ${NATIVE ? 'This phone keeps saving what you delete and sends it when you are home.' : 'This shows what was there last time.'}</div>` : '';
  const head = `<div class="topbar">${crest}<span class="wordmark-app">Vault</span></div>`;
  const body = !ST ? '<div class="titlerow"><p class="pagelede">Loading…</p></div>' : S.tab === 'phones' ? phonesView(off) : S.tab === 'settings' ? settingsView(off) : deletedView(off);
  $app.innerHTML = `${head}${body}<nav class="tabbar" aria-label="Sections">${tabs}</nav>${S.sheet ? sheetView() : ''}${S.ask ? askView() : ''}`;
  $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = keep[i] || 0; });
  lazyMedia($app);
}

function shown() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => !it.dismissed && (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) && (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}
const titleRow = (name, extra = '') => `<div class="titlerow"><div class="titlerow-text"><h1 class="pagetitle">${name}</h1><p class="pagelede">${LEDE[name.toLowerCase()]}</p></div>${extra}</div>`;

function deletedView(off) {
  const all = live(), n = (f) => all.filter(f).length;
  const phoneOpts = [['all', 'All phones', all.length], ...ST.phones.map((p) => [p.ID, p.ID === ST.me ? 'This phone' : p.Name, n((i) => i.phone === p.ID)])];
  const typeOpts = [['all', 'All', all.length], ['photo', 'Photos', n((i) => i.kind === 'photo')], ['video', 'Videos', n((i) => i.kind === 'video')], ['voice', 'Voice', n((i) => i.kind === 'voice')], ['file', 'Files', n((i) => i.kind === 'file')]];
  const pills = (opts, key) => opts.map(([id, l, c]) => `<button type="button" class="pill" data-${key}="${esc(id)}" aria-pressed="${S[key] === id}">${esc(l)} <i>${c}</i></button>`).join('');
  const toggle = `<div class="viewtoggle" role="group" aria-label="View"><button type="button" data-view="grid" aria-pressed="${S.view === 'grid'}" aria-label="Grid">${icon('grid')}</button><button type="button" data-view="list" aria-pressed="${S.view === 'list'}" aria-label="List">${icon('list')}</button></div>`;
  return `${titleRow('Deleted', toggle)}
    <label class="search">${icon('search')}<span class="sr">Search deleted files</span><input type="search" id="q" value="${esc(S.q)}" placeholder="Search by name or folder"></label>
    <div class="rails"><div class="rail" role="group" aria-label="Type">${pills(typeOpts, 'type')}</div>
    ${phoneOpts.length > 2 ? `<div class="rail rail-sm" role="group" aria-label="Phone">${pills(phoneOpts, 'phone')}</div>` : ''}</div>
    <div class="headrule"></div>
    <div class="feed scroller" id="dl">${off}${listView()}</div>`;
}

function listView() {
  const all = shown(), items = all.filter((i) => !i.missed);
  const notes = all.filter((i) => i.missed).map((it) => `<div class="failnote" role="status">${icon('alert')}<span><b>${esc(it.name)}</b> couldn't be saved. ${esc(it.note || '')}</span><button type="button" class="quiet" data-dismiss="${it.id}">Dismiss</button></div>`).join('');
  if (!live().length) return notes + `<div class="empty">${icon('deleted')}<h2>Nothing deleted yet</h2><p>From now on, anything you delete shows up here, newest first.</p></div>`;
  if (!items.length) return notes + `<div class="empty">${icon('search')}<h2>Nothing matches that</h2><p>Try another name, or clear the filters.</p></div>`;
  const groups = [];
  for (const it of items) {
    const day = dayOf(new Date(it.deletedAt));
    if (groups.at(-1)?.day !== day) groups.push({ day, rows: [] });
    groups.at(-1).rows.push(S.view === 'list' ? rowView(it) : cardView(it));
  }
  return `<p class="feedcount"><b>${items.length}</b> ${items.length === 1 ? 'item' : 'items'} kept</p>${notes}` +
    groups.map((g) => `<section class="daygroup"><div class="dayhead"><b>${g.day}</b><span>${g.rows.length}</span><i></i></div><div class="${S.view === 'list' ? 'list' : 'grid'}">${g.rows.join('')}</div></section>`).join('');
}

const noPreview = (it) => /\.dng$/i.test(it.name);
const mark = (it) => FLOW[it.id]?.done ? `<span class="restoredmark">${icon('check')}</span>` : '';
const cardView = (it) => `<button type="button" class="card" data-open="${it.id}"><span class="media">${tile(it, view(it.id), noPreview(it))}${mark(it)}</span>
  <span class="card-meta"><span class="card-name">${esc(it.name)}</span><span class="card-phone">${esc(phoneName(it.phone))}</span><span class="card-days ${keptClass(it, ST.config.keep)}">${keptLabel(it, ST.config.keep)}</span></span></button>`;
const rowView = (it) => `<button type="button" class="lrow" data-open="${it.id}"><span class="media">${tile(it, view(it.id), noPreview(it))}${mark(it)}</span>
  <span class="lrow-text"><span class="card-name">${esc(it.name)}</span><span class="card-phone">${esc(phoneName(it.phone))}</span><span class="card-when">${it.byTime ? 'by ' : ''}${whenShort(new Date(it.deletedAt))}</span></span>
  <span class="lrow-right"><span class="card-days ${keptClass(it, ST.config.keep)}">${keptLabel(it, ST.config.keep)}</span><span class="card-days">${size(it.size)}</span></span></button>`;

function sheetView() {
  const it = ITEMS.find((i) => i.id === S.sheet);
  if (!it) return '';
  const src = view(it.id);
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}#t=0.1" controls playsinline preload="metadata"></video>`
    : it.kind === 'voice' ? `${wave(it.id, 40)}<audio src="${src}" controls preload="none"></audio>` : `${doc()}<span class="tag is-doc">${esc(ext(it.name) || 'FILE')}</span>`;
  const p = phoneById(it.phone), me = it.phone === ST.me;
  return `<div class="msheet" data-close><div class="msheet-card" role="dialog" aria-label="${esc(it.name)}"><div class="grab"><span></span></div>
    <div class="msheet-body scroller"><div class="preview">${pv}</div><p class="detail-name">${esc(it.name)}</p><p class="detail-kind">${kindLabel(it)}, ${size(it.size)}</p>
    <dl class="kv"><div><dt>Deleted</dt><dd class="mono">${it.byTime ? 'By ' : ''}${whenShort(new Date(it.deletedAt))}</dd></div>
    <div><dt>From</dt><dd>${me && p ? `This phone (${esc(p.Name)})` : esc(phoneName(it.phone))}</dd></div>
    <div><dt>Was in</dt><dd class="mono">${esc(it.folder)}</dd></div><div><dt>Type and size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd></div>
    <div><dt>Kept</dt><dd class="mono ${keptClass(it, ST.config.keep)}">${keptLabel(it, ST.config.keep)}</dd></div></dl></div>
    <div class="actions">${actions(it, p, me)}</div></div></div>`;
}

function actions(it, p, me) {
  const f = FLOW[it.id];
  if (f?.done) return `<div class="done">${icon('check')}<span class="done-text">Restored. It's back in ${esc(f.folder)}.<em>on ${esc(f.name)}</em></span></div><div class="actions-quiet"><button type="button" class="quiet" data-closesheet>Done</button></div>`;
  if (f?.wait || p?.Pending?.includes(it.id)) return `<div class="restoring"><div class="restoring-row">${icon('spin', 'spin')}Restoring…</div><div class="progline"><span></span></div>${f?.wait ? `<p>${esc(f.wait)}</p>` : ''}</div>`;
  if (f === 'confirm') return `<div class="confirm"><p class="confirm-text">Dismiss this from the vault?</p><p class="confirm-sub">It leaves this list. The file stays in the vault folder until your keep time runs out.</p>
    <div class="confirm-row"><button type="button" class="btn" data-unconfirm="${it.id}">Keep it</button><button type="button" class="btn danger" data-dismiss="${it.id}">Dismiss</button></div></div>`;
  const target = me ? 'this phone' : p ? p.Name : '';
  return `<div class="actions-stack">${p ? `<button type="button" class="btn primary block" data-restore="${it.id}">Restore to ${esc(target)}</button>` : ''}
    <a class="btn block" href="${view(it.id, true)}" download="${esc(it.name)}">${icon('save')}${NATIVE ? 'Download' : 'Save to Files'}</a></div>
    <div class="msg bad" role="status">${esc(S.msg)}</div>
    <div class="actions-quiet"><button type="button" class="quiet" data-askdismiss="${it.id}">Dismiss</button></div>`;
}

function askView() {
  const a = S.ask;
  return `<div class="msheet" data-closeask><div class="msheet-card" role="dialog" aria-label="Keep for less time?"><div class="grab"><span></span></div>
    <div class="msheet-body"><h2 class="sheet-title">Keep for less time?</h2><p class="sheet-text">This clears ${plural(a.count, 'file')} (${esc(a.size)}) deleted more than ${esc(a.label)} ago. They can't be brought back.</p><p class="sheet-note">Everything deleted since then stays in the vault.</p></div>
    <div class="actions"><div class="actions-stack"><button type="button" class="btn block danger" data-keepyes="${a.id}">Clear them</button><button type="button" class="btn block" data-askclear>Keep them</button></div></div></div></div>`;
}

function phonesView(off) {
  const local = NATIVE ? JSON.parse(NATIVE.status()) : null;
  const saved = (p) => live().filter((i) => i.phone === p.ID);
  const me = ST.phones.find((p) => p.ID === ST.me);
  const others = ST.phones.filter((p) => p !== me);
  return `${titleRow('Phones')}<div class="headrule"></div>
    <div class="feed scroller">${off}${me ? (me.Kind === 'iphone' ? heroIphone(me, saved(me)) : heroAndroid(me, local || me.Status || {}, saved(me), local)) : ''}
    ${others.length ? `<div class="sectionhead"><b>Other phones</b><i></i></div><div class="phonelist">${others.map((p) => otherPhone(p, saved(p).length)).join('')}</div>` : ''}
    <div class="pcrow"><i class="dotlight ${OFFLINE ? 'off' : ''}"></i><span>${OFFLINE ? "Can't reach your PC" : 'Connected to your PC'}</span></div>
    <p class="mhint">${icon('info')}<span>To add another phone, open Vault on your PC and choose <b>Phones</b>, then <b>Add a phone</b>.</span></p></div>`;
}

const ring = '<div class="ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="45"/><circle class="ring-arc" cx="50" cy="50" r="45"/></svg><img src="/icon.svg" alt=""></div>';
const heroTop = (eyebrow, name) => `<div class="hero-id">${icon('phones')}<div><span>${eyebrow}</span><b>${esc(name)}</b></div></div>`;

function heroAndroid(p, st, saved, local) {
  const up = fresh(p);
  const rows = [[st.allFiles, 'All files access allowed', 'All files access is off', 'files'], [st.battery, 'Battery set to Unrestricted', 'Battery is not Unrestricted', 'battery'], [st.binOn !== false, "Gallery's Recycle bin is on", "Gallery's Recycle bin looks off", 'bin']];
  const allOk = rows.every(([ok]) => ok), good = allOk && (up || NATIVE);
  const month = saved.filter((i) => Date.now() - new Date(i.deletedAt) < 30 * 864e5).length;
  const checks = rows.map(([ok, yes, no, fix]) => `<li class="mcheck ${ok ? '' : 'is-bad'}"><span class="check-mark">${icon(ok ? 'check' : 'x')}</span><span class="check-label">${ok ? yes : no}</span>${!ok && NATIVE ? `<button type="button" class="btn-fix" data-fix="${fix}">Fix</button>` : ''}</li>`).join('');
  const pending = local?.pending ? `<li class="mcheck is-wait"><span class="check-mark">${icon('clock')}</span><span class="check-label">Waiting to send: <b>${plural(local.pending, 'file')}</b>, sent when the PC is reachable</span></li>` : '';
  return `<section class="mhero ${good ? '' : 'is-warn'}">${heroTop('This phone', p.Name)}
    <div class="hero-state">${ring}<h2 class="hero-headline">${good ? 'Watching the bin' : allOk ? 'Not seen lately' : 'Needs a fix'}</h2><p class="hero-check">Last check ${ago(p.LastSeen)}</p><p class="hero-saved"><b>${month}</b> ${month === 1 ? 'file' : 'files'} saved this month</p></div>
    <ul class="mchecks">${checks}${pending}</ul></section>`;
}

function heroIphone(p, saved) {
  return `<section class="mhero">${heroTop('This iPhone', p.Name)}
    <div class="hero-state">${ring}<h2 class="hero-headline">Backs up at home</h2><p class="hero-check">Last backup ${whenShort(new Date(p.LastSeen))}</p><p class="hero-saved"><b>${saved.length}</b> ${saved.length === 1 ? 'item' : 'items'} saved</p></div>
    <dl class="kv pad"><div><dt>Runs when</dt><dd>It joins your home Wi-Fi, and when it starts charging</dd></div><div><dt>Covers</dt><dd>Photos and videos, screenshots, screen recordings, WhatsApp and Telegram media</dd></div></dl></section>`;
}

function otherPhone(p, n) {
  const ios = p.Kind === 'iphone', up = fresh(p);
  const state = ios ? ['is-idle', 'Backs up at home'] : up ? ['', 'Watching the bin'] : ['is-warn', 'Not seen lately'];
  return `<div class="phonecard"><span class="phonecard-glyph">${icon('phones')}</span><span class="phonecard-text"><b>${esc(p.Name)}</b><span class="phonecard-state ${state[0]}"><i class="dotlight"></i>${state[1]}</span></span>
    <span class="phonecard-right"><span>${ios ? whenShort(new Date(p.LastSeen)) : ago(p.LastSeen)}</span><span>${n} saved</span></span></div>`;
}

function settingsView(off) {
  const c = ST.config;
  return `${titleRow('Settings')}<div class="headrule"></div>
    <div class="feed scroller">${off}
    <section class="group"><div class="sectionhead"><b>Vault</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Keep deleted files</h2><div class="chips">${KEEP.map(([id, l]) => `<button type="button" class="pill" data-keep="${id}" aria-pressed="${c.keep === id}">${c.keep === id ? icon('check') : ''}${l}</button>`).join('')}</div><p class="block-hint">Only files deleted longer ago than this are cleared.</p></div>
      <div class="block"><h2 class="block-title">Stored on your PC</h2><p class="vaultpath-m">${esc(c.vaultDir)}</p>${ST.free ? `<p class="capstat"><b>${esc(nice(ST.free))}</b> free</p>` : ''}<p class="block-hint">You can move it from Settings on the PC.</p></div>
    </div></section>
    <section class="group"><div class="sectionhead"><b>Look</b><i></i></div><div class="panel"><div class="block"><h2 class="block-title">Colours</h2><div class="themes">${THEMES.map(([id, l, bg, panel, ac]) => `<button type="button" class="mswatch" data-theme-pick="${id}" aria-pressed="${c.theme === id}"><span class="mswatch-preview" style="background:${bg}"><i style="background:${panel}"></i><u style="background:${ac}"></u>${c.theme === id ? `<em>${icon('check')}</em>` : ''}</span><span class="mswatch-name">${l}</span></button>`).join('')}</div></div></div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST.version)}</span></div></div>`;
}

$app.addEventListener('click', async (e) => {
  if (e.target.dataset?.close !== undefined && e.target.classList.contains('msheet')) { closeSheet(); return; }
  if (e.target.dataset?.closeask !== undefined) { S.ask = null; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.tab) { S.tab = d.tab; render(); }
    else if (d.phone) { S.phone = d.phone; render(); }
    else if (d.type) { S.type = d.type; render(); }
    else if (d.view) { S.view = d.view; try { localStorage.setItem('vaultView', d.view); } catch (e2) {} render(); }
    else if (d.open) { S.sheet = d.open; S.msg = ''; render(); }
    else if (d.closesheet !== undefined) closeSheet();
    else if (d.askdismiss) { FLOW[d.askdismiss] = 'confirm'; render(); }
    else if (d.unconfirm) { delete FLOW[d.unconfirm]; render(); }
    else if (d.dismiss) { await api('/api/phone/dismiss/' + d.dismiss, {}); delete FLOW[d.dismiss]; if (S.sheet === d.dismiss) S.sheet = null; refresh(); }
    else if (d.restore) {
      await api('/api/phone/restore/' + d.restore, {});
      const it = ITEMS.find((i) => i.id === d.restore), p = phoneById(it.phone);
      FLOW[it.id] = { wait: p.Kind === 'iphone' ? 'Queued. It goes back into Photos the next time the iPhone backs up.' : it.phone === ST.me ? `It goes back into ${it.folder}.` : `Waiting for the ${p.Name} to pick it up. It goes back into ${it.folder}.` };
      if (it.phone === ST.me && NATIVE) NATIVE.syncNow();
      S.msg = ''; render();
      watchRestore(it);
    }
    else if (d.fix) { NATIVE.fix(d.fix); }
    else if (d.keep) {
      if (KEEPDAYS[d.keep] < KEEPDAYS[ST.config.keep]) {
        const p = await api('/api/phone/keep-preview?keep=' + d.keep);
        if (p.count) { S.ask = { id: d.keep, count: p.count, size: p.size, label: b.textContent.toLowerCase() }; render(); return; }
      }
      await api('/api/phone/settings', { keep: d.keep }); refresh();
    }
    else if (d.keepyes) { await api('/api/phone/settings', { keep: d.keepyes }); S.ask = null; refresh(); }
    else if (d.askclear !== undefined) { S.ask = null; render(); }
    else if (d.themePick) { await api('/api/phone/settings', { theme: d.themePick }); refresh(); }
  } catch (err) { S.msg = err.message; render(); }
});
function closeSheet() {
  if (FLOW[S.sheet] === 'confirm' || FLOW[S.sheet]?.done) delete FLOW[S.sheet];
  S.sheet = null; S.msg = ''; render();
}
// Shows "Restored" once the phone has put the file back (the PC drops it from that phone's list).
function watchRestore(it) {
  const t0 = Date.now();
  const t = setInterval(async () => {
    await refresh();
    const p = phoneById(it.phone);
    if (p && (p.Pending || []).includes(it.id) && Date.now() - t0 < 20 * 60e3) return;
    clearInterval(t);
    if (p && !(p.Pending || []).includes(it.id)) FLOW[it.id] = { done: true, name: p.Name, folder: it.folder };
    else delete FLOW[it.id];
    render();
  }, 3000);
}
$app.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; const n = document.getElementById('dl'); n.innerHTML = (OFFLINE ? n.querySelector('.offline')?.outerHTML || '' : '') + listView(); lazyMedia($app); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.vaultRefresh = refresh; // the Android app calls this after it sends something
refresh();
setInterval(() => { if (!document.hidden && !S.sheet && !S.ask && document.activeElement?.id !== 'q') refresh(); }, 30000);
