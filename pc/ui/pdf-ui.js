// The PDF tools' page and settings in the PC window. app.js draws the frame and calls pdfView()/pdfSettings();
// /m/pdf-core.js draws the box.
'use strict';

const PDFAPI = {
  base: '/api/ui/pdf',
  auth: (x) => x.setRequestHeader('X-Vault', '1'),
  touch: false,
  after: () => soon(),
  from: (j) => fromName(j),
  where: (j) => j.state !== 'done' ? '' : j.from ? (j.fetched ? `Sent back to ${esc(fromName(j))}` : `Waiting for ${esc(fromName(j))} to pick it up`) : 'On this PC',
  acts: (j) => `${j.state === 'done' ? `<button class="btn small" data-pdfpc="show" data-id="${j.id}">${icon('folder')}Show</button>` : ''}${frShareBtn('pdf', j)}
    <button class="iconbtn" data-pdfpc="remove" data-id="${j.id}" aria-label="Remove from history" title="Remove from history">${icon('x')}</button>`,
};

function pdfView() {
  const jobs = pdfJobs();
  const live = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const days = [];
  for (const j of jobs.filter((j) => j.state === 'done' || j.state === 'failed')) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(pdfRow(j, true));
  }
  const hist = days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
    : `<div class="empty">${icon('pdf')}<h2>Nothing done yet</h2><p>Pick a tool above and drop in PDFs. What your phones send shows up here too.</p></div>`;
  return `<main class="plain">
    <div class="pagehead"><div><h1 class="pagetitle">PDF tools</h1><p class="pagelede">Merge, split, reorder, compress and lock PDFs. Everything runs on this PC; nothing is uploaded anywhere.</p></div></div>
    <div class="dlwrap scroller"><div class="dlinner">
      ${P.err ? `<div class="notebox">${icon('alert')}<div>${esc(P.err)}</div></div>` : ''}
      <div class="dlbox cvbox">${pdfBox()}</div>
      ${live.length ? `<section class="sec"><h2 class="group-label">Working now</h2><div class="rows hrows">${live.map((j) => pdfRow(j)).join('')}</div></section>` : ''}
      <section class="sec"><h2 class="group-label">History</h2>${hist}</section>
    </div></div>
  </main>`;
}

function pdfSettings() {
  if (!PDFST) return '';
  const gs = PDFST.gs;
  return `<div class="cols" style="margin-top:18px">
    <div class="col">
      <section><h2 class="group-label">PDF tools · where files go</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">PC folder</span><span class="row-hint mono">${esc(PDFST.dir)}</span></div><button class="btn small" data-pdfpc="folder">Change…</button></div>
        <div class="row"><div class="row-text"><span class="row-title">Phones</span><span class="row-hint">The S23 saves into Documents › Premade, the iPhone opens the Share sheet. A copy stays here.</span></div></div>
      </div></section>
    </div>
    <div class="col">
      <section><h2 class="group-label">PDF tools · engines</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">Merge, pages, split, passwords</span><span class="row-hint">pdfcpu, built in</span></div><span class="sbadge is-good"><i></i>Ready</span></div>
        <div class="row"><div class="row-text"><span class="row-title">Strong compression</span><span class="row-hint">Ghostscript (free, about 70 MB), for scans and photo PDFs${gs.startsWith('error') ? ' · ' + esc(gs.slice(7)) : ''}</span></div>
          ${gs === 'ok' ? '<span class="sbadge is-good"><i></i>Ready</span>' : gs === 'installing' ? '<span class="sbadge"><i></i>Installing…</span>' : '<button class="btn small" data-pdfpc="gs">Install</button>'}</div>
      </div></section>
    </div>
  </div>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pdfpc]');
  if (!b) return;
  const a = b.dataset.pdfpc, id = b.dataset.id;
  try {
    if (a === 'remove') await api('/api/ui/pdf/remove/' + id, {});
    else if (a === 'show') return void await api('/api/ui/pdf/show/' + id, {});
    else if (a === 'folder') await api('/api/ui/pdf/folder', {});
    else if (a === 'gs') { await api('/api/ui/pdf/gs', {}); soon(); }
    await pdfRefresh(); render();
  } catch (err) { P.err = err.message; render(); }
});
