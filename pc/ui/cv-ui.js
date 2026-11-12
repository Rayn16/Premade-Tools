// The Converter's page and settings in the PC window. app.js draws the frame and calls convertView()/cvSettings().
'use strict';

let CV = null; // /api/ui/cv
const C = { files: [], to: '', small: false, combine: true, err: '', up: -1 };

ICON.convert = '<path d="M4 8h13l-3-3M20 16H7l3 3"/>';
ICON.upload = '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>';
ICON.doc = '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>';

const cvRunning = () => (CV?.jobs || []).some((j) => j.state === 'queued' || j.state === 'running');
const extOf = (n) => (n.split('.').pop() || '').toLowerCase();
const kindOf = (n) => (CV?.kinds || []).find((k) => k.exts.includes(extOf(n)));
const kindIcon = { image: 'photo', video: 'video', audio: 'music', doc: 'doc', sheet: 'doc', slides: 'doc' };

// What the picked files are, and why they can't be converted (if they can't).
function picked() {
  if (!C.files.length) return { kind: null, why: '' };
  const kinds = C.files.map((f) => kindOf(f.name));
  if (kinds.some((k) => !k)) {
    const bad = C.files[kinds.indexOf(undefined)].name;
    return { kind: null, why: extOf(bad) === 'pdf' ? "For PDFs, use the PDF tools. The Converter takes pictures, videos, sound and office files." : `${bad} isn't a kind of file the Converter knows.` };
  }
  if (kinds.some((k) => k !== kinds[0])) return { kind: null, why: 'Pick files of one kind at a time (only pictures, or only videos, …).' };
  const k = kinds[0];
  if (!CV.ready[k.engine]) return { kind: k, why: k.engine === 'soffice' ? '' : 'The engine for this is still being set up. Try again in a minute.' };
  return { kind: k, why: '' };
}

function pickTarget(k) {
  if (!k.targets.some((t) => t.id === C.to)) {
    const ext = extOf(C.files[0].name);
    C.to = (k.targets.find((t) => t.id !== ext && !(ext === 'jpeg' && t.id === 'jpg')) || k.targets[0]).id;
  }
  return C.to;
}

function officeNote(k) {
  if (!k || k.engine !== 'soffice' || CV.office === 'ok') return '';
  const st = CV.office;
  if (st === 'installing') return `<div class="notebox is-info">${icon('spin', 'spin')}<div><b>Installing LibreOffice…</b> Windows may ask once to allow it. This takes a few minutes.</div></div>`;
  return `<div class="notebox">${icon('alert')}<div>Office files are converted by <b>LibreOffice</b>, a free office suite, and it isn't on this PC yet (about 350 MB).${st.startsWith('error') ? ` Last try: ${esc(st.slice(7))}.` : ''}
    <div class="acts"><button type="button" class="btn small primary" data-cv="office">Install LibreOffice</button></div></div></div>`;
}

function convertView() {
  const jobs = [...(CV?.jobs || [])].sort(newest);
  const { kind, why } = CV ? picked() : {};
  const to = kind ? pickTarget(kind) : '';
  const many = C.files.length > 1;
  const canCombine = kind?.id === 'image' && to === 'pdf' && many;
  const can = kind && !why && (kind.engine !== 'soffice' || CV.office === 'ok') && C.up < 0;
  const total = C.files.reduce((s, f) => s + f.size, 0);
  const chips = C.files.slice(0, 6).map((f, i) => `<span class="cvchip">${icon(kindIcon[kindOf(f.name)?.id] || 'doc')}<span>${esc(f.name)}</span><button type="button" class="iconbtn" data-cv="drop" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></span>`).join('')
    + (C.files.length > 6 ? `<span class="cvchip more">+${C.files.length - 6} more</span>` : '');
  const box = !C.files.length
    ? `<label class="cvdrop" id="cvdrop">${icon('upload')}<b>Drop files here</b><span>or</span><span class="btn">Choose files…</span>
        <input type="file" id="cvpick" multiple hidden><small>Pictures (iPhone HEIC too), videos, sound, Word, Excel and PowerPoint files.</small></label>`
    : `<div class="cvpicked"><div class="cvchips">${chips}</div><button type="button" class="btn small" data-cv="clear">Start over</button></div>
      <div class="under">${why ? `<span class="detected is-bad">${icon('alert')}<span>${esc(why)}</span></span>`
        : `<span class="detected"><i class="dotlight"></i><span><b>${C.files.length} ${esc(kind.label.toLowerCase())}${many ? 's' : ''}</b> · ${size(total)}</span></span>`}</div>
      ${kind ? `<div class="cvto"><span class="group-label">Make ${many ? 'them' : 'it'}</span><div class="seg">${kind.targets.map((t) => `<button type="button" data-cv="to" data-to="${t.id}" aria-pressed="${t.id === to}" title="${esc(t.note || '')}">${esc(t.label)}</button>`).join('')}</div></div>
      <p class="cvhint">${esc(kind.targets.find((t) => t.id === to)?.note || '')}</p>
      <div class="cvopts">
        ${kind.engine !== 'soffice' ? `<label class="sw"><input type="checkbox" class="switch" role="switch" id="cvsmall" ${C.small ? 'checked' : ''}>Smaller file${kind.id === 'video' ? ' (up to 1080p)' : kind.id === 'image' ? ' (up to 2048 px)' : ''}</label>` : ''}
        ${canCombine ? `<label class="sw"><input type="checkbox" class="switch" role="switch" id="cvcombine" ${C.combine ? 'checked' : ''}>All in one PDF</label>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn primary" data-cv="go" ${can ? '' : 'disabled'}>${C.up >= 0 ? `${icon('spin', 'spin')}Sending ${C.up}%` : 'Convert'}</button>
      </div>` : ''}
      ${officeNote(kind)}`;
  return `<section class="main">${head('Convert')}<div class="body scroller"><div class="col">
    ${C.err ? `<div class="notebox">${icon('alert')}<div>${esc(C.err)}</div></div>` : ''}
    <div class="dlbox cvbox">${box}</div>
    ${jobs.length ? byDay(jobs, (j) => j.at, cvRow) : `<div class="empty">${icon('convert')}<h2>Nothing converted yet</h2><p>Drop files above. Everything runs on this PC, and files converted from your phones show up here too.</p></div>`}
  </div></div></section>`;
}

const cvTitle = (j) => j.inputs.length > 1 ? `${j.inputs[0]} and ${j.inputs.length - 1} more` : j.inputs[0];
const cvTarget = (j) => CV?.kinds?.find((k) => k.id === j.kind)?.targets.find((t) => t.id === j.target)?.label || j.target.toUpperCase();

// A conversion as a row: the result's own picture when it has one, what it became, and where it is now.
function cvFields(j) {
  const fs = j.files || [], n = shown1(fs), live = isLive(j);
  const meta = j.state === 'failed' ? j.note || "That didn't convert."
    : `To ${cvTarget(j)}` + (live ? ', ' + (j.state === 'queued' ? 'waiting its turn' : j.pct < 1 ? 'starting' : Math.floor(j.pct) + '%')
      : (fs.length > 1 ? `, ${fs.length} files` : '') + (j.size && j.inSize ? `, ${size(j.inSize)} to ${size(j.size)}` : '') + (j.note ? '. ' + j.note : ''));
  return { id: j.id, th: thumb(j.state === 'failed' ? 'alert' : fs[n]?.kind || kindIcon[j.kind] || 'doc', j.state === 'done' && n >= 0 ? `/api/ui/cv/file/${j.id}/${n}` : ''),
    title: esc(cvTitle(j)), meta: esc(meta), bad: j.state === 'failed', where: whereOf(j), when: stamp(new Date(j.at)), pct: live ? (j.state === 'queued' ? 0 : j.pct) : -1 };
}

function cvRow(j) {
  const id = `data-id="${j.id}"`;
  return rowOf({ ...cvFields(j), acts: isLive(j) ? `<button type="button" class="btn text" data-cv="cancel" ${id}>Cancel</button>`
    : `${j.state === 'done' ? `<button type="button" class="btn text" data-cv="show" ${id}>Show</button>` : ''}${more('cv' + j.id, [frShareBtn('cv', j), `<button type="button" role="menuitem" data-cv="remove" ${id}>${icon('x')}Remove from the list</button>`])}` });
}

function cvSettings() {
  if (!CV) return '';
  const ok = '<span class="ok">Ready</span>', office = CV.office;
  return `<section class="sec"><h2>Converter</h2>
    <div class="srow"><span class="grow">Pictures<span class="h">ImageMagick, free. ${CV.ready.magick ? 'It reads iPhone HEIC photos too.' : 'Setting itself up.'}</span></span>${CV.ready.magick ? ok : ''}</div>
    <div class="srow"><span class="grow">Video and sound<span class="h">FFmpeg, shared with the Downloader.${CV.ready.ffmpeg ? '' : ' Setting itself up.'}</span></span>${CV.ready.ffmpeg ? ok : ''}</div>
    <div class="srow"><span class="grow">Office files<span class="h">LibreOffice, free, about 350 MB.${office === 'installing' ? ' Installing now.' : office.startsWith('error') ? ' Last try: ' + esc(office.slice(7)) + '.' : ''}</span></span>
      ${office === 'ok' ? ok : office === 'installing' ? '' : '<button type="button" class="btn" data-cv="office">Install</button>'}</div>
  </section>`;
}

async function cvRefresh() {
  try { CV = await api('/api/ui/cv'); } catch (e) {}
}

function cvAdd(list) {
  C.files = C.files.concat([...list]); C.err = ''; render();
}

function cvSend() {
  const { kind } = picked();
  const fd = new FormData();
  for (const f of C.files) fd.append('f', f, f.name);
  const q = `?to=${C.to}&small=${C.small ? 1 : 0}&combine=${kind.id === 'image' && C.to === 'pdf' && C.combine ? 1 : 0}`;
  const x = new XMLHttpRequest();
  x.open('POST', '/api/ui/cv/start' + q);
  x.setRequestHeader('X-Vault', '1');
  x.upload.onprogress = (e) => { if (e.lengthComputable) { C.up = Math.floor(e.loaded / e.total * 100); render(); } };
  x.onload = async () => {
    C.up = -1;
    if (x.status === 200) { C.files = []; C.err = ''; } else C.err = x.responseText.trim() || 'That didn\'t work.';
    await cvRefresh(); render(); soon();
  };
  x.onerror = () => { C.up = -1; C.err = "Couldn't send the files."; render(); };
  C.up = 0; render(); x.send(fd);
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cv]');
  if (!b) return;
  const a = b.dataset.cv, id = b.dataset.id;
  try {
    if (a === 'go') cvSend();
    else if (a === 'to') { C.to = b.dataset.to; render(); }
    else if (a === 'drop') { C.files.splice(+b.dataset.i, 1); render(); }
    else if (a === 'clear') { C.files = []; C.err = ''; render(); }
    else if (a === 'cancel') { await api('/api/ui/cv/cancel/' + id, {}); await cvRefresh(); render(); }
    else if (a === 'remove') { await api('/api/ui/cv/remove/' + id, {}); await cvRefresh(); render(); }
    else if (a === 'show') await api('/api/ui/cv/show/' + id, {});
    else if (a === 'office') { await api('/api/ui/cv/office', {}); await cvRefresh(); render(); soon(); }
  } catch (err) { C.err = err.message; render(); }
});
$app.addEventListener('change', (e) => {
  if (e.target.id === 'cvpick') cvAdd(e.target.files);
  else if (e.target.id === 'cvsmall') C.small = e.target.checked;
  else if (e.target.id === 'cvcombine') C.combine = e.target.checked;
});
// Dropping files anywhere in the window opens them in the Converter.
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.querySelector('#cvdrop,#pdfdrop,#trdrop,#dropzone')?.classList.add('is-over'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.querySelector('#cvdrop,#pdfdrop,#trdrop,#dropzone')?.classList.remove('is-over'); });
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  if (S.page === 'setup') return;
  const files = [...e.dataTransfer.files];
  if (S.page === 'drop') { FD.files = FD.files.concat(files); FD.err = ''; render(); return; }
  if (S.page === 'transcribe') { T.files = T.files.concat(files); T.err = ''; render(); return; }
  if (files.every(pdfIsPdf)) { S.page = 'pdf'; pdfAdd(files, P.op !== 'merge'); return; } // PDFs go to the PDF tools
  S.page = 'convert'; cvAdd(files);
});
