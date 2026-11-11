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
const cvJobs = () => [...ljOf('cv'), ...(CVS?.jobs || [])];
const cvBusy = () => cvJobs().some(isLive);
const cvExt = (n) => (n.split('.').pop() || '').toLowerCase();
const cvKind = (n) => (CVS?.kinds || []).find((k) => k.exts.includes(cvExt(n)));
const cvIcon = { image: 'photo', video: 'video', audio: 'music', doc: 'doc', sheet: 'doc', slides: 'doc' };
const cvName = (j) => j.inputs.length > 1 ? `${j.inputs[0]} and ${j.inputs.length - 1} more` : j.inputs[0];
const cvFileURL = (j, n, dl) => `${PCURL}/api/phone/cv/file/${j.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`;

async function cvRefresh() {
  try { CVS = await api('/api/phone/cv'); } catch (e) { return; }
  for (const j of cvJobs()) {
    if (j.local || j.from !== ST?.me || j.state !== 'done' || j.fetched) continue;
    if (NATIVE?.saveConverted && !cvSaving.has(j.id)) { cvSaving.add(j.id); NATIVE.saveConverted(j.id); } // straight into Gallery
    else if (!NATIVE && !cvBlobs[j.id] && j.size < 300 << 20) cvFetch(j);
  }
}

async function cvFetch(j) {
  cvBlobs[j.id] = 'loading';
  try {
    cvBlobs[j.id] = await Promise.all(j.files.map(async (f, n) => {
      const r = await fetch(cvFileURL(j, n));
      if (!r.ok) throw new Error(await r.text()); // never save the PC's error as the file
      const b = await r.blob();
      return new File([b], f.name.split(/[\\/]/).pop(), { type: b.type });
    }));
  } catch (e) { cvBlobs[j.id] = 'failed'; } // Save then falls back to the link, and Get tries again
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
  if (NATIVE?.saveConverted) return j.from === ST?.me && j.fetched ? '' : `<button type="button" class="btn text" data-cvsave="${j.id}">Save</button>`;
  const files = cvBlobs[j.id];
  if (Array.isArray(files) && navigator.canShare?.({ files })) return `<button type="button" class="btn text" data-cvshare="${j.id}">Save</button>`;
  if (files === 'loading') return `<span class="btn text" aria-disabled="true">${icon('spin', 'spin')}Getting it</span>`;
  return j.files.length === 1 ? `<a class="btn text" href="${cvFileURL(j, 0, true)}">Save</a>` : `<button type="button" class="btn text" data-cvget="${j.id}">Get</button>`;
}

const cvTarget = (j) => (CVS?.kinds || []).find((k) => k.id === j.kind)?.targets.find((t) => t.id === j.target)?.label || j.target.toUpperCase();
// A conversion as a row, seen from this phone: a photo result shows itself, then what it became and where it is now.
function cvFields(j) {
  const fs = j.files || [], n = shown1(fs), live = isLive(j);
  const meta = j.state === 'failed' ? j.note || "That didn't convert."
    : `To ${cvTarget(j)}` + (live ? ', ' + (j.local ? j.note || 'on this phone' : j.state === 'queued' ? 'waiting its turn' : j.pct < 1 ? 'starting' : Math.floor(j.pct) + '%')
      : (fs.length > 1 ? `, ${fs.length} files` : '') + (j.size && j.inSize ? `, ${size(j.inSize)} to ${size(j.size)}` : '') + (j.note ? '. ' + j.note : ''));
  return { id: j.id, th: thumb(j.state === 'failed' ? 'alert' : fs[n]?.kind || cvIcon[j.kind] || 'doc', j.state === 'done' && fs[n]?.kind === 'photo' && !j.local && !OFFLINE ? cvFileURL(j, n) : ''),
    title: esc(cvName(j)), meta: esc(meta), bad: j.state === 'failed', where: whereOf(j, IOS ? 'Saved' : 'In Gallery'), when: stamp(new Date(j.at)), pct: live ? (j.state === 'queued' ? 0 : j.pct) : -1 };
}

function cvRow(j) {
  const mine = j.from === ST?.me;
  const acts = j.local ? ljSaveBtn(j) : isLive(j) ? (mine ? `<button type="button" class="btn text" data-cvcancel="${j.id}">Cancel</button>` : '')
    : (j.state === 'done' ? cvSaveButton(j) : '') + more('cv' + j.id, [frShareBtn('cv', j), mine && `<button type="button" role="menuitem" data-cvremove="${j.id}">${icon('x')}Remove from the list</button>`]);
  return rowOf({ ...cvFields(j), acts });
}

function cvPicked() {
  if (!CS.files.length) return {};
  const kinds = CS.files.map((f) => cvKind(f.name));
  if (kinds.some((k) => !k)) {
    const bad = CS.files[kinds.indexOf(undefined)].name;
    return { why: cvExt(bad) === 'pdf' ? 'For PDFs, use the PDF tools on Home.' : `${bad} isn't a kind of file the Converter knows.` };
  }
  if (kinds.some((k) => k !== kinds[0])) return { why: 'Pick files of one kind at a time (only photos, or only videos).' };
  const k = kinds[0];
  if (!k.targets.some((t) => t.id === CS.to)) {
    const ext = cvExt(CS.files[0].name);
    CS.to = (k.targets.find((t) => t.id !== ext && !(ext === 'jpeg' && t.id === 'jpg')) || k.targets[0]).id;
  }
  if (CVS.local && k.engine === 'soffice') return { kind: k, why: 'Word, Excel and PowerPoint files need your PC. Convert them when it\'s reachable.' };
  if (!CVS.ready[k.engine]) return { kind: k, why: k.engine === 'soffice' ? 'Office files need LibreOffice on your PC. Install it there: Settings › Converter.' : 'Your PC is still setting up this engine. Try again in a few minutes.' };
  return { kind: k };
}

function cvView() {
  if (OFFLINE || !CVS) CVS = CV_LOCAL; // the PC is out of reach: this phone converts
  const { kind, why } = cvPicked();
  const many = CS.files.length > 1, total = CS.files.reduce((s, f) => s + f.size, 0);
  const box = !CS.files.length
    ? `<label class="cvdrop">${icon('upload')}<b>Pick files</b><small>${IOS ? 'Photos, videos, or anything in Files' : 'Photos, videos, music or documents'}</small><input type="file" id="cvpick" multiple hidden></label>`
    : `<div class="cvpicked"><div class="cvchips">${CS.files.slice(0, 4).map((f) => `<span class="cvchip">${icon(cvIcon[cvKind(f.name)?.id] || 'doc')}<span>${esc(f.name)}</span></span>`).join('')}${CS.files.length > 4 ? `<span class="cvchip more">+${CS.files.length - 4}</span>` : ''}</div>
        <button type="button" class="btn small" data-cvclear>Start over</button></div>
      <div class="under">${why ? `<span class="detected is-bad">${icon('alert')}<span>${esc(why)}</span></span>` : `<span class="detected"><i class="dotlight"></i><span><b>${CS.files.length} ${esc(kind.label.toLowerCase())}${many ? 's' : ''}</b> · ${size(total)}</span></span>`}</div>
      ${kind ? `<div class="cvto"><span class="group-label">Make ${many ? 'them' : 'it'}</span><div class="seg">${kind.targets.map((t) => `<button type="button" data-cvto="${t.id}" aria-pressed="${t.id === CS.to}">${esc(t.label)}</button>`).join('')}</div></div>
        <p class="cvhint">${esc(kind.targets.find((t) => t.id === CS.to)?.note || '')}</p>
        ${kind.engine !== 'soffice' ? `<label class="sw"><input type="checkbox" class="switch" role="switch" id="cvsmall" ${CS.small ? 'checked' : ''}>Smaller file</label>` : ''}
        ${kind.id === 'image' && CS.to === 'pdf' && many ? `<label class="sw"><input type="checkbox" class="switch" role="switch" id="cvcombine" ${CS.combine ? 'checked' : ''}>All in one PDF</label>` : ''}` : ''}
      <button type="button" class="btn primary big" data-cvgo ${kind && !why && CS.up < 0 ? '' : 'disabled'}>${CS.up >= 0 ? `Sending ${CS.up}%` : 'Convert'}</button>`;
  const jobs = [...cvJobs()].sort(newest);
  return `${note(esc(CS.err))}<div class="dlbox cvbox">${box}</div>
    <p class="tip">${CVS.local ? 'Your PC is out of reach, so this phone converts it. Tap it when it\'s done to save it.' : IOS ? 'Your PC converts it. Tap it when it\'s done to save it.' : 'Your PC converts it, then it goes into Gallery by itself.'}
      ${IOS ? `For photos, the Share button in Photos is faster. <button type="button" class="link" data-go="cvsettings">Set it up</button>` : ''}</p>
    ${jobs.length ? byDay(jobs, (j) => j.at, cvRow) : ''}`;
}

function cvSettingsView() {
  const base = PCLINK, t = encodeURIComponent(TOKEN), c = CVS?.local ? null : CVS, ok = (on) => on ? '<span class="ok">Ready</span>' : '';
  return `${IOS ? `<section class="sec"><h2>Share button</h2><p class="tip">Make the <b>${SHORTCUT_CV}</b> Shortcut once. In Photos, tap Share and pick it: it keeps the original photo and saves the result back to Photos.</p>
    <details class="iosguide"><summary>Set up "${SHORTCUT_CV}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_CV}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, pick <b>Images</b>, <b>Media</b> and <b>Files</b>.</li>
      <li>Add <b>Repeat with Each</b> item in <b>Shortcut Input</b>. Everything below goes inside it.</li>
      <li><b>Get Name</b> of <b>Repeat Item</b>, then <b>Get Details of Files</b> › <b>File Extension</b> of <b>Repeat Item</b>, and a <b>Text</b> with <b>Name</b>.<b>File Extension</b>. <b>Set Variable</b> <b>File</b> to that Text.</li>
      <li><b>Get Contents of URL</b> with the address below, with <b>File</b> put where it says NAME.${copyField('Choices', `${base}/api/phone/cv/ios/targets?t=${t}&name=NAME`)}</li>
      <li><b>If</b> <b>Contents of URL</b> <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> and <b>Stop This Shortcut</b>. <b>End If</b>. Then <b>Split Text</b> by <b>New Lines</b> and <b>Choose from List</b> (prompt: “Make it”).</li>
      <li><b>Get Contents of URL</b> with the address below, NAME as before and TO replaced by <b>Chosen Item</b>. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Repeat Item</b>. <b>Set Variable</b> <b>Job</b> to it, and stop with a notification if it <b>begins with</b> <b>ERR</b>.${copyField('Start', `${base}/api/phone/cv/ios/start?t=${t}&name=NAME&to=TO`)}</li>
      <li>Add a <b>Text</b> “no” and <b>Set Variable</b> <b>Done</b> to it. Then <b>Repeat</b> <b>90</b> times, and inside it <b>If</b> <b>Done</b> <b>is</b> “no”:</li>
      <li>…<b>Get Contents of URL</b> of the address below, with <b>Job</b> put where it says JOB. <b>If</b> it <b>begins with</b> <b>WAIT</b>: <b>Wait</b> 2 seconds. <b>Otherwise</b>, <b>If</b> it <b>begins with</b> <b>ERR</b>: <b>Show Notification</b> with it. <b>Otherwise</b>: <b>Save to Photo Album</b> (for PDFs and documents use <b>Save File</b> instead). In both of these, <b>Set Variable</b> <b>Done</b> to a Text “yes”.${copyField('Get', `${base}/api/phone/cv/ios/get/JOB?t=${t}`)}</li>
      <li>After the Repeat: <b>If</b> <b>Done</b> <b>is</b> “no”: <b>Show Notification</b> “Still converting on the PC. Open Premade Tools to save it when it's done.”</li>
      <li>Try it: in Photos pick a photo, tap <b>Share</b> › <b>${SHORTCUT_CV}</b> › <b>JPG</b>. Allow access to devices on your network and to Photos when asked.</li>
    </ol></details></section>
    <section class="sec"><h2>Picking files here</h2><p class="tip">Picking a photo here, the iPhone may already turn HEIC into JPG. For videos, tap <b>Options</b> and turn <b>Most Compatible</b> off, or pick from Files, to send the original.</p></section>` : ''}
    <section class="sec"><h2>On your PC</h2>
      <div class="srow"><span class="grow">Save folder<span class="h mono">${esc(c?.dir || '')}</span><span class="h">A copy of everything stays here. Every tool saves into this one folder. Change it on the PC in Settings.</span></span></div>
      ${c ? `<div class="srow"><span class="grow">Pictures</span>${ok(c.ready.magick)}</div><div class="srow"><span class="grow">Video and sound</span>${ok(c.ready.ffmpeg)}</div>
      <div class="srow"><span class="grow">Office files${c.office === 'ok' ? '' : '<span class="h">Need LibreOffice on your PC. Install it there: Settings › Converter.</span>'}</span>${ok(c.office === 'ok')}</div>` : ''}
    </section>`;
}

async function cvSend() {
  const { kind } = cvPicked();
  if (CVS.local) { localConvert(kind, CS.files, CS.to, CS.small, kind.id === 'image' && CS.to === 'pdf' && CS.combine); CS.files = []; CS.err = ''; render(); return; }
  CS.up = 0; CS.err = ''; render();
  let x;
  try {
    x = await sendForm(`${PCURL}/api/phone/cv/start?to=${CS.to}&small=${CS.small ? 1 : 0}&combine=${kind.id === 'image' && CS.to === 'pdf' && CS.combine ? 1 : 0}`,
      { Authorization: 'Bearer ' + TOKEN }, CS.files, {}, (p) => { CS.up = Math.floor(p * 100); render(); });
  } catch (e) { CS.up = -1; CS.err = e.message; render(); return; }
  CS.up = -1;
  if (x.status === 200) { CS.files = []; CS.err = ''; } else CS.err = x.responseText.trim() || "That didn't work.";
  await cvRefresh(); render(); cvPoll();
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
    else if (d.cvremove) { await api('/api/phone/cv/remove/' + d.cvremove, {}); await cvRefresh(); render(); }
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
