// Transcribe on the phone. Pick a voice memo or video, the PC's Whisper turns it into text, and the text comes
// back here to read and copy; the .srt subtitles download on tap. The box and rows are /m/tr-core.js.
'use strict';

const TRAPI = {
  base: '/api/phone/tr',
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => trPoll(),
  from: (j) => dlFrom(j),
  url: (j, n, dl) => `/api/phone/tr/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`,
  where: () => '',
  acts: (j) => frShareBtn('tr', j),
};

function trToolsView(off) {
  const title = dlTitle('Transcribe', 'Voice memos and videos become text. Your PC listens; nothing goes online.');
  if (OFFLINE || !TRST) return title + `<div class="feed scroller">${off}<p class="mhint">${icon('info')}<span>The PC does the listening, so it needs to be on and reachable${IOS ? ' (at home, or anywhere with Tailscale)' : ''}.</span></p></div>`;
  const mine = trJobs().filter((j) => j.from === ST?.me).slice(0, 5);
  return `${title}<div class="feed scroller">${off}
    ${T.err ? `<div class="notebox">${icon('alert')}<div>${esc(T.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${trBox()}
      <div class="route"><i class="dotlight"></i><span>${IOS ? `To talk now, run the <b>${SHORTCUT_TR}</b> Shortcut (Settings tab shows how). Voice Memos can share straight to it.` : 'Voice Recorder files are in Recordings, in My Files.'}</span></div></div>
    ${mine.length ? `<section class="sec"><h2 class="group-label">From this phone</h2><div class="rows hrows">${mine.map((j) => trRow(j)).join('')}</div></section>` : ''}
  </div>`;
}

function trHistoryView(off) {
  const days = [];
  for (const j of trJobs()) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(trRow(j, true));
  }
  return `${dlTitle('History', 'Everything transcribed, on the PC and your phones.')}
    <div class="feed scroller">${off}${days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
      : `<div class="empty">${icon('transcribe')}<h2>Nothing transcribed yet</h2><p>Pick a voice memo in Transcribe, or tap Transcribe on a download.</p></div>`}</div>`;
}

const SHORTCUT_TR = 'Transcribe with Premade';

// iPhone: Home Screen apps reach the PC over http, where Safari keeps the mic off, so a Shortcut records instead.
function trShortcutGuide() {
  const base = location.origin, t = encodeURIComponent(TOKEN);
  const field = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}"><button type="button" class="btn" data-copy>Copy</button></div>`;
  return `<section class="group"><div class="sectionhead"><b>Record and transcribe</b><i></i></div>
    <details class="iosguide"><summary>Set up "${SHORTCUT_TR}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_TR}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>; under <b>Receive</b>, pick <b>Media</b> and <b>Files</b>. Then it also takes voice memos from Voice Memos › Share.</li>
      <li><b>If</b> <b>Shortcut Input</b> <b>has any value</b>: <b>Set Variable</b> <b>Sound</b> to <b>Shortcut Input</b>. <b>Otherwise</b>: <b>Record Audio</b> (tap the arrow: Start Recording <b>Immediately</b>, Finish Recording <b>On Tap</b>) and <b>Set Variable</b> <b>Sound</b> to <b>Recorded Audio</b>. <b>End If</b>.</li>
      <li><b>Get Contents of URL</b> with the address below. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Sound</b>. <b>Set Variable</b> <b>Job</b> to it. <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> and <b>Stop This Shortcut</b>. For English text from any language, change <b>to=text</b> to <b>to=en</b>.${field('Start', `${base}/api/phone/tr/ios/start?t=${t}&name=Recording.m4a&to=text`)}</li>
      <li>Add a <b>Text</b> “no” and <b>Set Variable</b> <b>Done</b> to it. Then <b>Repeat</b> <b>300</b> times, and inside it <b>If</b> <b>Done</b> <b>is</b> “no”:</li>
      <li>…<b>Get Contents of URL</b> of the address below, with <b>Job</b> put where it says JOB. <b>If</b> it <b>begins with</b> <b>WAIT</b>: <b>Wait</b> 2 seconds. <b>Otherwise</b>, <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with it. <b>Otherwise</b>: <b>Copy to Clipboard</b> and <b>Show Result</b>. In both of these, <b>Set Variable</b> <b>Done</b> to a Text “yes”.${field('Get', `${base}/api/phone/tr/ios/get/JOB?t=${t}`)}</li>
      <li>Put it where your thumb is: <b>Share</b> › <b>Add to Home Screen</b>, or Settings › <b>Action Button</b> › Shortcut. Allow the microphone and devices on your network when asked. The text also lands in History here and on the PC.</li>
    </ol></details></section>`;
}

function trSettingsView(off) {
  const e = TRST?.engine || {};
  return `${dlTitle('Settings', 'Where text goes, and the speech engine.')}<div class="headrule"></div>
    <div class="feed scroller">${off}${IOS ? trShortcutGuide() : ''}
    <section class="group"><div class="sectionhead"><b>On this phone</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Text and subtitles</h2><p class="block-hint">Open a finished file and tap Copy text. Subtitles (.srt) ${IOS ? 'open in Safari; tap Share › Save to Files' : 'save into Downloads'}.</p></div>
    </div></section>
    <section class="group"><div class="sectionhead"><b>On the PC</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Transcripts folder</h2><p class="vaultpath-m">${esc(TRST?.dir || '')}</p><p class="block-hint">A .txt and an .srt of everything stay here. Change it on the PC in Settings.</p></div>
      <div class="block"><h2 class="block-title">Speech engine</h2><p class="block-hint">${e.state === 'ok' ? `Whisper is ready${e.gpu ? ' on the graphics card' : ''}.` : e.state === 'installing' ? `The PC is getting it (${e.pct}%).` : 'The PC gets Whisper (free, about 2.3 GB) the first time something is transcribed.'}${e.translate ? ' Translating to English is ready too.' : ''}</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>`;
}

let trTimer = null;
function trPoll() {
  clearTimeout(trTimer);
  trTimer = setTimeout(async () => { await trRefresh(); render(); if (trBusy()) trPoll(); }, 2000);
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-trdl]');
  if (!b) return;
  try { await trFromDL(b.dataset.trdl); S.tool = 'transcribe'; S.tab = 'transcribe'; render(); } catch (err) { T.err = err.message; S.tool = 'transcribe'; S.tab = 'transcribe'; render(); }
});
trRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
