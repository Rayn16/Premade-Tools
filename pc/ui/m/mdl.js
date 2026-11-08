// The Downloader on the phone. The PC does the downloading; the S23 app saves results into Gallery by itself,
// and the iPhone saves them to Photos through the "Download with Premade" Shortcut.
'use strict';

const DS = { url: '', audio: false, probe: null, probing: '', busy: false, err: '', note: null };
const SHORTCUT_DL = 'Download with Premade';
const IOS = !NATIVE;
let dlProbeTimer = null;
const saving = new Set(); // jobs the Android app was asked to save

ICON.dl = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
ICON.link = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
ICON.music = '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>';
ICON.menu = '<path d="M4 7h16M4 12h16M4 17h16"/>';
ICON.share = '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>';

const dlJobs = () => DL?.jobs || [];
const dlBusy = () => dlJobs().some((j) => j.state === 'queued' || j.state === 'running');
const dlHue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const dlSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const dlFrom = (j) => (j.local ? 'this phone' : !j.from ? 'the PC' : j.from === ST?.me ? 'this phone' : phoneById(j.from)?.Name || 'a phone');
const dlThumb = (j) => `<span class="thumb" style="--h:${dlHue(j.id)}">${icon(j.audio ? 'music' : (j.files || []).some((f) => f.kind === 'video') || !j.files?.length ? 'video' : 'photo')}</span>`;
const dlTag = (s) => `<span class="sitetag">${esc(s || 'Link')}</span>`;
const fileURL = (j, n, dl) => `${PCURL}/api/phone/dl/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;
const runDl = (text) => 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT_DL) + '&input=text&text=' + encodeURIComponent(text);
const dlTitle = (name, lede) => `<div class="titlerow"><div class="titlerow-text"><h1 class="pagetitle">${name}</h1><p class="pagelede">${lede}</p></div></div>`;

// On the S23, finished downloads sent from this phone go straight into Gallery.
function dlAfterRefresh() {
  if (!NATIVE?.saveDownload) return;
  for (const j of dlJobs()) {
    if (j.from === ST?.me && j.state === 'done' && !j.fetched && !saving.has(j.id)) { saving.add(j.id); NATIVE.saveDownload(j.id); }
  }
}

function dlSaveButton(j) {
  if (j.state !== 'done') return '';
  if (NATIVE?.saveDownload) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn small" data-dlsave="${j.id}">${icon('save')}Save</button>`;
  if (j.audio || (j.files || []).every((f) => f.kind === 'audio' || f.kind === 'file')) return `<a class="btn small" href="${fileURL(j, 0, true)}">${icon('save')}To Files</a>`;
  return `<a class="btn small" href="${runDl(j.url)}">${icon('save')}To Photos</a>`;
}

function dlRow(j, full) {
  const state = j.state === 'queued' ? 'Waiting its turn' : j.state === 'running' ? (j.pct < 1 ? 'Starting…' : j.pct >= 99 ? 'Finishing…' : `On the PC ${Math.floor(j.pct)}%`) : '';
  const where = j.state !== 'done' ? '' : j.from === ST?.me && j.fetched ? (IOS ? 'In Photos' : 'In Gallery') : j.from === ST?.me && NATIVE ? 'Saving…' : 'On the PC';
  return `<div class="row">${dlThumb(j)}<div class="row-text grow"><span class="row-title clip">${esc(j.title || j.url)}</span>
    <div class="hmeta">${dlTag(j.site)}${full ? `<span>${esc(j.what)}${j.size ? ' · ' + dlSize(j.size) : ''}</span>` : ''}<span>${hm(new Date(j.at))}${full ? ' · from ' + esc(dlFrom(j)) : ''}</span>
    ${state ? `<span class="jobstate">${state}</span>` : ''}${where ? `<span class="where">${icon('check')}${where}</span>` : ''}</div>
    ${j.state === 'running' || j.state === 'queued' ? `<div class="prog"><i style="width:${Math.max(2, j.pct)}%"></i></div>` : ''}
    ${j.state === 'failed' ? `<div class="hmeta bad">${icon('alert')}${esc(j.note)}</div>` : ''}</div>
    <div class="hacts">${dlSaveButton(j)}${frShareBtn('dl', j)}${full && j.state === 'done' && (j.files || []).some((f) => f.kind === 'video' || f.kind === 'audio') ? `<button type="button" class="btn small" data-trdl="${j.id}">${icon('transcribe')}Text</button>` : ''}${j.state === 'running' || j.state === 'queued' ? `<button type="button" class="btn small" data-dlcancel="${j.id}">Cancel</button>` : ''}</div></div>`;
}

function dlLine() {
  if (DS.err) return `<div class="detected is-bad">${icon('alert')}<span>${esc(DS.err)}</span></div>`;
  if (!DS.url.trim()) return `<div class="detected">Any link from TikTok, YouTube, Instagram, X, Reddit and about 1,700 other sites.</div>`;
  if (DS.probing) return `<div class="detected"><span class="pulse"></span><span>Checking the link…</span></div>`;
  const p = DS.probe;
  if (!p) return '';
  if (p.err) return `<div class="detected is-bad">${icon('alert')}<span>${esc(p.err)}${p.login ? ' On the PC: Settings › Logins.' : ''}</span></div>`;
  return `<div class="detected"><i class="dotlight"></i><span><b>${esc(p.site)}</b> · ${esc(p.title || '')}${p.title ? ' · ' : ''}${esc(DS.audio && !p.pictures ? 'Sound only, MP3' : p.what)}</span></div>`;
}

function dlView(off) {
  if (OFFLINE && IOS) return dlTitle('Download', 'Paste a link, or share one from any app.') + `<div class="feed scroller">${off}
    <div class="dlbox">
      <label class="dlinput">${icon('link')}<span class="sr">Link</span><input id="dlhere" value="${esc(DS.url)}" placeholder="Paste a link" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>
      <div class="detected">Any link from TikTok, YouTube, Instagram, X, Reddit and about 1,700 other sites.</div>
      <div class="bigbtns">${navigator.clipboard?.readText ? '<button type="button" class="btn" data-dlherepaste>Paste</button>' : ''}<button type="button" class="btn primary" data-dlhere>${icon('dl')}Download</button></div>
      <div class="route"><i class="dotlight"></i><span>Your PC is out of reach, so this iPhone downloads it with the free <b>a-Shell</b> app, through the <b>${SHORTCUT_DL}</b> Shortcut, and saves it to Photos.</span></div></div>
    <p class="mhint">${icon('info')}<span>First time? Set up the Shortcut and a-Shell once: <b>Settings</b> tab, then <b>Share button</b> and <b>When your PC is off</b>.</span></p></div>`;
  if (OFFLINE) return dlTitle('Download', 'Paste a link, or share one from any app.') + `<div class="feed scroller">${off}
    <p class="mhint">${icon('info')}<span>Your PC is off or out of reach. Links you share wait and go to the PC when it's back.</span></p></div>`;
  const mine = dlJobs().filter((j) => j.from === ST?.me).slice(0, 6);
  const can = DS.url.trim() && !DS.busy && DL?.ready;
  const n = DS.note;
  return `${dlTitle('Download', IOS ? 'Paste a link, or tap Share in any app.' : 'Paste a link, or share one to Premade Tools from any app.')}
    <div class="feed scroller">${off}
      <div class="dlbox">
        <label class="dlinput">${icon('link')}<span class="sr">Link</span><input id="dlurl" value="${esc(DS.url)}" placeholder="Paste a link" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>
        ${dlLine()}
        <div class="bigbtns">${NATIVE?.clipboard ? `<button type="button" class="btn" data-dlpaste>Paste</button>` : ''}<button type="button" class="btn primary" data-dlgo ${can ? '' : 'disabled'}>${DS.busy ? 'Checking…' : `${icon('dl')}Download`}</button></div>
        <label class="dlswitch"><span>Audio only (MP3)</span><input type="checkbox" class="switch" role="switch" id="dlaudio" ${DS.audio ? 'checked' : ''}></label>
        <div class="route"><i class="dotlight"></i><span>${IOS ? 'Your PC downloads it. Tap <b>To Photos</b> when it\'s done.' : 'Your PC downloads it, then it goes into Gallery by itself.'}</span></div>
        ${!DL?.ready ? `<div class="notebox is-info">${icon('info')}<div>The PC is still setting up its download engines. Try again in a few minutes.</div></div>` : ''}
        ${n?.repeat ? `<div class="notebox is-info">${icon('info')}<div>You already have <b>${esc(n.repeat.title)}</b>, from ${esc(dayOf(new Date(n.repeat.at)).toLowerCase())}.<div class="acts">${dlSaveButton(n.repeat)}<button type="button" class="btn small" data-dlforce>Download again</button></div></div></div>` : ''}
      </div>
      ${mine.length ? `<section class="sec"><h2 class="group-label">From this phone</h2><div class="rows hrows">${mine.map((j) => dlRow(j)).join('')}</div></section>` : ''}
      ${IOS ? `<p class="mhint">${icon('share')}<span>Faster: in TikTok, Instagram or YouTube tap <b>Share</b> (then <b>More</b>) and pick <b>${SHORTCUT_DL}</b>. Set it up once in <b>Settings</b>.</span></p>` : ''}
    </div>`;
}

function dlHistoryView(off) {
  const days = [];
  for (const j of dlJobs()) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(dlRow(j, true));
  }
  return `${dlTitle('History', 'Everything downloaded on the PC and your phones, newest first.')}
    <div class="feed scroller">${off}${days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
      : `<div class="empty">${icon('dl')}<h2>Nothing downloaded yet</h2><p>Paste a link in Download, or share one from any app.</p></div>`}</div>`;
}

function dlAskView() {
  const p = DS.ask;
  return `<div class="msheet" data-dlaskno><div class="msheet-card"><div class="grab"><span></span></div>
    <div class="msheet-body"><p class="eyebrow">${esc(p.site)} playlist</p><h2 class="ask-title">${esc(p.title)}</h2>
    <p class="ask-text">This link is a playlist of <b>${p.count} ${DS.audio ? 'songs' : 'videos'}</b>. All of them, or just the one it was opened on?</p></div>
    <div class="actions dlask"><button type="button" class="btn primary block" data-dlmode="all">All ${p.count}</button><button type="button" class="btn block" data-dlmode="one">Just this one</button><button type="button" class="btn block" data-dlaskno>Cancel</button></div></div></div>`;
}

function dlSettingsView(off) {
  const base = PCLINK, t = encodeURIComponent(TOKEN);
  const field = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}"><button type="button" class="btn" data-copy>Copy</button></div>`;
  const eng = DL?.engines || [];
  const ios = IOS ? `
    <section class="group"><div class="sectionhead"><b>Share button</b><i></i></div>
    <details class="iosguide"><summary>Set up "${SHORTCUT_DL}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_DL}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, keep only <b>URLs</b>, <b>Safari web pages</b> and <b>Text</b>, and set <b>If there's no input</b> to <b>Get Clipboard</b>.</li>
      <li>Add <b>Get Network Details</b> (Wi-Fi, <b>Network Name</b>), then <b>If</b> <b>Network Details</b> <b>is</b> your home Wi-Fi name. Everything up to <b>Otherwise</b> runs at home through your PC.</li>
      <li>Inside the If: <b>Get Contents of URL</b> with the address below, Method <b>POST</b>, Request Body <b>File</b>, and pick <b>Shortcut Input</b>.${field('Start', `${base}/api/phone/dl/ios/start?t=${t}`)}</li>
      <li><b>Set Variable</b> named <b>Job</b> to <b>Contents of URL</b>. Then <b>If</b> <b>Job</b> <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with <b>Job</b>, then <b>Stop This Shortcut</b>. <b>End If</b>.</li>
      <li><b>Repeat</b> <b>40</b> times. Inside it: a <b>Text</b> with the address below, with <b>Job</b> put where it says JOB, then <b>Get Contents of URL</b> of that Text.${field('Get', `${base}/api/phone/dl/ios/get/JOB?t=${t}`)}</li>
      <li>Still inside the Repeat: <b>If</b> <b>Contents of URL</b> <b>begins with</b> <b>WAIT</b>, do nothing (the PC waits up to 20 seconds each time). <b>Otherwise</b>: <b>If</b> it <b>begins with</b> <b>ERR</b>, <b>Show Notification</b> and <b>Stop This Shortcut</b>. <b>Otherwise</b>: <b>If</b> <b>File Extension</b> <b>is</b> <b>zip</b>, <b>Extract Archive</b> then <b>Save to Photo Album</b>; <b>Otherwise</b> <b>Save to Photo Album</b> on <b>Contents of URL</b>. Then <b>Show Notification</b> “Saved to Photos” and <b>Stop This Shortcut</b>.</li>
      <li>After the Repeat ends, still at home: <b>Show Notification</b> “Still downloading on the PC. Open Premade Tools to save it later.”</li>
      <li><b>Otherwise</b> (away from home Wi-Fi): see <b>When your PC is off</b> below.</li>
      <li>Try it: in TikTok tap <b>Share</b> › <b>More</b> › <b>${SHORTCUT_DL}</b>. Allow access to devices on your network and to Photos when asked.</li>
    </ol></details></section>
    <section class="group"><div class="sectionhead"><b>When your PC is off</b><i></i></div>
    <details class="iosguide"><summary>Download on the iPhone with a-Shell</summary><ol>
      <li>Install <b>a-Shell</b> (free, App Store). Open it and run this once (it takes a minute):${field('Setup', 'pip install -U yt-dlp gallery-dl')}</li>
      <li>In the Shortcut's <b>Otherwise</b> part: add a-Shell's <b>Execute Command</b> with this command, and put <b>Shortcut Input</b> where it says LINK (keep the quotes).${field('Command', 'mkdir -p ~/Documents/premade && cd ~/Documents/premade && rm -f * && (yt-dlp -f "b[ext=mp4]/b" -o "%(title).80B.%(ext)s" "LINK" || gallery-dl -D . "LINK")')}</li>
      <li>Then a-Shell's <b>Get File</b> (or <b>Get Contents of Folder</b> on a-Shell › <b>premade</b>) and <b>Save to Photo Album</b>.</li>
      <li>Keep the screen on while it runs. YouTube may not work without the PC, so YouTube links are best shared at home.</li>
    </ol></details></section>` : `
    <section class="group"><div class="sectionhead"><b>Share menu</b><i></i></div><div class="panel"><div class="block"><h2 class="block-title">Premade Tools is in every app's Share menu</h2><p class="block-hint">In TikTok, Instagram, YouTube or X tap Share and pick Premade Tools. The PC downloads it and it lands in Gallery. Away from home, links wait and go when the PC is reachable.</p></div></div></section>`;
  return `${dlTitle('Settings', 'How downloads get to this phone.')}<div class="headrule"></div>
    <div class="feed scroller">${off}${ios}
    <section class="group"><div class="sectionhead"><b>On the PC</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Download folder</h2><p class="vaultpath-m">${esc(DL?.dir || '')}</p><p class="block-hint">A copy of everything stays here. Change it on the PC in Settings.</p></div>
      <div class="block"><h2 class="block-title">Logins</h2><p class="block-hint">${(DL?.logins || []).length ? 'Logged in to ' + esc(DL.logins.join(', ')) + '. ' : ''}For Instagram stories and other posts that need an account, log in once on the PC: Settings › Logins.</p></div>
      <div class="block"><h2 class="block-title">Engines</h2><p class="block-hint mono">${eng.map((e) => `${esc(e.name)} ${esc(e.version || e.state)}`).join(' · ')}</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>`;
}

async function dlProbeNow() {
  const url = DS.url.trim();
  if (!url) { DS.probe = null; DS.probing = ''; return render(); }
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
    DS.probe = r.probe; DS.ask = null; S.dlAsk = false;
    if (r.job) { DS.url = ''; DS.probe = null; }
    else if (r.repeat) DS.note = { repeat: r.repeat };
    else if (r.probe?.ask) { DS.ask = r.probe; S.dlAsk = true; }
    DL = await api('/api/phone/dl');
    NATIVE?.watchDownloads?.();
  } catch (e) { DS.err = e.message; }
  DS.busy = false; render();
}

$app.addEventListener('click', async (e) => {
  if (e.target.dataset?.dlaskno !== undefined && e.target.classList.contains('msheet')) { S.dlAsk = false; render(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.dlgo !== undefined) dlGo();
    else if (d.dlforce !== undefined) dlGo('', true);
    else if (d.dlmode) dlGo(d.dlmode);
    else if (d.dlaskno !== undefined) { S.dlAsk = false; render(); }
    else if (d.dlpaste !== undefined) { DS.url = NATIVE.clipboard() || ''; DS.err = ''; dlProbeNow(); }
    else if (d.dlcancel) { await api('/api/phone/dl/cancel/' + d.dlcancel, {}); refresh(); }
    else if (d.dlhere !== undefined) { if (DS.url.trim()) location.href = runDl(DS.url.trim()); }
    else if (d.dlherepaste !== undefined) { DS.url = (await navigator.clipboard.readText()).trim(); render(); }
    else if (d.dlsave) { saving.add(d.dlsave); NATIVE.saveDownload(d.dlsave); b.textContent = 'Saving…'; }
  } catch (err) { DS.err = err.message; render(); }
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'dlhere') DS.url = e.target.value;
  if (e.target.id !== 'dlurl') return;
  DS.url = e.target.value; DS.err = ''; DS.note = null; DS.probe = null;
  clearTimeout(dlProbeTimer);
  dlProbeTimer = setTimeout(dlProbeNow, 700);
});
$app.addEventListener('change', (e) => { if (e.target.id === 'dlaudio') { DS.audio = e.target.checked; render(); } });
$app.addEventListener('keydown', (e) => { if (e.target.id === 'dlurl' && e.key === 'Enter') { clearTimeout(dlProbeTimer); e.target.blur(); dlGo(); } });
