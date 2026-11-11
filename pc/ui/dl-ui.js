// The Downloader's page and settings in the PC window. app.js draws the frame and calls downloadView()/dlSettings().
'use strict';

let DL = null; // /api/ui/dl
const D = { url: '', audio: false, probe: null, probing: '', ask: null, note: null, err: '', busy: false, logins: false };
let probeTimer = null;

ICON.download = ICON.dl = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';

const dlRunning = () => (DL?.jobs || []).some(isLive);
const fromName = (j) => (!j.from ? 'this PC' : phoneById(j.from)?.Name || 'a phone');
const LOGIN_SITES = [['instagram', 'Instagram'], ['x', 'X'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['facebook', 'Facebook'], ['reddit', 'Reddit']];
const siteKey = (name) => (LOGIN_SITES.find(([, l]) => l === name) || [])[0];
const and = (list) => list.join(', ').replace(/, ([^,]*)$/, ' and $1');

// A download as a row: its first picture or video, what it is, and where it is now.
function dlFields(j) {
  const fs = j.files || [], n = shown1(fs), p = j.from && phoneById(j.from), live = isLive(j);
  const kind = j.state === 'failed' ? 'alert' : (fs[n] || fs[0])?.kind || (j.audio ? 'audio' : /picture/.test(j.what || '') ? 'photo' : 'video');
  const state = j.state === 'queued' ? 'waiting its turn' : j.pct < 1 ? 'starting' : j.pct >= 99 ? 'finishing' : Math.floor(j.pct) + '%';
  return { id: j.id, th: thumb(kind, j.state === 'done' && n >= 0 ? `/api/ui/dl/file/${j.id}/${n}` : '', dlDur(j)),
    title: esc(j.title || j.url.replace(/^https?:\/\/(www\.)?/, '')), bad: j.state === 'failed',
    meta: j.state === 'failed' ? esc(j.note || "That didn't download.") : esc(dlWhat(j) + (live ? ', ' + state : j.size ? ', ' + size(j.size) : '') + (j.note ? '. ' + j.note : '')),
    where: whereOf(j, p && `In ${esc(p.Name)}'s ${p.Kind === 'iphone' ? (j.audio ? 'Files' : 'Photos') : 'Gallery'}`),
    when: stamp(new Date(j.at)), pct: live ? (j.state === 'queued' ? 0 : j.pct) : -1 };
}

function histRow(j) {
  const id = `data-id="${j.id}"`, item = (a, ic, l) => `<button type="button" role="menuitem" data-dl="${a}" ${id}>${icon(ic)}${l}</button>`;
  const remove = item('remove', 'x', 'Remove from the list');
  const acts = isLive(j) ? `<button type="button" class="btn text" data-dl="cancel" ${id}>Cancel</button>`
    : j.state === 'done' ? `<button type="button" class="btn text" data-dl="show" ${id}>Show</button>${more('dl' + j.id, [frShareBtn('dl', j),
      (j.files || []).some((f) => f.kind === 'video' || f.kind === 'audio') && `<button type="button" role="menuitem" data-trdl="${j.id}">${icon('transcribe')}Transcribe</button>`,
      item('again', 'dl', 'Download again'), remove])}`
    : `${j.login ? `<button type="button" class="btn" data-dl="login" data-site="${siteKey(j.login) || ''}">Log in</button>` : ''}<button type="button" class="btn text" data-dl="again" ${id}>Try again</button>${more('dl' + j.id, [remove])}`;
  return rowOf({ ...dlFields(j), acts });
}

function detectLine() {
  const line = (text, bad) => `<span class="detected ${bad ? 'is-bad' : ''}">${bad ? icon('alert') : ''}<span>${text}</span></span>`;
  if (D.err) return line(esc(D.err), true);
  if (!D.url.trim()) return line('Works with TikTok, YouTube, Instagram, X, Reddit and about 1,700 other sites.');
  if (D.probing) return `<span class="detected"><i class="pulse"></i><span>Checking the link…</span></span>`;
  const p = D.probe;
  if (!p) return line('Press Download, or Enter.');
  if (p.err) return line(esc(p.err), true);
  const what = D.audio && !p.pictures ? (p.ask ? `${p.count} songs as MP3` : 'Sound only, as MP3') : p.what;
  return `<span class="detected"><i class="dotlight"></i><span><b>${esc(p.site)}</b> · ${esc(p.title || '')}${p.title ? ' · ' : ''}${esc(what)}</span></span>`;
}

function engineBanner() {
  if (!DL || DL.ready) return '';
  const bad = DL.engines.filter((e) => e.state === 'error');
  if (bad.length) return `<div class="notebox">${icon('alert')}<div>The download engines couldn't be set up: ${esc(bad.map((e) => `${e.name} (${e.err})`).join(', '))}.<div class="acts"><button type="button" class="btn small" data-dl="engines">Try again</button></div></div></div>`;
  return `<div class="notebox is-info">${icon('info')}<div><b>Setting up the download engines.</b> The first time, Premade Tools fetches yt-dlp, gallery-dl, FFmpeg and Deno (about 200 MB, free and open source). This takes a few minutes, once.</div></div>`;
}

function noteView() {
  const n = D.note;
  if (n?.repeat) {
    const j = n.repeat, day = dayOf(new Date(j.at));
    return `<div class="notebox is-info">${icon('info')}<div>You already downloaded <b>${esc(j.title)}</b> ${/^(Today|Yesterday)$/.test(day) ? day.toLowerCase() : 'on ' + esc(whenShort(new Date(j.at)).replace(/ \d+:\d+$/, ''))} at ${hm(new Date(j.at))}.
      <div class="acts"><button type="button" class="btn small" data-dl="show" data-id="${j.id}">Show it</button><button type="button" class="btn small" data-dl="force">Download it again</button></div></div></div>`;
  }
  if (n?.login) return `<div class="notebox">${icon('alert')}<div>${esc(n.err)} A small Edge window opens: log in, close it, then press Download again. A second account is safer, because sites can block accounts that download.
    <div class="acts"><button type="button" class="btn small primary" data-dl="login" data-site="${siteKey(n.login) || ''}">Log in to ${esc(n.login)}</button></div></div></div>`;
  return '';
}

function downloadView() {
  const jobs = [...(DL?.jobs || [])].sort(newest);
  const can = D.url.trim() && !D.busy && !(D.probe && D.probe.err && !D.probe.login) && DL?.ready;
  return `<section class="main">${head('Download')}<div class="body scroller"><div class="col">${engineBanner()}
    <div class="dlbox"><div class="linkbar">
        <label class="linkfield">${icon('link')}<input id="dlurl" value="${esc(D.url)}" placeholder="Paste a link" aria-label="Link" autocomplete="off" spellcheck="false"><button type="button" class="btn text" data-dl="paste">Paste</button></label>
        <button type="button" class="btn primary big" data-dl="go" ${can ? '' : 'disabled'}>${D.busy ? `${icon('spin', 'spin')}Checking…` : 'Download'}</button></div>
      <div class="under">${detectLine()}<label class="sw"><input type="checkbox" class="switch" role="switch" id="dlaudio" ${D.audio ? 'checked' : ''}>Audio only (MP3)</label></div>
      ${noteView()}</div>
    ${jobs.length ? byDay(jobs, (j) => j.at, histRow) : `<div class="empty">${icon('dl')}<h2>Nothing downloaded yet</h2><p>Paste a link above. Downloads from your phones show up here too.</p></div>`}
  </div></div></section>${D.ask ? askView() : ''}`;
}

function askView() {
  const p = D.ask;
  return `<div class="backdrop" data-dl="askno"><section class="sheet upd" role="dialog" aria-modal="true" aria-label="Playlist">
    <div class="ask-head"><p class="eyebrow">${esc(p.site)} playlist</p><h2 class="sheet-title">${esc(p.title)}</h2></div>
    <div class="ask-body">This link is a playlist of <b>${p.count} ${D.audio ? 'songs' : 'videos'}</b>. Download all of them, or just the one the link was opened on?</div>
    <div class="ask-foot"><button type="button" class="btn" data-dl="askno">Cancel</button><button type="button" class="btn" data-dl="mode" data-mode="one">Just this one</button><button type="button" class="btn primary" data-dl="mode" data-mode="all">All ${p.count}</button></div>
  </section></div>`;
}

const ENGNAME = { ffmpeg: 'FFmpeg', deno: 'Deno' };
function dlSettings() {
  if (!DL) return '';
  const logged = LOGIN_SITES.filter(([k]) => (DL.logins || []).includes(k)), eng = DL.engines.filter((e) => e.name !== 'magick');
  const bad = eng.filter((e) => e.state === 'error'), names = (list) => and(list.map((e) => ENGNAME[e.name] || e.name));
  const checked = eng.map((e) => e.checked).filter((t) => t && !t.startsWith('0001')).sort()[0];
  const engHint = bad.length ? `${esc(names(bad))} couldn't be set up: ${esc(bad[0].err || 'no reason given')}.`
    : !DL.ready || eng.some((e) => e.state !== 'ok') ? 'Setting up. The first time takes a few minutes.'
    : `${names(eng)} are ready. They update every 6 hours${checked ? `, last checked ${ago(checked)}` : ''}.`;
  return `<section class="sec"><h2>Downloader</h2>
    <div class="srow"><span class="grow">Logins<span class="h">${logged.length ? `Logged in to ${and(logged.map(([, l]) => l))}, for posts they hide from logged-out people.` : 'Only needed for posts a site hides from logged-out people, like Instagram stories.'}</span></span>
      <button type="button" class="btn" data-dl="logins" aria-expanded="${D.logins}">${D.logins ? 'Done' : 'Manage'}</button></div>
    ${D.logins ? `<p class="srow sub h">You log in once in a small Edge window, and the login stays on this PC. A second account is safer, because sites can block accounts that download.</p>
      ${LOGIN_SITES.map(([k, l]) => { const on = (DL.logins || []).includes(k); return `<div class="srow sub"><span class="grow">${l}</span>${on ? '<span class="ok">Logged in</span>' : ''}<button type="button" class="btn small" data-dl="login" data-site="${k}">${on ? 'Log in again' : 'Log in'}</button></div>`; }).join('')}
      ${logged.length ? '<div class="srow sub"><span class="grow">Forget all logins</span><button type="button" class="btn small danger" data-dl="forget">Forget</button></div>' : ''}` : ''}
    <div class="srow"><span class="grow">Engines<span class="h">${engHint}</span></span><button type="button" class="btn" data-dl="engines">Update now</button></div>
    <label class="srow"><span class="grow">Nightly yt-dlp<span class="h">Sites change all the time. Nightly gets their fixes first.</span></span><input type="checkbox" class="switch" role="switch" id="nightly" ${DL.nightly ? 'checked' : ''}></label>
  </section>`;
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
    else if (a === 'force') dlStart(D.note?.repeat?.mode, true); // a playlist again: the same choice, all or one
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
    else if (a === 'logins') { D.logins = !D.logins; render(); }
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
$app.addEventListener('change', async (e) => {
  if (e.target.id === 'dlaudio') { D.audio = e.target.checked; render(); }
  else if (e.target.id === 'nightly') { await api('/api/ui/dl/nightly', { on: e.target.checked }).catch(() => {}); await dlRefresh(); render(); }
});
$app.addEventListener('keydown', (e) => { if (e.target.id === 'dlurl' && e.key === 'Enter') { clearTimeout(probeTimer); dlStart(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && D.ask) { D.ask = null; render(); } });
