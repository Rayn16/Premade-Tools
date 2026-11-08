// Vault on the phone: the same screens for the Android app (inside its WebView) and the iPhone home-screen app.
'use strict';

const qs = new URLSearchParams(location.hash.slice(1) || location.search); // Android: #t=…; iPhone Home Screen app: ?t=…
if (qs.get('t')) { try { localStorage.setItem('vaultToken', qs.get('t')); } catch (e) {} }
const TOKEN = qs.get('t') || (() => { try { return localStorage.getItem('vaultToken'); } catch (e) { return null; } })();
const NATIVE = window.Vault || null; // Android bridge, absent on iPhone

const S = { tool: 'home', tab: 'home', drawer: false, phone: 'all', type: 'all', q: '', sheet: null, msg: '', ask: null, view: 'grid' };
try { S.view = localStorage.getItem('vaultView') || 'grid'; } catch (e) {}
if (qs.get('tool') === 'drop') { S.tool = 'drop'; S.tab = 'drop'; } // the Android app's "Sent to this phone" notification
// Each tool has its own bottom tabs; the ☰ sidebar switches tools.
const TOOLS = { home: { name: 'Home', icon: 'home', tabs: [['home', 'Home', 'home']] },
  download: { name: 'Downloader', icon: 'dl', tabs: [['dl', 'Download', 'dl'], ['history', 'History', 'clock'], ['dlsettings', 'Settings', 'settings']] },
  convert: { name: 'Converter', icon: 'convert', tabs: [['convert', 'Convert', 'convert'], ['cvhistory', 'History', 'clock'], ['cvsettings', 'Settings', 'settings']] },
  pdf: { name: 'PDF', icon: 'pdf', tabs: [['pdf', 'Tools', 'pdf'], ['pdfhistory', 'History', 'clock'], ['pdfsettings', 'Settings', 'settings']] },
  transcribe: { name: 'Transcribe', icon: 'transcribe', tabs: [['transcribe', 'Transcribe', 'transcribe'], ['trhistory', 'History', 'clock'], ['trsettings', 'Settings', 'settings']] },
  drop: { name: 'File drop', icon: 'drop', tabs: [['drop', 'Drop', 'drop'], ['drophistory', 'History', 'clock'], ['dropsettings', 'Settings', 'settings']] },
  vault: { name: 'Vault', icon: 'shield', tabs: [['deleted', 'Deleted', 'deleted'], ['phones', 'Phones', 'phones'], ['settings', 'Settings', 'settings']] } };
const FLOW = {}; // file id → 'confirm', { wait: text } or { done: true, name, folder }
let ST = null, ITEMS = [], OFFLINE = false, LAST = '';
let DL = null; // /api/phone/dl, drawn by mdl.js
const $app = document.getElementById('app');

async function api(path, body) {
  const opt = { headers: { Authorization: 'Bearer ' + TOKEN } };
  if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}

let VER = ''; // the PC version these pages came from
async function refresh() {
  try {
    [ST, ITEMS, DL] = await Promise.all([api('/api/phone/state'), api('/api/phone/deleted'), api('/api/phone/dl').catch(() => DL), typeof cvRefresh === 'function' && cvRefresh(), typeof pdfPhoneRefresh === 'function' && pdfPhoneRefresh(), typeof trToolsView === 'function' && trRefresh()]); // mcv.js and mpdf.js load after this file
    OFFLINE = false;
    if (VER && VER !== ST.version) { // the PC just updated itself: get the new pages, and the new Android app
      try { localStorage.setItem('ptUpdated', '1'); } catch (e) {}
      location.reload(); return;
    }
    VER = ST.version;
    dlAfterRefresh();
    try { localStorage.setItem('vaultCache', JSON.stringify([ST, ITEMS])); } catch (e) {}
  } catch (e) {
    OFFLINE = true;
    if (!ST) { try { [ST, ITEMS] = JSON.parse(localStorage.getItem('vaultCache')) || []; } catch (e2) {} }
  }
  const now = JSON.stringify([ST, ITEMS, OFFLINE, DL, CVS, PDFST, TRST]);
  if (now !== LAST || (S.tab !== 'deleted' && S.tab !== 'dl' && S.tab !== 'convert' && S.tab !== 'pdf' && S.tab !== 'transcribe' && S.tab !== 'drop')) render();
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
    $app.innerHTML = `<div class="topbar">${crest}<span class="wordmark-app">Premade Tools</span></div><div class="titlerow"><div><h1 class="pagetitle">Not paired yet</h1><p class="pagelede">Open Premade Tools on your PC, choose Phones, then Add a phone, and scan the code with this phone.</p></div></div>`;
    return;
  }
  const keep = [...$app.querySelectorAll('.scroller')].map((n) => n.scrollTop);
  const c = ST?.config || {};
  $app.dataset.theme = c.theme || 'red';
  $app.style.setProperty('--c', c.custom || '#d9202d');
  const keepFocus = document.activeElement?.id;
  const tool = TOOLS[S.tool];
  const tabs = tool.tabs.map(([id, l, ic]) =>
    `<button type="button" class="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${l}</span></button>`).join('');
  const off = OFFLINE ? `<div class="offline">Can't reach your PC right now. ${NATIVE ? 'This phone keeps saving what you delete and sends it when you are home.' : 'This shows what was there last time.'}</div>` : '';
  const head = `<div class="topbar"><button type="button" class="menubtn" data-drawer aria-label="Tools" aria-expanded="${S.drawer}">${icon('menu')}</button>${crest}<span class="wordmark-app">${tool.name}</span></div>`;
  const views = { home: homeView, phones: phonesView, settings: settingsView, deleted: deletedView, dl: dlView, history: dlHistoryView, dlsettings: dlSettingsView, convert: cvView, cvhistory: cvHistoryView, cvsettings: cvSettingsView,
    pdf: pdfToolsView, pdfhistory: pdfHistoryView, pdfsettings: pdfSettingsView, transcribe: trToolsView, trhistory: trHistoryView, trsettings: trSettingsView,
    drop: dropToolsView, drophistory: dropHistoryView, dropsettings: dropSettingsView };
  const body = !ST ? '<div class="titlerow"><p class="pagelede">Loading…</p></div>' : (views[S.tab] || deletedView)(off);
  $app.innerHTML = `${head}${body}${tool.tabs.length > 1 ? `<nav class="tabbar" aria-label="Sections">${tabs}</nav>` : ''}${S.sheet ? sheetView() : ''}${S.ask ? askView() : ''}${S.dlAsk ? dlAskView() : ''}${S.drawer ? drawerView() : ''}${updView()}`;
  $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = keep[i] || 0; });
  if (keepFocus && document.getElementById(keepFocus)) document.getElementById(keepFocus).focus();
  lazyMedia($app);
}

function homeView(off) {
  const done = (jobs) => jobs.filter((j) => j.state === 'done').length;
  return `<div class="titlerow"><div class="titlerow-text"><h1 class="pagetitle">Your tools</h1><p class="pagelede">Pick a tool to open it.</p></div></div>
    <div class="feed scroller">${off}${homeCards('tool', [
      ['download', 'dl', 'Downloader', 'Save videos and photos from any link.', tally(done(dlJobs()), 'download saved', 'downloads saved')],
      ['convert', 'convert', 'Converter', 'Turn files into other formats on your PC.', tally(done(typeof cvJobs === 'function' ? cvJobs() : []), 'file converted', 'files converted')],
      ['pdf', 'pdf', 'PDF', 'Merge, split, reorder, compress and lock PDFs.', tally(done(pdfJobs()), 'PDF done', 'PDFs done')],
      ['transcribe', 'transcribe', 'Transcribe', 'Turn voice memos and videos into text.', tally(done(trJobs()), 'file transcribed', 'files transcribed')],
      ['drop', 'drop', 'File drop', 'Send files, links and text to your PC.', dropNew() ? `<b>${dropNew()}</b> new for this phone` : tally(dropJobs().length, 'drop this week', 'drops this week')],
      ['vault', 'shield', 'Vault', 'Get back what you deleted on your phones.', tally(live().length, 'deleted item', 'deleted items') + ' kept']])}</div>`;
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
    <div class="feed scroller" id="dl">${off}${iosNudge()}${listView()}</div>`;
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
  if (f === 'confirm') return `<div class="confirm"><p class="confirm-text">Delete this from the vault?</p><p class="confirm-sub">The copy on this PC is deleted. It can't be brought back.</p>
    <div class="confirm-row"><button type="button" class="btn" data-unconfirm="${it.id}">Keep it</button><button type="button" class="btn danger" data-dismiss="${it.id}">Dismiss</button></div></div>`;
  const target = me ? 'this phone' : p ? p.Name : '';
  return `<div class="actions-stack">${p ? `<button type="button" class="btn primary block" data-restore="${it.id}">Restore to ${esc(target)}</button>` : ''}
    <a class="btn block" href="${view(it.id, true)}" download="${esc(it.name)}">${icon('save')}${NATIVE ? 'Download' : 'Save to Files'}</a></div>
    <div class="msg bad" role="status">${esc(S.msg)}</div>
    <div class="actions-quiet"><button type="button" class="quiet" data-askdismiss="${it.id}">Dismiss</button></div>`;
}

// The pop-up that offers a new version. Updating puts it on the PC, which hands it to this phone.
function updView() {
  if (!ST?.update || OFFLINE || (S.updLater === ST.update && !S.updBusy)) return '';
  return `<div class="mpop"><div class="mpop-card" role="dialog" aria-modal="true" aria-label="Update ready">
    <img class="mpop-crest" src="/icon.svg" alt=""><h2 class="sheet-title">Update ready</h2>
    <p class="sheet-text">Premade Tools <b class="mono">${esc(ST.update)}</b> is out. You have <span class="mono">${esc(ST.version)}</span>.</p>
    <p class="sheet-note" role="status">${esc(S.updBusy || (NATIVE ? 'It updates your PC, then this app.' : 'It updates your PC, and this app with it.'))}</p>
    <div class="actions-stack"><button type="button" class="btn primary block" data-updnow ${S.updBusy ? 'disabled' : ''}>Update now</button><button type="button" class="btn block" data-updlater ${S.updBusy ? 'disabled' : ''}>Later</button></div></div></div>`;
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
    <div class="feed scroller">${off}${me ? (me.Kind === 'iphone' ? heroIphone(me, saved(me)) + iosGuide(me) : heroAndroid(me, local || me.Status || {}, saved(me), local)) : ''}
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
    <div class="hero-state">${ring}<h2 class="hero-headline">${neverBackedUp(p) ? 'Not backed up yet' : 'Backs up at home'}</h2><p class="hero-check">${neverBackedUp(p) ? 'Add the Shortcut below, then tap Back up now' : 'Last backup ' + whenShort(new Date(p.LastSeen))}</p><p class="hero-saved"><b>${saved.length}</b> ${saved.length === 1 ? 'item' : 'items'} saved</p></div>
    <dl class="kv pad"><div><dt>Runs when</dt><dd>It joins your home Wi-Fi, and when it starts charging</dd></div><div><dt>Covers</dt><dd>Photos and videos, screenshots, screen recordings, WhatsApp and Telegram media</dd></div></dl></section>`;
}

// iPhone: apps can't see Recently Deleted, so a Shortcut the user builds once sends the PC a copy of
// each photo and video, and the PC shows a file only after it's gone from the phone.
const SHORTCUT = 'Vault backup';
const neverBackedUp = (p) => new Date(p.LastSeen) - new Date(p.Paired) < 5000;
const runShortcut = 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT);

function iosNudge() {
  const me = phoneById(ST.me);
  if (!me || me.Kind !== 'iphone') return '';
  if (!navigator.standalone) return `<p class="mhint ios-nudge">${icon('info')}<span>Tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Vault from there.</span></p>`;
  if (neverBackedUp(me)) return `<p class="mhint ios-nudge">${icon('info')}<span>One more step: add the backup Shortcut. Open <b>Phones</b> and follow the steps.</span></p>`;
  return '';
}

function iosGuide(p) {
  const base = location.origin, t = encodeURIComponent(TOKEN);
  const field = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}"><button type="button" class="btn" data-copy>Copy</button></div>`;
  const steps = [
    `Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT}</b>.`,
    `Add <b>Find Photos</b> (leave it on All Photos).`,
    `Add <b>Get Details of Images</b> and pick <b>Name</b>.`,
    `Add <b>Combine Text</b> and set it to <b>New Lines</b>.`,
    `Add <b>Get Contents of URL</b> with the address below. Method <b>POST</b>, Request Body <b>File</b>, and pick <b>Combined Text</b>.${field('Backup', `${base}/api/phone/ios/backup?t=${t}`)}`,
    `Add <b>Set Variable</b>, name it <b>Need</b>, set to <b>Contents of URL</b>.`,
    `Add <b>Repeat with Each</b> and pick <b>Photos</b> from step 2. Inside it:`,
    `<b>Text</b>: type <b>|</b>, insert <b>Repeat Item</b> and tap it to choose <b>Name</b>, then type <b>|</b>.`,
    `<b>If</b> <b>Need</b> <b>contains</b> <b>Text</b>. Inside it, <b>Get Contents of URL</b> with the address below, Method <b>PUT</b>, Request Body <b>File</b> set to <b>Repeat Item</b>, and two headers: <b>X-Key</b> and <b>X-Name</b>, both <b>Repeat Item</b> › <b>Name</b>.${field('Upload', `${base}/api/phone/upload?t=${t}`)}`,
    `After <b>End Repeat</b>, for files you restore from the PC: <b>Get Contents of URL</b> with this address.${field('Restores', `${base}/api/phone/ios/restores?t=${t}`)}`,
    `Add <b>Split Text</b> by <b>New Lines</b>, then <b>Repeat with Each</b>. Inside it: <b>If Repeat Item is not none</b>, then a <b>Text</b> with the first address below with <b>Repeat Item</b> put where it says ID, <b>Get Contents of URL</b> of that Text, and <b>Save to Photo Album</b>. Then another <b>Text</b> with the second address, again with <b>Repeat Item</b> for ID, and <b>Get Contents of URL</b> of it with Method <b>POST</b>.${field('Restore file', `${base}/api/phone/file/ID?t=${t}`)}${field('Restored', `${base}/api/phone/restored/ID?t=${t}`)}`,
    `Tap <b>Back up now</b> below to run it once. Allow access to Photos and to devices on your network when asked. The first run sends every photo, so keep the screen on and the iPhone on Wi-Fi.`,
    `Make it run by itself: <b>Automation</b> tab › <b>+</b> › <b>Wi-Fi</b>, pick your home Wi-Fi, choose <b>Run Immediately</b> and pick <b>${SHORTCUT}</b>. Add a second one with <b>Charger</b> › <b>Is Connected</b>.`,
  ];
  return `<details class="iosguide" ${neverBackedUp(p) ? 'open' : ''}><summary>Set up the backup Shortcut</summary>
    <ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol></details>
    <a class="btn primary block" href="${runShortcut}">Back up now</a>`;
}

function otherPhone(p, n) {
  const ios = p.Kind === 'iphone', up = fresh(p);
  const state = ios ? ['is-idle', 'Backs up at home'] : up ? ['', 'Watching the bin'] : ['is-warn', 'Not seen lately'];
  return `<div class="phonecard"><span class="phonecard-glyph">${icon('phones')}</span><span class="phonecard-text"><b>${esc(p.Name)}</b><span class="phonecard-state ${state[0]}"><i class="dotlight"></i>${state[1]}</span></span>
    <span class="phonecard-right"><span>${ios ? whenShort(new Date(p.LastSeen)) : ago(p.LastSeen)}</span><span>${n} saved</span></span></div>`;
}

function drawerView() {
  const c = ST?.config || {};
  const tools = Object.entries(TOOLS).map(([id, t]) => `<button type="button" class="drawer-tool" data-tool="${id}" aria-current="${S.tool === id ? 'page' : 'false'}">${icon(t.icon)}<span>${t.name}</span></button>`).join('');
  return `<div class="drawer-back" data-closedrawer><nav class="drawer" aria-label="Tools">
    <div class="drawer-head">${crest}<span class="wordmark-app">Premade Tools</span></div>
    <p class="drawer-label">Tools</p>${tools}
    <div class="drawer-foot"><p class="drawer-label">Look</p><div class="themes">${THEMES.map(([id, l, bg, panel, ac]) => `<button type="button" class="mswatch" data-theme-pick="${id}" aria-pressed="${c.theme === id}"><span class="mswatch-preview" style="background:${bg}"><i style="background:${panel}"></i><u style="background:${ac}"></u>${c.theme === id ? `<em>${icon('check')}</em>` : ''}</span><span class="mswatch-name">${l}</span></button>`).join('')}</div>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>
  </nav></div>`;
}

function settingsView(off) {
  const c = ST.config;
  return `${titleRow('Settings')}<div class="headrule"></div>
    <div class="feed scroller">${off}
    <section class="group"><div class="sectionhead"><b>Vault</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Keep deleted files</h2><div class="chips">${KEEP.map(([id, l]) => `<button type="button" class="pill" data-keep="${id}" aria-pressed="${c.keep === id}">${c.keep === id ? icon('check') : ''}${l}</button>`).join('')}</div><p class="block-hint">Only files deleted longer ago than this are cleared.</p></div>
      <div class="block"><h2 class="block-title">Stored on your PC</h2><p class="vaultpath-m">${esc(c.vaultDir)}</p>${ST.free ? `<p class="capstat"><b>${esc(nice(ST.free))}</b> free</p>` : ''}<p class="block-hint">You can move it from Settings on the PC.</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST.version)}</span></div></div>`;
}

$app.addEventListener('click', async (e) => {
  if (e.target.dataset?.close !== undefined && e.target.classList.contains('msheet')) { closeSheet(); return; }
  if (e.target.dataset?.closeask !== undefined) { S.ask = null; render(); return; }
  if (e.target.dataset?.closedrawer !== undefined) { S.drawer = false; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy !== undefined) { // clipboard API needs https; a selected field + execCommand works over plain http
    const inp = b.previousElementSibling; inp.select(); inp.setSelectionRange(0, 9999);
    try { document.execCommand('copy'); b.textContent = 'Copied'; } catch (e2) { b.textContent = 'Select and copy'; }
    return;
  }
  const d = b.dataset;
  try {
    if (d.tab) { S.tab = d.tab; render(); }
    else if (d.drawer !== undefined) { S.drawer = !S.drawer; render(); }
    else if (d.tool) { S.tool = d.tool; S.tab = TOOLS[d.tool].tabs[0][0]; S.drawer = false; render(); }
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
    else if (d.updlater !== undefined) { S.updLater = ST.update; render(); }
    else if (d.updnow !== undefined) {
      S.updBusy = 'Updating your PC…'; render();
      const m = (await api('/api/phone/update', {})).msg;
      S.updBusy = /^Updating/.test(m) ? 'Updating your PC. This reloads in a moment.' : '';
      if (!S.updBusy) { S.updLater = ST.update; S.msg = m; }
      render();
    }
    else if (d.themePick) { await api('/api/phone/settings', { theme: d.themePick }); refresh(); }
  } catch (err) { S.updBusy = ''; S.msg = err.message; render(); }
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
try { if (localStorage.getItem('ptUpdated') && NATIVE?.update) NATIVE.update(); localStorage.removeItem('ptUpdated'); } catch (e) {}
let slow = 0;
setInterval(() => { // every 2 s while a download runs, else every 30 s
  if (document.hidden || S.sheet || S.ask || S.drawer || ['q', 'dlurl', 'pdfpw'].includes(document.activeElement?.id)) return;
  if (dlBusy() || (typeof cvBusy === 'function' && cvBusy()) || pdfBusy() || trBusy() || ++slow >= 15) { slow = 0; refresh(); }
}, 2000);
