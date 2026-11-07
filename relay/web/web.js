// Friends for people with only a phone: this page talks to the relay itself. friends-core.js draws the people and
// the Send sheet as it does in the app; this file stands in for the PC (api(), uploads) and adds what came in.
'use strict';

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const qs = new URLSearchParams(location.search);
// A Home Screen app keeps its own storage, apart from Safari, so the key also rides in the address (?t=…).
let TOKEN = qs.get('t') || (() => { try { return localStorage.getItem('frToken'); } catch (e) { return null; } })();
const keep = (t) => { TOKEN = t; try { t ? localStorage.setItem('frToken', t) : localStorage.removeItem('frToken'); } catch (e) {} history.replaceState(null, '', t ? '?t=' + t : '/'); };
if (TOKEN) keep(TOKEN);

const SENDS = [];       // this session's sends, for the Sending list
let INBOX = [], NAME = '', ERR = '';
const GOT = {};         // inbox id → 'saving' | File (fetched, waiting for a tap to share)
const $app = document.getElementById('app');
const FRAPI = {
  base: '/w', hdr: {}, touch: true,
  sheet: (label, body) => `<div class="msheet" data-frclose><div class="msheet-card" role="dialog" aria-modal="true" aria-label="${label}"><div class="grab"><span></span></div>
    <div class="msheet-body frsheet"><h2 class="sheet-title">${label}</h2>${body}</div>
    <div class="actions"><button type="button" class="btn block" data-fr="close">Cancel</button></div></div></div>`,
};

async function relay(method, path, body) {
  const r = await fetch(path, { method, headers: { Authorization: 'Bearer ' + (TOKEN || ''), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status === 401) { keep(null); throw new Error('You were removed from Friends. Ask to join again.'); }
  if (!r.ok) throw new Error(out.error || r.statusText);
  return out;
}

// friends-core.js calls the PC's Friends API; here each call goes to the relay instead.
async function api(path, body) {
  if (path === '/w') {
    if (!TOKEN) return { ready: true, joined: false, sends: SENDS };
    const me = await relay('GET', '/people');
    NAME = me.name;
    return { ready: true, joined: true, name: me.name, pc: '', err: ERR, sends: SENDS, me };
  }
  if (path === '/w/join') {
    const name = (body.name || '').trim();
    if (!name) throw new Error('Type your name.');
    const r = await relay('POST', '/join', { name, devices: [{ id: 'web', name: IOS ? 'iPhone' : 'Phone', kind: IOS ? 'iphone' : 'android' }] });
    keep(r.token);
    return 'ok';
  }
  if (path === '/w/name') { if (body.name.trim()) await relay('PUT', '/me', { name: body.name }); return 'ok'; }
  const m = path.match(/^\/w\/(approve|remove)\/(\w+)$/);
  if (m) return relay('POST', `/${m[1]}/${m[2]}`);
  throw new Error('Not on a phone-only page.');
}

// Sends go straight to the relay, 50 MB at a time.
function putPart(url, blob, onp) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
    x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded);
    x.onload = () => x.status === 200 ? ok(JSON.parse(x.responseText)) : bad(new Error((JSON.parse(x.responseText || '{}').error) || "That didn't send."));
    x.onerror = () => bad(new Error("Can't reach Friends. Check the internet."));
    x.send(blob);
  });
}
async function frUpload(files, to, dev) { // replaces friends-core's version, which uploads to the PC
  const p = frPerson(to);
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let before = 0;
  for (const f of files) {
    const s = { id: Math.random().toString(36).slice(2), name: f.name, to: p?.name || '', dev: dev === 'all' ? 'all devices' : p?.devices.find((d) => d.id === dev)?.name || '', pct: 0, state: 'running', at: new Date().toISOString() };
    SENDS.unshift(s);
    try {
      const st = await relay('POST', '/send', { to, dev, name: f.name, size: f.size });
      const parts = [];
      for (let off = 0, n = 1; off < f.size || n === 1; off += st.part, n++) {
        const blob = f.slice(off, off + st.part);
        parts.push(await putPart(`/send/${st.id}/${n}`, blob, (l) => { s.pct = (off + l) / (f.size || 1) * 100; FR.up = Math.floor((before + off + l) / total * 100); render(); }));
        if (!f.size) break;
      }
      await relay('POST', `/send/${st.id}/done`, { parts });
      s.state = 'done'; s.pct = 100;
    } catch (e) { s.state = 'failed'; s.note = e.message; throw e; } finally { before += f.size; }
  }
}

// What friends sent here. Save fetches it, then opens the Share sheet (iPhone) or downloads it; once saved it's
// deleted from the relay.
async function inboxRefresh() {
  if (!TOKEN || !frOn()) { INBOX = []; return; }
  try { INBOX = await relay('GET', '/inbox'); } catch (e) {}
}
function inboxView() {
  if (!INBOX.length) return '';
  return `<section class="sec"><h2 class="group-label">Sent to you</h2><div class="rows hrows">${INBOX.map((it) => {
    const got = GOT[it.id];
    const btn = got === 'saving' ? `<span class="btn small" aria-disabled="true">${icon('spin', 'spin')}Getting it</span>`
      : got ? `<button type="button" class="btn small primary" data-w="share" data-id="${it.id}">${icon('save')}Save now</button>`
      : `<button type="button" class="btn small" data-w="save" data-id="${it.id}">${icon('save')}Save</button>`;
    return `<div class="row"><span class="thumb" style="--h:${pdfHue(it.id)}">${icon(/\.(jpe?g|png|heic|gif|webp)$/i.test(it.name) ? 'photo' : /\.(mp4|mov|m4v|webm)$/i.test(it.name) ? 'video' : 'file')}</span>
      <div class="row-text grow"><span class="row-title clip">${esc(it.name)}</span><div class="hmeta"><span>From ${esc(it.fromName)} · ${hm(new Date(it.at))} · ${size(it.size)}</span></div></div>
      <div class="hacts">${btn}<button type="button" class="iconbtn" data-w="drop" data-id="${it.id}" aria-label="Delete" title="Delete">${icon('x')}</button></div></div>`;
  }).join('')}</div></section>`;
}
async function save(it) {
  GOT[it.id] = 'saving'; render();
  const r = await fetch('/file/' + it.id, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) throw new Error('That file is gone.');
  const file = new File([await r.blob()], it.name, { type: r.headers.get('Content-Type') || '' });
  if (navigator.canShare?.({ files: [file] })) { GOT[it.id] = file; render(); return; } // the Share sheet needs a fresh tap
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: it.name });
  a.click();
  await done(it.id);
}
async function done(id) {
  await relay('DELETE', '/file/' + id).catch(() => {});
  delete GOT[id];
  INBOX = INBOX.filter((i) => i.id !== id);
  render();
}

function render() {
  const keepFocus = document.activeElement?.id;
  const install = TOKEN && IOS && !navigator.standalone ? `<p class="mhint">${icon('info')}<span>Tap <b>Share</b> › <b>Add to Home Screen</b> so Premade Friends opens like an app.</span></p>` : '';
  $app.innerHTML = `<div class="topbar"><span class="crest"><img src="/icon.svg" alt=""></span><span class="wordmark-app">Friends</span></div>
    <div class="titlerow"><div class="titlerow-text"><h1 class="pagetitle">Friends</h1><p class="pagelede">Everyone who has Premade Tools. Send them anything, and get what they send you.</p></div></div>
    <div class="feed scroller">${install}${inboxView()}${frPage()}</div>${frSheet()}`;
  if (keepFocus && document.getElementById(keepFocus)) document.getElementById(keepFocus).focus();
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  const it = INBOX.find((i) => i.id === b.dataset.id);
  if (!it) return;
  try {
    if (b.dataset.w === 'save') await save(it);
    else if (b.dataset.w === 'share') { await navigator.share({ files: [GOT[it.id]] }); await done(it.id); }
    else if (b.dataset.w === 'drop' && confirm(`Delete ${it.name}? ${it.fromName} would have to send it again.`)) await done(it.id);
  } catch (err) { if (err.name !== 'AbortError') { delete GOT[it.id]; FR.err = err.message; render(); } }
});

// While open: check in (so friends see this phone online) and look for new files.
let last = '';
async function tick() {
  if (document.hidden) return;
  if (TOKEN) await relay('PUT', '/me', {}).catch(() => {});
  await frRefresh(); await inboxRefresh();
  const now = JSON.stringify([FRST, INBOX, SENDS]);
  if (now !== last && !FR.share && !['frname', 'frmyname'].includes(document.activeElement?.id)) render();
  last = now;
}
document.addEventListener('visibilitychange', tick);
setInterval(tick, 20000);
tick().then(render);
