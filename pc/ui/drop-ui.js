// File drop's page and settings in the PC window. app.js draws the frame and calls dropView()/dropSettings();
// /m/drop-core.js draws the box and rows.
'use strict';

const copyBtn = (it) => `<button type="button" class="btn text" data-droppc="copy" data-id="${it.id}">${FD.copied === it.id ? 'Copied' : 'Copy'}</button>`;
const DROPAPI = {
  base: '/api/ui/drop',
  hdr: { 'X-Vault': '1' },
  touch: false,
  after: () => {},
  url: (it, n, dl) => `/api/ui/drop/file/${it.id}/${n}${dl ? '?dl=1' : ''}`,
  thumb: (it, n) => `/api/ui/drop/file/${it.id}/${n}`,
  seen: +localStorage.dropSeen || Date.now(), // for "2 new" in the sidebar
  acts: (it) => it.kind === 'link' ? `<button type="button" class="btn text" data-droppc="open" data-id="${it.id}">Open</button>${copyBtn(it)}`
    : it.kind === 'text' ? copyBtn(it) : it.to === 'pc' ? `<button type="button" class="btn text" data-droppc="show" data-id="${it.id}">Show</button>` : '',
};

function dropView() {
  localStorage.dropSeen = DROPAPI.seen = Date.now();
  const all = [...dropJobs()].sort(newest);
  return `<section class="main">${head('File drop')}<div class="body scroller"><div class="col">
    ${FD.err ? `<div class="notebox">${icon('alert')}<div>${esc(FD.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${dropBox()}</div>
    ${dropClipCard()}
    ${all.length ? byDay(all, (it) => it.at, dropRow) : `<div class="empty">${icon('drop')}<h2>Nothing here yet</h2><p>On your phone, share a photo, file or link to Premade, and it lands here.</p></div>`}
  </div></div></section>`;
}

function dropSettings() {
  if (!DROPST) return '';
  return `<section class="sec"><h2>File drop</h2>
    <label class="srow"><span class="grow">Sync the clipboard<span class="h">Text copied on this PC reaches your phones, and theirs reaches this PC. The iPhone picks it up when you open Premade.</span></span><input type="checkbox" class="switch" role="switch" id="clipsync" ${DROPST.clipSync ? 'checked' : ''}></label>
    <div class="srow"><span class="grow">Kept in the list for 7 days<span class="h">Files already saved stay where they are.</span></span></div>
  </section>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-droppc]');
  if (!b) return;
  const a = b.dataset.droppc, id = b.dataset.id;
  try {
    if (a === 'copy') { await api('/api/ui/drop/copy/' + id, {}); dropCopied(id); }
    else if (a === 'open') await api('/api/ui/drop/open/' + id, {});
    else if (a === 'show') await api('/api/ui/drop/show/' + id, {});
  } catch (err) { FD.err = err.message; S.page = 'drop'; render(); }
});
$app.addEventListener('change', async (e) => {
  if (e.target.id !== 'clipsync') return;
  await api('/api/ui/settings', { clipSync: e.target.checked });
  await dropRefresh(); render();
});
dropRefresh().then(() => { if (ST) render(); }); // app.js's first refresh ran before this file loaded
