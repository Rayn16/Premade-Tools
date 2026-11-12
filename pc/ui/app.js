// Vault's PC window. Plain JS: the server sends state, this draws it in Premade's look.
'use strict';

const S = { page: 'home', phone: 'all', type: 'all', q: '', sel: null, closed: false, msg: '', pair: null, pairBase: 0, step: 1, drive: null, drives: null, folder: '', basePhones: 0, updMsg: '', ask: null, updLater: '', updBusy: '', updErr: '', updAt: 0 };
if (location.hash === '#drop') S.page = 'drop'; // a clicked File drop notification opens the window here
const FLOW = {};    // file id → 'confirm', { wait: text } or { done: true, name, folder }
let ST = null;      // /api/ui/state
let ITEMS = [];     // /api/ui/deleted
let VER = '';       // the version this page was loaded with
let PAGED = '';     // the page drawn last, so only a new one fades in
let LAST = '';      // the last data drawn, so an unchanged poll doesn't redraw (and stop a playing video)
const $app = document.getElementById('app');
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const opt = { headers: { 'X-Vault': '1' } };
  if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}

async function refresh() {
  try {
    [ST, ITEMS] = await Promise.all([api('/api/ui/state'), api('/api/ui/deleted'), dlRefresh(), cvRefresh(), pdfRefresh(), trRefresh(), dropRefresh(), frRefresh()]);
    if (!S.drives || S.page === 'settings') S.drives = await api('/api/ui/drives');
  } catch (e) { return; }
  if (VER && VER !== ST.version) { location.reload(); return; } // the PC just updated itself
  VER = ST.version;
  if (S.updBusy && ST.updErr) { S.updBusy = ''; S.updErr = ST.updErr; } // the download or the swap failed: say why, offer it again
  if (!ST.config.setupDone && S.page !== 'setup') S.page = 'setup';
  const now = JSON.stringify([ST, ITEMS, S.drives, DL, CV, PDFST, TRST, DROPST, FRST]);
  if (now !== LAST || ['setup', 'phones', 'settings'].includes(S.page)) render(); // those show times like "5 minutes ago"
  LAST = now;
}

const phoneById = (id) => (ST.phones || []).find((p) => p.ID === id);
const phoneName = (id) => phoneById(id)?.Name || 'Removed phone';
// Where a tool's result is now, seen from this PC: here, on its way to the phone that asked for it, or with that phone.
function whereOf(j, got) {
  if (j.state === 'failed') return '';
  if (!j.from) return j.state === 'done' ? icon('pc') + 'On this PC' : '';
  const p = esc(phoneName(j.from));
  return icon('phones') + (j.state !== 'done' ? `Goes to ${p} when it's done` : j.fetched ? got || `Sent back to ${p}` : `Waiting for ${p} to pick it up`);
}
const fileUrl = (id) => `/api/ui/file/${id}`;
const vaultDrive = () => (S.drives || []).find((d) => d.Root.slice(0, 2).toLowerCase() === (ST.config.vaultDir || '').slice(0, 2).toLowerCase());
const usedPct = (d) => { const t = toBytes(d.Total); return t ? Math.min(100, Math.max(0, (1 - d.FreeB / t) * 100)) : 0; };
const fresh = (p) => Date.now() - new Date(p.LastSeen) < 2 * 3600e3;

// ---------- frame ----------
const NAV = [['home', 'Home', 'home'], ['download', 'Download', 'dl'], ['convert', 'Convert', 'convert'], ['pdf', 'PDF', 'pdf'], ['transcribe', 'Transcribe', 'transcribe'],
  ['drop', 'File drop', 'drop'], ['deleted', 'Vault', 'shield'], ['friends', 'Friends', 'friends']];
const head = (title, extra = '') => `<div class="head"><h1>${title}</h1>${extra}</div>`;

function render() {
  if (!ST) return;
  const c = ST.config;
  const keep = [...$app.querySelectorAll('.scroller')].map((n) => n.scrollTop);
  const act = document.activeElement, focusId = act?.id, caret = [act?.selectionStart, act?.selectionEnd];
  paintTheme($app, c);
  setSize(c.size || 100);
  let html = setupView;
  if (S.page !== 'setup') {
    const count = { download: running(DL?.jobs || []), convert: running(CV?.jobs || []), pdf: running(pdfJobs()), transcribe: running(trJobs()),
      drop: S.page !== 'drop' && dropNew() ? dropNew() + ' new' : '', friends: frMe()?.waiting?.length ? frMe().waiting.length + ' asking' : '' };
    const on = S.page === 'phones' ? 'deleted' : S.page;
    const item = ([id, l, ic]) => `<button type="button" class="navitem" data-go="${id}" ${on === id ? 'aria-current="page"' : ''}>${icon(ic)}${l}${count[id] ? `<span class="navitem-count">${count[id]}</span>` : ''}</button>`;
    const view = { home: homeView, download: downloadView, convert: convertView, pdf: pdfView, transcribe: trView, drop: dropView, friends: frView, phones: phonesView, settings: settingsView }[S.page] || deletedView;
    html = () => `<div class="shell">
      <nav class="side" aria-label="Tools"><div class="brand">${MARK}Premade Tools</div>
        <div class="nav">${NAV.map(item).join('')}</div>${devices()}
        <div class="nav end">${item(['settings', 'Settings', 'settings'])}</div></nav>
      ${view()}
    </div>${S.pair && S.page === 'phones' ? pairSheet() : ''}${frSheet()}${updSheet()}`;
  }
  redraw($app, html());
  if (S.page !== PAGED) { if (PAGED) pageIn($app.querySelector('.shell>.side+*')); PAGED = S.page; } // a new page fades in
  $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = keep[i] || 0; });
  const f = focusId && document.getElementById(focusId);
  if (f && f !== document.activeElement) { f.focus(); try { f.setSelectionRange(caret[0], caret[1]); } catch (e) {} }
  lazyMedia($app);
}

function setSize(pct) {
  document.documentElement.style.zoom = pct / 100;
  $app.style.setProperty('--z', pct / 100);
}

// The bottom of the sidebar: this PC, each phone and how it's doing, and any warning.
function devices() {
  const pc = `<div class="dev">${icon('pc')}<div><b>This PC</b><span>${ST.moving ? 'Moving the vault…' : ST.free ? esc(nice(ST.free)) + ' free' : ''}</span></div></div>`;
  const phones = ST.phones.map((p) => {
    const ios = p.Kind === 'iphone', on = !ios && fresh(p) && p.Status?.watching !== false;
    return `<div class="dev">${icon('phones')}<div><b>${esc(p.Name)}</b><span><i class="dot ${on ? 'on' : ios ? '' : 'warn'}"></i>${ios ? 'Backed up ' + ago(p.LastSeen) : on ? 'Watching the bin' : 'Last seen ' + ago(p.LastSeen)}</span></div></div>`;
  }).join('');
  const warn = (ST.warnings || []).map((w) => `<div class="dev is-warn">${icon('alert')}<div><span>${esc(w)}</span></div></div>`).join('');
  return `<div class="devs">${pc}${phones}${warn}</div>`;
}

// ---------- Home: the latest from every tool ----------
const noPv = (it) => /\.(heic|heif|dng)$/i.test(it.name);
const vaultFields = (it) => ({ th: thumb(it.kind, (it.kind === 'photo' && !noPv(it)) || it.kind === 'video' ? fileUrl(it.id) : ''), title: esc(it.name),
  meta: `${kindLabel(it)} deleted on ${esc(phoneName(it.phone))}, ${size(it.size)}`, where: icon('pc') + 'Kept in the vault on this PC', when: stamp(new Date(it.deletedAt)) });

function homeView() {
  const all = [...(DL?.jobs || []).map((j) => [j, dlFields(j), 'data-go="download"']), ...(CV?.jobs || []).map((j) => [j, cvFields(j), 'data-go="convert"']),
    ...pdfJobs().map((j) => [j, pdfFields(j), 'data-go="pdf"']), ...trJobs().map((j) => [j, trFields(j), 'data-go="transcribe"']),
    ...dropJobs().map((j) => [j, dropFields(j), 'data-go="drop"']), ...liveItems(ITEMS).map((it) => [{ at: it.deletedAt }, vaultFields(it), `data-go="deleted" data-pick="${it.id}"`])]
    .sort(([a], [b]) => newest(a, b)).slice(0, 40);
  return `<section class="main">${head('Home')}<div class="body scroller"><div class="col">
    ${all.length ? byDay(all, ([j]) => j.at, ([, f, go]) => rowOf({ ...f, go })) : `<div class="empty">${icon('home')}<h2>Nothing here yet</h2><p>What you download, convert or send, and what you delete on your phones, shows up here.</p></div>`}
  </div></div></section>`;
}

// ---------- Vault: Deleted ----------
function shownItems() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => !it.dismissed && (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) &&
    (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}
const items = () => shownItems().filter((it) => !it.missed);
const vaultHead = (tab) => head('Vault', `<nav class="tabs" aria-label="Vault">${[['deleted', 'Deleted'], ['phones', 'Phones']].map(([id, l]) => `<button type="button" data-go="${id}" ${tab === id ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav><span class="grow"></span>
  ${tab === 'deleted' ? `<label class="search">${icon('search')}<span class="sr">Search deleted files</span><input type="search" id="q" value="${esc(S.q)}" placeholder="Search"></label>` : `<button type="button" class="btn primary" data-pair>${icon('plus')}Add a phone</button>`}`);

function deletedView() {
  const body = deletedBody(), it = items().find((i) => i.id === S.sel); // the body picks the first file when none is
  return `<div class="vault" data-panel="${it ? 'open' : 'closed'}"><section class="main">${vaultHead('deleted')}<div class="body scroller" id="dl">${body}</div></section>
    <aside class="insp" id="insp" aria-label="Selected file">${it ? inspector(it) : ''}</aside></div>`;
}

function deletedBody() {
  const all = shownItems(), list = all.filter((i) => !i.missed), live = liveItems(ITEMS);
  if (!list.find((i) => i.id === S.sel)) S.sel = S.closed ? null : list[0]?.id || null;
  const pick = (key, label, opts) => `<label class="sel"><select data-filter="${key}" aria-label="${label}">${opts.map(([id, l]) => `<option value="${esc(id)}" ${S[key] === id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${icon('down')}</label>`;
  const filters = `<div class="filters">${ST.phones.length > 1 ? pick('phone', 'Phone', [['all', 'All phones'], ...ST.phones.map((p) => [p.ID, p.Name])]) : ''}
    ${pick('type', 'Type', [['all', 'All types'], ['photo', 'Photos'], ['video', 'Videos'], ['voice', 'Voice'], ['file', 'Files']])}<span class="grow"></span>
    <span class="count">${plural(list.length, 'file')}, ${size(list.reduce((n, i) => n + (i.size || 0), 0))}</span></div>`;
  const notes = all.filter((i) => i.missed).map((it) => `<p class="note">${icon('alert')}<span>${esc(it.name)} couldn't be saved. ${esc(it.note || 'It was deleted from ' + phoneName(it.phone) + ' without using the Recycle bin.')}</span><button type="button" class="btn text" data-dismiss="${it.id}">Dismiss</button></p>`).join('');
  if (!live.length) return notes + `<div class="empty">${icon('deleted')}<h2>Nothing deleted yet</h2><p>From now on, anything you delete on your phones shows up here, newest first.</p></div>`;
  return filters + notes + (list.length ? byDay(list, (i) => i.deletedAt, cardView, 'grid') : `<div class="empty">${icon('search')}<h2>Nothing matches that</h2><p>Try another name, or clear the filters.</p></div>`);
}

function cardView(it) {
  const keep = ST.config.keep;
  return `<button type="button" class="card" data-sel="${it.id}" aria-pressed="${S.sel === it.id}">
    <span class="media">${tile(it, fileUrl(it.id), noPv(it))}${FLOW[it.id]?.done ? `<span class="restoredmark">${icon('check')}</span>` : ''}</span>
    <span class="t">${esc(it.name)}</span><span class="m">${esc(phoneName(it.phone))} · ${it.byTime ? 'by ' : ''}${stamp(new Date(it.deletedAt))}</span>${keptClass(it, keep) ? `<span class="m warn">${keptLabel(it, keep)}</span>` : ''}</button>`;
}

function inspector(it) {
  const src = fileUrl(it.id), keep = ST.config.keep;
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}#t=0.1" controls preload="metadata"></video>`
    : it.kind === 'voice' ? `${wave(it.id, 44)}<audio src="${src}" controls preload="none"></audio>` : `${doc()}<span class="tag">${esc(ext(it.name) || 'FILE')}</span>`;
  return `<div class="insp-top"><button type="button" class="iconbtn" data-closeinsp aria-label="Close">${icon('x')}</button></div>
    <div class="insp-body scroller"><div class="preview">${pv}</div><h2 class="detail-name">${esc(it.name)}</h2>
      <dl class="facts"><dt>Deleted</dt><dd>${it.byTime ? 'By ' : ''}${whenShort(new Date(it.deletedAt))}</dd><dt>From</dt><dd>${esc(phoneName(it.phone))}</dd>
        <dt>Was in</dt><dd class="mono">${esc(it.folder)}</dd><dt>Size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd>
        <dt>Kept</dt><dd class="${keptClass(it, keep) ? 'warn' : ''}">${keptLabel(it, keep)}</dd></dl></div>
    <div class="insp-acts">${actions(it)}</div>`;
}

function actions(it) {
  const f = FLOW[it.id], p = phoneById(it.phone);
  if (f?.done) return `<div class="done"><span class="donemark" data-in="done:${it.id}">${icon('check')}</span><span class="done-text">Restored. It's back in ${esc(f.folder)}.<em>On ${esc(f.name)}</em></span></div><button type="button" class="quiet" data-flowclear="${it.id}">Done</button>`;
  if (f?.wait || p?.Pending?.includes(it.id)) return `<div class="restoring"><div class="restoring-row">${icon('spin', 'spin')}Restoring…</div><div class="progline"><span></span></div>${f?.wait ? `<p>${esc(f.wait)}</p>` : ''}</div>
    <button type="button" class="quiet" data-unrestore="${it.id}">Cancel</button>`;
  if (f === 'confirm') return `<div class="confirm"><p class="confirm-text">Delete this from the vault?</p><p class="confirm-sub">The copy on this PC is deleted. It can't be brought back.</p>
    <div class="confirm-row"><button type="button" class="btn" data-flowclear="${it.id}">Keep it</button><button type="button" class="btn danger" data-dismiss="${it.id}">Delete</button></div></div>`;
  return `${p ? `<button type="button" class="btn primary block" data-restore="${it.id}">Restore to ${esc(p.Name)}</button>` : ''}
    <button type="button" class="btn block" data-save="${it.id}">Save to PC</button>
    <div class="msg" role="status">${esc(S.msg)}</div>
    <button type="button" class="quiet" data-askdismiss="${it.id}">Delete from vault</button>`;
}

function paintInspector() {
  const it = items().find((i) => i.id === S.sel);
  const page = $app.querySelector('.vault[data-panel]');
  if (!page) return;
  page.dataset.panel = it ? 'open' : 'closed';
  $('insp').innerHTML = it ? inspector(it) : '';
  moved($('insp'));
}

// ---------- Vault: Phones ----------
function phonesView() {
  const live = liveItems(ITEMS);
  const list = ST.phones.map((p) => {
    const st = p.Status || {}, ios = p.Kind === 'iphone', up = fresh(p), n = live.filter((i) => i.phone === p.ID).length;
    const checks = ios ? [[true, 'Backs up when it joins your home Wi-Fi, and when it starts charging'], [true, 'Covers photos and videos, screenshots, screen recordings, WhatsApp and Telegram media. Not voice memos.']]
      : [[st.binOn !== false, "Gallery's Recycle bin is on", "Gallery's Recycle bin looks off"], [st.allFiles, 'All files access allowed', 'All files access is off'], [st.battery, 'Battery set to Unrestricted', 'Battery is not Unrestricted']];
    const state = ios ? 'Last backup ' + whenShort(new Date(p.LastSeen)) : (up ? 'Watching the bin, checked ' : 'Not seen since ') + ago(p.LastSeen);
    return `<section class="phone">${icon('phones')}<div><h2>${esc(p.Name)}</h2><p class="state"><i class="dot ${ios ? '' : up ? 'on' : 'warn'}"></i>${state}${p.Restores ? `. ${plural(p.Restores, 'file')} waiting to restore` : ''}</p></div>
      <p class="n"><b>${n}</b>kept</p>
      <ul>${checks.map(([ok, yes, no]) => `<li class="${ok ? '' : 'is-bad'}">${icon(ios ? 'info' : ok ? 'check' : 'alert')}${ok ? yes : no + '. Open Premade on the phone and tap Fix.'}</li>`).join('')}</ul>
      <div class="foot">${S.ask?.forget === p.ID ? `<span class="grow">Forget ${esc(p.Name)}? It stops sending deleted files. Files already saved stay in the vault.</span><button type="button" class="btn small" data-askclear>Keep it</button><button type="button" class="btn small danger" data-forget="${p.ID}">Forget</button>`
        : `<button type="button" class="quiet" data-askforget="${p.ID}">Forget this phone</button>`}</div></section>`;
  }).join('');
  return `<section class="main">${vaultHead('phones')}<div class="body scroller"><div class="col">
    ${list || `<div class="empty">${icon('phones')}<h2>No phones yet</h2><p>Add a phone and it starts sending what you delete to this PC.</p></div>`}
    <p class="hint">${icon('info')}Files an app deletes without the bin can't be saved. A note shows on Deleted when that happens.</p></div></div></section>`;
}

function pairSheet() {
  const got = ST.phones.length > S.pairBase ? ST.phones.at(-1) : null;
  return `<div class="backdrop" data-closepair><section class="sheet" role="dialog" aria-modal="true" aria-label="Add a phone">
    <div class="sheet-head"><div><h2 class="sheet-title">Add a phone</h2><p class="sheet-sub">Scan the code with the phone's camera.</p></div><button type="button" class="iconbtn" data-closepair aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body"><div class="qr"><img src="${S.pair.qr}" alt="QR code to pair a phone"></div>
      <div class="osteps"><div><b>Android</b><p>Install Premade Tools from the page it opens, then allow All files access.</p></div>
      <div><b>iPhone</b><p>In Safari, tap Share, then Add to Home Screen, then add the Vault shortcut.</p></div></div></div>
    <div class="waitrow">${got ? `<span class="good">${icon('check')}</span><span>${esc(got.Name)} connected.</span>` : `<i class="pulse"></i><span>Waiting for a phone… <span>It must be on the same Wi-Fi as this PC.</span></span>`}</div>
    <div class="sheet-foot">${esc(S.pair.url)}</div></section></div>`;
}

// The pop-up that offers a new version. "Later" hides it until the window opens again.
function updSheet() {
  if (!ST.update || (S.updLater === ST.update && !S.updBusy)) return '';
  const busy = S.updBusy, note = busy || S.updErr;
  return `<div class="backdrop"><section class="sheet upd" role="dialog" aria-modal="true" aria-label="Update ready">
    <div class="upd-body">${MARK}<h2 class="sheet-title">Update ready</h2>
      <p class="upd-text">Premade Tools <b>${esc(ST.update)}</b> is out. You have ${esc(ST.version)}.</p>
      ${note ? `<p class="upd-text" role="status">${esc(note)}</p>` : ''}</div>
    <div class="upd-foot"><button type="button" class="btn" data-updlater ${busy ? 'disabled' : ''}>Later</button><button type="button" class="btn primary" data-updnow ${busy ? 'disabled' : ''}>Update now</button></div></section></div>`;
}

// ---------- Settings ----------
// Away from home: phones do the work themselves, and with Tailscale they still reach this PC for its tools.
function awaySettings() {
  const st = ST.tailscale || 'off', ok = st === 'ok';
  const step = (done, title, hint) => `<div class="srow"><span class="grow">${title}<span class="h">${hint}</span></span>${done === null ? '' : done ? '<span class="ok">Done</span>' : ''}</div>`;
  return `<section class="sec"><h2>Away from home</h2>
    <div class="srow"><span class="grow">${ok ? 'Through Tailscale' : 'Through the Friends relay'}<span class="h">${ok ? `Phones reach this PC at <span class="mono">${esc(ST.remote)}</span>, and use its tools as if they were home.` : 'Phones reach this PC through the Friends relay, at home and away, with nothing to set up. Sending files over 100 MB from a phone needs Tailscale (free). These steps tick off by themselves within two minutes.'}</span></span></div>
    ${step(st !== 'off', '1. Tailscale on this PC', 'Install <a href="https://tailscale.com/download/windows" target="_blank" rel="noopener">Tailscale</a> and sign in.')}
    ${step(ok, '2. HTTPS turned on', 'In the <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noopener">Tailscale admin page</a>, under DNS, turn on MagicDNS and HTTPS Certificates.')}
    ${step(null, '3. Tailscale on each phone', 'Install it from the App Store or Play Store, sign in with the same account, and leave it on.')}</section>`;
}

function settingsView() {
  const c = ST.config, d = vaultDrive(), ask = S.ask?.keep;
  const sw = (k, label, hint) => `<label class="srow"><span class="grow">${label}${hint ? `<span class="h">${hint}</span>` : ''}</span><input type="checkbox" class="switch" role="switch" data-set="${k}" ${c[k] ? 'checked' : ''}></label>`;
  const healthBad = (ST.warnings || []).some((w) => /health/i.test(w));
  return `<section class="main">${head('Settings')}<div class="body scroller"><div class="set">
    <section class="sec"><h2>Look</h2>${themePicker(c.theme, c.custom || '#d9202d')}
      ${c.theme === 'custom' ? `<label class="srow"><span class="grow">Your color</span><input type="color" class="colorpick" id="custom" value="${esc(c.custom || '#d9202d')}"></label>` : ''}
      ${motionRow('Follow Windows')}
      <label class="srow"><span class="grow">App size</span><input class="slider" type="range" min="80" max="140" step="10" value="${c.size}" id="size"><span class="pct" id="sizeval">${c.size}%</span></label></section>
    <section class="sec"><h2>Where files go</h2>
      ${DL ? `<div class="srow"><span class="grow">Save folder<span class="h mono">${esc(DL.dir)}</span><span class="h">Every tool saves here. What a phone sends goes back to it, and a copy stays here.</span></span><button type="button" class="btn" data-dl="folder">Change</button></div>` : ''}
      <div class="srow"><span class="grow">Vault folder<span class="h"><span class="mono">${esc(c.vaultDir)}</span>${d ? `, ${esc(nice(d.Free))} free` : ''}${ST.moving ? '. Moving it now.' : ''}</span></span><button type="button" class="btn" data-move ${ST.moving ? 'disabled' : ''}>Move</button></div>
      <div class="srow"><span class="grow">Keep deleted files<span class="h">Only files deleted longer ago than this are cleared.</span></span><label class="sel"><select id="keep" aria-label="Keep deleted files">${KEEP.map(([id, l]) => `<option value="${id}" ${(ask?.id || c.keep) === id ? 'selected' : ''}>${l}</option>`).join('')}</select>${icon('down')}</label></div>
      ${ask ? `<div class="srow sub"><span class="grow">This clears ${plural(ask.count, 'file')} (${esc(ask.size)}) deleted more than ${esc(ask.label)} ago. They can't be brought back.</span><button type="button" class="btn" data-askclear>Keep them</button><button type="button" class="btn danger" data-keepyes="${ask.id}">Clear them</button></div>` : ''}
    </section>
    ${dlSettings()}${cvSettings()}${pdfSettings()}${trSettings()}${dropSettings()}${awaySettings()}
    <section class="sec"><h2>Warnings</h2>${sw('warnPhone', "When a phone hasn't checked in for 3 days")}${sw('warnHealth', "When the vault drive's health drops", c.warnHealth && healthBad ? 'The vault drive needs a look.' : '')}${sw('warnSpace', 'When the vault drive runs low on space')}</section>
    <section class="sec"><h2>Premade Tools ${esc(ST.version)}</h2>
      <div class="srow"><span class="grow">${ST.update ? `Version ${esc(ST.update)} is out` : 'Updates'}<span class="h" role="status">${esc(S.updMsg || 'Your phones update with it.')}</span></span><button type="button" class="btn" data-update>Check now</button></div>
      ${sw('startWin', 'Start with Windows')}
      <div class="srow"><span class="grow">Setup<span class="h">Pick the vault's drive and add phones, step by step.</span></span><button type="button" class="btn" data-rerun>Show setup again</button></div>
    </section></div></div></section>`;
}

// ---------- Setup ----------
const STEPS = ['Where your vault lives', 'Your Android phone', 'Your iPhone', "You're set"];
function setupView() {
  const n = S.step;
  const marks = STEPS.map((l, i) => {
    const state = i + 1 < n ? 'done' : i + 1 === n ? 'current' : 'next';
    return `<div class="steprow" data-state="${state}"><span class="stepmark">${state === 'done' ? icon('check') : i + 1}</span><span class="steptext"><span class="steplabel">${l}</span></span></div>`;
  }).join('');
  let title, lede = '', body, note;
  const kind = n === 2 ? 'android' : 'iphone', ofKind = ST.phones.filter((p) => p.Kind === kind);
  const got = (n === 2 || n === 3) && ofKind.length > (S.basePhones || 0);
  if (n === 1) {
    title = 'Where should your vault live?';
    lede = 'This is where everything you delete on your phones is kept. Pick the drive with the most room.';
    note = 'You can move the vault later in Settings.';
    body = `<p class="grouplabel">Drive</p>
      <div class="drives" role="radiogroup" aria-label="Drive">${(S.drives || []).map((d) => {
        const used = usedPct(d), tight = used > 80;
        return `<button type="button" class="drive" role="radio" data-drive="${esc(d.Root)}" aria-checked="${S.drive === d.Root}"><span class="radio"></span><span>
          <span class="drive-top"><span class="drive-name">${esc(d.Root.slice(0, 2))} ${esc(d.Label || 'Local disk')}</span>${d.System ? '<span class="drivetag">Windows drive</span>' : ''}<span class="drive-size">${esc(nice(d.Total))}</span></span>
          <span class="capacity"><i class="${tight ? 'is-tight' : ''}" style="width:${used.toFixed(1)}%"></i></span>
          <span class="drive-free ${tight ? 'is-tight' : ''}">${esc(nice(d.Free))} free</span></span></button>`;
      }).join('')}</div>
      <p class="grouplabel">Vault folder</p>
      <div class="folderrow"><label class="folderfield">${icon('folder')}<input id="folder" value="${esc(S.folder)}" aria-label="Vault folder"></label><button type="button" class="btn" data-pickfolder>Change</button></div>
      <p class="callout">${icon('shield')}<span>The vault holds the only copy of what you delete, so Premade keeps an eye on this drive's health and warns you early if it starts to fail.</span></p>
      <div class="msg bad" role="status">${esc(S.msg)}</div>`;
  } else if (n === 2 || n === 3) {
    title = `Connect your ${n === 2 ? 'Android phone' : 'iPhone'}`;
    note = 'You can add this phone later from Vault › Phones.';
    const steps = n === 2 ? `<li><span>Open the camera on the phone and <b>scan this code</b>.</span></li><li><span>Install <b>Premade Tools</b> from the page it opens.</span></li><li><span>Allow <b>All files access</b>, and set the battery to <b>Unrestricted</b> when the app asks.</span></li><li><span>Keep Gallery's <b>Recycle bin</b> on <span class="path">(Gallery › Menu › Settings › Recycle bin)</span>.</span></li>`
      : `<li><span><b>Scan this code</b> with the iPhone's camera. Premade opens in Safari.</span></li><li><span>Tap Share, then <b>Add to Home Screen</b>.</span></li><li><span>Open Premade from your home screen and tap <b>Add the shortcut</b>. It then walks you through its two automations: joining home Wi-Fi and starting to charge.</span></li><li><span>In WhatsApp and Telegram, turn on <b>Save to Photos</b>.</span></li>`;
    body = `<div class="pairgrid"><div class="qrwrap"><div class="qr">${S.pair ? `<img src="${S.pair.qr}" alt="QR code to pair">` : ''}</div><span class="qrnote">Pairing code for this PC</span></div><ol class="howto">${steps}</ol></div>
      ${got ? `<div class="waiting is-on"><span class="checkmark">${icon('check')}</span><span class="waiting-text"><span class="waiting-title">${esc(ofKind.at(-1).Name)} connected.</span><span class="waiting-sub">${n === 2 ? "It's watching the Recycle bin." : 'It backs up when it joins your home Wi-Fi or starts charging.'}</span></span></div>`
        : `<div class="waiting"><i class="pulse"></i><span class="waiting-text"><span class="waiting-title">Waiting for your ${n === 2 ? 'phone' : 'iPhone'}…</span><span class="waiting-sub">It must be on the same Wi-Fi as this PC.</span></span></div>`}`;
  } else {
    title = "You're set";
    note = 'You can change any of this later in Settings.';
    const d = vaultDrive();
    body = `<p class="done-copy">From now on, anything you delete on your phones shows up in <b>Vault</b>, newest first, and stays here after the phone's own bin empties.</p>
      <div class="summary">
        <div class="summary-row"><span>Vault</span><span class="summary-val"><span class="mono">${esc(ST.config.vaultDir)}</span>${d ? `<small>Drive ${esc(d.Root.slice(0, 1))}, ${esc(d.Label || 'Local disk')}, ${esc(nice(d.Free))} free of ${esc(nice(d.Total))}</small>` : ''}</span></div>
        <div class="summary-row"><span>Phones</span><span class="summary-val">${ST.phones.length ? ST.phones.map((p) => `<span class="phoneline"><i class="dot on"></i>${esc(p.Name)}</span>`).join('') : '<span class="phoneline is-idle">No phones yet. <em>Add one from Vault › Phones.</em></span>'}</span></div>
      </div>`;
  }
  const primary = n === 1 || n === 4 || got;
  const next = n === 4 ? 'Open Premade Tools' : primary ? 'Next' : "Skip, I don't have one";
  return `<div class="setup">
    <aside class="brandpanel"><div class="brand-head">${MARK}<h1 class="brand-title">Premade Tools</h1><p class="brand-lede">Set up the vault, the safety net for what you delete on your phones. Four short steps.</p></div>
      <div class="steps">${marks}</div><p class="brand-foot">Premade Tools ${esc(ST.version)}</p></aside>
    <main class="stage"><div class="stagehead"><p class="stagekicker">Step ${n} of 4</p><h1 class="stagetitle">${esc(title)}</h1>${lede ? `<p class="stagelede">${lede}</p>` : ''}</div>
      <div class="stagebody scroller">${body}</div>
      <div class="stagefoot"><button type="button" class="btn" data-back ${n === 1 ? 'disabled' : ''}>Back</button><span>${note}</span><button type="button" class="btn ${primary ? 'primary' : ''}" data-next>${next}</button></div></main>
  </div>`;
}

async function enterStep(n) {
  S.step = n; S.msg = '';
  if (n === 1) {
    S.drives = await api('/api/ui/drives');
    const best = [...S.drives].sort((a, b) => (a.System - b.System) || (b.FreeB - a.FreeB))[0];
    if (best && !S.drive) { S.drive = vaultDrive()?.Root || best.Root; S.folder = ST.config.vaultDir || best.Root + 'Premade Vault'; }
  }
  if (n === 2 || n === 3) {
    S.basePhones = ST.phones.filter((p) => p.Kind === (n === 2 ? 'android' : 'iphone')).length;
    S.pair = await api('/api/ui/pair');
  }
  render();
}

// ---------- events ----------
$app.addEventListener('click', async (e) => {
  if (e.target.classList?.contains('backdrop')) { S.pair = null; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.go) { S.page = d.go; S.msg = ''; S.ask = null; if (d.pick) { S.sel = d.pick; S.closed = false; } if (d.go !== 'phones') S.pair = null; render(); if (d.go === 'settings') refresh(); }
    else if (d.sel) {
      S.sel = d.sel; S.closed = false; S.msg = '';
      $app.querySelectorAll('.card[aria-pressed="true"]').forEach((n) => n.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      paintInspector();
    }
    else if (d.closeinsp !== undefined) { S.closed = true; S.sel = null; S.msg = ''; render(); }
    else if (d.askdismiss) { FLOW[d.askdismiss] = 'confirm'; paintInspector(); }
    else if (d.flowclear) { delete FLOW[d.flowclear]; render(); }
    else if (d.dismiss) { await api('/api/ui/dismiss/' + d.dismiss, {}); delete FLOW[d.dismiss]; refresh(); }
    else if (d.save) { const r = await api('/api/ui/save/' + d.save, {}); S.msg = 'Saved to ' + r.path; paintInspector(); }
    else if (d.restore) {
      await api('/api/ui/restore/' + d.restore, {});
      const it = ITEMS.find((i) => i.id === d.restore), p = phoneById(it.phone);
      FLOW[it.id] = { wait: p.Kind === 'iphone' ? 'Queued. It goes back into Photos the next time the iPhone backs up.' : `Waiting for the ${p.Name} to pick it up (within 15 minutes, sooner when the phone is in use). It goes back into ${it.folder}.` };
      S.msg = ''; paintInspector();
      refresh();
      watchRestore(it);
    }
    else if (d.unrestore) { await api('/api/ui/unrestore/' + d.unrestore, {}); FLOW[d.unrestore] = { cancelled: true }; refresh(); }
    else if (d.pair !== undefined) { S.pair = await api('/api/ui/pair'); S.pairBase = ST.phones.length; render(); soon(); }
    else if (d.closepair !== undefined) { S.pair = null; render(); }
    else if (d.askforget) { S.ask = { forget: d.askforget }; render(); }
    else if (d.askclear !== undefined) { S.ask = null; render(); }
    else if (d.forget) { await api('/api/ui/forget/' + d.forget, {}); S.ask = null; refresh(); }
    else if (d.keepyes) { await api('/api/ui/settings', { keep: d.keepyes }); S.ask = null; refresh(); }
    else if (d.move !== undefined) {
      const r = await api('/api/ui/pickfolder', {});
      if (r.dir && confirm(`Move the vault to ${r.dir}? It copies in the background, then removes the old copy.`)) { await api('/api/ui/vault', { dir: r.dir }); refresh(); }
    }
    else if (d.updlater !== undefined) { S.updLater = ST.update; render(); }
    else if (d.updnow !== undefined) {
      S.updBusy = 'Downloading the update…'; S.updErr = ''; S.updAt = Date.now(); render();
      const m = (await api('/api/ui/update', {})).msg;
      S.updBusy = /^Updating/.test(m) ? m : ''; S.updMsg = m;
      if (/^Update failed/.test(m)) S.updErr = m; // stays open so Update now can be tapped again
      else if (!S.updBusy) S.updLater = ST.update; // already new
      render(); soon();
    }
    else if (d.update !== undefined) { S.updMsg = 'Checking…'; render(); S.updMsg = (await api('/api/ui/update', {})).msg; render(); }
    else if (d.rerun !== undefined) { S.page = 'setup'; enterStep(1); }
    else if (d.drive) { S.drive = d.drive; S.folder = d.drive + 'Premade Vault'; render(); }
    else if (d.pickfolder !== undefined) { const r = await api('/api/ui/pickfolder', {}); if (r.dir) { S.folder = r.dir; render(); } }
    else if (d.back !== undefined) enterStep(S.step - 1);
    else if (d.next !== undefined) {
      if (S.step === 1) {
        const dir = ($('folder')?.value || S.folder).trim();
        if (dir !== ST.config.vaultDir) await api('/api/ui/vault', { dir });
        await refresh();
        enterStep(2);
      } else if (S.step < 4) enterStep(S.step + 1);
      else { await api('/api/ui/settings', { setupDone: true }); S.page = 'home'; S.pair = null; refresh(); }
    }
  } catch (err) { S.updBusy = ''; S.msg = err.message; S.updMsg = S.page === 'settings' ? err.message : S.updMsg; render(); }
});

// Shows "Restored" once the phone has put the file back (it leaves that phone's waiting list).
function watchRestore(it) {
  const t0 = Date.now();
  const t = setInterval(async () => {
    if (FLOW[it.id]?.cancelled) { clearInterval(t); delete FLOW[it.id]; return; }
    await refresh();
    const p = phoneById(it.phone);
    if (p && (p.Pending || []).includes(it.id) && Date.now() - t0 < 60 * 60e3) return;
    clearInterval(t);
    if (p && !(p.Pending || []).includes(it.id)) FLOW[it.id] = { done: true, name: p.Name, folder: it.folder };
    else delete FLOW[it.id];
    render();
  }, 5000);
}
$app.addEventListener('input', async (e) => {
  const t = e.target;
  if (t.id === 'q') { S.q = t.value; $('dl').innerHTML = deletedBody(); paintInspector(); lazyMedia($app); }
  else if (t.id === 'folder') S.folder = t.value;
  else if (t.id === 'size') { setSize(+t.value); $('sizeval').textContent = t.value + '%'; }
});
$app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.set) { await api('/api/ui/settings', { [t.dataset.set]: t.checked }); refresh(); }
  else if (t.dataset.filter) { S[t.dataset.filter] = t.value; render(); }
  else if (t.name === 'theme') { await api('/api/ui/settings', { theme: t.value }); refresh(); }
  else if (t.id === 'keep') { // a shorter time first shows what would be cleared
    S.ask = null;
    if (KEEPDAYS[t.value] < KEEPDAYS[ST.config.keep]) {
      const p = await api('/api/ui/keep-preview?keep=' + t.value);
      if (p.count) { S.ask = { keep: { id: t.value, count: p.count, size: p.size, label: KEEP.find(([id]) => id === t.value)[1].toLowerCase() } }; render(); return; }
    }
    await api('/api/ui/settings', { keep: t.value }); refresh();
  }
  else if (t.id === 'size') { await api('/api/ui/settings', { size: +t.value }); refresh(); }
  else if (t.id === 'custom') { await api('/api/ui/settings', { custom: t.value }); refresh(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.pair && S.page === 'phones') { S.pair = null; render(); } });

// Poll fast while waiting for a phone to pair, slowly otherwise.
let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 3000); };
async function tick() {
  // Don't redraw under someone mid-typing. The link box redraws anyway (focus and caret are put back), so a
  // download started from it keeps showing its progress.
  const typing = document.activeElement && ['q', 'folder', 'pdfpw', 'frname', 'frmyname', 'frpcname'].includes(document.activeElement.id);
  if (!typing) await refresh();
  if (S.updBusy && Date.now() - S.updAt > 3 * 60e3) { S.updBusy = ''; S.updErr = "Premade Tools hasn't come back yet. Close this window and open Premade Tools from the Start menu."; render(); }
  clearTimeout(timer);
  timer = setTimeout(tick, S.updBusy ? 1500 : dlRunning() ? 1000 : cvRunning() || pdfBusy() || trBusy() || PDFST?.gs === 'installing' || CV?.office === 'installing' || (DL && !DL.ready) ? 1500 : S.pair || S.page === 'setup' || S.page === 'drop' ? 3000 : FRST?.sends?.some((s) => s.state === 'running') ? 1500 : S.page === 'friends' ? 10000 : 30000);
}
refresh().then(() => { if (S.page === 'setup') enterStep(1); soon(); });
