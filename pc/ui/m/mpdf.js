// The PDF tools on the phone. Pick PDFs, the PC does the work, and the result comes back: the S23 app saves it
// into Documents › Premade by itself; on the iPhone, Save opens the Share sheet (Save to Files, Mail, …).
// The box itself is /m/pdf-core.js.
'use strict';

const pdfSaving = new Set(); // jobs the Android app was asked to save
const pdfBlobs = {};         // iPhone: job id → File[] fetched ahead, so Save opens the Share sheet at once
const pdfURL = (j, n, dl) => `${PCURL}/api/phone/pdf/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;

const PDFAPI = {
  get base() { return PCURL + '/api/phone/pdf'; }, // PCURL changes when the other address answers
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => pdfPoll(),
  from: (j) => dlFrom(j),
  where: (j) => j.local ? ljWhere(j) : j.state !== 'done' ? '' : j.from === ST?.me && j.fetched ? (IOS ? 'Saved' : 'In Documents') : j.from === ST?.me && NATIVE?.savePdf ? 'Saving…' : 'On the PC',
  acts: (j) => j.local ? ljSaveBtn(j) : j.state === 'done' ? pdfSaveBtn(j) + frShareBtn('pdf', j) : '',
};
function pdfSaveBtn(j) {
    if (NATIVE?.savePdf) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn small" data-pdfsave="${j.id}">${icon('save')}Save</button>`;
    const files = pdfBlobs[j.id];
    if (Array.isArray(files) && navigator.canShare?.({ files })) return `<button type="button" class="btn small primary" data-pdfshare="${j.id}">${icon('share')}Save</button>`;
    if (files === 'loading') return `<span class="btn small" aria-disabled="true">${icon('spin', 'spin')}Getting it</span>`;
    return j.files.length === 1 ? `<a class="btn small" href="${pdfURL(j, 0, true)}">${icon('save')}Get</a>` : `<button type="button" class="btn small" data-pdfget="${j.id}">${icon('save')}Get</button>`;
}

// After each refresh: what this phone sent and is ready goes to Documents (S23) or is fetched ahead (iPhone).
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
      const b = await (await fetch(pdfURL(j, n))).blob();
      return new File([b], f.name.split(/[\\/]/).pop(), { type: 'application/pdf' });
    }));
  } catch (e) { delete pdfBlobs[j.id]; }
  render();
}

function pdfToolsView(off) {
  if (OFFLINE || !PDFST) PDFST = PDF_LOCAL; // the PC is out of reach: this phone does it
  const title = dlTitle('PDF tools', PDFST.local ? 'Pick what to do, then the PDFs.' : 'Pick what to do, then the PDFs. Your PC does the work.');
  const mine = pdfJobs().filter((j) => j.from === ST?.me).slice(0, 5);
  return `${title}<div class="feed scroller">${off}
    ${P.err ? `<div class="notebox">${icon('alert')}<div>${esc(P.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${pdfBox()}
      <div class="route"><i class="dotlight"></i><span>${PDFST.local ? "Your PC is out of reach, so this phone does it. Tap <b>Save</b> when it's done." : IOS ? "Your PC does it. Tap <b>Save</b> when it's done." : 'Your PC does it, then it goes into Documents › Premade by itself.'}</span></div></div>
    ${mine.length ? `<section class="sec"><h2 class="group-label">From this phone</h2><div class="rows hrows">${mine.map((j) => pdfRow(j)).join('')}</div></section>` : ''}
  </div>`;
}

function pdfHistoryView(off) {
  const days = [];
  for (const j of pdfJobs()) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(pdfRow(j, true));
  }
  return `${dlTitle('History', 'Everything the PDF tools did, on the PC and your phones.')}
    <div class="feed scroller">${off}${days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
      : `<div class="empty">${icon('pdf')}<h2>Nothing done yet</h2><p>Pick a tool in Tools.</p></div>`}</div>`;
}

function pdfSettingsView(off) {
  const gs = PDFST?.gs || '';
  return `${dlTitle('Settings', 'Where new PDFs go.')}<div class="headrule"></div>
    <div class="feed scroller">${off}
    <section class="group"><div class="sectionhead"><b>On this phone</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">${IOS ? 'Share sheet' : 'Documents › Premade'}</h2><p class="block-hint">${IOS ? 'Tap Save on a finished PDF and pick Save to Files, Mail or any app.' : 'Finished PDFs go into Documents › Premade by themselves. My Files shows them.'}</p></div>
    </div></section>
    <section class="group"><div class="sectionhead"><b>On the PC</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Save folder on the PC</h2><p class="vaultpath-m">${esc(PDFST?.dir || '')}</p><p class="block-hint">A copy of everything stays here. Every tool saves into this one folder. Change it on the PC in Settings.</p></div>
      <div class="block"><h2 class="block-title">Strong compression</h2><p class="block-hint">${gs === 'ok' ? 'Ghostscript is ready, so scans and photo PDFs shrink a lot.' : gs === 'installing' ? 'Ghostscript is being installed on the PC.' : 'Ghostscript (free) isn\'t on the PC yet, so scans shrink less. Install it on the PC: Settings › PDF tools, or compress a PDF there once.'}</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>`;
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
  else if (d.pdfshare) {
    try {
      await navigator.share({ files: pdfBlobs[d.pdfshare] });
      await api('/api/phone/pdf/fetched/' + d.pdfshare, {});
      await pdfRefresh(); render();
    } catch (err) { /* closed the Share sheet */ }
  } else if (d.pdfget) { const j = pdfJobs().find((x) => x.id === d.pdfget); if (j) { pdfFetch(j); render(); } }
});
pdfPhoneRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
