// File drop's page and settings in the PC window. app.js draws the frame and calls dropView()/dropSettings();
// /m/drop-core.js draws the box and rows.
'use strict';

const DROPAPI = {
  base: '/api/ui/drop',
  hdr: { 'X-Vault': '1' },
  touch: false,
  after: () => {},
  url: (it, n, dl) => `/api/ui/drop/file/${it.id}/${n}${dl ? '?dl=1' : ''}`,
  acts: (it) => it.kind === 'link' ? `<button type="button" class="btn small" data-droppc="open" data-id="${it.id}">${icon('link')}Open</button><button type="button" class="btn small" data-droppc="copy" data-id="${it.id}">${icon(FD.copied === it.id ? 'check' : 'copy')}${FD.copied === it.id ? 'Copied' : 'Copy'}</button>`
    : it.kind === 'text' ? `<button type="button" class="btn small" data-droppc="copy" data-id="${it.id}">${icon(FD.copied === it.id ? 'check' : 'copy')}${FD.copied === it.id ? 'Copied' : 'Copy'}</button>`
    : it.to === 'pc' ? `<button type="button" class="btn small" data-droppc="show" data-id="${it.id}">${icon('folder')}Show</button>` : '',
};

function dropView() {
  const all = dropJobs(), got = all.filter((j) => j.to === 'pc'), sent = all.filter((j) => j.to !== 'pc');
  return `<main class="plain">
    <div class="pagehead"><div><h1 class="pagetitle">File drop</h1><p class="pagelede">Send files, links and text between this PC and your phones. What you copy on one shows up on the others.</p></div></div>
    <div class="dlwrap scroller"><div class="dlinner">
      ${FD.err ? `<div class="notebox">${icon('alert')}<div>${esc(FD.err)}</div></div>` : ''}
      <div class="dlbox cvbox">${dropBox()}</div>
      ${dropClipCard()}
      <section class="sec"><h2 class="group-label">To this PC</h2>${dropList(got, 'On your phone, share a photo, file or link to Premade, and it lands here.')}</section>
      ${sent.length ? `<section class="sec"><h2 class="group-label">To your phones</h2>${dropList(sent, '')}</section>` : ''}
    </div></div>
  </main>`;
}

function dropSettings() {
  if (!DROPST) return '';
  return `<div class="cols" style="margin-top:18px">
    <div class="col">
      <section><h2 class="group-label">File drop · where files go</h2><div class="rows">
        <div class="row"><div class="row-text"><span class="row-title">Save folder, the same for every tool</span><span class="row-hint mono">${esc(DROPST.dir)}</span></div><button type="button" class="btn small" data-droppc="folder">Change…</button></div>
        <div class="row"><div class="row-text"><span class="row-title">Kept in the list</span><span class="row-hint">7 days. Files already saved stay where they are.</span></div></div>
      </div></section>
    </div>
    <div class="col">
      <section><h2 class="group-label">File drop · clipboard</h2><div class="rows">
        <label class="row"><span class="row-text"><span class="row-title">Sync the clipboard</span><span class="row-hint">Text copied on this PC reaches your phones, and theirs reaches this PC. The iPhone picks it up when you open Premade.</span></span><input type="checkbox" class="switch" role="switch" id="clipsync" ${DROPST.clipSync ? 'checked' : ''}></label>
      </div></section>
    </div>
  </div>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-droppc]');
  if (!b) return;
  const a = b.dataset.droppc, id = b.dataset.id;
  try {
    if (a === 'copy') { await api('/api/ui/drop/copy/' + id, {}); dropCopied(id); }
    else if (a === 'open') await api('/api/ui/drop/open/' + id, {});
    else if (a === 'show') await api('/api/ui/drop/show/' + id, {});
    else if (a === 'folder') { await api('/api/ui/drop/folder', {}); await dropRefresh(); render(); }
  } catch (err) { FD.err = err.message; S.page = 'drop'; render(); }
});
$app.addEventListener('change', async (e) => {
  if (e.target.id !== 'clipsync') return;
  await api('/api/ui/settings', { clipSync: e.target.checked });
  await dropRefresh(); render();
});
dropRefresh().then(() => { if (ST) render(); }); // app.js's first refresh ran before this file loaded
