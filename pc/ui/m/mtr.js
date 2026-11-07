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
  acts: () => '',
};

function trToolsView(off) {
  const title = dlTitle('Transcribe', 'Voice memos and videos become text. Your PC listens; nothing goes online.');
  if (OFFLINE || !TRST) return title + `<div class="feed scroller">${off}<p class="mhint">${icon('info')}<span>The PC does the listening, so it needs to be on and reachable${IOS ? ' (at home, or anywhere with Tailscale)' : ''}.</span></p></div>`;
  const mine = trJobs().filter((j) => j.from === ST?.me).slice(0, 5);
  return `${title}<div class="feed scroller">${off}
    ${T.err ? `<div class="notebox">${icon('alert')}<div>${esc(T.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${trBox()}
      <div class="route"><i class="dotlight"></i><span>${IOS ? 'Voice Memos: tap ⋯ › Save to Files first, then pick it here.' : 'Voice Recorder files are in Recordings, in My Files.'}</span></div></div>
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

function trSettingsView(off) {
  const e = TRST?.engine || {};
  return `${dlTitle('Settings', 'Where text goes, and the speech engine.')}<div class="headrule"></div>
    <div class="feed scroller">${off}
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
