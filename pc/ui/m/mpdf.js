// The PDF tools on the phone. Pick PDFs, the PC does the work, and the result comes back: the S23 app saves it
// into Download › Premade by itself; on the iPhone, Save opens the Share sheet (Save to Files, Mail, …).
// The box itself is /m/pdf-core.js.
'use strict';

const pdfSaving = new Set(); // jobs the Android app was asked to save
const pdfBlobs = {};         // iPhone: job id → File[] fetched ahead, so Save opens the Share sheet at once
const pdfURL = (j, n, dl) => `${PCURL}/api/phone/pdf/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;

const PDFAPI = {
  get base() { return PCURL + '/api/phone/pdf'; }, // PCURL can change (home, Tailscale, the relay link), so read it each time
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => pdfPoll(),
  where: (j) => whereOf(j, IOS ? 'Saved' : 'In Download › Premade'),
  acts: (j) => j.local ? ljSaveBtn(j) : (j.state === 'done' ? pdfSaveBtn(j) : '') + more('pdf' + j.id, [frShareBtn('pdf', j),
    j.from === ST?.me && `<button type="button" role="menuitem" data-pdfremove="${j.id}">${icon('x')}Remove from the list</button>`]),
};
function pdfSaveBtn(j) {
  if (NATIVE?.savePdf) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn text" data-pdfsave="${j.id}">Save</button>`;
  const files = pdfBlobs[j.id];
  if (Array.isArray(files) && navigator.canShare?.({ files })) return `<button type="button" class="btn text" data-pdfshare="${j.id}">Save</button>`;
  if (files === 'loading') return `<span class="btn text" aria-disabled="true">${icon('spin', 'spin')}Getting it</span>`;
  return j.files.length === 1 ? `<a class="btn text" href="${pdfURL(j, 0, true)}">Save</a>` : `<button type="button" class="btn text" data-pdfget="${j.id}">Get</button>`;
}

// After each refresh: what this phone sent and is ready goes to Download › Premade (S23) or is fetched ahead (iPhone).
async function pdfPhoneRefresh() {
  await pdfRefresh();
  for (const j of pdfJobs()) {
    if (j.local || j.from !== ST?.me || j.state !== 'done' || j.fetched) continue;
    if (NATIVE?.savePdf && !pdfSaving.has(j.id)) { pdfSaving.add(j.id); NATIVE.savePdf(j.id); }
    else if (!NATIVE && !pdfBlobs[j.id] && j.size < 300 << 20) pdfFetch(j);
  }
}

async function pdfFetch(j) {
  pdfBlobs[j.id] = 'loading';
  try {
    pdfBlobs[j.id] = await Promise.all(j.files.map(async (f, n) => {
      const r = await fetch(pdfURL(j, n));
      if (!r.ok) throw new Error(await r.text()); // never save the PC's error as the PDF
      const b = await r.blob();
      return new File([b], f.name.split(/[\\/]/).pop(), { type: 'application/pdf' });
    }));
  } catch (e) { pdfBlobs[j.id] = 'failed'; } // Save then falls back to the link, and Get tries again
  render();
}

function pdfToolsView() {
  if (OFFLINE || !PDFST) PDFST = PDF_LOCAL; // the PC is out of reach: this phone does it
  const jobs = [...pdfJobs()].sort(newest);
  return `${note(esc(P.err))}<div class="dlbox cvbox">${pdfBox()}</div>
    <p class="tip">${PDFST.local ? "Your PC is out of reach, so this phone does it. Tap it when it's done to save it." : IOS ? "Your PC does it. Tap it when it's done to save it." : 'Your PC does it, then it goes into Download › Premade by itself.'}</p>
    ${jobs.length ? byDay(jobs, (j) => j.at, pdfRow) : ''}`;
}

function pdfSettingsView() {
  const gs = PDFST?.local ? '' : PDFST?.gs || '';
  return `<section class="sec"><h2>On ${ME}</h2>
      <div class="srow"><span class="grow">${IOS ? 'Save' : 'Download › Premade'}<span class="h">${IOS ? 'Tap a finished PDF, then Save, and pick Save to Files, Mail or any app.' : 'Finished PDFs go into Download › Premade by themselves. My Files shows them.'}</span></span></div></section>
    <section class="sec"><h2>On your PC</h2>
      <div class="srow"><span class="grow">Save folder<span class="h mono">${esc(PDFST?.local ? '' : PDFST?.dir || '')}</span><span class="h">A copy of everything stays here. Every tool saves into this one folder. Change it on the PC in Settings.</span></span></div>
      <div class="srow"><span class="grow">Strong compression<span class="h">${gs === 'ok' ? 'Ghostscript is ready, so scans and photo PDFs shrink a lot.' : gs === 'installing' ? 'Ghostscript is being installed on your PC.' : "Ghostscript (free) isn't on your PC yet, so scans shrink less. Install it there: Settings › PDF tools, or compress a PDF there once."}</span></span>${gs === 'ok' ? '<span class="ok">Ready</span>' : ''}</div>
    </section>`;
}

let pdfTimer = null;
function pdfPoll() {
  clearTimeout(pdfTimer);
  pdfTimer = setTimeout(async () => { await pdfPhoneRefresh(); render(); if (pdfBusy() || Object.values(pdfBlobs).includes('loading')) pdfPoll(); }, 1500);
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.pdfsave) { pdfSaving.add(d.pdfsave); NATIVE.savePdf(d.pdfsave); b.textContent = 'Saving…'; }
  else if (d.pdfremove) { await api(`${PDFAPI.base}/remove/${d.pdfremove}`, {}).catch(() => {}); await pdfRefresh(); render(); }
  else if (d.pdfshare) {
    try {
      await navigator.share({ files: pdfBlobs[d.pdfshare] });
      await api('/api/phone/pdf/fetched/' + d.pdfshare, {});
      await pdfRefresh(); render();
    } catch (err) { /* closed the Share sheet */ }
  } else if (d.pdfget) { const j = pdfJobs().find((x) => x.id === d.pdfget); if (j) { pdfFetch(j); render(); } }
});
pdfPhoneRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
