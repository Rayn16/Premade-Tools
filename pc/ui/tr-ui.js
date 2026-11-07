// Transcribe's page and settings in the PC window. app.js draws the frame and calls trView()/trSettings();
// /m/tr-core.js draws the box and rows.
'use strict';

const TRAPI = {
  base: '/api/ui/tr',
  hdr: { 'X-Vault': '1' },
  touch: false,
  after: () => soon(),
  from: (j) => fromName(j),
  url: (j, n, dl) => `/api/ui/tr/file/${j.id}/${n}${dl ? '?dl=1' : ''}`,
  where: (j) => j.state !== 'done' || !j.from ? '' : `On ${esc(fromName(j))} too`,
  acts: (j) => `${j.state === 'done' ? `<button class="btn small" data-trpc="show" data-id="${j.id}">${icon('folder')}Show</button>` : ''}
    <button class="iconbtn" data-trpc="remove" data-id="${j.id}" aria-label="Remove from history" title="Remove from history">${icon('x')}</button>`,
};

function trHist(jobs, empty) {
  const days = [];
  for (const j of jobs) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(trRow(j, true));
  }
  return days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
    : `<div class="empty">${icon('transcribe')}<h2>Nothing transcribed yet</h2><p>${empty}</p></div>`;
}

function trView() {
  const jobs = trJobs(), live = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  return `<main class="plain">
    <div class="pagehead"><div><h1 class="pagetitle">Transcribe</h1><p class="pagelede">Voice memos and videos become text and subtitles. Whisper runs on this PC's graphics card; nothing is uploaded anywhere.</p></div></div>
    <div class="dlwrap scroller"><div class="dlinner">
      ${T.err ? `<div class="notebox">${icon('alert')}<div>${esc(T.err)}</div></div>` : ''}
      <div class="dlbox cvbox">${trBox()}</div>
      ${live.length ? `<section class="sec"><h2 class="group-label">Working now</h2><div class="rows hrows">${live.map((j) => trRow(j)).join('')}</div></section>` : ''}
      <section class="sec"><h2 class="group-label">History</h2>${trHist(jobs.filter((j) => j.state === 'done' || j.state === 'failed'), 'Drop in a voice memo or video. Downloads have a Transcribe button too, and what your phones send shows up here.')}</section>
    </div></div>
  </main>`;
}

function trSettings() {
  if (!TRST) return '';
  const e = TRST.engine, st = e.state;
  return `<div class="cols" style="margin-top:18px">
    <div class="col">
      <section><h2 class="group-label">Transcribe · where text goes</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">PC folder</span><span class="row-hint mono">${esc(TRST.dir)}</span></div><button class="btn small" data-trpc="folder">Change…</button></div>
        <div class="row"><div class="row-text"><span class="row-title">Each file gives</span><span class="row-hint">A .txt with the words and an .srt with subtitles, with the same name as the file.</span></div></div>
      </div></section>
    </div>
    <div class="col">
      <section><h2 class="group-label">Transcribe · engine</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">Whisper (large-v3-turbo)</span><span class="row-hint">whisper.cpp, free · ${e.gpu ? 'on the NVIDIA graphics card' : 'no NVIDIA card found, so it runs slowly on the processor'} · about ${e.gpu ? '2.3' : '1.7'} GB${st.startsWith('error') ? ' · ' + esc(st.slice(7)) : ''}</span></div>
          ${st === 'ok' ? '<span class="sbadge is-good"><i></i>Ready</span>' : st === 'installing' ? `<span class="sbadge"><i></i>Getting it… ${e.pct}%</span>` : '<button class="btn small" data-trpc="engine">Get it now</button>'}</div>
        <div class="row"><div class="row-text"><span class="row-title">Translate to English</span><span class="row-hint">A second model (Whisper medium, about 1.5 GB), fetched the first time you translate</span></div>
          ${e.translate ? '<span class="sbadge is-good"><i></i>Ready</span>' : st === 'installing' ? '' : `<button class="btn small" data-trpc="engine" data-to="en" ${st === 'ok' ? '' : 'disabled'}>Get it now</button>`}</div>
      </div></section>
    </div>
  </div>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-trpc],[data-trdl]');
  if (!b) return;
  const a = b.dataset.trpc, id = b.dataset.id;
  try {
    if (b.dataset.trdl) { await trFromDL(b.dataset.trdl); S.page = 'transcribe'; }
    else if (a === 'remove') await api('/api/ui/tr/remove/' + id, {});
    else if (a === 'show') return void await api('/api/ui/tr/show/' + id, {});
    else if (a === 'folder') await api('/api/ui/tr/folder', {});
    else if (a === 'engine') { await api('/api/ui/tr/engine' + (b.dataset.to ? '?to=en' : ''), {}); soon(); }
    await trRefresh(); render();
  } catch (err) { T.err = err.message; S.page = 'transcribe'; render(); }
});
trRefresh().then(() => { if (ST) render(); }); // app.js's first refresh ran before this file loaded
