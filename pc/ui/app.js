// Vault's PC window. Plain JS: the server sends state, this draws it in Premade's look.
'use strict';

const S = { page: 'home', phone: 'all', type: 'all', q: '', sel: null, closed: false, msg: '', pair: null, pairBase: 0, step: 1, drive: null, drives: null, folder: '', basePhones: 0, updMsg: '', ask: null, updLater: '', updBusy: '' };
const FLOW = {};    // file id → 'confirm', { wait: text } or { done: true, name, folder }
let ST = null;      // /api/ui/state
let ITEMS = [];     // /api/ui/deleted
let VER = '';       // the version this page was loaded with
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
    [ST, ITEMS] = await Promise.all([api('/api/ui/state'), api('/api/ui/deleted'), dlRefresh(), cvRefresh(), pdfRefresh(), trRefresh(), dropRefresh()]);
    if (!S.drives || S.page === 'settings') S.drives = await api('/api/ui/drives');
  } catch (e) { return; }
  if (VER && VER !== ST.version) { location.reload(); return; } // the PC just updated itself
  VER = ST.version;
  if (!ST.config.setupDone && S.page !== 'setup') S.page = 'setup';
  const now = JSON.stringify([ST, ITEMS, S.drives, DL, CV, PDFST, TRST, DROPST]);
  if (now !== LAST || (S.page !== 'deleted' && S.page !== 'download' && S.page !== 'convert' && S.page !== 'pdf' && S.page !== 'transcribe' && S.page !== 'drop')) render();
  LAST = now;
}

const phoneById = (id) => (ST.phones || []).find((p) => p.ID === id);
const phoneName = (id) => phoneById(id)?.Name || 'Removed phone';
const fileUrl = (id) => `/api/ui/file/${id}`;
const vaultDrive = () => (S.drives || []).find((d) => d.Root.slice(0, 2).toLowerCase() === (ST.config.vaultDir || '').slice(0, 2).toLowerCase());
const usedPct = (d) => { const t = toBytes(d.Total); return t ? Math.min(100, Math.max(0, (1 - d.FreeB / t) * 100)) : 0; };
const fresh = (p) => Date.now() - new Date(p.LastSeen) < 2 * 3600e3;

// ---------- frame ----------
function render() {
  if (!ST) return;
  const c = ST.config;
  const keep = [...$app.querySelectorAll('.scroller')].map((n) => n.scrollTop);
  const act = document.activeElement, focusId = act?.id, caret = [act?.selectionStart, act?.selectionEnd];
  $app.dataset.theme = c.theme || 'red';
  $app.style.setProperty('--c', c.custom || '#d9202d');
  setSize(c.size || 100);
  const title = `<header class="titlebar"><span class="crest"><img src="/icon.svg" alt=""></span><span class="wordmark">Premade Tools</span><span class="wordmark-sep">/</span><span class="wordmark-app">${S.page === 'home' ? 'Home' : S.page === 'download' ? 'Downloader' : S.page === 'convert' ? 'Converter' : S.page === 'pdf' ? 'PDF' : S.page === 'transcribe' ? 'Transcribe' : S.page === 'drop' ? 'File drop' : S.page === 'settings' ? 'Settings' : 'Vault'}</span></header>`;
  if (S.page === 'setup') { $app.innerHTML = title + setupView(); $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = keep[i] || 0; }); return; }
  const live = liveItems(ITEMS);
  const item = ([id, l, n]) =>
    `<button type="button" class="navitem" data-go="${id}" ${S.page === id ? 'aria-current="page"' : ''}>${icon(id)}<span class="navitem-label">${l}</span><span class="navitem-count">${n}</span></button>`;
  const dlDone = (DL?.jobs || []).filter((j) => j.state === 'done').length;
  const cvDone = (CV?.jobs || []).filter((j) => j.state === 'done').length;
  const pdfDone = pdfJobs().filter((j) => j.state === 'done').length;
  const nav = `<div class="rail-nav">${item(['home', 'Home', ''])}</div>
    <div class="rail-group eyebrow">Downloader</div><div class="rail-nav">${item(['download', 'Download', dlDone || ''])}</div>
    <div class="rail-group eyebrow">Converter</div><div class="rail-nav">${item(['convert', 'Convert', cvDone || ''])}</div>
    <div class="rail-group eyebrow">PDF</div><div class="rail-nav">${item(['pdf', 'PDF tools', pdfDone || ''])}</div>
    <div class="rail-group eyebrow">Transcribe</div><div class="rail-nav">${item(['transcribe', 'Transcribe', trJobs().filter((j) => j.state === 'done').length || ''])}</div>
    <div class="rail-group eyebrow">File drop</div><div class="rail-nav">${item(['drop', 'File drop', dropNew() || ''])}</div>
    <div class="rail-group eyebrow">Vault</div><div class="rail-nav">${[['deleted', 'Deleted', live.length], ['phones', 'Phones', ST.phones.length]].map(item).join('')}</div>
    <div class="rail-sep"></div><div class="rail-nav" style="margin-top:8px">${item(['settings', 'Settings', ''])}</div>`;
  const d = vaultDrive();
  const box = S.page === 'home' ? '' : S.page === 'drop' && DROPST ? `<div class="vaultbox">
        <div class="eyebrow">Files sent here go to</div>
        <div class="vaultbox-path">${esc(DROPST.dir)}</div>
        <div class="vaultbox-stat"><b>${dropJobs().length}</b> in the last 7 days</div>
        <div class="vaultbox-stat">Clipboard sync ${DROPST.clipSync ? '<b>on</b>' : 'off'}</div>
      </div>` : S.page === 'transcribe' && TRST ? `<div class="vaultbox">
        <div class="eyebrow">Text and subtitles go to</div>
        <div class="vaultbox-path">${esc(TRST.dir)}</div>
        <div class="vaultbox-stat"><b>${trJobs().filter((j) => j.state === 'done').length}</b> done · <b>${esc(nice(TRST.free))}</b> free</div>
        <div class="vaultbox-stat">and back to the phone that sent them</div>
      </div>` : S.page === 'pdf' && PDFST ? `<div class="vaultbox">
        <div class="eyebrow">New PDFs go to</div>
        <div class="vaultbox-path">${esc(PDFST.dir)}</div>
        <div class="vaultbox-stat"><b>${pdfDone}</b> done · <b>${esc(nice(PDFST.free))}</b> free</div>
        <div class="vaultbox-stat">and back to the phone that sent them</div>
      </div>` : S.page === 'convert' && CV ? `<div class="vaultbox">
        <div class="eyebrow">Converted files go to</div>
        <div class="vaultbox-path">${esc(CV.dir)}</div>
        <div class="vaultbox-stat"><b>${cvDone}</b> done · <b>${esc(nice(CV.free))}</b> free</div>
        <div class="vaultbox-stat">and back to the phone that sent them</div>
      </div>` : S.page === 'download' && DL ? `<div class="vaultbox">
        <div class="eyebrow">Downloads go to</div>
        <div class="vaultbox-path">${esc(DL.dir)}</div>
        <div class="vaultbox-stat"><b>${dlDone}</b> saved · <b>${esc(nice(DL.free))}</b> free</div>
        <div class="vaultbox-stat">and back to the phone that sent the link</div>
      </div>` : `<div class="vaultbox">
        <div class="eyebrow">Saved on this PC</div>
        <div class="vaultbox-path">${esc(c.vaultDir || 'Not picked yet')}</div>
        ${d ? `<div class="capacity"><i style="width:${usedPct(d).toFixed(1)}%"></i></div>` : ''}
        ${ST.free ? `<div class="vaultbox-stat"><b>${esc(nice(ST.free))}</b> free</div>` : ''}
        <div class="vaultbox-stat">${live.length ? `<b>${live.length}</b> deleted ${live.length === 1 ? 'item' : 'items'} kept` : 'Nothing deleted yet'}</div>
      </div>`;
  $app.innerHTML = `${title}
  <div class="shell">
    <nav class="rail" aria-label="Sections">
      <div>${nav}</div><div></div>
      ${box}
    </nav>
    ${S.page === 'home' ? homeView(live, dlDone, cvDone) : S.page === 'phones' ? phonesView() : S.page === 'settings' ? settingsView() : S.page === 'download' ? downloadView() : S.page === 'convert' ? convertView() : S.page === 'pdf' ? pdfView() : S.page === 'transcribe' ? trView() : S.page === 'drop' ? dropView() : deletedView()}
  </div>
  ${statusBar()}${S.pair && S.page === 'phones' ? pairSheet() : ''}${updSheet()}`;
  $app.querySelectorAll('.scroller').forEach((n, i) => { n.scrollTop = keep[i] || 0; });
  const f = focusId && document.getElementById(focusId);
  if (f && f !== document.activeElement) { f.focus(); try { f.setSelectionRange(caret[0], caret[1]); } catch (e) {} }
  lazyMedia($app);
}

function setSize(pct) {
  document.documentElement.style.zoom = pct / 100;
  $app.style.setProperty('--z', pct / 100);
}

function statusBar() {
  const c = ST.config, bits = [];
  for (const p of ST.phones) {
    const st = p.Status || {};
    if (p.Kind === 'iphone') bits.push(['is-idle', p.Name, `backed up ${whenShort(new Date(p.LastSeen))}`]);
    else if (fresh(p) && st.watching !== false) bits.push(['', p.Name, 'watching the bin']);
    else bits.push(['is-warn', p.Name, 'last seen ' + ago(p.LastSeen)]);
  }
  if (!ST.phones.length && c.vaultDir) bits.push(['is-idle', 'Vault on ' + c.vaultDir.slice(0, 2), (ST.free ? nice(ST.free) : '?') + ' free']);
  if (ST.moving) bits.push(['is-warn', 'Moving the vault…', '']);
  for (const w of ST.warnings || []) bits.push(['is-warn', w, '']);
  const running = (DL?.jobs || []).filter((j) => j.state === 'running' || j.state === 'queued').length;
  if (running) bits.push(['', 'Downloading', String(running)]);
  const converting = (CV?.jobs || []).filter((j) => j.state === 'running' || j.state === 'queued').length;
  if (converting) bits.push(['', 'Converting', String(converting)]);
  const pdfing = pdfJobs().filter((j) => j.state === 'running' || j.state === 'queued').length;
  if (pdfing) bits.push(['', 'PDF tools', String(pdfing)]);
  const tring = trJobs().filter((j) => j.state === 'running' || j.state === 'queued').length;
  if (tring) bits.push(['', 'Transcribing', String(tring)]);
  if (TRST?.engine?.state === 'installing') bits.push(['is-idle', 'Speech engine', `getting it ${TRST.engine.pct}%`]);
  if (DL && !DL.ready) bits.push(['is-idle', 'Download engines', 'setting up']);
  const row = ([cls, name, text]) => `<span class="st ${cls}"><i class="dotlight"></i><b>${esc(name)}${text ? ':' : ''}</b>${text ? `<span>${esc(text)}</span>` : ''}</span>`;
  return `<footer class="statusbar">${bits.map(row).join('')}<span class="statusbar-ver">Premade Tools ${esc(ST.version)}</span></footer>`;
}

// ---------- Home ----------
function homeView(live, dlDone, cvDone) {
  const dlRun = (DL?.jobs || []).filter((j) => j.state === 'running' || j.state === 'queued').length;
  const cvRun = (CV?.jobs || []).filter((j) => j.state === 'running' || j.state === 'queued').length;
  return `<main class="home scroller">
    <div class="pagehead"><div><h1 class="pagetitle">Your tools</h1><p class="pagelede">Pick a tool to open it. Everything runs on this PC.</p></div></div>
    ${homeCards('go', [
      ['download', 'dl', 'Downloader', 'Paste a link from TikTok, Instagram, YouTube and more, and save it.', dlRun ? `<b>${dlRun}</b> downloading now` : tally(dlDone, 'download saved', 'downloads saved')],
      ['convert', 'convert', 'Converter', 'Turn photos, videos, audio and documents into other formats.', cvRun ? `<b>${cvRun}</b> converting now` : tally(cvDone, 'file converted', 'files converted')],
      ['pdf', 'pdf', 'PDF', 'Merge, split, reorder, compress and lock PDFs.', pdfBusy() ? '<b>Working</b> on PDFs now' : tally(pdfJobs().filter((j) => j.state === 'done').length, 'PDF done', 'PDFs done')],
      ['transcribe', 'transcribe', 'Transcribe', 'Turn voice memos and videos into text and subtitles.', trBusy() ? '<b>Listening</b> now' : tally(trJobs().filter((j) => j.state === 'done').length, 'file transcribed', 'files transcribed')],
      ['drop', 'drop', 'File drop', 'Send files, links and text between this PC and your phones.', dropNew() ? `<b>${dropNew()}</b> new from your phones` : tally(dropJobs().length, 'drop this week', 'drops this week')],
      ['deleted', 'shield', 'Vault', 'Keeps what you delete on your phones, so you can get it back.', `${tally(live.length, 'deleted item', 'deleted items')} kept · ${tally(ST.phones.length, 'phone', 'phones')}`]])}
  </main>`;
}

// ---------- Deleted ----------
function shownItems() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => !it.dismissed && (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) &&
    (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}

function deletedView() {
  const live = liveItems(ITEMS), n = (f) => live.filter(f).length;
  const phoneOpts = [['all', 'All phones', live.length], ...ST.phones.map((p) => [p.ID, p.Name, n((i) => i.phone === p.ID)])];
  const typeOpts = [['all', 'All types', live.length], ['photo', 'Photos', n((i) => i.kind === 'photo')], ['video', 'Videos', n((i) => i.kind === 'video')], ['voice', 'Voice', n((i) => i.kind === 'voice')], ['file', 'Files', n((i) => i.kind === 'file')]];
  const pills = (opts, key) => opts.map(([id, l, c]) => `<button type="button" class="pill" data-${key}="${esc(id)}" aria-pressed="${S[key] === id}">${esc(l)} <i>${c}</i></button>`).join('');
  const twoPhones = phoneOpts.length > 2;
  const count = '<span class="visiblecount" id="count"></span>';
  const body = deletedBody();
  const it = items().find((i) => i.id === S.sel);
  return `<main class="page" data-panel="${it ? 'open' : 'closed'}">
    <section class="feed">
      <div class="pagehead">
        <div><h1 class="pagetitle">Deleted</h1><p class="pagelede">Everything you deleted on your phones since setup, newest first.</p></div>
        <label class="search">${icon('search')}<span class="sr">Search deleted files</span><input type="search" id="q" value="${esc(S.q)}" placeholder="Search by name or folder"></label>
      </div>
      <div class="filterbar">
        ${twoPhones ? `<div class="filterrow" role="group" aria-label="Phone"><span class="filterlabel">Phone</span>${pills(phoneOpts, 'phone')}${count}</div>` : ''}
        <div class="filterrow" role="group" aria-label="Type"><span class="filterlabel">Type</span>${pills(typeOpts, 'type')}${twoPhones ? '' : count}</div>
      </div>
      <div id="dl">${body}</div>
    </section>
    <aside class="inspector" id="insp" aria-label="Selected file">${it ? inspector(it) : ''}</aside>
  </main>`;
}

const items = () => shownItems().filter((it) => !it.missed);
const countLabel = () => `<b>${items().length}</b> ${items().length === 1 ? 'item' : 'items'}`;

function deletedBody() {
  const all = shownItems(), list = all.filter((i) => !i.missed);
  if (!list.find((i) => i.id === S.sel)) S.sel = S.closed ? null : list[0]?.id || null;
  const notes = all.filter((i) => i.missed).map((it) => `<div class="failnote" role="status">${icon('alert')}<span><b>${esc(it.name)}</b> couldn't be saved. ${esc(it.note || 'It was deleted from ' + phoneName(it.phone) + ' without using the Recycle bin.')}</span><button type="button" class="quiet" data-dismiss="${it.id}">Dismiss</button></div>`).join('');
  setTimeout(() => { const n = $('count'); if (n) n.innerHTML = countLabel(); });
  if (!liveItems(ITEMS).length) return notes + `<div class="empty">${icon('deleted')}<h2>Nothing deleted yet</h2><p>From now on, anything you delete on your phones shows up here, newest first.</p></div>`;
  if (!list.length) return notes + `<div class="empty">${icon('search')}<h2>Nothing matches that</h2><p>Try another name, or clear the filters.</p></div>`;
  const groups = [];
  for (const it of list) {
    const day = dayOf(new Date(it.deletedAt));
    if (groups.at(-1)?.day !== day) groups.push({ day, cards: [] });
    groups.at(-1).cards.push(cardView(it));
  }
  return notes + `<div class="gridscroll scroller">${groups.map((g) => `<section class="daygroup"><div class="dayhead"><b>${g.day}</b><span>${g.cards.length}</span><i></i></div><div class="grid">${g.cards.join('')}</div></section>`).join('')}</div>`;
}

function cardView(it) {
  const d = new Date(it.deletedAt);
  return `<button type="button" class="card" data-sel="${it.id}" aria-pressed="${S.sel === it.id}">
    <span class="media">${tile(it, fileUrl(it.id), /\.(heic|heif|dng)$/i.test(it.name))}${FLOW[it.id]?.done ? `<span class="restoredmark">${icon('check')}</span>` : ''}</span>
    <span class="card-meta"><span class="card-name">${esc(it.name)}</span><span class="card-phone">${esc(phoneName(it.phone))}</span>
    <span class="card-when">${it.byTime ? 'by ' : ''}${whenShort(d)}</span><span class="card-days ${keptClass(it, ST.config.keep)}">${keptLabel(it, ST.config.keep)}</span></span></button>`;
}

function inspector(it) {
  const src = fileUrl(it.id);
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}#t=0.1" controls preload="metadata"></video>`
    : it.kind === 'voice' ? `${wave(it.id, 44)}<audio src="${src}" controls preload="none"></audio>` : `${doc()}<span class="tag is-doc">${esc(ext(it.name) || 'FILE')}</span>`;
  return `<div class="inspector-head"><span class="eyebrow">${kicker(it)}</span><button type="button" class="iconbtn" data-closeinsp aria-label="Close">${icon('x')}</button></div>
    <div class="inspector-body scroller">
      <div class="preview">${pv}</div>
      <p class="detail-name">${esc(it.name)}</p>
      <p class="detail-kind">${kindLabel(it)}, ${size(it.size)}</p>
      <dl class="kv">
        <div><dt>Deleted</dt><dd class="mono">${it.byTime ? 'By ' : ''}${whenShort(new Date(it.deletedAt))}</dd></div>
        <div><dt>From</dt><dd>${esc(phoneName(it.phone))}</dd></div>
        <div><dt>Was in</dt><dd class="mono">${esc(it.folder)}</dd></div>
        <div><dt>Type and size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd></div>
        <div><dt>Kept</dt><dd class="mono ${keptClass(it, ST.config.keep)}">${keptLabel(it, ST.config.keep)}</dd></div>
      </dl>
    </div>
    <div class="actions">${actions(it)}</div>`;
}

function actions(it) {
  const f = FLOW[it.id], p = phoneById(it.phone);
  if (f?.done) return `<div class="done">${icon('check')}<span class="done-text">Restored. It's back in ${esc(f.folder)}.<em>on ${esc(f.name)}</em></span></div><div class="actions-quiet"><button type="button" class="quiet" data-flowclear="${it.id}">Done</button></div>`;
  if (f?.wait || p?.Pending?.includes(it.id)) return `<div class="restoring"><div class="restoring-row">${icon('spin', 'spin')}Restoring…</div><div class="progline"><span></span></div>${f?.wait ? `<p>${esc(f.wait)}</p>` : ''}</div>`;
  if (f === 'confirm') return `<div class="confirm"><p class="confirm-text">Delete this from the vault?</p><p class="confirm-sub">The copy on this PC is deleted. It can't be brought back.</p>
    <div class="confirm-row"><button type="button" class="btn small" data-flowclear="${it.id}">Keep it</button><button type="button" class="btn small danger" data-dismiss="${it.id}">Dismiss</button></div></div>`;
  return `<div class="actions-stack">
      ${p ? `<button type="button" class="btn primary block" data-restore="${it.id}">Restore to ${esc(p.Name)}</button>` : ''}
      <button type="button" class="btn block" data-save="${it.id}">Save to PC</button>
    </div>
    <div class="msg" role="status">${esc(S.msg)}</div>
    <div class="actions-quiet"><button type="button" class="quiet" data-askdismiss="${it.id}">Dismiss</button></div>`;
}

function paintInspector() {
  const it = items().find((i) => i.id === S.sel);
  const page = $app.querySelector('.page[data-panel]');
  if (!page) return;
  page.dataset.panel = it ? 'open' : 'closed';
  $('insp').innerHTML = it ? inspector(it) : '';
}

// ---------- Phones ----------
function phoneFig(p, dot) {
  return `<div class="phonefig ${p.Kind === 'iphone' ? 'is-ios' : ''}"><div class="phonefig-body"><div class="phonefig-screen"><span class="phonefig-cam"></span><span class="phonefig-glow"></span></div></div><span class="statedot ${dot}"></span></div>`;
}
const forgetFoot = (p) => S.ask?.forget === p.ID
  ? `<div class="pcard-foot"><span class="forget-text">Forget ${esc(p.Name)}? <span>It stops sending deleted files. Files already saved stay in the vault.</span></span><button type="button" class="btn small" data-askclear>Keep it</button><button type="button" class="btn small danger" data-forget="${p.ID}">Forget</button></div>`
  : `<div class="pcard-foot"><button type="button" class="quiet" data-askforget="${p.ID}">Forget this phone</button></div>`;
const countBox = (n, month) => `<div class="pcard-count"><span class="count-n">${n}</span><span class="count-label">${n === 1 ? 'item' : 'items'} saved</span>${month === undefined ? '' : `<span class="count-month">${month} this month</span>`}</div>`;

function phonesView() {
  const live = liveItems(ITEMS);
  const cards = ST.phones.map((p) => {
    const st = p.Status || {}, up = fresh(p), saved = live.filter((i) => i.phone === p.ID);
    if (p.Kind === 'iphone') return `<section class="pcard"><div class="pcard-top">${phoneFig(p, '')}
      <div class="pcard-main"><div class="pcard-id"><span class="pcard-name">${esc(p.Name)}</span><span class="kindtag">iPhone</span></div>
        <div class="pcard-state"><span class="sbadge"><i></i>Backs up at home</span><span class="lastseen">Last backup ${whenShort(new Date(p.LastSeen))}</span></div>
        <dl class="ipkv"><div><dt>Runs when</dt><dd>It joins your home Wi-Fi, and when it starts charging</dd></div>
        <div><dt>Covers</dt><dd>Photos and videos, screenshots, screen recordings, WhatsApp and Telegram media</dd></div>
        <div><dt>Not covered</dt><dd class="muted">Voice memos and call recordings</dd></div></dl></div>
      ${countBox(saved.length)}</div>
      <div class="pnote">${icon('info')}<span>The iPhone hides its Recently Deleted album from apps, so this PC keeps a hidden copy and shows a file here once it's gone from the iPhone.</span></div>${forgetFoot(p)}</section>`;
    const month = saved.filter((i) => Date.now() - new Date(i.deletedAt) < 30 * 864e5).length;
    const checks = [[st.binOn !== false, 'Recycle bin on', "Gallery's Recycle bin looks off"], [st.allFiles, 'All files access', 'All files access is off'], [st.battery, 'Battery Unrestricted', 'Battery is not Unrestricted']];
    const bad = checks.find(([ok]) => !ok);
    return `<section class="pcard"><div class="pcard-top">${phoneFig(p, up ? 'is-good' : 'is-warn')}
      <div class="pcard-main"><div class="pcard-id"><span class="pcard-name">${esc(p.Name)}</span><span class="kindtag">Android</span></div>
        <div class="pcard-state"><span class="sbadge ${up ? 'is-good' : 'is-warn'}"><i></i>${up ? 'Watching the bin' : 'Not seen lately'}</span><span class="lastseen">${up ? 'Last check' : 'Last seen'} ${ago(p.LastSeen)}${p.Restores ? ` · ${plural(p.Restores, 'file')} waiting to restore` : ''}</span></div>
        <ul class="checks">${checks.map(([ok, yes]) => `<li class="check ${ok ? '' : 'is-bad'}">${icon(ok ? 'check' : 'x')}${yes}</li>`).join('')}</ul></div>
      ${countBox(saved.length, month)}</div>
      ${bad ? `<div class="fixstrip">${icon('alert')}<span><b>${bad[2]}.</b> Open Vault on the phone and tap Fix.</span></div>` : ''}${forgetFoot(p)}</section>`;
  }).join('');
  return `<main class="plain"><div class="pagehead"><div><h1 class="pagetitle">Phones</h1><p class="pagelede">The phones that send what you delete to this PC.</p></div>
      <button type="button" class="btn primary" data-pair>${icon('plus')}Add a phone</button></div>
    <p class="hint">${icon('info')}Files an app deletes without the bin can't be saved. You'll see a note when that happens.</p>
    <div class="phonelist scroller">${cards || `<div class="empty">${icon('phones')}<h2>No phones yet</h2><p>Add a phone and it starts sending what you delete to this PC.</p></div>`}</div></main>`;
}

function pairSheet() {
  const got = ST.phones.length > S.pairBase ? ST.phones.at(-1) : null;
  return `<div class="backdrop" data-closepair><section class="sheet" role="dialog" aria-label="Add a phone">
    <div class="sheet-head"><div><h2 class="sheet-title">Add a phone</h2><p class="sheet-sub">Scan with the phone's camera.</p></div><button type="button" class="iconbtn" data-closepair aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body"><div class="qr"><img src="${S.pair.qr}" alt="QR code to pair a phone"></div>
      <div class="osteps"><div><b>Android</b><p>Install Premade Tools from the page it opens, then allow All files access.</p></div>
      <div><b>iPhone</b><p>In Safari, tap Share, then Add to Home Screen, then add the Vault shortcut.</p></div></div></div>
    <div class="waitrow">${got ? `<span class="good">${icon('check')}</span><span>${esc(got.Name)} connected.</span>` : `<i class="pulse"></i><span>Waiting for a phone… <span>The phone must be on the same Wi-Fi as this PC.</span></span>`}</div>
    <div class="sheet-foot">${esc(S.pair.url)}</div></section></div>`;
}

// The pop-up that offers a new version. "Later" hides it until the window opens again.
function updSheet() {
  if (!ST.update || (S.updLater === ST.update && !S.updBusy)) return '';
  const busy = S.updBusy;
  return `<div class="backdrop"><section class="sheet upd" role="dialog" aria-modal="true" aria-label="Update ready">
    <div class="upd-body"><img class="upd-crest" src="/icon.svg" alt=""><h2 class="sheet-title">Update ready</h2>
      <p class="upd-text">Premade Tools <b class="mono">${esc(ST.update)}</b> is out. You have <span class="mono">${esc(ST.version)}</span>.</p>
      ${busy ? `<p class="upd-text" role="status">${esc(busy)}</p>` : ''}</div>
    <div class="upd-foot"><button type="button" class="btn" data-updlater ${busy ? 'disabled' : ''}>Later</button><button type="button" class="btn primary" data-updnow ${busy ? 'disabled' : ''}>Update now</button></div></section></div>`;
}

// ---------- Settings ----------
function settingsView() {
  const c = ST.config, d = vaultDrive();
  const sw = (k, label, hint) => `<label class="row"><span class="row-text"><span class="row-title">${label}</span>${hint ? `<span class="row-hint">${hint}</span>` : ''}</span><input type="checkbox" class="switch" role="switch" data-set="${k}" ${c[k] ? 'checked' : ''}></label>`;
  const themes = [...THEMES.map(([id, l, bg, , ac]) => [id, l, bg, ac]), ['custom', 'Custom', '#1d1d20', c.custom]];
  const healthBad = (ST.warnings || []).some((w) => /health/i.test(w));
  const total = d ? toBytes(d.Total) : 0, vaultPct = total ? toBytes(ST.bytes) / total * 100 : 0, usedTotal = d ? usedPct(d) : 0;
  const ask = S.ask?.keep;
  return `<main class="plain"><div class="pagehead"><div><h1 class="pagetitle">Settings</h1><p class="pagelede">Downloads and logins, the converter, PDF tools, Transcribe, File drop, where the vault lives, and how the app looks.</p></div></div>
  <div class="settings scroller">
    ${dlSettings()}
    ${cvSettings()}
    ${pdfSettings()}
    ${trSettings()}
    ${dropSettings()}
    <h2 class="group-label" style="margin-top:22px">Vault</h2>
    <section class="hero">
      <div class="hero-head"><p class="eyebrow">Your vault</p>${c.warnHealth ? `<span class="health ${healthBad ? 'is-warn' : ''}"><i class="dotlight"></i>Drive health <b>${healthBad ? 'Needs a look' : 'No warnings'}</b></span>` : ''}</div>
      <div class="vaultpath"><div>${esc(c.vaultDir)}</div><button type="button" class="btn" data-move ${ST.moving ? 'disabled' : ''}>Move…</button></div>
      <p class="hero-hint">${ST.moving ? 'Moving the vault…' : 'Pick a new folder and the vault moves there in the background.'}</p>
      ${d ? `<div class="hero-rule"></div>
      <div class="drive-line"><b>Drive ${esc(d.Root.slice(0, 2))} ${d.Label ? `"${esc(d.Label)}"` : ''}</b><span>${esc(nice(d.Total))}</span></div>
      <div class="cap"><i class="cap-vault" style="width:${vaultPct.toFixed(2)}%"></i><i class="cap-other" style="width:${Math.max(0, usedTotal - vaultPct).toFixed(2)}%"></i></div>
      <ul class="caplegend"><li><i class="legdot is-vault"></i>Vault <b>${esc(ST.bytes || '0 B')}</b></li><li><i class="legdot is-other"></i>Other files</li><li><i class="legdot is-free"></i>Free <b>${esc(nice(d.Free))}</b> of ${esc(nice(d.Total))}</li></ul>` : ''}
    </section>
    <div class="cols">
      <div class="col">
        <section><h2 class="group-label">Keeping</h2><div class="rows">
          <div class="row is-stacked"><div class="row-text"><span class="row-title">Keep deleted items</span><span class="row-hint">Only files deleted longer ago than this are cleared. Shortening it shows you what would go first.</span></div>
            <div class="row-ctl"><div class="seg">${KEEP.map(([id, l]) => `<button type="button" data-keep="${id}" aria-pressed="${(ask?.id || c.keep) === id}">${l}</button>`).join('')}</div></div></div>
          ${ask ? `<div class="row is-stacked"><div class="confirm"><p class="confirm-text">This clears ${plural(ask.count, 'file')} (${esc(ask.size)}) deleted more than ${esc(ask.label)} ago.</p><p class="confirm-sub">They can't be brought back.</p>
            <div class="confirm-row"><button type="button" class="btn small" data-askclear>Keep them</button><button type="button" class="btn small danger" data-keepyes="${ask.id}">Clear them</button></div></div></div>` : ''}
          <label class="row"><span class="row-text"><span class="row-title">Shrink old deleted videos</span><span class="row-hint">Videos deleted more than 3 months ago get shrunk by your graphics card. They look almost the same but aren't the exact originals. Coming in a later update.</span></span><input type="checkbox" class="switch" role="switch" disabled></label>
        </div></section>
        <section><h2 class="group-label">App</h2><div class="rows">
          ${sw('startWin', 'Start with Windows')}
          <div class="row"><div class="row-text"><span class="row-title mono">Premade Tools ${esc(ST.version)}</span>${S.updMsg ? `<span class="row-hint" role="status">${esc(S.updMsg)}</span>` : ''}</div><button type="button" class="btn small" data-update>Check for updates</button></div>
          <div class="row"><div class="row-text"><span class="row-title">Setup</span></div><button type="button" class="btn small" data-rerun>Show setup again</button></div>
        </div></section>
      </div>
      <div class="col">
        <section><h2 class="group-label">Look</h2><div class="rows">
          <div class="row is-stacked"><div class="row-text"><span class="row-title">Theme</span></div>
            <div class="row-ctl swatches">${themes.map(([id, l, bg, ac]) => `<button type="button" class="swatch" data-theme-pick="${id}" aria-pressed="${c.theme === id}" style="--sw-bg:${bg};--sw-ac:${esc(ac)}"><i></i><span>${l}</span></button>`).join('')}</div>
            ${c.theme === 'custom' ? `<label class="colorpick">Colour <input type="color" id="custom" value="${esc(c.custom)}"></label>` : ''}</div>
          <div class="row is-stacked"><div class="row-head"><div class="row-text"><span class="row-title">App size</span></div><span class="row-value" id="sizeval">${c.size}%</span></div>
            <div class="row-ctl"><div class="sizerow"><span>80%</span><input class="range" type="range" min="80" max="140" step="10" value="${c.size}" id="size" aria-label="App size"><span>140%</span></div></div></div>
        </div></section>
        <section><h2 class="group-label">Warnings</h2><div class="rows">
          ${sw('warnPhone', "When a phone hasn't checked in for 3 days")}
          ${sw('warnHealth', "When the vault drive's health drops")}
          ${sw('warnSpace', 'When the vault drive runs low on space')}
        </div></section>
      </div>
    </div>
  </div></main>`;
}

// ---------- Setup ----------
const STEPS = ['Where your vault lives', 'Your Android phone', 'Your iPhone', "You're set"];
function setupView() {
  const n = S.step;
  const marks = STEPS.map((l, i) => {
    const state = i + 1 < n ? 'done' : i + 1 === n ? 'current' : 'next';
    return `<div class="steprow" data-state="${state}"><span class="stepmark">${state === 'done' ? icon('check') : i + 1}</span><span class="steptext"><span class="steplabel">${l}</span>${state === 'next' ? '' : `<span class="stepnote">${state === 'done' ? 'Done' : 'Now'}</span>`}</span></div>`;
  }).join('');
  let title, lede = '', body, note;
  const kind = n === 2 ? 'android' : 'iphone', ofKind = ST.phones.filter((p) => p.Kind === kind);
  const got = (n === 2 || n === 3) && ofKind.length > (S.basePhones || 0);
  if (n === 1) {
    title = 'Where should your vault live?';
    lede = 'This is where everything you delete on your phones is kept. Pick the drive with the most room. You can move it later in Settings.';
    note = 'You can move the vault later in Settings.';
    body = `<p class="grouplabel">Pick a drive</p>
      <div class="drives" role="radiogroup" aria-label="Drive">${(S.drives || []).map((d) => {
        const used = usedPct(d), tight = used > 80;
        return `<button type="button" class="drive" role="radio" data-drive="${esc(d.Root)}" aria-checked="${S.drive === d.Root}"><span class="radio"></span><span>
          <span class="drive-top"><span class="drive-name"><span class="mono">${esc(d.Root.slice(0, 2))}</span> ${esc(d.Label || 'Local disk')}</span>${d.System ? '<span class="drivetag">Windows drive</span>' : ''}<span class="drive-size">${esc(nice(d.Total))}</span></span>
          <span class="capacity" style="display:block"><i class="${tight ? 'is-tight' : ''}" style="width:${used.toFixed(1)}%"></i></span>
          <span class="drive-free ${tight ? 'is-tight' : ''}" style="display:block"><b>${esc(nice(d.Free))}</b> free</span></span></button>`;
      }).join('')}</div>
      <p class="grouplabel">Vault folder</p>
      <div class="folderrow"><label class="folderfield">${icon('folder')}<input id="folder" value="${esc(S.folder)}" aria-label="Vault folder"></label><button type="button" class="btn" data-pickfolder>Change…</button></div>
      <div class="callout">${icon('shield')}<p>The vault holds the only copy of what you delete, so Vault keeps an eye on this drive's health and warns you early if it starts to fail.</p></div>
      <div class="msg bad" role="status">${esc(S.msg)}</div>`;
  } else if (n === 2 || n === 3) {
    title = `Connect your ${n === 2 ? 'Android phone' : 'iPhone'}`;
    note = 'You can add this phone later from Phones.';
    const steps = n === 2 ? `<li><span>Open the camera on the phone and <b>scan this code</b>.</span></li><li><span>Install <b>Premade Tools</b> from the page it opens.</span></li><li><span>Allow <b>All files access</b>, and set the battery to <b>Unrestricted</b> when the app asks.</span></li><li><span>Keep Gallery's <b>Recycle bin</b> on <span class="path">(Gallery › Menu › Settings › Recycle bin)</span>.</span></li>`
      : `<li><span><b>Scan this code</b> with the iPhone's camera. Vault opens in Safari.</span></li><li><span>Tap Share, then <b>Add to Home Screen</b>.</span></li><li><span>Open Vault from your home screen and tap <b>Add the shortcut</b>. It then walks you through its two automations: joining home Wi-Fi and starting to charge.</span></li><li><span>In WhatsApp and Telegram, turn on <b>Save to Photos</b>.</span></li>`;
    body = `<div class="pairgrid"><div class="qrwrap"><div class="qr">${S.pair ? `<img src="${S.pair.qr}" alt="QR code to pair">` : ''}</div><span class="qrnote">Pairing code for this PC</span></div><ol class="howto">${steps}</ol></div>
      ${got ? `<div class="waiting is-on"><span class="checkmark">${icon('check')}</span><span class="waiting-text"><span class="waiting-title">${esc(ofKind.at(-1).Name)} connected.</span><span class="waiting-sub">${n === 2 ? "It's watching the Recycle bin." : 'It backs up when it joins your home Wi-Fi or starts charging.'}</span></span></div>`
        : `<div class="waiting"><span class="beacon"><i></i></span><span class="waiting-text"><span class="waiting-title">Waiting for your ${n === 2 ? 'phone' : 'iPhone'}…</span><span class="waiting-sub">It must be on the same Wi-Fi as this PC.</span></span></div>`}`;
  } else {
    title = "You're set";
    note = 'You can change any of this later in Settings.';
    const d = vaultDrive();
    body = `<div class="done-hero"><span class="done-seal">${icon('check')}</span><p class="done-copy">From now on, anything you delete on your phones shows up in <b>Deleted</b>, newest first, and stays here after the phone's own bin empties.</p></div>
      <div class="summary"><p class="eyebrow">Your setup</p>
        <div class="summary-row"><span>Vault</span><span class="summary-val"><span class="mono">${esc(ST.config.vaultDir)}</span>${d ? `<small>Drive ${esc(d.Root.slice(0, 1))} "${esc(d.Label || 'Local disk')}", ${esc(nice(d.Total))}, ${esc(nice(d.Free))} free</small>` : ''}</span></div>
        <div class="summary-row"><span>Phones</span><span class="summary-val">${ST.phones.length ? ST.phones.map((p) => `<span class="phoneline"><i class="dotlight"></i>${esc(p.Name)}</span>`).join('') : '<span class="phoneline is-idle"><i class="dotlight"></i>No phones yet <em>add one from Phones</em></span>'}</span></div>
      </div>`;
  }
  const primary = n === 1 || n === 4 || got;
  const next = n === 4 ? 'Open Vault' : primary ? 'Next' : "Skip, I don't have one";
  return `<div class="setup">
    <aside class="brandpanel"><div class="brand-head"><span class="bigcrest"><img src="/icon.svg" alt=""></span><h1 class="brand-title">Vault</h1><p class="brand-lede">A safety net for what you delete on your phones. Four short steps.</p></div>
      <div class="steps">${marks}</div><div class="brand-foot">Premade Tools ${esc(ST.version)}</div></aside>
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
    if (d.go) { S.page = d.go; S.msg = ''; S.ask = null; if (d.go !== 'phones') S.pair = null; render(); if (d.go === 'settings') refresh(); }
    else if (d.phone) { S.phone = d.phone; render(); }
    else if (d.type) { S.type = d.type; render(); }
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
      if (p.Kind !== 'iphone') watchRestore(it);
    }
    else if (d.pair !== undefined) { S.pair = await api('/api/ui/pair'); S.pairBase = ST.phones.length; render(); soon(); }
    else if (d.closepair !== undefined) { S.pair = null; render(); }
    else if (d.askforget) { S.ask = { forget: d.askforget }; render(); }
    else if (d.askclear !== undefined) { S.ask = null; render(); }
    else if (d.forget) { await api('/api/ui/forget/' + d.forget, {}); S.ask = null; refresh(); }
    else if (d.keep) {
      S.ask = null;
      if (KEEPDAYS[d.keep] < KEEPDAYS[ST.config.keep]) {
        const p = await api('/api/ui/keep-preview?keep=' + d.keep);
        if (p.count) { S.ask = { keep: { id: d.keep, count: p.count, size: p.size, label: b.textContent.toLowerCase() } }; render(); return; }
      }
      await api('/api/ui/settings', { keep: d.keep }); refresh();
    }
    else if (d.keepyes) { await api('/api/ui/settings', { keep: d.keepyes }); S.ask = null; refresh(); }
    else if (d.themePick) { await api('/api/ui/settings', { theme: d.themePick }); refresh(); }
    else if (d.move !== undefined) {
      const r = await api('/api/ui/pickfolder', {});
      if (r.dir && confirm(`Move the vault to ${r.dir}? It copies in the background, then removes the old copy.`)) { await api('/api/ui/vault', { dir: r.dir }); refresh(); }
    }
    else if (d.updlater !== undefined) { S.updLater = ST.update; render(); }
    else if (d.updnow !== undefined) {
      S.updBusy = 'Downloading the update…'; render();
      const m = (await api('/api/ui/update', {})).msg;
      S.updBusy = /^Updating/.test(m) ? m : ''; S.updMsg = m;
      if (!S.updBusy) S.updLater = ST.update; // failed or already new: close it, Settings shows why
      render();
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
  else if (t.id === 'size') { await api('/api/ui/settings', { size: +t.value }); refresh(); }
  else if (t.id === 'custom') { await api('/api/ui/settings', { custom: t.value }); refresh(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.pair && S.page === 'phones') { S.pair = null; render(); } });

// Poll fast while waiting for a phone to pair, slowly otherwise.
let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(tick, 3000); };
async function tick() {
  const typing = document.activeElement && ['q', 'folder', 'dlurl', 'pdfpw'].includes(document.activeElement.id);
  if (!typing) await refresh();
  clearTimeout(timer);
  timer = setTimeout(tick, dlRunning() || cvRunning() || pdfBusy() || trBusy() || PDFST?.gs === 'installing' || CV?.office === 'installing' || (DL && !DL.ready) ? 1500 : S.pair || S.page === 'setup' || S.page === 'drop' ? 3000 : 30000);
}
refresh().then(() => { if (S.page === 'setup') enterStep(1); soon(); });
