// The Downloader's page and settings in the PC window. app.js draws the frame and calls downloadView()/dlSettings().
'use strict';

let DL = null; // /api/ui/dl
const D = { url: '', audio: false, probe: null, probing: '', ask: null, note: null, err: '', busy: false };
let probeTimer = null;

ICON.download = ICON.dl = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
ICON.link = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
ICON.music = '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>';
ICON.paste = '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5h6V3H9z"/>';

const dlRunning = () => (DL?.jobs || []).some((j) => j.state === 'queued' || j.state === 'running');
const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const sizeOf = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fromName = (j) => (!j.from ? 'this PC' : (ST?.phones || []).find((p) => p.ID === j.from)?.Name || 'a phone');
const LOGIN_SITES = [['instagram', 'Instagram'], ['x', 'X'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['facebook', 'Facebook'], ['reddit', 'Reddit']];
const siteTag = (s) => `<span class="sitetag">${esc(s || 'Link')}</span>`;
const siteKey = (name) => (LOGIN_SITES.find(([, l]) => l === name) || [])[0];

function jobThumb(j) {
  const k = j.audio ? 'music' : (j.files || []).some((f) => f.kind === 'photo') && !(j.files || []).some((f) => f.kind === 'video') ? 'photo' : 'video';
  return `<span class="thumb" style="--h:${hue(j.id)}">${icon(k)}</span>`;
}

function detectLine() {
  if (D.err) return `<span class="detected is-bad">${icon('alert')}<span>${esc(D.err)}</span></span>`;
  if (!D.url.trim()) return `<span class="detected">Works with TikTok, YouTube, Instagram, X, Reddit and about 1,700 other sites. No need to say which.</span>`;
  if (D.probing) return `<span class="detected"><span class="pulse"></span><span>Checking the link…</span></span>`;
  const p = D.probe;
  if (!p) return `<span class="detected">Press Download, or Enter.</span>`;
  if (p.err) return `<span class="detected is-bad">${icon('alert')}<span>${esc(p.err)}</span></span>`;
  const what = D.audio && !p.pictures ? (p.ask ? `${p.count} songs as MP3` : 'Sound only, as MP3') : p.what;
  return `<span class="detected"><i class="dotlight"></i><span><b>${esc(p.site)}</b> · ${esc(p.title || '')}${p.title ? ' · ' : ''}${esc(what)}</span></span>`;
}

function engineBanner() {
  if (!DL || DL.ready) return '';
  const bad = DL.engines.filter((e) => e.state === 'error');
  if (bad.length) return `<div class="notebox">${icon('alert')}<div>The download engines couldn't be set up: ${esc(bad.map((e) => `${e.name} (${e.err})`).join(', '))}.<div class="acts"><button class="btn small" data-dl="engines">Try again</button></div></div></div>`;
  return `<div class="notebox is-info">${icon('info')}<div><b>Setting up the download engines.</b> The first time, Premade Tools fetches yt-dlp, gallery-dl, FFmpeg and Deno (about 200 MB, free and open source). This takes a few minutes, once.</div></div>`;
}

function noteView() {
  const n = D.note;
  if (!n) return '';
  if (n.repeat) {
    const j = n.repeat;
    return `<div class="notebox is-info">${icon('info')}<div>You already downloaded this one, <b>${esc(j.title)}</b>, ${esc(/^(Today|Yesterday)$/.test(dayOf(new Date(j.at))) ? dayOf(new Date(j.at)).toLowerCase() : 'on ' + dayOf(new Date(j.at)))} at ${hm(new Date(j.at))}.
      <div class="acts"><button class="btn small" data-dl="show" data-id="${j.id}">${icon('folder')}Show it</button><button class="btn small" data-dl="force">Download it again</button></div></div></div>`;
  }
  if (n.login) {
    return `<div class="notebox">${icon('alert')}<div>${esc(n.err)}<div class="acts"><button class="btn small primary" data-dl="login" data-site="${siteKey(n.login) || ''}">Log in to ${esc(n.login)}</button></div>
      <p class="row-hint" style="margin:8px 0 0">A small Edge window opens. Log in, close it, then press Download again. A second account is safer, because sites can block accounts that download.</p></div></div>`;
  }
  return '';
}

function downloadView() {
  const jobs = DL?.jobs || [];
  const live = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const past = jobs.filter((j) => j.state === 'done' || j.state === 'failed');
  const can = D.url.trim() && !D.busy && !(D.probe && D.probe.err && !D.probe.login) && DL?.ready;
  const liveRows = live.map((j) => `<div class="row">${jobThumb(j)}
    <div class="row-text grow"><span class="row-title">${esc(j.title || j.url)}</span>
      <div class="hmeta">${siteTag(j.site)}<span>${esc(j.what)}</span><span class="jobstate">${j.state === 'queued' ? 'Waiting its turn' : j.pct < 1 ? 'Starting…' : j.pct >= 99 ? 'Finishing…' : `Downloading ${Math.floor(j.pct)}%`}</span><span>from ${esc(fromName(j))}</span></div>
      <div class="prog"><i style="width:${Math.max(2, j.pct)}%"></i></div></div>
    <button class="btn small" data-dl="cancel" data-id="${j.id}">Cancel</button></div>`).join('');
  const days = [];
  for (const j of past) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(histRow(j));
  }
  const hist = days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
    : `<div class="empty">${icon('dl')}<h2>Nothing downloaded yet</h2><p>Paste a link above. Downloads from your phones show up here too.</p></div>`;
  return `<main class="plain">
    <div class="pagehead"><div><h1 class="pagetitle">Download</h1><p class="pagelede">Paste any link. Premade Tools works out which site it's from and saves it.</p></div></div>
    <div class="dlwrap scroller"><div class="dlinner">
      ${engineBanner()}
      <div class="dlbox">
        <div class="dlfield">
          <label class="dlinput">${icon('link')}<span class="sr">Link</span><input id="dlurl" value="${esc(D.url)}" placeholder="Paste a link" autocomplete="off" spellcheck="false"></label>
          <button class="btn" data-dl="paste">${icon('paste')}Paste</button>
          <button class="btn primary" data-dl="go" ${can ? '' : 'disabled'}>${D.busy ? `${icon('spin', 'spin')}Checking…` : `${icon('dl')}Download`}</button>
        </div>
        <div class="dlunder">${detectLine()}
          <label class="audiosw"><input type="checkbox" class="switch" role="switch" id="dlaudio" ${D.audio ? 'checked' : ''}>Audio only (MP3)</label></div>
        ${noteView()}
      </div>
      ${liveRows ? `<section class="sec"><h2 class="group-label">Downloading now</h2><div class="rows hrows">${liveRows}</div></section>` : ''}
      <section class="sec"><h2 class="group-label">History</h2>${hist}</section>
    </div></div>
  </main>${D.ask ? askView() : ''}`;
}

function histRow(j) {
  const n = (j.files || []).length;
  const where = j.state === 'failed' ? '' : j.from ? (j.fetched ? `In ${esc(fromName(j))}'s ${(ST.phones.find((p) => p.ID === j.from) || {}).Kind === 'iphone' ? 'Photos' : 'Gallery'}` : `Waiting for ${esc(fromName(j))} to pick it up`) : 'On this PC';
  return `<div class="row">${jobThumb(j)}
    <div class="row-text grow"><span class="row-title">${esc(j.title || j.url)}</span>
      <div class="hmeta">${siteTag(j.site)}<span>${esc(j.what)}${j.size ? ' · ' + sizeOf(j.size) : ''}${n > 1 ? ` · ${n} files` : ''}</span><span>${hm(new Date(j.at))} · from ${esc(fromName(j))}</span>
      ${where ? `<span class="where">${icon('check')}${where}</span>` : ''}</div>
      ${j.state === 'failed' ? `<div class="hmeta bad">${icon('alert')}${esc(j.note)}</div>` : j.note ? `<div class="hmeta">${esc(j.note)}</div>` : ''}</div>
    <div class="hacts">
      ${j.state === 'done' ? `<button class="btn small" data-dl="show" data-id="${j.id}">${icon('folder')}Show</button>` : ''}${frShareBtn('dl', j)}
      ${j.state === 'done' && (j.files || []).some((f) => f.kind === 'video' || f.kind === 'audio') ? `<button class="btn small" data-trdl="${j.id}">${icon('transcribe')}Transcribe</button>` : ''}
      ${j.login ? `<button class="btn small" data-dl="login" data-site="${siteKey(j.login) || ''}">Log in</button>` : ''}
      <button class="btn small" data-dl="again" data-id="${j.id}">${j.state === 'failed' ? 'Try again' : 'Again'}</button>
      <button class="iconbtn" data-dl="remove" data-id="${j.id}" aria-label="Remove from history" title="Remove from history">${icon('x')}</button>
    </div></div>`;
}

function askView() {
  const p = D.ask;
  return `<div class="backdrop" data-dl="askno"><div class="sheet" role="dialog" aria-label="Playlist">
    <div class="ask-head"><p class="eyebrow">${esc(p.site)} playlist</p><h2 class="ask-title">${esc(p.title)}</h2></div>
    <div class="ask-body">This link is a playlist of <b>${p.count} ${D.audio ? 'songs' : 'videos'}</b>. Download all of them, or just the one the link was opened on?</div>
    <div class="ask-foot"><button class="btn" data-dl="askno">Cancel</button><button class="btn" data-dl="mode" data-mode="one">Just this one</button><button class="btn primary" data-dl="mode" data-mode="all">All ${p.count}</button></div>
  </div></div>`;
}

function dlSettings() {
  if (!DL) return '';
  const logged = new Set(DL.logins || []);
  const eng = DL.engines.filter((e) => e.name !== 'magick').map((e) => `<span>${esc(e.name)}</span><b>${esc(e.version || '—')}</b><span class="${e.state === 'ok' ? 'ok' : e.state === 'error' ? 'bad' : ''}">${e.state === 'ok' ? 'ready' : e.state === 'installing' ? 'installing…' : e.state === 'missing' ? 'not yet' : 'failed'}</span>`).join('');
  const checked = DL.engines.map((e) => e.checked).filter((t) => t && !t.startsWith('0001')).sort()[0];
  return `<div class="cols" style="margin-top:0">
    <div class="col">
      <section><h2 class="group-label">Downloader · where files go</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">Save folder, the same for every tool</span><span class="row-hint mono">${esc(DL.dir)}</span></div><button class="btn small" data-dl="folder">Change…</button></div>
        <div class="row"><div class="row-text"><span class="row-title">Phones</span><span class="row-hint">A link sent from a phone goes back to that phone: on the iPhone into Photos or Files, on the S23 into Download › Premade. A copy stays here.</span></div></div>
      </div></section>
      <section style="margin-top:16px"><h2 class="group-label">Downloader · logins</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-hint">Only needed for posts a site hides from logged-out people, like Instagram stories. You log in once in a small Edge window; the login stays on this PC. A second account is safer, because sites can block accounts that download.</span></div></div>
        ${LOGIN_SITES.map(([k, l]) => `<div class="row"><div class="row-text"><span class="row-title">${l}</span></div>${logged.has(k) ? '<span class="sbadge is-good"><i></i>Logged in</span>' : ''}<button class="btn small" data-dl="login" data-site="${k}">${logged.has(k) ? 'Log in again' : 'Log in'}</button></div>`).join('')}
        ${logged.size ? '<div class="row"><div class="row-text"><span class="row-title">Forget all logins</span></div><button class="btn small danger" data-dl="forget">Forget</button></div>' : ''}
      </div></section>
    </div>
    <div class="col">
      <section><h2 class="group-label">Downloader · engines</h2><div class="rows">
        <div class="engines">${eng}</div>
        <div class="row is-stacked"><div class="row-text"><span class="row-title">yt-dlp updates</span><span class="row-hint">Sites change all the time. The engines update by themselves every 6 hours, so a broken site is usually fixed the same day. Nightly gets fixes first.</span></div>
          <div class="row-ctl"><div class="seg"><button type="button" data-dl="nightly" data-on="0" aria-pressed="${!DL.nightly}">Stable</button><button type="button" data-dl="nightly" data-on="1" aria-pressed="${DL.nightly}">Nightly</button></div></div></div>
        <div class="row"><div class="row-text"><span class="row-title">${checked ? 'Checked ' + esc(ago(checked)) : 'Not checked yet'}</span></div><button class="btn small" data-dl="engines">Update now</button></div>
      </div></section>
    </div>
  </div>`;
}

async function dlRefresh() {
  try { DL = await api('/api/ui/dl'); } catch (e) {}
}

async function dlProbeNow() {
  const url = D.url.trim();
  if (!url) { D.probe = null; D.probing = ''; return render(); }
  D.probing = url; render();
  try {
    const p = await api('/api/ui/dl/probe?url=' + encodeURIComponent(url));
    if (D.url.trim() !== url) return;
    D.probe = p; D.probing = '';
    if (p.login) D.note = { login: p.login, err: p.err };
  } catch (e) { D.probing = ''; D.err = e.message; }
  render();
}

async function dlStart(mode, force) {
  if (!D.url.trim()) return;
  D.busy = true; D.err = ''; render();
  try {
    const r = await api('/api/ui/dl/start', { url: D.url, audio: D.audio, mode: mode || '', force: !!force });
    D.probe = r.probe; D.note = null; D.ask = null;
    if (r.job) { D.url = ''; D.probe = null; }
    else if (r.repeat) D.note = { repeat: r.repeat };
    else if (r.probe?.ask) D.ask = r.probe;
    else if (r.probe?.login) D.note = { login: r.probe.login, err: r.probe.err };
    await dlRefresh();
  } catch (e) { D.err = e.message; }
  D.busy = false; render(); soon();
}

$app.addEventListener('click', async (e) => {
  if (e.target.classList?.contains('backdrop') && D.ask) { D.ask = null; render(); return; }
  const b = e.target.closest('[data-dl]');
  if (!b || b.classList.contains('backdrop')) return;
  const a = b.dataset.dl, id = b.dataset.id;
  try {
    if (a === 'go') dlStart();
    else if (a === 'force') dlStart('', true);
    else if (a === 'mode') { const m = b.dataset.mode; D.ask = null; dlStart(m); }
    else if (a === 'askno') { D.ask = null; render(); }
    else if (a === 'paste') {
      try { D.url = (await navigator.clipboard.readText()).trim(); D.err = ''; D.note = null; dlProbeNow(); }
      catch (err) { document.getElementById('dlurl')?.focus(); D.err = 'Press Ctrl+V to paste.'; render(); }
    }
    else if (a === 'cancel') { await api('/api/ui/dl/cancel/' + id, {}); await dlRefresh(); render(); }
    else if (a === 'remove') { await api('/api/ui/dl/remove/' + id, {}); await dlRefresh(); render(); }
    else if (a === 'show') await api('/api/ui/dl/show/' + id, {});
    else if (a === 'again') { const j = DL.jobs.find((x) => x.id === id); D.url = j.url; D.audio = !!j.audio; dlStart(j.mode, true); }
    else if (a === 'login') { if (b.dataset.site) await api('/api/ui/dl/login/' + b.dataset.site, {}); }
    else if (a === 'forget') { await api('/api/ui/dl/forget-logins', {}); await dlRefresh(); render(); }
    else if (a === 'folder') { await api('/api/ui/dl/folder', {}); await dlRefresh(); render(); }
    else if (a === 'nightly') { await api('/api/ui/dl/nightly', { on: b.dataset.on === '1' }); await dlRefresh(); render(); }
    else if (a === 'engines') { await api('/api/ui/dl/engines', {}); setTimeout(async () => { await dlRefresh(); render(); }, 1500); }
  } catch (err) { D.err = err.message; render(); }
});
$app.addEventListener('input', (e) => {
  if (e.target.id !== 'dlurl') return;
  D.url = e.target.value; D.err = ''; D.note = null; D.probe = null;
  clearTimeout(probeTimer);
  probeTimer = setTimeout(dlProbeNow, 700);
  render();
});
$app.addEventListener('change', (e) => { if (e.target.id === 'dlaudio') { D.audio = e.target.checked; render(); } });
$app.addEventListener('keydown', (e) => { if (e.target.id === 'dlurl' && e.key === 'Enter') { clearTimeout(probeTimer); dlStart(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && D.ask) { D.ask = null; render(); } });
