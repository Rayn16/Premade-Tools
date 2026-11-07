// Vault's PC window. Plain JS: the server sends state, this draws it in Premade's look.
'use strict';

const S = { page: 'deleted', phone: 'all', type: 'all', q: '', sel: null, msg: '', pair: null, pairFor: null, step: 1, drive: null, folder: '', basePhones: 0, updMsg: '' };
let ST = null;      // /api/ui/state
let ITEMS = [];     // /api/ui/deleted
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
  plus: '<path d="M12 5v14M5 12h14"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
};
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TINT = { photo: 'var(--gold)', video: 'var(--accent)', voice: 'var(--good)', file: 'var(--muted)' };
const KEEP = [['forever', 'Forever'], ['2y', '2 years'], ['1y', '1 year'], ['6m', '6 months'], ['3m', '3 months']];
const KEEPDAYS = { forever: Infinity, '2y': 730, '1y': 365, '6m': 182, '3m': 91 };
const THEMES = [['red', 'Red and black', '#d9202d'], ['league', 'League', '#c8aa6e'], ['light', 'Light', '#f2eee4'], ['purple', 'Purple', '#7c4dff'], ['green', 'Green', '#27c381'], ['mono', 'Mono', '#ffffff'], ['custom', 'Custom', null]];

async function api(path, body) {
  const opt = { headers: { 'X-Vault': '1' } };
  if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return r.json();
}

async function refresh() {
  try {
    [ST, ITEMS] = await Promise.all([api('/api/ui/state'), api('/api/ui/deleted')]);
  } catch (e) { return; }
  if (!ST.config.setupDone && S.page !== 'setup') S.page = 'setup';
  render();
}

// ---------- time and size labels ----------
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
function dayOf(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = (t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5;
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier';
}
function whenShort(d) {
  const day = dayOf(d);
  return day === 'Earlier' ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm(d) : hm(d);
}
function whenLong(d) {
  const day = dayOf(d);
  return (day === 'Earlier' ? d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : day) + ', ' + hm(d);
}
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
const phoneById = (id) => (ST.phones || []).find((p) => p.ID === id);
const phoneName = (id) => phoneById(id)?.Name || 'Removed phone';
const kindLabel = (it) => it.kind === 'photo' ? (/screenshot/i.test(it.folder + it.name) ? 'Screenshot' : 'Photo') : it.kind === 'video' ? 'Video' : it.kind === 'voice' ? 'Voice recording' : (it.name.split('.').pop() || 'File').toUpperCase();

// ---------- frame ----------
function render() {
  if (!ST) return;
  const c = ST.config;
  $app.dataset.theme = c.theme || 'red';
  $app.style.setProperty('--c', c.custom || '#d9202d');
  document.documentElement.style.zoom = (c.size || 100) / 100;
  const nav = [['deleted', 'Deleted'], ['phones', 'Phones'], ['settings', 'Settings']].map(([id, l]) =>
    `<button type="button" class="navb" data-go="${id}" ${S.page === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${l}</span></button>`).join('');
  const kept = ST.count ? `${ST.count} deleted files kept` : 'Nothing deleted yet';
  $app.innerHTML = `
  <div class="wrap">
    <nav class="rail" aria-label="Sections">
      <div class="brand">Premade Tools</div>
      <div class="eyebrow">Vault</div>
      ${S.page === 'setup' ? '' : nav}
      <div class="railfoot">
        <span class="eyebrow" style="margin:0">Saved on this PC</span>
        <span class="mono">${esc(c.vaultDir || 'Not picked yet')}</span>
        <span class="small muted">${kept}</span>
      </div>
    </nav>
    <main>${S.page === 'setup' ? setupView() : S.page === 'phones' ? phonesView() : S.page === 'settings' ? settingsView() : deletedView()}</main>
  </div>
  ${statusBar()}`;
}

function statusBar() {
  const c = ST.config, bits = [];
  for (const p of ST.phones) {
    const st = p.Status ? p.Status : {};
    const fresh = Date.now() - new Date(p.LastSeen) < 2 * 3600e3;
    if (p.Kind === 'iphone') bits.push(`${esc(p.Name)}: backed up ${whenShort(new Date(p.LastSeen))}`);
    else bits.push(`${esc(p.Name)}: ${fresh && st.watching !== false ? 'watching the bin' : 'last seen ' + ago(p.LastSeen)}`);
  }
  if (c.vaultDir) bits.push(`Vault on ${esc(c.vaultDir.slice(0, 2))} · ${esc(ST.free || '?')} free`);
  if (ST.moving) bits.push('<span class="w">Moving the vault…</span>');
  for (const w of ST.warnings || []) bits.push(`<span class="w">${esc(w)}</span>`);
  return `<footer class="statusbar">${bits.map((b) => `<span>${b}</span>`).join('')}<span class="end">Premade Tools ${esc(ST.version)}</span></footer>`;
}

// ---------- Deleted ----------
function shownItems() {
  const q = S.q.trim().toLowerCase();
  return ITEMS.filter((it) => (S.phone === 'all' || it.phone === S.phone) && (S.type === 'all' || it.kind === S.type) &&
    (!q || (it.name + ' ' + it.folder).toLowerCase().includes(q)));
}

function deletedView() {
  const phoneOpts = [['all', 'All phones'], ...ST.phones.map((p) => [p.ID, p.Name])];
  const typeOpts = [['all', 'All types'], ['photo', 'Photos'], ['video', 'Videos'], ['voice', 'Voice'], ['file', 'Files']];
  const pills = (opts, key) => opts.map(([id, l]) => `<button type="button" class="pill" data-${key}="${esc(id)}" aria-pressed="${S[key] === id}">${esc(l)}</button>`).join('');
  return `
  <div class="head">
    <div><h1>Deleted</h1><p>Everything you deleted on your phones since setup, newest first.</p></div>
    <label class="search">${icon('search')}<span class="sr">Search deleted files</span>
      <input type="search" id="q" value="${esc(S.q)}" placeholder="Search by name"></label>
  </div>
  <div class="filters">
    ${phoneOpts.length > 2 ? `<div class="pills" role="group" aria-label="Phone">${pills(phoneOpts, 'phone')}</div>` : ''}
    <div class="pills" role="group" aria-label="Type">${pills(typeOpts, 'type')}</div>
    <span class="small muted" id="count"></span>
  </div>
  <div id="dl">${deletedBody()}</div>`;
}

function deletedBody() {
  const all = shownItems();
  const missed = all.filter((it) => it.missed);
  const items = all.filter((it) => !it.missed);
  if (!items.find((it) => it.id === S.sel)) S.sel = items[0]?.id || null;
  const notes = missed.map((it) => `<div class="notice" role="status">${icon('alert')}<span><b>${esc(it.name)}</b> couldn't be saved. ${esc(it.note || 'It was deleted from ' + phoneName(it.phone) + ' without using the Recycle bin.')}</span><button type="button" class="btn" data-dismiss="${it.id}">Dismiss</button></div>`).join('');
  if (!ITEMS.filter((i) => !i.missed).length) return notes + `<div class="card empty"><h2>Nothing deleted yet</h2><p>From now on, anything you delete on your phones shows up here, newest first.</p></div>`;
  let rows = '', last = null;
  for (const it of items) {
    const d = new Date(it.deletedAt), day = dayOf(d);
    if (day !== last) { rows += `<div class="dayh">${day}</div>`; last = day; }
    const thumb = it.kind === 'photo' && !/\.(heic|heif|dng)$/i.test(it.name) ? `<img src="/api/ui/file/${it.id}" alt="" loading="lazy">` : icon(it.kind);
    rows += `<button type="button" class="row" data-sel="${it.id}" aria-selected="${S.sel === it.id}">
      <span class="thumb" style="--t:${TINT[it.kind]}">${thumb}</span>
      <span class="rowmain"><span class="name">${esc(it.name)}</span><span class="where">${esc(phoneName(it.phone))} · ${esc(it.folder)}</span></span>
      <span class="rowend"><span>${it.byTime ? 'by ' : ''}${whenShort(d)}</span><span>${size(it.size)}</span></span></button>`;
  }
  const list = items.length ? `<div class="card list" role="listbox" aria-label="Deleted files">${rows}</div>` : `<div class="card empty">Nothing deleted matches that.</div>`;
  setTimeout(() => { const n = document.getElementById('count'); if (n) n.textContent = items.length + (items.length === 1 ? ' file' : ' files'); });
  return notes + `<div class="split">${list}${detailView(items.find((it) => it.id === S.sel))}</div>`;
}

function detailView(it) {
  if (!it) return '<div></div>';
  const src = `/api/ui/file/${it.id}`;
  const pv = it.kind === 'photo' ? `<img src="${src}" alt="Preview of ${esc(it.name)}" onerror="this.replaceWith(document.createTextNode('No preview for this photo type'))">`
    : it.kind === 'video' ? `<video src="${src}#t=0.1" controls preload="metadata"></video>`
    : it.kind === 'voice' ? `<audio src="${src}" controls preload="none"></audio>` : icon('file');
  const p = phoneById(it.phone);
  const keep = ST.config.keep === 'forever' ? 'Forever' : 'Until ' + new Date(new Date(it.deletedAt).getTime() + KEEPDAYS[ST.config.keep] * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `<aside class="card detail" aria-label="Selected file">
    <div class="preview">${pv}</div>
    <h2 style="overflow-wrap:anywhere">${esc(it.name)}</h2>
    <dl class="kv">
      <dt>Deleted</dt><dd>${it.byTime ? 'By ' : ''}${whenLong(new Date(it.deletedAt))}</dd>
      <dt>From</dt><dd>${esc(phoneName(it.phone))}</dd>
      <dt>Was in</dt><dd>${esc(it.folder)}</dd>
      <dt>Type and size</dt><dd>${kindLabel(it)}, ${size(it.size)}</dd>
      <dt>Kept</dt><dd>${keep}</dd>
    </dl>
    <div class="acts">
      ${p ? `<button type="button" class="btn primary" data-restore="${it.id}">${icon('restore')}Restore to ${esc(p.Name)}</button>` : ''}
      <button type="button" class="btn" data-save="${it.id}">${icon('save')}Save to PC</button>
    </div>
    <div class="msg" role="status">${esc(S.msg)}</div>
  </aside>`;
}

// ---------- Phones ----------
function pairBox() {
  return `<section class="card pair" aria-label="Pair a phone">
    <div class="qr">${S.pair ? `<img src="${S.pair.qr}" alt="QR code to pair a phone">` : ''}</div>
    <div style="display:grid;gap:10px;flex:1 1 320px;min-width:0">
      <h2>Scan with the phone's camera</h2>
      <ol class="steps">
        <li>Android: install Premade Tools from the page it opens, then allow All files access.</li>
        <li>iPhone: in Safari, tap Share, then Add to Home Screen, then add the Vault shortcut.</li>
      </ol>
      <span class="small muted"><span class="dot pulse"></span> Waiting for a phone… The phone must be on the same Wi-Fi as this PC.</span>
      <span class="mono small muted">${esc(S.pair?.url || '')}</span>
    </div></section>`;
}

function phonesView() {
  const cards = ST.phones.map((p) => {
    const st = p.Status || {};
    const fresh = Date.now() - new Date(p.LastSeen) < 2 * 3600e3;
    const ok = (b, yes, no) => `<li>${b ? icon('check', 'good') : icon('x', 'bad')}${b ? yes : no}</li>`;
    if (p.Kind === 'iphone') return `<section class="card phone">
      <div class="top">${icon('phones')}<h2>${esc(p.Name)}</h2><span class="badge ${fresh ? 'good' : 'warn'}">Backs up at home</span></div>
      <dl class="kv"><dt>Last backup</dt><dd>${whenLong(new Date(p.LastSeen))}</dd>
      <dt>Runs when</dt><dd>It joins your home Wi-Fi, and when it starts charging</dd>
      <dt>Covers</dt><dd>Photos and videos, screenshots, screen recordings, WhatsApp and Telegram media</dd>
      <dt>Not covered</dt><dd>Voice memos and call recordings</dd></dl>
      <p class="hint">The iPhone hides its Recently Deleted album from apps, so this PC keeps a hidden copy and shows a file here once it's gone from the iPhone.</p>
      <div><button type="button" class="btn" data-forget="${p.ID}">Forget this phone</button></div></section>`;
    const month = ITEMS.filter((i) => i.phone === p.ID && !i.missed && Date.now() - new Date(i.deletedAt) < 30 * 864e5).length;
    return `<section class="card phone">
      <div class="top">${icon('phones')}<h2>${esc(p.Name)}</h2><span class="badge ${fresh ? 'good' : 'warn'}">${fresh ? 'Watching the bin' : 'Not seen lately'}</span></div>
      <dl class="kv"><dt>Last check</dt><dd>${ago(p.LastSeen)}</dd>
      <dt>How it works</dt><dd>Anything that lands in the Recycle bin is sent here.</dd>
      <dt>Saved this month</dt><dd>${month} files</dd>
      ${p.Restores ? `<dt>Waiting to restore</dt><dd>${p.Restores} files</dd>` : ''}</dl>
      <ul class="checks">${ok(st.allFiles, 'All files access allowed', 'All files access is off')}${ok(st.battery, 'Battery set to Unrestricted', 'Battery is not Unrestricted')}${ok(st.binOn !== false, "Gallery's Recycle bin is on", "Gallery's Recycle bin looks off")}</ul>
      <p class="hint">Files an app deletes without the bin can't be saved. You'll see a note when that happens.</p>
      <div><button type="button" class="btn" data-forget="${p.ID}">Forget this phone</button></div></section>`;
  }).join('');
  return `<div class="head"><div><h1>Phones</h1><p>The phones that send what you delete to this PC.</p></div>
    <button type="button" class="btn primary" data-pair>${icon('plus')}Pair a phone</button></div>
    ${S.pair ? pairBox() : ''}
    ${cards ? `<div class="grid2">${cards}</div>` : '<div class="card empty">No phones yet. Tap Pair a phone.</div>'}`;
}

// ---------- Settings ----------
function settingsView() {
  const c = ST.config;
  const toggle = (k, label) => `<label class="toggle"><input type="checkbox" data-set="${k}" ${c[k] ? 'checked' : ''}>${label}</label>`;
  return `<div class="head"><div><h1>Settings</h1><p>Where the vault lives, how long it keeps things, and how the app looks.</p></div></div>
  <div class="set">
    <section class="card"><h2>Vault</h2>
      <div class="field"><span>Where it lives</span><div style="display:grid;gap:6px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono">${esc(c.vaultDir)}</span><button type="button" class="btn" data-move ${ST.moving ? 'disabled' : ''}>Move…</button></div><p class="hint">Pick a new folder and the vault moves there in the background.</p></div></div>
      <div class="field"><span>Keep deleted files</span><div style="display:grid;gap:6px"><div class="pills">${KEEP.map(([id, l]) => `<button type="button" class="pill" data-keep="${id}" aria-pressed="${c.keep === id}">${l}</button>`).join('')}</div><p class="hint">Only files deleted longer ago than this are cleared. Shortening it shows you what would go first.</p></div></div>
      <div class="field"><span>Space saver</span><div style="display:grid;gap:6px"><label class="toggle"><input type="checkbox" disabled>Shrink old deleted videos</label><p class="hint">Videos deleted more than 3 months ago get shrunk by your graphics card. They look almost the same but aren't the exact originals. Coming in a later update.</p></div></div>
    </section>
    <section class="card"><h2>Look</h2>
      <div class="field"><span>Theme</span><div class="swatches">${THEMES.map(([id, l, col]) => `<button type="button" class="sw" data-theme-pick="${id}" aria-pressed="${c.theme === id}"><i style="background:${col || c.custom}"></i>${l}</button>`).join('')}
        ${c.theme === 'custom' ? `<label class="toggle">Colour <input type="color" id="custom" value="${esc(c.custom)}"></label>` : ''}</div></div>
      <div class="field"><span>App size: ${c.size}%</span><input type="range" min="80" max="140" step="10" value="${c.size}" id="size" aria-label="App size"></div>
    </section>
    <section class="card"><h2>Warnings</h2>
      ${toggle('warnPhone', "When a phone hasn't checked in for 3 days")}
      ${toggle('warnHealth', "When the vault drive's health drops")}
      ${toggle('warnSpace', 'When the vault drive runs low on space')}
    </section>
    <section class="card"><h2>App</h2>
      ${toggle('startWin', 'Start with Windows')}
      <div class="field"><span>Version</span><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="mono">${esc(ST.version)}</span><button type="button" class="btn" data-update>Check for updates</button><span class="small muted" role="status">${esc(S.updMsg)}</span></div></div>
      <div><button type="button" class="btn" data-rerun>Show setup again</button></div>
    </section>
  </div>`;
}

// ---------- Setup ----------
function setupView() {
  const n = S.step;
  let body = '';
  if (n === 1) {
    const ds = S.drives || [];
    body = `<h1>Where should your vault live?</h1>
      <p class="muted" style="margin:0">This is where everything you delete on your phones is kept. Pick the drive with the most room. You can move it later in Settings.</p>
      <div class="drivelist">${ds.map((d) => `<button type="button" class="drive" data-drive="${esc(d.Root)}" aria-pressed="${S.drive === d.Root}">
        <span class="rowmain"><span class="name">${esc(d.Root.slice(0, 2))} ${esc(d.Label || 'Local disk')}</span><span class="where">${d.System ? 'Windows drive · ' : ''}${esc(d.Total)}</span></span>
        <span class="rowend"><span>${esc(d.Free)} free</span></span></button>`).join('')}</div>
      <div class="field"><span>Folder</span><div style="display:grid;gap:6px"><div style="display:flex;gap:8px"><input class="text" id="folder" value="${esc(S.folder)}" aria-label="Vault folder"><button type="button" class="btn" data-pickfolder>Change…</button></div><p class="hint">Opens Windows' folder picker, so you can choose any folder.</p></div></div>
      <div class="callout">The vault holds the only copy of what you delete, so Vault keeps an eye on this drive's health and warns you early if it starts to fail.</div>
      <div class="msg bad" role="status">${esc(S.msg)}</div>`;
  } else if (n === 2 || n === 3) {
    const kind = n === 2 ? 'android' : 'iphone';
    const got = ST.phones.filter((p) => p.Kind === kind).length > (S.basePhones || 0);
    const steps = n === 2 ? `<li>Open the camera on the phone and scan this code.</li><li>Install Premade Tools from the page it opens.</li><li>Allow All files access, and set the battery to Unrestricted when the app asks.</li><li>Keep Gallery's Recycle bin on (Gallery › Menu › Settings › Recycle bin).</li>`
      : `<li>Scan this code with the iPhone's camera. Vault opens in Safari.</li><li>Tap Share, then Add to Home Screen.</li><li>Open Vault from your home screen and tap Add the shortcut. It then walks you through its two automations: joining home Wi-Fi and starting to charge.</li><li>In WhatsApp and Telegram, turn on Save to Photos.</li>`;
    body = `<h1>Connect your ${n === 2 ? 'Android phone' : 'iPhone'}</h1>
      <div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">
        <div class="qr">${S.pair ? `<img src="${S.pair.qr}" alt="QR code to pair">` : ''}</div>
        <div style="display:grid;gap:12px;flex:1 1 300px"><ol class="steps">${steps}</ol>
        ${got ? `<span class="good">${icon('check')} ${esc(ST.phones.filter((p) => p.Kind === kind).slice(-1)[0].Name)} connected.${n === 2 ? " It's watching the Recycle bin." : ' It backs up when it joins your home Wi-Fi or starts charging.'}</span>`
          : `<span class="small muted"><span class="dot pulse"></span> Waiting for your ${n === 2 ? 'phone' : 'iPhone'}… It must be on the same Wi-Fi as this PC.</span>`}</div>
      </div>`;
  } else {
    body = `<h1>You're set</h1><p class="muted" style="margin:0">From now on, anything you delete on your phones shows up in Deleted, newest first, and stays here after the phone's own bin empties.</p>`;
  }
  const next = n === 4 ? 'Open Vault' : n === 1 ? 'Next' : (ST.phones.filter((p) => p.Kind === (n === 2 ? 'android' : 'iphone')).length > (S.basePhones || 0) ? 'Next' : "Skip, I don't have one");
  return `<div class="card wizard"><span class="stepno">Step ${n} of 4</span>${body}
    <div class="wfoot"><span>${n > 1 && n < 4 ? '<button type="button" class="btn" data-back>Back</button>' : ''}</span><button type="button" class="btn primary" data-next>${next}</button></div></div>`;
}

async function enterStep(n) {
  S.step = n; S.msg = '';
  if (n === 1 && !S.drives) {
    S.drives = await api('/api/ui/drives');
    const best = [...S.drives].sort((a, b) => (a.System - b.System) || (b.FreeB - a.FreeB))[0];
    if (best && !S.drive) { S.drive = best.Root; S.folder = ST.config.vaultDir || best.Root + 'Premade Vault'; }
  }
  if (n === 2 || n === 3) {
    S.basePhones = ST.phones.filter((p) => p.Kind === (n === 2 ? 'android' : 'iphone')).length;
    S.pair = await api('/api/ui/pair');
  }
  render();
}

// ---------- events ----------
$app.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.go) { S.page = d.go; S.msg = ''; if (d.go !== 'phones') S.pair = null; render(); }
    else if (d.phone) { S.phone = d.phone; render(); }
    else if (d.type) { S.type = d.type; render(); }
    else if (d.sel) { S.sel = d.sel; S.msg = ''; document.getElementById('dl').innerHTML = deletedBody(); }
    else if (d.dismiss) { await api('/api/ui/dismiss/' + d.dismiss, {}); refresh(); }
    else if (d.save) { const r = await api('/api/ui/save/' + d.save, {}); S.msg = 'Saved to ' + r.path; render(); }
    else if (d.restore) {
      await api('/api/ui/restore/' + d.restore, {});
      const it = ITEMS.find((i) => i.id === d.restore), p = phoneById(it.phone);
      S.msg = p.Kind === 'iphone' ? 'Queued. It goes back into Photos the next time the iPhone backs up.' : `Waiting for the ${p.Name} to pick it up (within 15 minutes, sooner when the phone is in use). It goes back into ${it.folder}.`;
      refresh();
      if (p.Kind !== 'iphone') watchRestore(it);
    }
    else if (d.pair !== undefined) { S.pair = await api('/api/ui/pair'); render(); }
    else if (d.forget) { if (confirm('Forget this phone? It stops sending deleted files. Files already saved stay in the vault.')) { await api('/api/ui/forget/' + d.forget, {}); refresh(); } }
    else if (d.keep) {
      const cur = KEEPDAYS[ST.config.keep], nw = KEEPDAYS[d.keep];
      if (nw < cur) {
        const p = await api('/api/ui/keep-preview?keep=' + d.keep);
        if (p.count && !confirm(`This clears ${p.count} files (${p.size}) deleted more than ${b.textContent.toLowerCase()} ago. They can't be brought back. Go ahead?`)) return;
      }
      await api('/api/ui/settings', { keep: d.keep }); refresh();
    }
    else if (d.themePick) { await api('/api/ui/settings', { theme: d.themePick }); refresh(); }
    else if (d.move !== undefined) {
      const r = await api('/api/ui/pickfolder', {});
      if (r.dir && confirm(`Move the vault to ${r.dir}? It copies in the background, then removes the old copy.`)) { await api('/api/ui/vault', { dir: r.dir }); refresh(); }
    }
    else if (d.update !== undefined) { S.updMsg = 'Checking…'; render(); S.updMsg = (await api('/api/ui/update', {})).msg; render(); }
    else if (d.rerun !== undefined) { S.page = 'setup'; enterStep(1); }
    else if (d.drive) { S.drive = d.drive; S.folder = d.drive + 'Premade Vault'; render(); }
    else if (d.pickfolder !== undefined) { const r = await api('/api/ui/pickfolder', {}); if (r.dir) { S.folder = r.dir; render(); } }
    else if (d.back !== undefined) enterStep(S.step - 1);
    else if (d.next !== undefined) {
      if (S.step === 1) {
        const dir = (document.getElementById('folder')?.value || S.folder).trim();
        if (dir !== ST.config.vaultDir) await api('/api/ui/vault', { dir });
        await refresh();
        enterStep(2);
      } else if (S.step < 4) enterStep(S.step + 1);
      else { await api('/api/ui/settings', { setupDone: true }); S.page = 'deleted'; S.pair = null; refresh(); }
    }
  } catch (err) { S.msg = err.message; render(); }
});

// Shows "Restored" once the phone has put the file back (it leaves that phone's waiting list).
function watchRestore(it) {
  const t0 = Date.now();
  const t = setInterval(async () => {
    await refresh();
    const p = phoneById(it.phone);
    if (p && (p.Pending || []).includes(it.id) && Date.now() - t0 < 60 * 60e3) return;
    clearInterval(t);
    if (S.sel === it.id && p && !(p.Pending || []).includes(it.id)) { S.msg = `Restored. It's back on the ${p.Name}, in ${it.folder}.`; render(); }
  }, 5000);
}
$app.addEventListener('input', async (e) => {
  const t = e.target;
  if (t.id === 'q') { S.q = t.value; document.getElementById('dl').innerHTML = deletedBody(); }
  else if (t.id === 'folder') S.folder = t.value;
  else if (t.id === 'size') { document.documentElement.style.zoom = t.value / 100; }
});
$app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.set) { await api('/api/ui/settings', { [t.dataset.set]: t.checked }); refresh(); }
  else if (t.id === 'size') { await api('/api/ui/settings', { size: +t.value }); refresh(); }
  else if (t.id === 'custom') { await api('/api/ui/settings', { custom: t.value }); refresh(); }
});

// Poll fast while waiting for a phone to pair, slowly otherwise.
async function tick() {
  const typing = document.activeElement && ['q', 'folder'].includes(document.activeElement.id);
  if (!typing) await refresh();
  setTimeout(tick, S.pair || S.page === 'setup' ? 3000 : 30000);
}
refresh().then(() => { if (S.page === 'setup') enterStep(1); setTimeout(tick, 3000); });
