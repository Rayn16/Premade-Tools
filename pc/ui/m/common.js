// What the PC window and the phone screens share: icons, labels and the picture tiles.
'use strict';

const ICON = {
  deleted: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  phones: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3 8-7.5 9.5-4.5-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.2 10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  spin: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>'
};
ICON.home = '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>';
ICON.chev = '<path d="M9 6l6 6-6 6"/>';
ICON.back = '<path d="M15 6l-6 6 6 6"/>';
ICON.up = '<path d="M6 15l6-6 6 6"/>';
ICON.down = '<path d="M6 9l6 6 6-6"/>';
ICON.pc = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>';
ICON.dots = '<path d="M5 12h.01M12 12h.01M19 12h.01"/>';
ICON.music = '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>';
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The Premade mark, drawn inline so it stays sharp at any size.
const MARK = '<svg class="mark" viewBox="112 90 288 334" aria-hidden="true"><path d="M124 102H230L256 128L282 102H388V280L256 412L124 280Z M194 174H290L316 200V260L290 286H240V365L194 319Z M240 216V246H278V216Z"/></svg>';
const KEEP = [['forever', 'Forever'], ['2y', '2 years'], ['1y', '1 year'], ['6m', '6 months'], ['3m', '3 months']];
const KEEPDAYS = { forever: Infinity, '2y': 730, '1y': 365, '6m': 182, '3m': 91 };
// id, label, background, accent: what each theme's swatch shows.
const THEMES = [['red', 'Red and black', '#141213', '#d9202d'], ['league', 'League', '#0a1420', '#0ac8b9'], ['light', 'Light', '#faf9f7', '#03717d'],
  ['purple', 'Purple', '#12101a', '#7c4dff'], ['green', 'Green', '#0c1411', '#27c381'], ['mono', 'Mono', '#000', '#fff']];
// The theme picker in Settings, PC and phone. Real radio buttons, so arrow keys and screen readers work.
const themePicker = (cur, custom) => `<div class="themes" role="radiogroup" aria-label="Theme">${[...THEMES, ...(custom ? [['custom', 'Your color', '#141416', custom]] : [])].map(([id, l, bg, ac]) =>
  `<label class="theme"><input type="radio" name="theme" value="${id}" ${cur === id ? 'checked' : ''}><i style="background:${bg};--sw:${esc(ac)}"></i>${l}</label>`).join('')}</div>`;
// Sets the theme on the app's root, with a text color that reads on the custom color.
function paintTheme(root, c) {
  const hex = /^#[\da-f]{6}$/i.test(c.custom || '') ? c.custom : '#d9202d', n = parseInt(hex.slice(1), 16);
  root.dataset.theme = c.theme || 'red';
  root.style.setProperty('--c', hex);
  root.style.setProperty('--on-c', ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 ? '#111' : '#fff');
}

// ---------- rows ----------
// One row of a list, the same on every page, PC and phone: picture, title, what it is, where it is now, when,
// buttons, and a line along the bottom while it runs (phones show the time after what it is). go: the attribute that
// makes the whole row open a page (Home).
// On the phone (TAPROWS) a finished row in a tool's list keeps its buttons in a sheet that opens when it's tapped:
// SHEET is that row, which byDay draws once more with FLAT on, into SHEETROW (m.js shows it), its menus laid flat.
let TAPROWS = false, SHEET = '', FLAT = false, SHEETROW = '';
function rowOf(r) {
  const tap = TAPROWS && r.id && r.acts && !r.go && !(r.pct >= 0) ? `data-rs="${r.id}"` : '', go = r.go || tap, tag = go ? 'button' : 'div';
  const text = `<span class="row-text"><span class="t" dir="auto" ${FLAT ? 'id="rs-t"' : ''}>${r.title}</span>${r.meta ? `<span class="m ${r.bad ? 'bad' : ''}">${r.meta}${r.when ? `<span class="mwhen">, ${r.when}</span>` : ''}</span>` : ''}${r.where ? `<span class="where">${r.where}</span>` : ''}</span>`;
  if (FLAT) return `<div class="msheet" data-close><div class="msheet-card" role="dialog" aria-modal="true" aria-labelledby="rs-t"><div class="grab"><span></span></div>
    <div class="msheet-body scroller"><div class="rs-head">${r.th}${text}</div>${r.extra || ''}</div><div class="msheet-acts rs-acts">${r.acts}</div></div></div>`;
  return `<${tag} ${go ? `type="button" ${go}` : ''} class="row ${r.cls || ''}" ${r.id ? `data-lj="${r.id}"` : ''}>${r.th}
    ${text}
    <span class="acts">${r.when ? `<span class="when">${r.when}</span>` : ''}${go ? '' : r.acts || ''}</span>${r.pct >= 0 ? `<span class="prog"><i style="width:${Math.max(2, r.pct)}%"></i></span>` : ''}${go ? '' : r.extra || ''}</${tag}>`;
}
// Rows under day headings (Today, Yesterday, This week, Earlier), in the order given. at(x) is each one's time.
function byDay(list, at, row, wrap = 'rows') {
  const days = [];
  for (const x of list) {
    const day = dayOf(new Date(at(x)));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(row(x));
    if (SHEET && x.id === SHEET) { FLAT = true; try { SHEETROW = row(x); } finally { FLAT = false; } }
  }
  return days.map((g) => `<h2 class="day">${g.day}</h2><div class="${wrap}">${g.rows.join('')}</div>`).join('');
}
// A row's picture: the file itself when it's a photo or video, else an icon for its kind. badge: "3:12", "1/3".
function thumb(kind, src, badge) {
  const media = !src ? '' : kind === 'photo' ? `<img src="${src}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : kind === 'video' ? `<video data-src="${src}#t=0.1" muted playsinline preload="metadata" tabindex="-1"></video>` : '';
  return `<span class="th" ${media ? `data-k="${src}"` : ''}>${icon(kind === 'audio' ? 'music' : ICON[kind] ? kind : 'file', kind === 'alert' ? 'bad' : '')}${media}${badge ? `<span class="dur">${esc(badge)}</span>` : ''}</span>`;
}
const shown1 = (files) => (files || []).findIndex((f) => f.kind === 'photo' || f.kind === 'video'); // the file a row's picture shows
const isLive = (j) => j.state === 'queued' || j.state === 'running';
// What a tool is doing now, for its count in the PC's sidebar and the phone's Home: "46%" while it works.
const running = (jobs) => { const j = jobs.find((x) => x.state === 'running') || jobs.find(isLive); return !j ? '' : j.state === 'queued' ? 'Waiting' : Math.floor(j.pct) + '%'; };
const newest = (a, b) => (isLive(b) - isLive(a)) || new Date(b.at) - new Date(a.at); // running first, then newest
// Draws html into root, keeping the pictures already loaded: a redraw every second while something runs would
// otherwise flash them and load the videos again.
function redraw(root, html) {
  const old = new Map([...root.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
  root.innerHTML = html;
  root.querySelectorAll('[data-k]').forEach((n) => { const o = old.get(n.dataset.k); if (o) { n.replaceWith(o); old.delete(n.dataset.k); } });
}
// A download in plain words: "Video from YouTube", "3 pictures from Instagram", "MP3 from YouTube".
const dlWhat = (j) => `${(j.what || 'Link').replace(/^Video, .*|^1 video from the playlist$/, 'Video').replace(/^Sound only, MP3$/, 'MP3').replace(/^1 picture$/, 'Photo').replace(/ pictures$/, ' photos').replace(/^Playlist, /, '').replace(/ songs as MP3$/, ' MP3s')} from ${j.site || 'the link'}`;
const dlDur = (j) => /^Video, ([\d:]+)$/.exec(j.what || '')?.[1] || '';

// The ⋯ button on a row and its menu of less used actions. MENU is the open one, so redraws keep it open.
// label: a word instead of ⋯ (an iPhone's "Save" for a download of several photos, one item each).
let MENU = '';
function more(id, items, label) {
  items = items.filter(Boolean);
  if (!items.length) return '';
  if (FLAT) return `<div class="rs-list">${label ? `<p class="rs-h">${label}</p>` : ''}${items.join('')}</div>`;
  return `<span class="more"><button type="button" class="btn ${label ? 'text' : 'icon'}" data-more="${id}" aria-haspopup="menu" aria-expanded="${MENU === id}" ${label ? '' : 'aria-label="More"'}>${label || icon('dots', 'dots')}</button>${MENU === id ? `<span class="menu" role="menu">${items.join('')}</span>` : ''}</span>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-more]');
  if (b) { e.stopPropagation(); MENU = MENU === b.dataset.more ? '' : b.dataset.more; render(); }
  else if (MENU) { MENU = ''; setTimeout(render); } // after the item's own action ran
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && MENU) { MENU = ''; render(); } });

// ---------- time and size labels ----------
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
function dayOf(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : 'Earlier';
}
function whenShort(d) {
  const day = dayOf(d);
  if (day === 'Today' || day === 'Yesterday') return day + ' ' + hm(d);
  const o = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-GB', o).replace(',', '') + ' ' + hm(d);
}
// A row's time: just the clock for today and yesterday (the day heading says which), else the short date.
const stamp = (d) => /^(Today|Yesterday)$/.test(dayOf(d)) ? hm(d) : whenShort(d);
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return plural(Math.round(s / 60), 'minute') + ' ago';
  if (s < 86400) return plural(Math.round(s / 3600), 'hour') + ' ago';
  return plural(Math.round(s / 86400), 'day') + ' ago';
}
function size(b) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
// The PC reports sizes as text like "1863 GB". Bytes for the bars, and TB for the big ones.
const toBytes = (s) => { const m = /([\d.]+)\s*(KB|MB|GB|B)/.exec(s || ''); return m ? m[1] * { B: 1, KB: 1 << 10, MB: 1 << 20, GB: 1 << 30 }[m[2]] : 0; };
const nice = (s) => { const b = toBytes(s); return b >= 1000 * (1 << 30) ? +(b / (1 << 30) / 1024).toFixed(2) + ' TB' : s; };
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

const ext = (name) => (name.includes('.') ? name.split('.').pop() : '').toUpperCase();
const isShot = (it) => /screenshot/i.test(it.folder + it.name);
function kindLabel(it) { // HTML: the type comes from the file's name, so it's escaped
  const e = esc(ext(it.name) === 'JPG' ? 'JPEG' : ext(it.name));
  if (it.kind === 'photo') return isShot(it) ? 'Screenshot' : (e + ' photo').trim();
  if (it.kind === 'video') return (e + ' video').trim();
  return it.kind === 'voice' ? 'Voice recording' : (e + ' file').trim();
}
const kicker = (it) => 'Deleted ' + (it.kind === 'photo' ? (isShot(it) ? 'screenshot' : 'photo') : it.kind === 'video' ? 'video' : it.kind === 'voice' ? 'voice recording' : 'file');
// Days until the vault clears this file, or null when it's kept forever.
function daysLeft(it, keep) {
  if (!KEEPDAYS[keep] || keep === 'forever') return null;
  return Math.max(0, Math.ceil((new Date(it.deletedAt).getTime() + KEEPDAYS[keep] * 864e5 - Date.now()) / 864e5));
}
const keptLabel = (it, keep) => { const n = daysLeft(it, keep); return n === null ? 'Forever' : plural(n, 'day') + ' left'; };
const keptClass = (it, keep) => { const n = daysLeft(it, keep); return n !== null && n < 14 ? 'is-warn' : ''; };
// Dismissed files leave every list: the PC deletes the copy and keeps only the record.
const liveItems = (items) => items.filter((i) => !i.missed && !i.dismissed);

// ---------- tiles ----------
// ponytail: the bars are a stand-in shape seeded by the file id, not the real sound; decoding audio for every tile costs too much.
function wave(id, n = 36) {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  let bars = '';
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / n * Math.PI * 3 + (h & 3)));
    bars += `<i style="height:${Math.round(14 + (h >>> 24) / 255 * 86 * env)}%"></i>`;
  }
  return `<span class="voicebox"><span class="wave">${bars}</span></span>`;
}
const doc = () => '<span class="docbox"><span class="docpage"><i class="is-head"></i><i></i><i></i><i class="is-mid"></i><i></i><i class="is-short"></i><i></i><i class="is-mid"></i><i></i><i class="is-short"></i></span></span>';
const DUR = {}; // id → "1:18", filled in as media loads
const durBadge = (it) => `<span class="badge" data-dur="${it.id}">${DUR[it.id] || ''}</span>`;

// A file's picture for grids and lists: its own photo or video frame, a sound shape, or a page.
function tile(it, src, noPreview) {
  if (it.kind === 'photo') {
    if (noPreview) return `<span class="ph">${icon('photo')}</span><span class="tag">${esc(ext(it.name))}</span>`;
    return `<span class="ph">${icon('photo')}</span><img src="${src}" alt="" loading="lazy" decoding="async" onerror="this.remove()">${isShot(it) ? '<span class="tag">SCREENSHOT</span>' : ''}`;
  }
  if (it.kind === 'video') return `<span class="ph">${icon('video')}</span><video data-src="${src}#t=0.1" data-id="${it.id}" muted playsinline preload="metadata" tabindex="-1"></video>${durBadge(it)}`;
  if (it.kind === 'voice') return `${wave(it.id)}<audio data-src="${src}" data-id="${it.id}" preload="metadata"></audio>${durBadge(it)}`;
  return `${doc()}<span class="tag is-doc">${esc(ext(it.name) || 'FILE')}</span>`;
}

// Videos and recordings only load once their tile scrolls near the screen, then report how long they run.
const seen = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  const v = e.target.querySelector('[data-src]');
  if (v) v.src = v.dataset.src;
  seen.unobserve(e.target);
}), { rootMargin: '300px' });
const lazyMedia = (root) => root.querySelectorAll('[data-src]:not([src])').forEach((v) => seen.observe(v.parentElement));
document.addEventListener('loadedmetadata', (e) => {
  const v = e.target, s = Math.round(v.duration);
  if (!v.dataset?.id || !isFinite(s)) return;
  DUR[v.dataset.id] = Math.floor(s / 60) + ':' + pad(s % 60);
  document.querySelectorAll(`[data-dur="${v.dataset.id}"]`).forEach((n) => { n.textContent = DUR[v.dataset.id]; });
}, true);

// One call with upload progress (onp gets the bytes sent); resolves with the XHR whatever its status.
function xhr(method, url, hdr, body, onp) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(hdr)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded);
    x.onload = () => ok(x);
    x.onerror = () => no(new Error("Couldn't reach your PC."));
    x.send(body);
  });
}
// Phones reach their PC through the relay's link away from home (the iPhone app always does), and the relay takes
// nothing over 100 MB in one call. So a phone's bigger file goes to /api/phone/piece first, 50 MB at a time (each
// tried 3 times), and the upload then names it by the id this gives back.
async function sendPieces(url, hdr, f, onp) {
  const piece = url.slice(0, url.indexOf('/api/phone/')) + '/api/phone/piece', P = 50 << 20;
  const u = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (let at = 0; at < f.size || !at; at += P) {
    for (let tries = 1; ; tries++) {
      const x = await xhr('PUT', `${piece}?u=${u}&at=${at}`, hdr, f.slice(at, at + P), (n) => onp(at + n)).catch((e) => { if (tries === 3) throw e; });
      if (x?.status === 200) break;
      if (x && (x.status < 500 || tries === 3)) throw new Error(x.responseText.trim() || "That didn't send.");
    }
  }
  return u;
}
// Files ("f") and fields as one form, with progress from 0 to 1. A phone's files over 90 MB together go in pieces.
async function sendForm(url, hdr, files, fields, onp) {
  const fd = new FormData(), total = files.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (url.includes('/api/phone/') && total > 90 << 20) {
    for (const f of files) { fd.append('p', `${await sendPieces(url, hdr, f, (n) => onp((done + n) / total))}/${f.name}`); done += f.size; }
  } else for (const f of files) fd.append('f', f, f.name);
  return xhr('POST', url, hdr, fd, (n) => onp(Math.min(1, (done + n) / total)));
}
