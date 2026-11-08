// The Converter on the phone. Pick files, the PC converts them, and they come back: the S23 app saves them into
// Gallery by itself; on the iPhone, Save opens the Share sheet (Save Image / Save Video / Save to Files).
'use strict';

const CS = { files: [], to: '', small: false, combine: true, up: -1, err: '' };
const SHORTCUT_CV = 'Convert with Premade';
const cvSaving = new Set(); // jobs the Android app was asked to save
const cvBlobs = {};         // iPhone: job id → File[] fetched ahead, so Save can open the Share sheet at once

ICON.convert = '<path d="M4 8h13l-3-3M20 16H7l3 3"/>';
ICON.upload = '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>';
ICON.doc = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>';

let CVS = null; // /api/phone/cv
const cvJobs = () => CVS?.jobs || [];
const cvBusy = () => cvJobs().some((j) => j.state === 'queued' || j.state === 'running');
const cvExt = (n) => (n.split('.').pop() || '').toLowerCase();
const cvKind = (n) => (CVS?.kinds || []).find((k) => k.exts.includes(cvExt(n)));
const cvIcon = { image: 'photo', video: 'video', audio: 'music', doc: 'doc', sheet: 'doc', slides: 'doc' };
const cvName = (j) => j.inputs.length > 1 ? `${j.inputs[0]} and ${j.inputs.length - 1} more` : j.inputs[0];
const cvFileURL = (j, n, dl) => `/api/phone/cv/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;

async function cvRefresh() {
  try { CVS = await api('/api/phone/cv'); } catch (e) { return; }
  for (const j of cvJobs()) {
    if (j.from !== ST?.me || j.state !== 'done' || j.fetched) continue;
    if (NATIVE?.saveConverted && !cvSaving.has(j.id)) { cvSaving.add(j.id); NATIVE.saveConverted(j.id); } // straight into Gallery
    else if (!NATIVE && !cvBlobs[j.id] && j.size < 300 << 20) cvFetch(j);
  }
}

async function cvFetch(j) {
  cvBlobs[j.id] = 'loading';
  try {
    cvBlobs[j.id] = await Promise.all(j.files.map(async (f, n) => {
      const b = await (await fetch(cvFileURL(j, n))).blob();
      return new File([b], f.name.split(/[\\/]/).pop(), { type: b.type });
    }));
  } catch (e) { delete cvBlobs[j.id]; }
  render();
}

async function cvShare(id) {
  const files = cvBlobs[id];
  try {
    await navigator.share({ files });
    await api('/api/phone/cv/fetched/' + id, {});
    await cvRefresh(); render();
  } catch (e) { /* closed the Share sheet */ }
}

function cvSaveButton(j) {
  if (j.state !== 'done') return '';
  if (NATIVE?.saveConverted) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn small" data-cvsave="${j.id}">${icon('save')}Save</button>`;
  const files = cvBlobs[j.id];
  if (Array.isArray(files) && navigator.canShare?.({ files })) return `<button type="button" class="btn small primary" data-cvshare="${j.id}">${icon('share')}Save</button>`;
  if (files === 'loading') return `<span class="btn small" aria-disabled="true">${icon('spin', 'spin')}Getting it</span>`;
  return j.files.length === 1 ? `<a class="btn small" href="${cvFileURL(j, 0, true)}">${icon('save')}To Files</a>` : `<button type="button" class="btn small" data-cvget="${j.id}">${icon('save')}Get</button>`;
}

function cvRow(j, full) {
  const state = j.state === 'queued' ? 'Waiting its turn' : j.state === 'running' ? (j.pct < 1 ? 'Starting…' : `On the PC ${Math.floor(j.pct)}%`) : '';
  const where = j.state !== 'done' ? '' : j.from === ST?.me && j.fetched ? (IOS ? 'Saved' : 'In Gallery') : j.from === ST?.me && NATIVE ? 'Saving…' : 'On the PC';
  const sizes = j.size && j.inSize ? `${dlSize(j.inSize)} → ${dlSize(j.size)}` : '';
  return `<div class="row"><span class="thumb" style="--h:${dlHue(j.id)}">${icon(cvIcon[j.kind] || 'doc')}</span><div class="row-text grow"><span class="row-title clip">${esc(cvName(j))}</span>
    <div class="hmeta"><span class="sitetag">${esc(j.target)}</span>${full && sizes ? `<span>${sizes}</span>` : ''}<span>${hm(new Date(j.at))}${full ? ' · from ' + esc(dlFrom(j)) : ''}</span>
    ${state ? `<span class="jobstate">${state}</span>` : ''}${where ? `<span class="where">${icon('check')}${where}</span>` : ''}</div>
    ${j.state === 'running' || j.state === 'queued' ? `<div class="prog"><i style="width:${Math.max(2, j.pct)}%"></i></div>` : ''}
    ${j.state === 'failed' ? `<div class="hmeta bad">${icon('alert')}${esc(j.note)}</div>` : j.note ? `<div class="hmeta">${esc(j.note)}</div>` : ''}</div>
    <div class="hacts">${cvSaveButton(j)}${frShareBtn('cv', j)}${j.state === 'running' || j.state === 'queued' ? `<button type="button" class="btn small" data-cvcancel="${j.id}">Cancel</button>` : ''}</div></div>`;
}

function cvPicked() {
  if (!CS.files.length) return {};
  const kinds = CS.files.map((f) => cvKind(f.name));
  if (kinds.some((k) => !k)) {
    const bad = CS.files[kinds.indexOf(undefined)].name;
    return { why: cvExt(bad) === 'pdf' ? "For PDFs, use the PDF tools (☰ › PDF)." : `${bad} isn't a kind of file the Converter knows.` };
  }
  if (kinds.some((k) => k !== kinds[0])) return { why: 'Pick files of one kind at a time (only photos, or only videos).' };
  const k = kinds[0];
  if (!k.targets.some((t) => t.id === CS.to)) {
    const ext = cvExt(CS.files[0].name);
    CS.to = (k.targets.find((t) => t.id !== ext && !(ext === 'jpeg' && t.id === 'jpg')) || k.targets[0]).id;
  }
  if (!CVS.ready[k.engine]) return { kind: k, why: k.engine === 'soffice' ? 'Office files need LibreOffice on the PC. Install it on the PC: Settings › Converter.' : 'The PC is still setting up this engine. Try again in a few minutes.' };
  return { kind: k };
}

function cvView(off) {
  const title = dlTitle('Convert', 'Pick photos, videos or documents and choose what they should become.');
  if (OFFLINE || !CVS) return title + `<div class="feed scroller">${off}<p class="mhint">${icon('info')}<span>The PC does the converting, so it needs to be on and reachable${IOS ? ' (at home, or anywhere with Tailscale)' : ''}.</span></p></div>`;
  const { kind, why } = cvPicked();
  const many = CS.files.length > 1, total = CS.files.reduce((s, f) => s + f.size, 0);
  const mine = cvJobs().filter((j) => j.from === ST?.me).slice(0, 6);
  const box = !CS.files.length
    ? `<label class="cvdrop">${icon('upload')}<b>Pick files</b><small>${IOS ? 'Photos, videos, or anything in Files' : 'Photos, videos, music or documents'}</small><input type="file" id="cvpick" multiple hidden></label>`
    : `<div class="cvchips">${CS.files.slice(0, 4).map((f) => `<span class="cvchip">${icon(cvIcon[cvKind(f.name)?.id] || 'doc')}<span>${esc(f.name)}</span></span>`).join('')}${CS.files.length > 4 ? `<span class="cvchip more">+${CS.files.length - 4}</span>` : ''}</div>
      ${why ? `<div class="detected is-bad">${icon('alert')}<span>${esc(why)}</span></div>` : `<div class="detected"><i class="dotlight"></i><span><b>${CS.files.length} ${esc(kind.label.toLowerCase())}${many ? 's' : ''}</b> · ${dlSize(total)}</span></div>`}
      ${kind ? `<p class="group-label" style="margin:12px 0 6px">Make ${many ? 'them' : 'it'}</p><div class="seg cvseg">${kind.targets.map((t) => `<button type="button" data-cvto="${t.id}" aria-pressed="${t.id === CS.to}">${esc(t.label)}</button>`).join('')}</div>
        <p class="block-hint cvhint">${esc(kind.targets.find((t) => t.id === CS.to)?.note || '')}</p>
        ${kind.engine !== 'soffice' ? `<label class="dlswitch"><span>Smaller file</span><input type="checkbox" class="switch" role="switch" id="cvsmall" ${CS.small ? 'checked' : ''}></label>` : ''}
        ${kind.id === 'image' && CS.to === 'pdf' && many ? `<label class="dlswitch"><span>All in one PDF</span><input type="checkbox" class="switch" role="switch" id="cvcombine" ${CS.combine ? 'checked' : ''}></label>` : ''}` : ''}
      <div class="bigbtns"><button type="button" class="btn" data-cvclear>Start over</button><button type="button" class="btn primary" data-cvgo ${kind && !why && CS.up < 0 ? '' : 'disabled'}>${CS.up >= 0 ? `Sending ${CS.up}%` : `${icon('convert')}Convert`}</button></div>`;
  return `${title}<div class="feed scroller">${off}
    ${CS.err ? `<div class="notebox">${icon('alert')}<div>${esc(CS.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${box}
      <div class="route"><i class="dotlight"></i><span>${IOS ? 'Your PC converts it. Tap <b>Save</b> when it\'s done.' : 'Your PC converts it, then it goes into Gallery by itself.'}</span></div></div>
    ${mine.length ? `<section class="sec"><h2 class="group-label">From this phone</h2><div class="rows hrows">${mine.map((j) => cvRow(j)).join('')}</div></section>` : ''}
    ${IOS ? `<p class="mhint">${icon('share')}<span>Faster for photos: in Photos tap <b>Share</b> and pick <b>${SHORTCUT_CV}</b>. It keeps the original photo and saves the result back to Photos. Set it up once in <b>Settings</b>.</span></p>
      <p class="mhint">${icon('info')}<span>Picking a photo here, the iPhone may already turn HEIC into JPG. For videos, tap <b>Options</b> › <b>Most Compatible</b> off, or use Files, to send the original.</span></p>` : ''}
  </div>`;
}

function cvHistoryView(off) {
  const days = [];
  for (const j of cvJobs()) {
    const day = dayOf(new Date(j.at));
    if (days.at(-1)?.day !== day) days.push({ day, rows: [] });
    days.at(-1).rows.push(cvRow(j, true));
  }
  return `${dlTitle('History', 'Everything converted on the PC and your phones, newest first.')}
    <div class="feed scroller">${off}${days.length ? days.map((g) => `<div class="daygroup"><div class="dayhead"><b>${esc(g.day)}</b><span>${g.rows.length}</span><i></i></div><div class="rows hrows">${g.rows.join('')}</div></div>`).join('')
      : `<div class="empty">${icon('convert')}<h2>Nothing converted yet</h2><p>Pick files in Convert.</p></div>`}</div>`;
}

function cvSettingsView(off) {
  const base = location.origin, t = encodeURIComponent(TOKEN);
  const field = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}"><button type="button" class="btn" data-copy>Copy</button></div>`;
  const ios = IOS ? `
    <section class="group"><div class="sectionhead"><b>Share button</b><i></i></div>
    <details class="iosguide"><summary>Set up "${SHORTCUT_CV}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_CV}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, pick <b>Images</b>, <b>Media</b> and <b>Files</b>.</li>
      <li>Add <b>Repeat with Each</b> item in <b>Shortcut Input</b>. Everything below goes inside it.</li>
      <li><b>Get Name</b> of <b>Repeat Item</b>, then <b>Get Details of Files</b> › <b>File Extension</b> of <b>Repeat Item</b>, and a <b>Text</b> with <b>Name</b>.<b>File Extension</b>. <b>Set Variable</b> <b>File</b> to that Text.</li>
      <li><b>Get Contents of URL</b> with the address below, with <b>File</b> put where it says NAME.${field('Choices', `${base}/api/phone/cv/ios/targets?t=${t}&name=NAME`)}</li>
      <li><b>If</b> <b>Contents of URL</b> <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> and <b>Stop This Shortcut</b>. <b>End If</b>. Then <b>Split Text</b> by <b>New Lines</b> and <b>Choose from List</b> (prompt: “Make it”).</li>
      <li><b>Get Contents of URL</b> with the address below, NAME as before and TO replaced by <b>Chosen Item</b>. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Repeat Item</b>. <b>Set Variable</b> <b>Job</b> to it, and stop with a notification if it <b>begins with</b> <b>ERR</b>.${field('Start', `${base}/api/phone/cv/ios/start?t=${t}&name=NAME&to=TO`)}</li>
      <li>Add a <b>Text</b> “no” and <b>Set Variable</b> <b>Done</b> to it. Then <b>Repeat</b> <b>90</b> times, and inside it <b>If</b> <b>Done</b> <b>is</b> “no”:</li>
      <li>…<b>Get Contents of URL</b> of the address below, with <b>Job</b> put where it says JOB. <b>If</b> it <b>begins with</b> <b>WAIT</b>: <b>Wait</b> 2 seconds. <b>Otherwise</b>, <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with it. <b>Otherwise</b>: <b>Save to Photo Album</b> (for PDFs and documents use <b>Save File</b> instead). In both of these, <b>Set Variable</b> <b>Done</b> to a Text “yes”.${field('Get', `${base}/api/phone/cv/ios/get/JOB?t=${t}`)}</li>
      <li>Try it: in Photos pick a photo, tap <b>Share</b> › <b>${SHORTCUT_CV}</b> › <b>JPG</b>. Allow access to devices on your network and to Photos when asked.</li>
    </ol></details></section>` : '';
  return `${dlTitle('Settings', 'Where converted files go.')}<div class="headrule"></div>
    <div class="feed scroller">${off}${ios}
    <section class="group"><div class="sectionhead"><b>On the PC</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Converted folder</h2><p class="vaultpath-m">${esc(CVS?.dir || '')}</p><p class="block-hint">A copy of everything stays here. Change it on the PC in Settings.</p></div>
      <div class="block"><h2 class="block-title">What it converts</h2><p class="block-hint">${(CVS?.kinds || []).map((k) => `<b>${esc(k.label)}s</b> to ${k.targets.map((x) => esc(x.label)).join(', ')}`).join('. ')}.</p></div>
      <div class="block"><h2 class="block-title">Engines</h2><p class="block-hint">Pictures ${CVS?.ready.magick ? 'ready' : 'setting up'} · Video and sound ${CVS?.ready.ffmpeg ? 'ready' : 'setting up'} · Office files ${CVS?.office === 'ok' ? 'ready' : 'need LibreOffice on the PC'}</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>`;
}

function cvSend() {
  const { kind } = cvPicked();
  const fd = new FormData();
  for (const f of CS.files) fd.append('f', f, f.name);
  const x = new XMLHttpRequest();
  x.open('POST', `/api/phone/cv/start?to=${CS.to}&small=${CS.small ? 1 : 0}&combine=${kind.id === 'image' && CS.to === 'pdf' && CS.combine ? 1 : 0}`);
  x.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
  x.upload.onprogress = (e) => { if (e.lengthComputable) { CS.up = Math.floor(e.loaded / e.total * 100); render(); } };
  x.onload = async () => {
    CS.up = -1;
    if (x.status === 200) { CS.files = []; CS.err = ''; } else CS.err = x.responseText.trim() || "That didn't work.";
    await cvRefresh(); render(); cvPoll();
  };
  x.onerror = () => { CS.up = -1; CS.err = "Couldn't reach your PC."; render(); };
  CS.up = 0; CS.err = ''; render(); x.send(fd);
}

// Quick polls while the PC works on this phone's files.
let cvTimer = null;
function cvPoll() {
  clearTimeout(cvTimer);
  cvTimer = setTimeout(async () => { await cvRefresh(); render(); if (cvBusy() || Object.values(cvBlobs).includes('loading')) cvPoll(); }, 1500);
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.cvgo !== undefined) cvSend();
    else if (d.cvto) { CS.to = d.cvto; render(); }
    else if (d.cvclear !== undefined) { CS.files = []; CS.err = ''; render(); }
    else if (d.cvcancel) { await api('/api/phone/cv/cancel/' + d.cvcancel, {}); await cvRefresh(); render(); }
    else if (d.cvsave) { cvSaving.add(d.cvsave); NATIVE.saveConverted(d.cvsave); b.textContent = 'Saving…'; }
    else if (d.cvshare) cvShare(d.cvshare);
    else if (d.cvget) { const j = cvJobs().find((x) => x.id === d.cvget); if (j) { cvFetch(j); render(); } }
  } catch (err) { CS.err = err.message; render(); }
});
$app.addEventListener('change', (e) => {
  if (e.target.id === 'cvpick') { CS.files = [...e.target.files]; CS.err = ''; render(); }
  else if (e.target.id === 'cvsmall') CS.small = e.target.checked;
  else if (e.target.id === 'cvcombine') CS.combine = e.target.checked;
});
cvRefresh().then(() => { if (ST) render(); });
