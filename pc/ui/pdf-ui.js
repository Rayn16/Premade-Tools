// The PDF tools' page and settings in the PC window. app.js draws the frame and calls pdfView()/pdfSettings();
// /m/pdf-core.js draws the box and rows.
'use strict';

const PDFAPI = {
  base: '/api/ui/pdf',
  hdr: { 'X-Vault': '1' },
  touch: false,
  after: () => soon(),
  where: (j) => whereOf(j),
  acts: (j) => `${j.state === 'done' ? `<button type="button" class="btn text" data-pdfpc="show" data-id="${j.id}">Show</button>` : ''}${more('pdf' + j.id, [frShareBtn('pdf', j),
    `<button type="button" role="menuitem" data-pdfpc="remove" data-id="${j.id}">${icon('x')}Remove from the list</button>`])}`,
};

function pdfView() {
  const jobs = pdfJobs().sort(newest);
  return `<section class="main">${head('PDF tools')}<div class="body scroller"><div class="col">
    ${P.err ? `<div class="notebox">${icon('alert')}<div>${esc(P.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${pdfBox()}</div>
    ${jobs.length ? byDay(jobs, (j) => j.at, pdfRow) : `<div class="empty">${icon('pdf')}<h2>Nothing done yet</h2><p>Pick a tool above and drop in PDFs. Everything runs on this PC, and what your phones send shows up here too.</p></div>`}
  </div></div></section>`;
}

function pdfSettings() {
  if (!PDFST) return '';
  const gs = PDFST.gs;
  return `<section class="sec"><h2>PDF tools</h2>
    <div class="srow"><span class="grow">Strong compression<span class="h">Ghostscript, free, about 70 MB. It shrinks scans and photo PDFs much more.${gs === 'installing' ? ' Installing now.' : gs.startsWith('error') ? ' Last try: ' + esc(gs.slice(7)) + '.' : ''}</span></span>
      ${gs === 'ok' ? '<span class="ok">Ready</span>' : gs === 'installing' ? '' : '<button type="button" class="btn" data-pdfpc="gs">Install</button>'}</div>
  </section>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pdfpc]');
  if (!b) return;
  const a = b.dataset.pdfpc, id = b.dataset.id;
  try {
    if (a === 'remove') await api('/api/ui/pdf/remove/' + id, {});
    else if (a === 'show') return void await api('/api/ui/pdf/show/' + id, {});
    else if (a === 'gs') { await api('/api/ui/pdf/gs', {}); soon(); }
    await pdfRefresh(); render();
  } catch (err) { P.err = err.message; render(); }
});
