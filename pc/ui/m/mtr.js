// Transcribe on the phone. Pick a voice memo or video, the PC's Whisper turns it into text, and the text comes
// back here to read and copy; the .srt subtitles download on tap. The box and rows are /m/tr-core.js.
'use strict';

const TRAPI = {
  get base() { return PCURL + '/api/phone/tr'; }, // PCURL can change (home, Tailscale, the relay link), so read it each time
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => trPoll(),
  url: (j, n, dl) => j.local ? ljURL(j, n) : `${PCURL}/api/phone/tr/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`,
  where: (j) => j.local ? ljWhere(j) : '', // the text is right there, under Text
  acts: (j) => j.local ? ljSaveBtn(j) : more('tr' + j.id, [frShareBtn('tr', j), j.from === ST?.me && `<button type="button" role="menuitem" data-trremove="${j.id}">${icon('x')}Remove from the list</button>`]),
};

function trToolsView() {
  if (OFFLINE || !TRST) TRST = TR_LOCAL; // the PC is out of reach: this phone listens
  const jobs = [...trJobs()].sort(newest);
  return `${note(esc(T.err))}<div class="dlbox cvbox">${trBox()}</div>
    <p class="tip">${TRST.local ? "Your PC is out of reach, so this phone listens. It's slower than the PC, and the first time it gets the speech engine (about 80 MB)."
      : IOS && !trCanRecord() ? `To talk now, run the ${SHORTCUT_TR} Shortcut. Voice Memos can share straight to it. <button type="button" class="link" data-go="trsettings">Set it up</button>`
      : IOS ? 'Record here, or pick a voice memo you saved to Files.' : 'Voice Recorder files are in Recordings, in My Files.'}</p>
    ${jobs.length ? byDay(jobs, (j) => j.at, trRow) : ''}`;
}

const SHORTCUT_TR = 'Transcribe with Premade';

// iPhone: Home Screen apps reach the PC over http, where Safari keeps the mic off, so a Shortcut records instead.
function trShortcutGuide() {
  const base = PCLINK, t = encodeURIComponent(TOKEN);
  return `<section class="sec"><h2>Record and transcribe</h2><p class="tip">Safari keeps the microphone off for Premade, so a Shortcut records instead. Make it once.</p>
    <details class="iosguide"><summary>Set up "${SHORTCUT_TR}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_TR}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>; under <b>Receive</b>, pick <b>Media</b> and <b>Files</b>. Then it also takes voice memos from Voice Memos › Share.</li>
      <li><b>If</b> <b>Shortcut Input</b> <b>has any value</b>: <b>Set Variable</b> <b>Sound</b> to <b>Shortcut Input</b>. <b>Otherwise</b>: <b>Record Audio</b> (tap the arrow: Start Recording <b>Immediately</b>, Finish Recording <b>On Tap</b>) and <b>Set Variable</b> <b>Sound</b> to <b>Recorded Audio</b>. <b>End If</b>.</li>
      <li><b>Get Contents of URL</b> with the address below. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Sound</b>. <b>Set Variable</b> <b>Job</b> to it. <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> and <b>Stop This Shortcut</b>. For English text from any language, change <b>to=text</b> to <b>to=en</b>.${copyField('Start', `${base}/api/phone/tr/ios/start?t=${t}&name=Recording.m4a&to=text`)}</li>
      <li>Add a <b>Text</b> “no” and <b>Set Variable</b> <b>Done</b> to it. Then <b>Repeat</b> <b>300</b> times, and inside it <b>If</b> <b>Done</b> <b>is</b> “no”:</li>
      <li>…<b>Get Contents of URL</b> of the address below, with <b>Job</b> put where it says JOB. <b>If</b> it <b>begins with</b> <b>WAIT</b>: <b>Wait</b> 2 seconds. <b>Otherwise</b>, <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with it. <b>Otherwise</b>: <b>Copy to Clipboard</b> and <b>Show Result</b>. In both of these, <b>Set Variable</b> <b>Done</b> to a Text “yes”.${copyField('Get', `${base}/api/phone/tr/ios/get/JOB?t=${t}`)}</li>
      <li>After the Repeat: <b>If</b> <b>Done</b> <b>is</b> “no”: <b>Show Notification</b> “Still transcribing on the PC. The text will be in Premade Tools › History.”</li>
      <li>Put it where your thumb is: <b>Share</b> › <b>Add to Home Screen</b>, or Settings › <b>Action Button</b> › Shortcut. Allow the microphone and devices on your network when asked. The text also lands in History here and on the PC.</li>
    </ol></details></section>`;
}

function trSettingsView() {
  const e = TRST?.local ? {} : TRST?.engine || {};
  return `${IOS ? trShortcutGuide() : ''}
    <section class="sec"><h2>On ${ME}</h2>
      <div class="srow"><span class="grow">Text and subtitles<span class="h">Tap Text on a finished file, then Copy text. Subtitles (.srt) ${IOS ? 'open in Safari; tap Share › Save to Files' : 'save into Downloads'}.</span></span></div></section>
    <section class="sec"><h2>On your PC</h2>
      <div class="srow"><span class="grow">Save folder<span class="h mono">${esc(TRST?.local ? '' : TRST?.dir || '')}</span><span class="h">A .txt and an .srt of everything stay here. Every tool saves into this one folder. Change it on the PC in Settings.</span></span></div>
      <div class="srow"><span class="grow">Speech engine<span class="h">${e.state === 'ok' ? `Whisper is ready${e.gpu ? ' on the graphics card' : ''}.${e.translate ? ' Translating to English is ready too.' : ''}` : e.state === 'installing' ? `Your PC is getting it (${e.pct}%).` : 'Your PC gets Whisper (free, about 2.3 GB) the first time something is transcribed.'}</span></span>${e.state === 'ok' ? '<span class="ok">Ready</span>' : ''}</div>
    </section>`;
}

let trTimer = null;
function trPoll() {
  clearTimeout(trTimer);
  trTimer = setTimeout(async () => { await trRefresh(); render(); if (trBusy()) trPoll(); }, 2000);
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-trdl],[data-trremove]');
  if (!b) return;
  try {
    if (b.dataset.trremove) { await api(`${TRAPI.base}/remove/${b.dataset.trremove}`, {}); await trRefresh(); render(); return; }
    await trFromDL(b.dataset.trdl);
  } catch (err) { T.err = err.message; }
  go('transcribe'); render(); // render: already on Transcribe, the error still shows
});
trRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
