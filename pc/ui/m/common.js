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
  list: '<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="5" cy="6" r="1.4"/><circle cx="5" cy="12" r="1.4"/><circle cx="5" cy="18" r="1.4"/>',
  spin: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>'
};
const PLAY = '<svg class="i play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
ICON.home = '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>';
ICON.chev = '<path d="M9 6l6 6-6 6"/>';
// Home's tool cards, for the PC window (data-go) and the phone (data-tool): [target, icon, name, what it does, live stat]
const homeCards = (attr, cards) => `<div class="toolcards">${cards.map(([to, ic, name, what, stat]) =>
  `<button type="button" class="toolcard" data-${attr}="${to}"><span class="toolcard-icon">${icon(ic)}</span><span class="toolcard-text"><span class="toolcard-name">${name}</span><span class="toolcard-what">${what}</span><span class="toolcard-stat">${stat}</span></span>${icon('chev', 'toolcard-go')}</button>`).join('')}</div>`;
const tally = (n, one, many) => `<b>${n}</b> ${n === 1 ? one : many}`;
const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEEP = [['forever', 'Forever'], ['2y', '2 years'], ['1y', '1 year'], ['6m', '6 months'], ['3m', '3 months']];
const KEEPDAYS = { forever: Infinity, '2y': 730, '1y': 365, '6m': 182, '3m': 91 };
// id, label, background, panel, accent
const THEMES = [['red', 'Red and black', '#0b0809', '#1f181a', '#d9202d'], ['league', 'League', '#010a13', '#0f1e35', '#0ac8b9'], ['light', 'Light', '#f2eee4', '#fffdf7', '#03717d'],
  ['purple', 'Purple', '#0c0913', '#1e1730', '#7c4dff'], ['green', 'Green', '#07100d', '#13231d', '#27c381'], ['mono', 'Mono', '#000000', '#181818', '#ffffff']];

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
// The PC reports sizes as text like "1863 GB". Bytes for the bars, and TB for the big ones.
const toBytes = (s) => { const m = /([\d.]+)\s*(KB|MB|GB|B)/.exec(s || ''); return m ? m[1] * { B: 1, KB: 1 << 10, MB: 1 << 20, GB: 1 << 30 }[m[2]] : 0; };
const nice = (s) => { const b = toBytes(s); return b >= 1000 * (1 << 30) ? +(b / (1 << 30) / 1024).toFixed(2) + ' TB' : s; };
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

const ext = (name) => (name.includes('.') ? name.split('.').pop() : '').toUpperCase();
const isShot = (it) => /screenshot/i.test(it.folder + it.name);
function kindLabel(it) {
  const e = ext(it.name) === 'JPG' ? 'JPEG' : ext(it.name);
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
// Dismissed files leave every list. The PC only flags them, so the file stays on disk until the keep time runs out.
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
const durBadge = (it, voice) => `<span class="badge">${voice ? icon('voice') : ''}<span data-dur="${it.id}">${DUR[it.id] || ''}</span></span>`;

// A file's picture for grids and lists: its own photo or video frame, a sound shape, or a page.
function tile(it, src, noPreview) {
  if (it.kind === 'photo') {
    if (noPreview) return `<span class="ph">${icon('photo')}</span><span class="tag">${esc(ext(it.name))}</span>`;
    return `<span class="ph">${icon('photo')}</span><img src="${src}" alt="" loading="lazy" decoding="async" onerror="this.remove()">${isShot(it) ? '<span class="tag">SCREENSHOT</span>' : ''}`;
  }
  if (it.kind === 'video') return `<span class="ph">${icon('video')}</span><video data-src="${src}#t=0.1" data-id="${it.id}" muted playsinline preload="metadata" tabindex="-1"></video><span class="playglyph">${PLAY}</span>${durBadge(it)}`;
  if (it.kind === 'voice') return `${wave(it.id)}<audio data-src="${src}" data-id="${it.id}" preload="metadata"></audio>${durBadge(it, true)}`;
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
