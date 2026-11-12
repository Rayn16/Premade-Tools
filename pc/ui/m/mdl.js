// The Downloader on the phone. The PC does the downloading; the S23 app saves results into Gallery by itself,
// and the iPhone saves them to Photos through the "Download with Premade" Shortcut.
'use strict';

const DS = { url: '', audio: false, probe: null, probing: '', busy: false, err: '', note: null, ask: null, phone: null, hereWarned: false };
const SHORTCUT_DL = 'Download with Premade';
let dlProbeTimer = null;
const saving = new Set(); // jobs the Android app was asked to save

ICON.dl = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';

const dlJobs = () => DL?.jobs || [];
const dlBusy = () => dlJobs().some(isLive);
const fileURL = (j, n, dl) => `${PCURL}/api/phone/dl/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;
// The link in what was pasted ("Look at this https://…"), as the PC finds it (cleanURL); the phone's own download needs it bare.
const dlLink = (s) => s.match(/https?:\/\/[^\s"'<>]+/i)?.[0].replace(/[.,;!?)]+$/, '') || (/^\S+\.\S+$/.test(s.trim()) ? 'https://' + s.trim() : s.trim());
const runDl = (text) => 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT_DL) + '&input=text&text=' + encodeURIComponent(text);

// On the S23, finished downloads sent from this phone go straight into Gallery.
function dlAfterRefresh() {
  if (!NATIVE?.saveDownload) return;
  for (const j of dlJobs()) {
    if (j.from === ST?.me && j.state === 'done' && !j.fetched && !saving.has(j.id)) { saving.add(j.id); NATIVE.saveDownload(j.id); }
  }
}

// A download as a row, seen from this phone. Photos show themselves; videos keep their icon, so a list doesn't
// pull every video's start over the phone's data.
function dlFields(j) {
  const fs = j.files || [], n = shown1(fs), live = isLive(j);
  const kind = j.state === 'failed' ? 'alert' : (fs[n] || fs[0])?.kind || (j.audio ? 'audio' : /picture/.test(j.what || '') ? 'photo' : 'video');
  const state = j.state === 'queued' ? 'waiting its turn' : j.pct < 1 ? 'starting' : j.pct >= 99 ? 'finishing' : Math.floor(j.pct) + '%';
  return { id: j.id, th: thumb(kind, j.state === 'done' && fs[n]?.kind === 'photo' && !OFFLINE ? fileURL(j, n) : '', dlDur(j)),
    title: esc(j.title || j.url.replace(/^https?:\/\/(www\.)?/, '')), bad: j.state === 'failed',
    meta: j.state === 'failed' ? esc(j.note || "That didn't download.") : esc(dlWhat(j) + (live ? ', ' + state : j.size ? ', ' + size(j.size) : '') + (j.note ? '. ' + j.note : '')),
    where: whereOf(j, IOS ? (j.audio ? 'In Files' : 'In your Photos') : 'In Gallery'), when: stamp(new Date(j.at)), pct: live ? (j.state === 'queued' ? 0 : j.pct) : -1 };
}

// Save: the S23 app saves it into Gallery. The iPhone opens a photo or video in Safari, whose Share button has
// Save Image and Save Video (several files: pick each from a menu); sound and files go to Files, several as one ZIP.
// It stays after saving: on the iPhone, opening it doesn't mean it was saved.
function dlSaveButton(j) {
  const fs = j.files || [];
  if (NATIVE?.saveDownload) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn text" data-dlsave="${j.id}">Save</button>`;
  if (j.audio || fs.every((f) => f.kind === 'audio' || f.kind === 'file')) return `<a class="btn text" href="${fs.length > 1 ? `${PCURL}/api/phone/dl/zip/${j.id}?t=${encodeURIComponent(TOKEN)}` : fileURL(j, 0, true)}" data-dlgot="${j.id}">Save</a>`;
  if (fs.length === 1) return `<a class="btn text" href="${fileURL(j, 0)}" target="_blank" data-dlgot="${j.id}">Save</a>`;
  return more('dlsave' + j.id, fs.map((f, n) => `<a role="menuitem" href="${fileURL(j, n)}" target="_blank" data-dlgot="${j.id}">${icon(f.kind === 'video' ? 'video' : 'photo')}${f.kind === 'video' ? 'Video' : 'Photo'} ${n + 1}</a>`), 'Save');
}

function dlRow(j) {
  const acts = isLive(j) ? (j.from === ST?.me ? `<button type="button" class="btn text" data-dlcancel="${j.id}">Cancel</button>` : '')
    : j.state !== 'done' ? '' : dlSaveButton(j) + more('dl' + j.id, [frShareBtn('dl', j),
      (j.files || []).some((f) => f.kind === 'video' || f.kind === 'audio') && `<button type="button" role="menuitem" data-trdl="${j.id}">${icon('transcribe')}Transcribe</button>`]);
  return rowOf({ ...dlFields(j), acts });
}

// What the link is, under the box: checking, the site and title, or why it won't work.
function dlLine() {
  const line = (text, bad) => `<p class="detected ${bad ? 'is-bad' : ''}">${bad ? icon('alert') : ''}<span>${text}</span></p>`;
  if (DS.err) return line(esc(DS.err), true);
  if (!DS.url.trim()) return '';
  if (DS.probing) return `<p class="detected"><i class="pulse"></i><span>Checking the link…</span></p>`;
  const p = DS.probe;
  if (!p) return '';
  if (p.err) return line(esc(p.err) + (p.login ? ' On the PC: Settings › Downloader › Logins.' : ''), true);
  return `<p class="detected"><i class="dotlight"></i><span><b>${esc(p.site)}</b> · ${esc(p.title || '')}${p.title ? ' · ' : ''}${esc(DS.audio && !p.pictures ? 'Sound only, MP3' : p.what)}</span></p>`;
}

function dlView() {
  const field = `<label class="linkfield">${icon('link')}<input id="dlurl" value="${esc(DS.url)}" placeholder="Paste a link" aria-label="Link" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">${NATIVE?.clipboard || navigator.clipboard?.readText ? '<button type="button" class="btn text" data-dlpaste>Paste</button>' : ''}</label>`;
  const audio = `<label class="sw"><input type="checkbox" class="switch" role="switch" id="dlaudio" ${DS.audio ? 'checked' : ''}>Audio only (MP3)</label>`;
  const ph = DS.phone || {}, n = DS.note;
  let box;
  if (OFFLINE && IOS) box = `${field}<button type="button" class="btn primary big" data-dlhere>Download</button>
    ${DS.hereWarned ? note(`Download opens Apple's <b>Shortcuts</b> app to run <b>${SHORTCUT_DL}</b>. If you haven't made that Shortcut and installed a-Shell yet, it won't work, so set them up first. Or wait until you're home, when your PC does it. Made them already? Tap <b>Download</b> again.`) : ''}
    <p class="tip">Your PC is out of reach, so this iPhone downloads it with the free a-Shell app, through the ${SHORTCUT_DL} Shortcut, and saves it to Photos. <button type="button" class="link" data-go="dlsettings">Set it up</button></p>`;
  else if (OFFLINE && NATIVE?.phoneDownload) box = `${field}${ph.err ? `<p class="detected is-bad">${icon('alert')}<span>${esc(ph.err)}</span></p>` : ph.busy ? `<p class="detected"><i class="pulse"></i><span>Downloading on this phone… ${ph.pct || 0}%</span></p><span class="prog"><i style="width:${Math.max(2, ph.pct || 0)}%"></i></span>`
      : ph.done ? `<p class="detected"><i class="dotlight"></i><span>Saved: <b>${esc(ph.done)}</b>, in Gallery.</span></p>` : ''}
    <button type="button" class="btn primary big" data-dlphone ${ph.busy ? 'disabled' : ''}>Download</button>${audio}
    <p class="tip">Your PC is out of reach, so this phone downloads it and puts it in Gallery.</p>`;
  else if (OFFLINE) box = `<p class="tip">Your PC is off or out of reach. Links you share wait and go to the PC when it's back.</p>`;
  else box = `${field}${dlLine()}<button type="button" class="btn primary big" data-dlgo ${DS.url.trim() && !DS.busy && DL?.ready ? '' : 'disabled'}>${DS.busy ? 'Checking…' : 'Download'}</button>${audio}
    <p class="tip">${IOS ? `From TikTok, Instagram or YouTube: tap Share, then ${SHORTCUT_DL}. <button type="button" class="link" data-go="dlsettings">Set it up</button>` : 'From TikTok, Instagram or YouTube: tap Share, then Premade Tools.'}</p>
    ${DL && !DL.ready ? note('Your PC is still setting up its download engines. Try again in a few minutes.', 'info') : ''}
    ${n?.repeat ? note(`You already have <b>${esc(n.repeat.title)}</b>, from ${esc(dayOf(new Date(n.repeat.at)).toLowerCase())}.<div class="acts">${dlSaveButton(n.repeat)}<button type="button" class="btn small" data-dlforce>Download again</button></div>`, 'info') : ''}`;
  const jobs = [...dlJobs()].sort(newest);
  return `<div class="dlbox">${box}</div>${jobs.length ? byDay(jobs, (j) => j.at, dlRow) : ''}`;
}

function dlAskView() {
  const p = DS.ask;
  return `<div class="backdrop" data-dlaskno><section class="sheet upd" role="dialog" aria-modal="true" aria-label="Playlist">
    <div class="ask-head"><p class="eyebrow">${esc(p.site)} playlist</p><h2 class="sheet-title">${esc(p.title)}</h2></div>
    <div class="ask-body">This link is a playlist of <b>${p.count} ${DS.audio ? 'songs' : 'videos'}</b>. All of them, or just the one it was opened on?</div>
    <div class="ask-foot"><button type="button" class="btn" data-dlaskno>Cancel</button><button type="button" class="btn" data-dlmode="one">Just this one</button><button type="button" class="btn primary" data-dlmode="all">All ${p.count}</button></div></section></div>`;
}

function dlSettingsView() {
  const base = PCLINK, t = encodeURIComponent(TOKEN), eng = DL?.engines || [];
  return `${IOS ? `<section class="sec"><h2>Share button</h2><p class="tip">Make the <b>${SHORTCUT_DL}</b> Shortcut once, and it's in the Share button of every app.</p>
    <details class="iosguide"><summary>Set up "${SHORTCUT_DL}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_DL}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, keep only <b>URLs</b>, <b>Safari web pages</b> and <b>Text</b>, and set <b>If there's no input</b> to <b>Get Clipboard</b>.</li>
      <li>Add <b>Get Contents of URL</b> with the address below, Method <b>POST</b>, Request Body <b>File</b>, and pick <b>Shortcut Input</b>.${copyField('Start', `${base}/api/phone/dl/ios/start?t=${t}`)}</li>
      <li><b>Set Variable</b> named <b>Job</b> to <b>Contents of URL</b>. Then <b>If</b> <b>Job</b> <b>begins with</b> <b>ERR OFF</b> (your PC is off or offline): do the steps in <b>When your PC is off</b> below, then <b>Stop This Shortcut</b>. <b>End If</b>.</li>
      <li>Then <b>If</b> <b>Job</b> <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with <b>Job</b>, then <b>Stop This Shortcut</b>. <b>End If</b>.</li>
      <li><b>Repeat</b> <b>40</b> times. Inside it: a <b>Text</b> with the address below, with <b>Job</b> put where it says JOB, then <b>Get Contents of URL</b> of that Text.${copyField('Get', `${base}/api/phone/dl/ios/get/JOB?t=${t}`)}</li>
      <li>Still inside the Repeat: <b>If</b> <b>Contents of URL</b> <b>begins with</b> <b>WAIT</b>, do nothing (the PC waits up to 20 seconds each time). <b>Otherwise</b>: <b>If</b> it <b>begins with</b> <b>ERR</b>, <b>Show Notification</b> and <b>Stop This Shortcut</b>. <b>Otherwise</b>: <b>If</b> <b>File Extension</b> <b>is</b> <b>zip</b>, <b>Extract Archive</b> then <b>Save to Photo Album</b>; <b>Otherwise</b> <b>Save to Photo Album</b> on <b>Contents of URL</b>. Then <b>Show Notification</b> “Saved to Photos” and <b>Stop This Shortcut</b>.</li>
      <li>After the Repeat ends: <b>Show Notification</b> “Still downloading on the PC. Open Premade Tools to save it later.”</li>
      <li>Try it: in TikTok tap <b>Share</b> › <b>More</b> › <b>${SHORTCUT_DL}</b>. Allow access to devices on your network and to Photos when asked.</li>
    </ol></details></section>
    <section class="sec"><h2>When your PC is off</h2>
    <details class="iosguide"><summary>Download on the iPhone with a-Shell</summary><ol>
      <li>Install <b>a-Shell</b> (free, App Store). Open it and run this once (it takes a minute):${copyField('Setup', 'pip install -U yt-dlp gallery-dl')}</li>
      <li>In the Shortcut, inside <b>If Job begins with ERR OFF</b>: add a-Shell's <b>Execute Command</b> with this command, and put <b>Shortcut Input</b> where it says LINK (keep the quotes).${copyField('Command', 'mkdir -p ~/Documents/premade && cd ~/Documents/premade && rm -f * && (yt-dlp -f "b[ext=mp4]/b" -o "%(title).80B.%(ext)s" "LINK" || gallery-dl -D . "LINK")')}</li>
      <li>Then a-Shell's <b>Get File</b> (or <b>Get Contents of Folder</b> on a-Shell › <b>premade</b>) and <b>Save to Photo Album</b>.</li>
      <li>Keep the screen on while it runs. YouTube may not work without the PC, so YouTube links are best shared at home.</li>
    </ol></details></section>`
    : `<section class="sec"><h2>Share menu</h2><p class="tip">Premade Tools is in every app's Share menu. In TikTok, Instagram, YouTube or X tap Share and pick Premade Tools. Your PC downloads it and it lands in Gallery. Away from home, links wait and go when your PC is reachable.</p></section>`}
    <section class="sec"><h2>On your PC</h2>
      <div class="srow"><span class="grow">Save folder<span class="h mono">${esc(DL?.dir || '')}</span><span class="h">A copy of everything stays here. Every tool saves into this one folder. Change it on the PC in Settings.</span></span></div>
      <div class="srow"><span class="grow">Logins<span class="h">${(DL?.logins || []).length ? 'Logged in to ' + esc(DL.logins.join(', ')) + '. ' : ''}For Instagram stories and other posts that need an account, log in once on the PC: Settings › Downloader › Logins.</span></span></div>
      <div class="srow"><span class="grow">Engines<span class="h">${eng.map((e) => `${esc(e.name)} ${esc(e.version || e.state)}`).join(', ') || 'Not set up yet.'}</span></span></div>
    </section>`;
}

async function dlProbeNow() {
  const url = DS.url.trim();
  if (!url || OFFLINE) { DS.probe = null; DS.probing = ''; return render(); }
  DS.probing = url; render();
  try {
    const p = await api('/api/phone/dl/probe?url=' + encodeURIComponent(url));
    if (DS.url.trim() !== url) return;
    DS.probe = p;
  } catch (e) { DS.err = e.message; }
  DS.probing = ''; render();
}

async function dlGo(mode, force) {
  DS.busy = true; DS.err = ''; DS.note = null; render();
  try {
    const r = await api('/api/phone/dl/start', { url: DS.url, audio: DS.audio, mode: mode || '', force: !!force });
    DS.probe = r.probe; DS.ask = null;
    if (r.job) { DS.url = ''; DS.probe = null; document.activeElement?.blur(); }
    else if (r.repeat) DS.note = { repeat: r.repeat };
    else if (r.probe?.ask) DS.ask = r.probe;
    DL = await api('/api/phone/dl');
    NATIVE?.watchDownloads?.();
  } catch (e) { DS.err = e.message; }
  DS.busy = false; render();
}

$app.addEventListener('click', async (e) => {
  if (e.target.matches('.backdrop[data-dlaskno]')) { DS.ask = null; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.dlgo !== undefined) dlGo();
    else if (d.dlforce !== undefined) dlGo(DS.note?.repeat?.mode, true); // a playlist again: the same choice, all or one
    else if (d.dlmode) dlGo(d.dlmode);
    else if (d.dlaskno !== undefined) { DS.ask = null; render(); }
    else if (d.dlpaste !== undefined) { DS.url = (NATIVE?.clipboard ? NATIVE.clipboard() : await navigator.clipboard.readText()) || ''; DS.err = ''; DS.probe = null; dlProbeNow(); }
    else if (d.dlcancel) { await api('/api/phone/dl/cancel/' + d.dlcancel, {}); refresh(); }
    else if (d.dlphone !== undefined) { if (DS.url.trim()) { DS.phone = { busy: true, pct: 0 }; render(); NATIVE.phoneDownload(dlLink(DS.url), DS.audio); } }
    else if (d.dlhere !== undefined) {
      if (!DS.url.trim()) return;
      // The first time, say what's about to open instead of dropping them into the Shortcuts app unannounced.
      let ok = false;
      try { ok = localStorage.getItem('dlShortcutOK') === '1'; } catch {}
      if (!ok && !DS.hereWarned) { DS.hereWarned = true; render(); return; }
      try { localStorage.setItem('dlShortcutOK', '1'); } catch {}
      location.href = runDl(dlLink(DS.url));
    }
    else if (d.dlsave) { saving.add(d.dlsave); NATIVE.saveDownload(d.dlsave); b.textContent = 'Saving…'; }
  } catch (err) { DS.err = err.message; render(); }
});
// iPhone: opening a download to save it counts as picked up, so the PC stops saying it's waiting for this phone.
$app.addEventListener('click', (e) => { const a = e.target.closest('a[data-dlgot]'); if (a) api('/api/phone/dl/fetched/' + a.dataset.dlgot, {}).catch(() => {}); });
$app.addEventListener('input', (e) => {
  if (e.target.id !== 'dlurl') return;
  DS.url = e.target.value; DS.err = ''; DS.note = null; DS.probe = null;
  clearTimeout(dlProbeTimer);
  dlProbeTimer = setTimeout(dlProbeNow, 700);
});
$app.addEventListener('change', (e) => { if (e.target.id === 'dlaudio') { DS.audio = e.target.checked; render(); } });
$app.addEventListener('keydown', (e) => { if (e.target.id === 'dlurl' && e.key === 'Enter' && !OFFLINE) { clearTimeout(dlProbeTimer); e.target.blur(); dlGo(); } });
// The S23 app reports a download it does by itself (PhoneDL.java).
window.phoneDlProgress = (pct) => { DS.phone = { busy: true, pct }; const b = document.querySelector('.dlbox .prog i'); if (b) b.style.width = Math.max(2, pct) + '%'; else render(); };
window.phoneDlDone = (res) => { DS.phone = res.startsWith('ERR:') ? { err: res.slice(4) } : { done: res.split('\n').join(', ') }; if (!DS.phone.err) DS.url = ''; render(); };
