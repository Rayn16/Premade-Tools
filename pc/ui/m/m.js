// Premade Tools on the phone: the same pages for the Android app (inside its WebView) and the iPhone home-screen app.
// Home lists the tools; each tool has one page (its box, then everything it did, by day) and a settings page.
'use strict';

const qs = new URLSearchParams(location.hash.slice(1) || location.search); // Android: #t=…; iPhone Home Screen app: ?t=…
if (qs.get('t')) { try { localStorage.setItem('vaultToken', qs.get('t')); } catch (e) {} }
const TOKEN = qs.get('t') || (() => { try { return localStorage.getItem('vaultToken'); } catch (e) { return null; } })();
const NATIVE = window.Vault || null; // Android bridge, absent on iPhone
const IOS = !NATIVE;
const ME = IOS ? 'this iPhone' : 'this phone';
// The pages come from the PC itself (Android app, the old iPhone icon) or from the relay (the iPhone icon now), which
// keeps working with the PC off. From the relay, the PC is reached at its Tailscale https address, or through the
// relay's link to it (link.go), whichever answers; both are saved at pairing and kept up to date.
const HOSTED = /\.workers\.dev$/.test(location.hostname);
const kept = (k) => { try { if (qs.get(k)) localStorage.setItem('pt' + k, qs.get(k)); return localStorage.getItem('pt' + k) || ''; } catch (e) { return qs.get(k) || ''; } };
const PCS = HOSTED ? [kept('pc'), kept('link')].filter(Boolean) : [];
let PCURL = PCS[0] || '';
const PCLINK = (HOSTED ? PCURL || kept('lan') : '') || location.origin; // the address Shortcuts use

// Every page: its title, what draws it, and its settings page (the ⚙ at the top).
const PAGES = {
  home: ['Premade Tools', () => homeView()],
  dl: ['Download', () => dlView(), 'dlsettings'], convert: ['Convert', () => cvView(), 'cvsettings'], pdf: ['PDF', () => pdfToolsView(), 'pdfsettings'],
  transcribe: ['Transcribe', () => trToolsView(), 'trsettings'], drop: ['File drop', () => dropToolsView(), 'dropsettings'],
  deleted: ['Vault', () => deletedView(), 'settings'], phones: ['Vault', () => phonesView(), 'settings'], friends: ['Friends', () => frToolsView()],
  dlsettings: ['Download settings', () => dlSettingsView()], cvsettings: ['Convert settings', () => cvSettingsView()], pdfsettings: ['PDF settings', () => pdfSettingsView()],
  trsettings: ['Transcribe settings', () => trSettingsView()], dropsettings: ['File drop settings', () => dropSettingsView()], settings: ['Settings', () => settingsView()],
};
// The tools on Home: page and icon.
const HOME = [['dl', 'dl'], ['convert', 'convert'], ['pdf', 'pdf'], ['transcribe', 'transcribe'], ['drop', 'drop'], ['deleted', 'shield'], ['friends', 'friends']];
// Pages are browser history, so Back (Android's, or the ‹ at the top) goes to the page before.
const S = { page: PAGES[history.state?.page] ? history.state.page : qs.get('tool') === 'drop' ? 'drop' : 'home', // the Android app's "Sent to this phone" notification
  phone: 'all', type: 'all', q: '', sheet: null, msg: '', ask: null };
if (!history.state) history.replaceState({ page: S.page, depth: 0 }, '');
const FLOW = {}; // file id → 'confirm', { wait: text } or { done: true, name, folder }
let ST = null, ITEMS = [], OFFLINE = false, LAST = '';
let DL = null; // /api/phone/dl, drawn by mdl.js
const $app = document.getElementById('app');
TAPROWS = true; // a finished row opens its buttons in a sheet (common.js)

function go(page) {
  if (page === S.page) return;
  history.pushState({ page, depth: (history.state?.depth || 0) + 1 }, '');
  S.page = page; S.sheet = null; S.msg = ''; MENU = ''; SHEET = ''; render();
}
function back() {
  if (history.state?.depth) return history.back();
  history.replaceState({ page: 'home', depth: 0 }, ''); S.page = 'home'; render(); // opened straight on a page
}
// An open sheet is a step of its own in history, so Back (Android's, or the iPhone's swipe) closes it and stays on the page.
let OWNBACK = false;
const sheetUp = () => !!(S.sheet || SHEET || FR.share || DS.ask);
function sheetStep() {
  if (sheetUp() && !history.state?.sheet) history.pushState({ ...history.state, sheet: 1 }, '');
  else if (!sheetUp() && history.state?.sheet) { OWNBACK = true; history.back(); } // closed some other way: drop its step
}
addEventListener('popstate', (e) => {
  if (OWNBACK) { OWNBACK = false; return; }
  if (FLOW[S.sheet] === 'confirm' || FLOW[S.sheet]?.done) delete FLOW[S.sheet];
  S.page = PAGES[e.state?.page] ? e.state.page : 'home'; S.sheet = null; MENU = ''; SHEET = ''; FR.share = null; DS.ask = null; render();
});

// A sheet from the bottom follows the finger down and closes past a third of its height (or on a quick flick);
// short of that it slides back. Only from its top, or once its contents are scrolled to the top.
let DRAG = null;
$app.addEventListener('touchstart', (e) => {
  const card = e.target.closest('.msheet:not(.out) .msheet-card');
  if (!card || e.touches.length > 1 || e.target.closest('input,select,textarea,video,audio') || document.documentElement.classList.contains('reduced')) return;
  DRAG = { card, y0: e.touches[0].clientY, t0: performance.now(), dy: 0, on: false };
}, { passive: true });
$app.addEventListener('touchmove', (e) => {
  if (!DRAG) return;
  const d = DRAG, dy = e.touches[0].clientY - d.y0, body = d.card.querySelector('.msheet-body');
  if (!d.on) {
    if (Math.abs(dy) < 8) return;
    if (dy < 0 || (body && body.scrollTop > 0 && !e.target.closest('.grab'))) { DRAG = null; return; } // a scroll, not a drag
    d.on = true; d.card.classList.remove('snap'); d.card.classList.add('dragging');
  }
  e.preventDefault();
  d.dy = Math.max(0, dy);
  d.card.style.transform = `translateY(${d.dy}px)`;
  d.card.parentNode.style.opacity = String(1 - Math.min(1, d.dy / d.card.offsetHeight) * .6);
}, { passive: false });
function dragEnd() {
  const d = DRAG; DRAG = null;
  if (!d?.on) return;
  d.card.classList.remove('dragging');
  const fast = d.dy / (performance.now() - d.t0) > .6; // px per ms
  if (d.dy > d.card.offsetHeight * .3 || (fast && d.dy > 40)) { closeAnySheet(); return; }
  d.card.classList.add('snap'); d.card.style.transform = ''; d.card.parentNode.style.opacity = '';
}
$app.addEventListener('touchend', dragEnd);
$app.addEventListener('touchcancel', dragEnd);
function closeAnySheet() { if (history.state?.sheet) history.back(); else { FR.share = null; DS.ask = null; closeSheet(); } }

async function api(path, body) {
  const opt = { headers: { Authorization: 'Bearer ' + TOKEN } };
  if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  if (HOSTED && PCURL && path.startsWith(PCURL + '/')) path = path.slice(PCURL.length); // the tools' bases carry PCURL; keep the fallback below
  if (!path.startsWith('/') || !HOSTED) r = await fetch(path.startsWith('/') ? PCURL + path : path, opt);
  else { // the address that answered last, then the other one
    for (const base of [PCURL, ...PCS.filter((b) => b !== PCURL)].filter(Boolean)) {
      try { r = await fetch(base + path, base === PCS.at(-1) ? opt : { ...opt, signal: AbortSignal.timeout(10e3) }); } catch (e) { continue; }
      if (r.headers.get('X-Premade-Link') === 'off') { r = null; continue; } // the relay: this PC isn't linked right now
      PCURL = base; break;
    }
    if (!r) throw new Error("Can't reach your PC.");
  }
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}

// The relay knows which PC each paired phone belongs to, so a phone with no address for its PC, or an old one,
// asks it (by a hash of its own key) instead of being paired again. Once per open, then every 5 minutes while out of reach.
let FOUND = 0;
async function findPC() {
  if (!HOSTED || !TOKEN || (PCS.length && !OFFLINE) || Date.now() - FOUND < 3e5) return;
  FOUND = Date.now();
  try {
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch('/find/' + h);
    if (!r.ok) return;
    const { link } = await r.json(), old = kept('link');
    if (!link || link === old) return;
    try { localStorage.setItem('ptlink', link); } catch (e) {}
    PCS.splice(PCS.indexOf(old) >= 0 ? PCS.indexOf(old) : PCS.length, 1, link);
    if (!PCURL || PCURL === old) PCURL = link;
  } catch (e) {}
}

let VER = ''; // the PC version these pages came from
async function refresh() {
  await findPC();
  try {
    [ST, ITEMS, DL] = await Promise.all([api('/api/phone/state'), api('/api/phone/deleted'), api('/api/phone/dl').catch(() => DL), typeof cvRefresh === 'function' && cvRefresh(), typeof pdfPhoneRefresh === 'function' && pdfPhoneRefresh(), typeof trToolsView === 'function' && trRefresh()]); // mcv.js and mpdf.js load after this file
    OFFLINE = false;
    if (VER && VER !== ST.version) { // the PC just updated itself: get the new pages, and the new Android app
      try { localStorage.setItem('ptUpdated', '1'); } catch (e) {}
      if (!busyNow()) { location.reload(); return; }
      NEWPAGES = true; // once nothing would be lost
    }
    VER = ST.version;
    if (S.updBusy && ST.updErr) { S.updBusy = ''; S.updErr = ST.updErr; } // the PC couldn't update: say why, offer it again
    if (NATIVE?.keepAway && ST.relay && !ST.relay.includes('REPLACE')) NATIVE.keepAway(ST.tsHost || '', `${ST.relay}/m/?t=${encodeURIComponent(TOKEN)}&pc=${encodeURIComponent(ST.remote || '')}&link=${encodeURIComponent(ST.link || '')}`);
    try { ST.fr ? localStorage.setItem('ptfr', ST.fr) : localStorage.removeItem('ptfr'); } catch (e) {} // the relay key, for drops while the PC is off
    if (HOSTED) for (const [k, v] of [['pc', ST.remote], ['link', ST.link]]) { // keep both addresses up to date
      if (!v || PCS.includes(v)) continue;
      try { localStorage.setItem('pt' + k, v); } catch (e) {}
      PCS.splice(k === 'pc' ? 0 : PCS.length, 0, v);
    }
    dlAfterRefresh();
    try { localStorage.setItem('vaultCache', JSON.stringify([ST, ITEMS])); } catch (e) {}
  } catch (e) {
    OFFLINE = true;
    if (!ST) { try { [ST, ITEMS] = JSON.parse(localStorage.getItem('vaultCache')) || []; } catch (e2) {} }
    if (!ST) { ST = { me: '', phones: [], version: '', config: { theme: 'red' } }; ITEMS = []; } // never reached the PC: the phone's own tools still work
  }
  const now = JSON.stringify([ST, ITEMS, OFFLINE, DL, CVS, PDFST, TRST]);
  if (now !== LAST || S.page === 'phones') render(); // Phones: "checked 5 minutes ago", and the Android app's own checks
  LAST = now;
}

const phoneById = (id) => (ST?.phones || []).find((p) => p.ID === id);
const phoneName = (id) => id === ST?.me ? 'This phone' : phoneById(id)?.Name || 'Removed phone';
const view = (id, dl) => `${PCURL}/api/phone/view/${id}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;
const fresh = (p) => Date.now() - new Date(p.LastSeen) < 2 * 3600e3;
const live = () => liveItems(ITEMS || []);
const note = (text, ic = 'alert') => text ? `<div class="notebox ${ic === 'alert' ? '' : 'is-info'}">${icon(ic)}<div>${text}</div></div>` : '';
// A Shortcut's address, with a Copy button (works over plain http too, see the click handler).
const copyField = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}" aria-label="${label}"><button type="button" class="btn small" data-copy>Copy</button></div>`;
// Where a tool's result is now, seen from this phone. got: where this phone put it once saved ("In your Photos").
function whereOf(j, got) {
  if (j.local) return ljWhere(j);
  if (j.state === 'failed') return '';
  const mine = j.from === ST?.me;
  if (j.state !== 'done') return mine ? icon('phones') + `Comes to ${ME} when done` : '';
  return !mine ? icon('pc') + 'On your PC' : j.fetched ? icon('check') + got : NATIVE ? icon('clock') + 'Saving…' : icon('pc') + 'On your PC';
}

const SCROLL = {}; // each page's scroll, kept for coming back to it
let DRAWN = '';
function render() {
  if (!TOKEN) {
    $app.innerHTML = `<header class="ph-title">${MARK}<h1>Premade Tools</h1></header><main class="ph-body"><h2 class="block-title">Not paired yet</h2>
      <p class="tip">Open Premade Tools on your PC, choose Vault, then Phones, then Add a phone, and scan the code with this phone.</p></main>`;
    return;
  }
  const keep = [...$app.querySelectorAll('.scroller')].map((n) => n.scrollTop), same = DRAWN === S.page;
  if (keep.length) SCROLL[DRAWN] = keep[0]; // the page itself is the first
  const act = document.activeElement, focusId = act?.id, caret = [act?.selectionStart, act?.selectionEnd];
  paintTheme($app, ST?.config || {});
  const [title, page, gear] = PAGES[S.page] || PAGES.home;
  const top = S.page === 'home' ? `<header class="ph-title">${MARK}<h1>${title}</h1><span class="grow"></span><button type="button" class="btn icon" data-go="settings" aria-label="Settings">${icon('settings')}</button></header>`
    : `<header class="ph-top"><button type="button" class="btn icon" data-back aria-label="Back">${icon('back')}</button><h1>${title}</h1><span class="grow"></span>${gear ? `<button type="button" class="btn icon" data-go="${gear}" aria-label="${title} settings">${icon('settings')}</button>` : ''}</header>`;
  const off = OFFLINE ? `<p class="note">${icon('alert')}<span>Can't reach your PC right now. ${NATIVE ? 'This phone keeps saving what you delete and sends it when you are home.' : HOSTED ? 'This phone does the work itself until it is.' : 'This shows what was there last time.'}</span></p>` : '';
  SHEETROW = '';
  const body = ST ? off + page() : '<p class="tip">Loading…</p>';
  if (!SHEETROW) SHEET = ''; // its row is gone
  // The tapped row's sheet steps aside while the Send sheet it opened is up.
  redraw($app, `${top}<main class="ph-body scroller">${body}</main>${FR.share ? '' : SHEETROW}${S.sheet ? sheetView() : ''}${DS.ask ? dlAskView() : ''}${frSheet()}${updView()}`);
  if (DRAWN && DRAWN !== S.page) pageIn($app.querySelector('.ph-body')); // a new page fades in
  DRAWN = S.page;
  sheetStep();
  $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = same ? keep[i] || 0 : i ? 0 : SCROLL[S.page] || 0; });
  const f = focusId && document.getElementById(focusId);
  if (f && f !== document.activeElement) { f.focus(); try { f.setSelectionRange(caret[0], caret[1]); } catch (e) {} }
  lazyMedia($app);
}

// ---------- Home: the tools, then the latest from all of them ----------
function homeView() {
  const n = { dl: running(dlJobs()), convert: running(cvJobs()), pdf: running(pdfJobs()), transcribe: running(trJobs()), drop: dropNew() ? dropNew() + ' new' : '',
    deleted: live().length ? live().length + ' kept' : '', friends: frMe()?.waiting?.length ? frMe().waiting.length + ' asking' : '' };
  const recent = [...dlJobs().map((j) => [j, dlFields(j), 'dl']), ...cvJobs().map((j) => [j, cvFields(j), 'convert']), ...pdfJobs().map((j) => [j, pdfFields(j), 'pdf']),
    ...trJobs().map((j) => [j, trFields(j), 'transcribe']), ...dropJobs().map((j) => [j, dropFields(j), 'drop'])].sort(([a], [b]) => newest(a, b)).slice(0, 8);
  return `${moveNudge()}<nav class="tools" aria-label="Tools">${HOME.map(([pg, ic]) => `<button type="button" class="tool" data-go="${pg}">${icon(ic)}<b>${PAGES[pg][0]}</b>${n[pg] ? `<span class="${pg === 'deleted' ? '' : 'live'}">${n[pg]}</span>` : ''}${icon('chev', 'chev')}</button>`).join('')}</nav>
    ${recent.length ? `<h2 class="day">Recent</h2><div class="rows">${recent.map(([, f, pg]) => rowOf({ ...f, go: `data-go="${pg}"` })).join('')}</div>` : ''}`;
}

// iPhones still on the old icon (pages from the PC over the home Wi-Fi): offer the new one, which opens anywhere.
function moveNudge() {
  if (HOSTED && !navigator.standalone && /iP(hone|ad|od)/.test(navigator.userAgent)) return note('<b>Keep Premade on this iPhone.</b> Tap <b>Share</b> › <b>Add to Home Screen</b>, then open Premade from there. It opens even with your PC off.', 'info');
  if (HOSTED && !PCS.length) return note('<b>Connect this iPhone to your PC again.</b> On the PC, open Premade › Vault › Phones › <b>Add a phone</b> and scan the code, then open Premade from the new icon. This phone\'s own tools work until then.', 'info');
  if (HOSTED || NATIVE || !ST?.relay || ST.relay.includes('REPLACE') || !/iP(hone|ad|od)/.test(navigator.userAgent)) return '';
  const to = `${ST.relay}/m/?t=${encodeURIComponent(TOKEN)}&pc=${encodeURIComponent(ST.remote || '')}&link=${encodeURIComponent(ST.link || '')}&lan=${encodeURIComponent(location.origin)}`;
  return note(`<b>Premade now works away from home.</b> Open the new version, then tap <b>Share</b> › <b>Add to Home Screen</b> and remove this old icon.<div class="acts"><a class="btn small primary" href="${esc(to)}">Open the new version</a></div>`, 'info');
}

// ---------- Vault: Deleted ----------
function shown() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => !it.dismissed && (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) && (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}
const vaultSeg = (on) => `<div class="seg two" role="group" aria-label="Vault">${[['deleted', 'Deleted'], ['phones', 'Phones']].map(([id, l]) => `<button type="button" data-seg="${id}" aria-pressed="${on === id}">${l}</button>`).join('')}</div>`;
const noPreview = (it) => /\.dng$/i.test(it.name);
// A square in the grid. Only its picture is kept across redraws (data-k), so the restored mark still updates.
const tileView = (it) => `<button type="button" class="tile" data-open="${it.id}" aria-label="${esc(it.name)}"><span class="media" data-k="v${it.id}">${tile(it, view(it.id), noPreview(it))}</span>${FLOW[it.id]?.done ? `<span class="restoredmark">${icon('check')}</span>` : ''}</button>`;

function deletedView() {
  const all = shown(), list = all.filter((i) => !i.missed);
  const pick = (key, label, opts) => `<label class="sel"><select data-filter="${key}" aria-label="${label}">${opts.map(([id, l]) => `<option value="${esc(id)}" ${S[key] === id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${icon('down')}</label>`;
  const notes = all.filter((i) => i.missed).map((it) => `<p class="note">${icon('alert')}<span>${esc(it.name)} couldn't be saved. ${esc(it.note || '')}</span><button type="button" class="btn text" data-dismiss="${it.id}">Dismiss</button></p>`).join('');
  return `${vaultSeg('deleted')}<label class="search">${icon('search')}<input type="search" id="q" value="${esc(S.q)}" placeholder="Search" aria-label="Search deleted files"></label>
    <div class="filters">${ST.phones.length > 1 ? pick('phone', 'Phone', [['all', 'All phones'], ...ST.phones.map((p) => [p.ID, p.ID === ST.me ? 'This phone' : p.Name])]) : ''}
      ${pick('type', 'Type', [['all', 'All types'], ['photo', 'Photos'], ['video', 'Videos'], ['voice', 'Voice'], ['file', 'Files']])}</div>
    ${ST.vault ? note(esc(ST.vault), 'info') : ''}${iosNudge()}${notes}
    ${!live().length ? `<div class="empty">${icon('deleted')}<h2>Nothing deleted yet</h2><p>From now on, anything you delete shows up here, newest first.</p></div>`
      : list.length ? byDay(list, (i) => i.deletedAt, tileView, 'pgrid') : `<div class="empty">${icon('search')}<h2>Nothing matches that</h2><p>Try another name, or clear the filters.</p></div>`}`;
}

// The file picked in the grid, from the bottom of the screen: its preview, what it was, and Restore.
function sheetView() {
  const it = ITEMS.find((i) => i.id === S.sheet);
  if (!it) return '';
  const src = view(it.id), keep = ST.config.keep;
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}#t=0.1" controls playsinline preload="metadata"></video>`
    : it.kind === 'voice' ? `${wave(it.id, 40)}<audio src="${src}" controls preload="none"></audio>` : `${doc()}<span class="tag">${esc(ext(it.name) || 'FILE')}</span>`;
  return `<div class="msheet" data-close><div class="msheet-card" role="dialog" aria-modal="true" aria-label="${esc(it.name)}"><div class="grab"><span></span></div>
    <div class="msheet-body scroller"><div class="preview">${pv}</div><h2 class="detail-name">${esc(it.name)}</h2>
      <dl class="facts"><dt>Deleted</dt><dd>${it.byTime ? 'By ' : ''}${whenShort(new Date(it.deletedAt))}</dd><dt>From</dt><dd>${esc(phoneName(it.phone))}</dd>
        <dt>Was in</dt><dd class="mono">${esc(it.folder)}</dd><dt>Size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd>
        <dt>Kept</dt><dd class="${keptClass(it, keep) ? 'warn' : ''}">${keptLabel(it, keep)}</dd></dl></div>
    <div class="msheet-acts">${actions(it, phoneById(it.phone))}</div></div></div>`;
}

function actions(it, p) {
  const f = FLOW[it.id];
  if (f?.done) return `<div class="done"><span class="donemark" data-in="done:${it.id}">${icon('check')}</span><span class="done-text">Restored. It's back in ${esc(f.folder)}.<em>On ${esc(f.name)}</em></span></div><button type="button" class="quiet" data-closesheet>Done</button>`;
  if (f?.wait || p?.Pending?.includes(it.id)) return `<div class="restoring"><div class="restoring-row">${icon('spin', 'spin')}Restoring…</div><div class="progline"><span></span></div>${f?.wait ? `<p>${esc(f.wait)}</p>` : ''}</div>
    <button type="button" class="quiet" data-unrestore="${it.id}">Cancel</button>`;
  if (f === 'confirm') return `<div class="confirm"><p class="confirm-text">Delete this from the vault?</p><p class="confirm-sub">The copy on your PC is deleted. It can't be brought back.</p>
    <div class="confirm-row"><button type="button" class="btn" data-unconfirm="${it.id}">Keep it</button><button type="button" class="btn danger" data-dismiss="${it.id}">Delete</button></div></div>`;
  return `${p ? `<button type="button" class="btn primary block" data-restore="${it.id}">Restore to ${it.phone === ST.me ? ME : esc(p.Name)}</button>` : ''}
    <a class="btn block" href="${view(it.id, true)}" download="${esc(it.name)}">${NATIVE ? 'Download' : 'Save to Files'}</a>
    <div class="msg bad" role="status">${esc(S.msg)}</div>
    <button type="button" class="quiet" data-askdismiss="${it.id}">Delete from vault</button>`;
}

// The pop-up that offers a new version. Updating puts it on the PC, which hands it to this phone.
function updView() {
  if (!ST?.update || (OFFLINE && !S.updBusy) || (S.updLater === ST.update && !S.updBusy)) return '';
  const busy = S.updBusy;
  return `<div class="backdrop"><section class="sheet upd" role="dialog" aria-modal="true" aria-label="Update ready">
    <div class="upd-body">${MARK}<h2 class="sheet-title">Update ready</h2><p class="upd-text">Premade Tools <b>${esc(ST.update)}</b> is out. You have ${esc(ST.version)}.</p>
      <p class="upd-text" role="status">${esc(busy || S.updErr || (NATIVE ? 'It updates your PC, then this app.' : 'It updates your PC, and this app with it.'))}</p></div>
    <div class="upd-foot"><button type="button" class="btn" data-updlater ${busy ? 'disabled' : ''}>Later</button><button type="button" class="btn primary" data-updnow ${busy ? 'disabled' : ''}>Update now</button></div></section></div>`;
}

// ---------- Vault: Phones ----------
function phonesView() {
  const local = NATIVE ? JSON.parse(NATIVE.status()) : null;
  const list = [...ST.phones].sort((a, b) => (b.ID === ST.me) - (a.ID === ST.me)).map((p) => { // this phone first
    const me = p.ID === ST.me, ios = p.Kind === 'iphone', st = (me && local) || p.Status || {}, up = fresh(p) || (me && NATIVE);
    const n = live().filter((i) => i.phone === p.ID).length;
    const checks = ios ? [[true, 'Backs up when it joins your home Wi-Fi, and when it starts charging'], [true, 'Covers photos and videos, screenshots, screen recordings, WhatsApp and Telegram media. Not voice memos.']]
      : [[st.binOn !== false, "Gallery's Recycle bin is on", "Gallery's Recycle bin looks off", 'bin'], [st.allFiles, 'All files access allowed', 'All files access is off', 'files'], [st.battery, 'Battery set to Unrestricted', 'Battery is not Unrestricted', 'battery']];
    const state = ios ? (neverBackedUp(p) ? 'Not backed up yet' : 'Last backup ' + whenShort(new Date(p.LastSeen))) : (up ? 'Watching the bin, checked ' : 'Not seen since ') + ago(p.LastSeen);
    return `<section class="phone">${icon('phones')}<div><h2>${esc(p.Name)}</h2><p class="state"><i class="dot ${ios ? '' : up ? 'on' : 'warn'}"></i>${me ? 'This phone. ' : ''}${state}</p></div><p class="n"><b>${n}</b>kept</p>
      <ul>${checks.map(([ok, yes, no, fix]) => `<li class="${ok ? '' : 'is-bad'}">${icon(ios ? 'info' : ok ? 'check' : 'alert')}<span class="grow">${ok ? yes : no}</span>${!ok && me && NATIVE ? `<button type="button" class="btn small" data-fix="${fix}">Fix</button>` : ''}</li>`).join('')}
        ${me && local?.pending ? `<li>${icon('clock')}<span class="grow">${plural(local.pending, 'file')} waiting to go to your PC when it's reachable</span></li>` : ''}</ul>
      ${me && ios ? `<div class="guide">${iosGuide(p)}</div>` : ''}</section>`;
  }).join('');
  return `${vaultSeg('phones')}<div class="phones">${list || `<div class="empty">${icon('phones')}<h2>No phones yet</h2></div>`}</div>
    <p class="hint">${icon(OFFLINE ? 'alert' : 'pc')}${OFFLINE ? "Can't reach your PC" : 'Connected to your PC'}</p>
    <p class="hint">${icon('info')}<span>To add another phone, open Premade on your PC: Vault › Phones › <b>Add a phone</b>.</span></p>`;
}

// iPhone: apps can't see Recently Deleted, so a Shortcut the user builds once sends the PC a copy of
// each photo and video, and the PC shows a file only after it's gone from the phone.
const SHORTCUT = 'Vault backup';
const neverBackedUp = (p) => new Date(p.LastSeen) - new Date(p.Paired) < 5000;
const runShortcut = 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT);

// The PC held back a backup that didn't see many photos it keeps (Store.SyncPhoneList), most likely Shortcuts let
// see only some of them.
const heldNote = (p) => p.Held ? note(`<b>The last backup didn't see ${p.Held} photos.</b> They don't show as deleted, because that many at once usually means Shortcuts can see only some photos. Open <b>Settings</b> › <b>Apps</b> › <b>Shortcuts</b> › <b>Photos</b>, pick <b>Full Access</b>, then tap <b>Back up now</b>.<div class="acts"><button type="button" class="btn small" data-heldok>I deleted them</button></div>`, 'info') : '';

function iosNudge() {
  const me = phoneById(ST.me);
  if (!me || me.Kind !== 'iphone') return '';
  if (me.Held) return heldNote(me);
  if (!navigator.standalone) return note('Tap <b>Share</b>, then <b>Add to Home Screen</b>, then open Premade from there.', 'info');
  if (neverBackedUp(me)) return note('One more step: add the backup Shortcut. Open <b>Phones</b> and follow the steps.', 'info');
  return '';
}

function iosGuide(p) {
  // The home address: the backup runs at home, and the relay takes nothing over 100 MB, so a long video would stop it.
  const base = kept('lan') || PCLINK, t = encodeURIComponent(TOKEN), redo = p.Relay && base !== PCLINK;
  const steps = [
    `Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT}</b>.`,
    `Add <b>Find Photos</b> (leave it on All Photos).`,
    `Add <b>Get Details of Images</b> and pick <b>Name</b>.`,
    `Add <b>Combine Text</b> and set it to <b>New Lines</b>.`,
    `Add <b>Get Contents of URL</b> with the address below. Method <b>POST</b>, Request Body <b>File</b>, and pick <b>Combined Text</b>.${copyField('Backup', `${base}/api/phone/ios/backup?t=${t}`)}`,
    `Add <b>Set Variable</b>, name it <b>Need</b>, set to <b>Contents of URL</b>.`,
    `Add <b>Repeat with Each</b> and pick <b>Photos</b> from step 2. Inside it:`,
    `<b>Text</b>: type <b>|</b>, insert <b>Repeat Item</b> and tap it to choose <b>Name</b>, then type <b>|</b>.`,
    `<b>If</b> <b>Need</b> <b>contains</b> <b>Text</b>. Inside it, <b>Get Contents of URL</b> with the address below, Method <b>PUT</b>, Request Body <b>File</b> set to <b>Repeat Item</b>, and two headers: <b>X-Key</b> and <b>X-Name</b>, both <b>Repeat Item</b> › <b>Name</b>.${copyField('Upload', `${base}/api/phone/upload?t=${t}`)}`,
    `After <b>End Repeat</b>, for files you restore from the PC: <b>Get Contents of URL</b> with this address.${copyField('Restores', `${base}/api/phone/ios/restores?t=${t}`)}`,
    `Add <b>Split Text</b> by <b>New Lines</b>, then <b>Repeat with Each</b>. Inside it: <b>If Repeat Item is not none</b>, then a <b>Text</b> with the first address below with <b>Repeat Item</b> put where it says ID, <b>Get Contents of URL</b> of that Text, and <b>Save to Photo Album</b>. Then another <b>Text</b> with the second address, again with <b>Repeat Item</b> for ID, and <b>Get Contents of URL</b> of it with Method <b>POST</b>.${copyField('Restore file', `${base}/api/phone/file/ID?t=${t}`)}${copyField('Restored', `${base}/api/phone/restored/ID?t=${t}`)}`,
    `Tap <b>Back up now</b> below to run it once. Allow access to Photos and to devices on your network when asked. The first run sends every photo, so keep the screen on and the iPhone on Wi-Fi.`,
    `Make it run by itself: <b>Automation</b> tab › <b>+</b> › <b>Wi-Fi</b>, pick your home Wi-Fi, choose <b>Run Immediately</b> and pick <b>${SHORTCUT}</b>. Add a second one with <b>Charger</b> › <b>Is Connected</b>.`,
  ];
  return `${heldNote(p)}${redo ? note(`<b>Update your backup Shortcut.</b> It sends photos through the internet, which takes nothing over 100 MB, so a long video stops every backup. Open it in Shortcuts, and in each address change the part before <b>/api</b> to <b>${esc(base)}</b>.`) : ''}
    <details class="iosguide" ${neverBackedUp(p) || redo ? 'open' : ''}><summary>Set up the backup Shortcut</summary><ol>${steps.map((x) => `<li>${x}</li>`).join('')}</ol></details>
    <a class="btn primary block" href="${runShortcut}">Back up now</a>`;
}

// ---------- Settings: the look, and how long the vault keeps things ----------
function settingsView() {
  const c = ST.config, ask = S.ask;
  return `${S.msg ? note(esc(S.msg)) : ''}<section class="sec"><h2>Look</h2>${themePicker(c.theme, c.custom || '#d9202d')}
      ${c.theme === 'custom' ? `<label class="srow"><span class="grow">Your color</span><input type="color" class="colorpick" id="custom" value="${esc(c.custom || '#d9202d')}"></label>` : ''}
      ${motionRow('Follow phone')}</section>
    <section class="sec"><h2>Vault</h2>
      <div class="srow"><span class="grow">Keep deleted files<span class="h">Only files deleted longer ago than this are cleared.</span></span><label class="sel"><select id="keep" aria-label="Keep deleted files">${KEEP.map(([id, l]) => `<option value="${id}" ${(ask?.id || c.keep) === id ? 'selected' : ''}>${l}</option>`).join('')}</select>${icon('down')}</label></div>
      ${ask ? `<div class="srow sub"><span class="grow">This clears ${plural(ask.count, 'file')} (${esc(ask.size)}) deleted more than ${esc(ask.label)} ago. They can't be brought back.</span></div>
        <div class="srow sub"><span class="grow"></span><button type="button" class="btn" data-askclear>Keep them</button><button type="button" class="btn danger" data-keepyes="${ask.id}">Clear them</button></div>` : ''}
      <div class="srow"><span class="grow">Stored on your PC<span class="h mono">${esc(c.vaultDir)}</span><span class="h">${ST.free ? esc(nice(ST.free)) + ' free. ' : ''}You can move it from Settings on the PC.</span></span></div></section>
    <section class="sec"><h2>Premade Tools ${esc(ST.version)}</h2><div class="srow"><span class="grow">Updates<span class="h">${NATIVE ? 'This app updates' : 'These pages update'} with your PC.</span></span></div></section>`;
}

$app.addEventListener('click', async (e) => {
  if (e.target.matches('.msheet[data-close]')) { closeSheet(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy !== undefined) { // clipboard API needs https; a selected field + execCommand works over plain http
    const inp = b.previousElementSibling; inp.select(); inp.setSelectionRange(0, 9999);
    try { document.execCommand('copy'); b.textContent = 'Copied'; } catch (e2) { b.textContent = 'Select and copy'; }
    return;
  }
  const d = b.dataset;
  try {
    if (d.go) go(d.go);
    else if (d.back !== undefined) back();
    else if (d.seg) { history.replaceState({ ...history.state, page: d.seg }, ''); S.page = d.seg; render(); } // Deleted ⇄ Phones isn't a step back
    else if (d.open) { S.sheet = d.open; S.msg = ''; render(); }
    else if (d.rs) { SHEET = d.rs; render(); }
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
    else if (d.unrestore) { await api('/api/phone/unrestore/' + d.unrestore, {}); FLOW[d.unrestore] = { cancelled: true }; refresh(); }
    else if (d.fix) { NATIVE.fix(d.fix); }
    else if (d.heldok !== undefined) { await api('/api/phone/ios/held', {}); refresh(); }
    else if (d.keepyes) { await api('/api/phone/settings', { keep: d.keepyes }); S.ask = null; refresh(); }
    else if (d.askclear !== undefined) { S.ask = null; render(); }
    else if (d.updlater !== undefined) { S.updLater = ST.update; render(); }
    else if (d.updnow !== undefined) {
      S.updBusy = 'Updating your PC…'; S.updErr = ''; S.updAt = Date.now(); render();
      const m = (await api('/api/phone/update', {})).msg;
      S.updBusy = /^Updating/.test(m) ? (NATIVE ? 'Updating your PC. Then this app updates and opens again by itself.' : 'Updating your PC. This reloads by itself when it’s done.') : '';
      if (/^Update failed/.test(m)) S.updErr = m;
      else if (!S.updBusy) { S.updLater = ST.update; S.msg = m; }
      render();
    }
  } catch (err) { if (S.updBusy) S.updErr = err.message; S.updBusy = ''; S.msg = err.message; render(); }
});
$app.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.filter) { S[t.dataset.filter] = t.value; render(); }
    else if (t.name === 'theme' || t.id === 'custom') { ST.config[t.name === 'theme' ? 'theme' : 'custom'] = t.value; render(); await api('/api/phone/settings', { [t.name === 'theme' ? 'theme' : 'custom']: t.value }); refresh(); }
    else if (t.id === 'keep') { // a shorter time first shows what would be cleared
      S.ask = null;
      if (KEEPDAYS[t.value] < KEEPDAYS[ST.config.keep]) {
        const p = await api('/api/phone/keep-preview?keep=' + t.value);
        if (p.count) { S.ask = { id: t.value, count: p.count, size: p.size, label: KEEP.find(([id]) => id === t.value)[1].toLowerCase() }; render(); return; }
      }
      await api('/api/phone/settings', { keep: t.value }); refresh();
    }
  } catch (err) { S.msg = err.message; render(); }
});
$app.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; render(); } });
function closeSheet() {
  if (FLOW[S.sheet] === 'confirm' || FLOW[S.sheet]?.done) delete FLOW[S.sheet];
  S.sheet = null; SHEET = ''; S.msg = ''; render();
}
// Shows "Restored" once the phone has put the file back (the PC drops it from that phone's list).
function watchRestore(it) {
  const t0 = Date.now();
  const t = setInterval(async () => {
    if (FLOW[it.id]?.cancelled) { clearInterval(t); delete FLOW[it.id]; return; }
    await refresh();
    const p = phoneById(it.phone);
    if (p && (p.Pending || []).includes(it.id) && Date.now() - t0 < 20 * 60e3) return;
    clearInterval(t);
    if (p && !(p.Pending || []).includes(it.id)) FLOW[it.id] = { done: true, name: p.Name, folder: it.folder };
    else delete FLOW[it.id];
    render();
  }, 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.vaultRefresh = refresh; // the Android app calls this after it sends something
// iPhone: new pages arrive with a new offline copy (sw.js). Look for one each time Premade comes to the front, and
// once it has taken over, reload as soon as nothing is going on, so the Home Screen app never sits on old pages.
let NEWPAGES = false;
const jobsBusy = () => S.updBusy || dlBusy() || (typeof cvBusy === 'function' && cvBusy()) || pdfBusy() || trBusy();
// What a reload would lose: a job, an upload, the PDF editor, a recording, or a result made here and not saved yet.
const busyNow = () => jobsBusy() || ED.on || T.rec || [FD, FR, T, P, typeof CS === 'object' ? CS : {}].some((o) => o.up >= 0)
  || LJ.some((j) => j.state === 'done' && !j.saved);
if (HOSTED && 'serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; // the very first install isn't an update
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) NEWPAGES = true; });
  navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
document.addEventListener("DOMContentLoaded", () => refresh()); // after every tool's file has loaded: with no PC to wait for, the first draw comes at once
try { if (localStorage.getItem('ptUpdated') && NATIVE?.update) NATIVE.update(); localStorage.removeItem('ptUpdated'); } catch (e) {}
let slow = 0;
setInterval(() => { // every second while a download runs, else every 30 s
  // A box being typed in isn't redrawn; an empty one (the link box after a download starts) is. Nor is an open sheet:
  // on an iPhone a tap that lands while the page is redrawn is lost, so a busy page made the Send sheet ignore taps.
  const a = document.activeElement;
  if (document.hidden || S.sheet || SHEET || DS.ask || FR.share || (['q', 'dlurl', 'pdfpw', 'droptext', 'frname', 'frmyname'].includes(a?.id) && a.value)) return;
  if (S.updBusy && Date.now() - S.updAt > 3 * 60e3) { S.updBusy = ''; S.updErr = "Your PC hasn't come back yet. Check that Premade Tools is open on it."; render(); }
  const busy = jobsBusy(); // polls every second
  if (NEWPAGES && !busyNow()) { location.reload(); return; }
  if (busy || ++slow >= 30) { slow = 0; refresh(); }
}, 1000);
