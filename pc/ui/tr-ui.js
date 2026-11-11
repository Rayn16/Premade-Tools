// Transcribe's page and settings in the PC window. app.js draws the frame and calls trView()/trSettings();
// /m/tr-core.js draws the box and rows.
'use strict';

const TRAPI = {
  base: '/api/ui/tr',
  hdr: { 'X-Vault': '1' },
  touch: false,
  after: () => soon(),
  url: (j, n, dl) => `/api/ui/tr/file/${j.id}/${n}${dl ? '?dl=1' : ''}`,
  where: (j) => j.state !== 'done' ? '' : j.from ? icon('phones') + `On ${esc(phoneName(j.from))} too` : icon('pc') + 'On this PC',
  acts: (j) => `${j.state === 'done' ? `<button type="button" class="btn text" data-trpc="show" data-id="${j.id}">Show</button>` : ''}${more('tr' + j.id, [frShareBtn('tr', j),
    `<button type="button" role="menuitem" data-trpc="remove" data-id="${j.id}">${icon('x')}Remove from the list</button>`])}`,
};

function trView() {
  const jobs = trJobs().sort(newest);
  return `<section class="main">${head('Transcribe')}<div class="body scroller"><div class="col">
    ${T.err ? `<div class="notebox">${icon('alert')}<div>${esc(T.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${trBox()}</div>
    ${jobs.length ? byDay(jobs, (j) => j.at, trRow) : `<div class="empty">${icon('transcribe')}<h2>Nothing transcribed yet</h2><p>Drop in a voice memo or video. Whisper runs on this PC, and downloads have a Transcribe button too.</p></div>`}
  </div></div></section>`;
}

function trSettings() {
  if (!TRST) return '';
  const e = TRST.engine, st = e.state, ok = '<span class="ok">Ready</span>';
  return `<section class="sec"><h2>Transcribe</h2>
    <div class="srow"><span class="grow">Speech engine<span class="h">Whisper large-v3-turbo, free, about ${e.gpu ? '2.3 GB, on the NVIDIA graphics card' : "1.7 GB. This PC has no NVIDIA card, so it's slow"}. Each file gives a .txt with the words and an .srt with subtitles.${st === 'installing' ? ` Getting it, ${e.pct}%.` : st.startsWith('error') ? ' Last try: ' + esc(st.slice(7)) + '.' : ''}</span></span>
      ${st === 'ok' ? ok : st === 'installing' ? '' : '<button type="button" class="btn" data-trpc="engine">Get it now</button>'}</div>
    <div class="srow"><span class="grow">Translate to English<span class="h">A second model, Whisper medium, about 1.5 GB. It's fetched the first time you translate.</span></span>
      ${e.translate ? ok : st === 'installing' ? '' : `<button type="button" class="btn" data-trpc="engine" data-to="en" ${st === 'ok' ? '' : 'disabled'}>Get it now</button>`}</div>
  </section>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-trpc],[data-trdl]');
  if (!b) return;
  const a = b.dataset.trpc, id = b.dataset.id;
  try {
    if (b.dataset.trdl) { await trFromDL(b.dataset.trdl); S.page = 'transcribe'; }
    else if (a === 'remove') await api('/api/ui/tr/remove/' + id, {});
    else if (a === 'show') return void await api('/api/ui/tr/show/' + id, {});
    else if (a === 'engine') { await api('/api/ui/tr/engine' + (b.dataset.to ? '?to=en' : ''), {}); soon(); }
    await trRefresh(); render();
  } catch (err) { T.err = err.message; S.page = 'transcribe'; render(); }
});
trRefresh().then(() => { if (ST) render(); }); // app.js's first refresh ran before this file loaded
