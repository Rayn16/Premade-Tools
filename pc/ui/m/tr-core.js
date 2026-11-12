// Transcribe's box and rows, shared by the PC window (tr-ui.js) and the phones (mtr.js), which set TRAPI:
// { base, hdr, touch, after(), acts(job), where(job), url(job, n, dl) }. The PC's Whisper does the work.
'use strict';

ICON.transcribe = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>';
ICON.copy = '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>';

let TRST = null; // GET TRAPI.base
const T = { files: [], to: 'text', up: -1, err: '', open: {}, text: {}, copied: '', rec: null, recAt: 0,
  lang: /^ar\b/i.test(navigator.language) ? 'ar' : 'en' }; // what's spoken, for the phone's own Whisper (it can't tell)
const trCanRecord = () => !!(window.Vault?.recordStart || (navigator.mediaDevices?.getUserMedia && window.MediaRecorder && window.isSecureContext));

const trJobs = () => [...(typeof ljOf === 'function' ? ljOf('tr') : []), ...(TRST?.jobs || [])]; // ljOf: jobs done on the phone itself (local.js)
const trBusy = () => trJobs().some(isLive) || TRST?.engine?.state === 'installing';
const trOk = (f) => /^(audio|video)\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|amr|caf|mov|mp4|m4v|mkv|webm|avi|wmv|flv|3gp|mts|ts)$/i.test(f.name);
const trTitle = (j) => j.inputs.length > 1 ? `${j.inputs[0]} and ${j.inputs.length - 1} more` : j.inputs[0];

async function trRefresh() {
  try { TRST = await api(TRAPI.base); } catch (e) {}
}

// What the engine still needs, in words; '' once it's ready.
function trEngineNote() {
  const e = TRST?.engine;
  if (!e || (e.state === 'ok' && (T.to !== 'en' || e.translate))) return '';
  if (e.state === 'installing') return `The PC is getting the speech engine (${e.pct}%). Your file waits its turn.`;
  if (e.state === 'ok') return 'Translating needs a second model (about 1.5 GB). The PC gets it the first time, once.';
  const big = e.gpu ? 'about 2.3 GB, runs on the graphics card' : 'about 1.7 GB; this PC has no NVIDIA card, so it will be slow';
  return `${e.state.startsWith('error') ? `Last try failed: ${e.state.slice(7)}. ` : ''}The first time, the PC gets the speech engine (${big}). After that nothing goes online.`;
}

// One file input that outlives every redraw (labels point at it with for="trfile").
const trInput = Object.assign(document.createElement('input'), { type: 'file', id: 'trfile', accept: 'audio/*,video/*', multiple: true });
trInput.style.cssText = 'position:fixed;left:-200px;width:1px;height:1px;opacity:0';
document.body.append(trInput);
trInput.addEventListener('change', () => { T.files = T.files.concat([...trInput.files]); T.err = ''; trInput.value = ''; render(); });

function trBox() {
  const bad = T.files.find((f) => !trOk(f));
  const files = !T.files.length
    ? `<label class="cvdrop" id="trdrop" for="trfile">${icon('transcribe')}<b>${TRAPI.touch ? 'Pick a voice memo or video' : 'Drop voice memos or videos here'}</b>${TRAPI.touch ? '' : '<span>or</span><span class="btn">Choose files…</span>'}
      <small>${TRAPI.touch ? 'From Files, Photos or anywhere on this phone' : 'Any sound or video file on this PC'}</small></label>`
    : `<div class="cvpicked"><div class="cvchips">${T.files.slice(0, 6).map((f, i) => `<span class="cvchip">${icon('transcribe')}<span>${esc(f.name)}</span><button type="button" class="iconbtn" data-tr="drop" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></span>`).join('')}${T.files.length > 6 ? `<span class="cvchip more">+${T.files.length - 6} more</span>` : ''}</div>
      <label class="btn small" for="trfile">${icon('plus')}Add</label><button type="button" class="btn small" data-tr="clear">Start over</button></div>
      <div class="under">${bad ? `<span class="detected is-bad">${icon('alert')}<span>${esc(bad.name)} has no sound. Pick a voice memo, video or sound file.</span></span>`
        : `<span class="detected"><i class="dotlight"></i><span><b>${T.files.length} ${T.files.length === 1 ? 'file' : 'files'}</b></span></span>`}</div>`;
  const rec = !trCanRecord() || T.files.length ? '' : T.up >= 0 ? `<div class="trrec"><span class="hint">${icon('spin', 'spin')}Sending the recording to the PC…</span></div>` : T.rec
    ? `<div class="trrec is-on"><span class="pulse"></span><b>Recording</b><span class="mono" id="trclock">${trClock()}</span><span class="grow"></span><button type="button" class="btn small" data-tr="recstop">${icon('check')}Stop and transcribe</button><button type="button" class="iconbtn" data-tr="reccancel" aria-label="Throw away the recording">${icon('x')}</button></div>`
    : `<div class="trrec"><span class="hint">Or talk now:</span><button type="button" class="btn small" data-tr="rec">${icon('transcribe')}Record</button></div>`;
  const note = trEngineNote();
  const ready = T.files.length && !bad && T.up < 0;
  return `${T.rec ? '' : files}${rec}
    <div class="cvopts"><label class="sw"><input type="checkbox" class="switch" role="switch" id="trto" ${T.to === 'en' ? 'checked' : ''}>Translate to English</label><span class="grow"></span>
      ${T.files.length ? `<button type="button" class="btn primary" data-tr="go" ${ready ? '' : 'disabled'}>${T.up >= 0 ? `${icon('spin', 'spin')}Sending ${T.up}%` : 'Transcribe'}</button>` : ''}</div>
    ${TRST?.local ? `<div class="cvto"><span class="group-label">Spoken in</span><div class="seg">${[['ar', 'Arabic'], ['en', 'English']].map(([k, l]) => `<button type="button" data-tr="lang" data-lang="${k}" aria-pressed="${T.lang === k}">${l}</button>`).join('')}</div></div>` : ''}
    <p class="cvhint">${TRST?.local ? (T.to === 'en' ? `${T.lang === 'ar' ? 'Arabic' : 'English'} in, English text out.` : `This phone writes down ${T.lang === 'ar' ? 'Arabic' : 'English'} as it's spoken.`) : T.to === 'en' ? 'Any language in, English text out.' : 'It hears the language by itself, Arabic and English included.'}</p>
    ${note ? `<p class="hint pdfnote">${icon('info')}<span>${esc(note)}</span></p>` : ''}`;
}

// The text of each file in a done job (file 2k is the .txt of input k), fetched when the row is opened.
async function trLoad(j) {
  T.text[j.id] = 'loading';
  try {
    const parts = await Promise.all(j.files.filter((f) => /\.txt$/i.test(f.name)).map(async (f) => {
      const r = await fetch(TRAPI.url(j, j.files.indexOf(f)), { headers: TRAPI.hdr });
      if (!r.ok) throw new Error();
      return (await r.text()).trim();
    }));
    T.text[j.id] = parts.join('\n\n');
  } catch (e) { T.text[j.id] = 'error'; }
  render();
}

function trTextView(j) {
  const t = T.text[j.id];
  if (t === undefined || t === 'loading') return '<div class="trtext"><i>Getting the text…</i></div>';
  if (t === 'error') return `<div class="trtext"><i>The text is gone from the PC's folder.</i></div>`;
  const srt = j.files.map((f, n) => [f, n]).filter(([f]) => /\.srt$/i.test(f.name));
  return `<div class="trtext scroller" dir="auto">${t ? esc(t) : '<i>No speech was heard.</i>'}</div>
    <div class="trbar"><button type="button" class="btn small primary" data-tr="copy" data-id="${j.id}">${icon(T.copied === j.id ? 'check' : 'copy')}${T.copied === j.id ? 'Copied' : 'Copy text'}</button>
      ${srt.map(([f, n]) => `<a class="btn small" href="${TRAPI.url(j, n, true)}">${icon('save')}Subtitles${srt.length > 1 ? ' · ' + esc(f.name.split(/[\\/]/).pop()) : ' (.srt)'}</a>`).join('')}</div>`;
}

// A job as a row (rowOf in common.js), with its text under it once opened; the device adds where it went and its buttons.
function trFields(j) {
  const live = isLive(j);
  const meta = j.state === 'failed' ? j.note || "That didn't work."
    : `${j.lang || 'Speech'} to ${j.target === 'en' ? 'English text' : 'text'}` + (live ? ', ' + (j.state === 'queued' ? 'waiting its turn' : 'listening') : j.note ? '. ' + j.note : '');
  return { id: j.id, th: thumb(j.state === 'failed' ? 'alert' : 'transcribe', ''), title: esc(trTitle(j)), meta: esc(meta), bad: j.state === 'failed',
    where: TRAPI.where(j), when: stamp(new Date(j.at)), pct: live ? (j.state === 'queued' ? 0 : j.pct) : -1 };
}

function trRow(j) {
  const open = (T.open[j.id] || FLAT) && j.state === 'done'; // the phone's sheet (FLAT, common.js) shows the text straight away
  if (open && T.text[j.id] === undefined) trLoad(j);
  const cancel = isLive(j) && !j.local && (!TRAPI.touch || j.from === ST?.me); // a phone cancels only its own
  return rowOf({ ...trFields(j), cls: 'trrow', extra: open ? trTextView(j) : '', acts: isLive(j) ? (cancel ? `<button type="button" class="btn text" data-tr="cancel" data-id="${j.id}">Cancel</button>` : '')
    : `${j.state === 'done' && !FLAT ? `<button type="button" class="btn text" data-tr="open" data-id="${j.id}" aria-expanded="${!!open}">${open ? 'Hide text' : 'Text'}</button>` : ''}${TRAPI.acts(j)}` });
}

async function trSend() {
  if (TRST?.local) { localTranscribe(T.files, T.to, T.lang); T.files = []; T.err = ''; render(); return; } // the phone listens (local.js)
  T.up = 0; T.err = ''; render();
  let x;
  try {
    x = await sendForm(`${TRAPI.base}/start?to=${T.to}`, TRAPI.hdr, T.files, {}, (p) => { T.up = Math.floor(p * 100); render(); });
  } catch (e) { T.up = -1; T.err = TRAPI.touch ? e.message : "Couldn't send the files."; render(); return; }
  T.up = -1;
  if (x.status === 200) { T.files = []; T.err = ''; } else T.err = x.responseText.trim() || "That didn't work.";
  await trRefresh(); render(); TRAPI.after();
}

// ---------- recording (the PC window only: phones reach the PC over http, where browsers keep the mic off) ----------
const trClock = () => { const s = Math.floor((Date.now() - T.recAt) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
let trTick = null;

// The S23 app records natively (window.Vault) and sends the sound to the PC itself, then calls trRecorded.
function trRecordNative() {
  const r = window.Vault.recordStart();
  if (r !== 'ok') { T.err = r === 'perm' ? 'Allow the microphone, then tap Record again.' : "The microphone couldn't start. Close other apps using it and try again."; render(); return; }
  T.rec = { stop() { clearInterval(trTick); T.rec = null; if (this.cancelled) window.Vault.recordStop(false, T.to); else { T.up = 0; window.Vault.recordStop(true, T.to); } render(); } };
  T.recAt = Date.now(); T.err = '';
  trTick = setInterval(() => { const c = document.getElementById('trclock'); if (c) c.textContent = trClock(); }, 500);
  render();
}
window.trRecorded = async (res) => {
  T.up = -1;
  if (res.startsWith('ERR')) T.err = res.replace(/^ERR:\s*/, '');
  await trRefresh(); render(); TRAPI.after();
};

async function trRecord() {
  if (window.Vault?.recordStart) return trRecordNative();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
    T.err = TRAPI.touch ? 'The microphone is off for Premade. Allow it when asked, or in Settings › Safari › Microphone.' : 'The microphone is off for Premade Tools. Allow it in the question at the top of the window, or in Windows Settings › Privacy › Microphone.'; render(); return;
  }
  const mr = new MediaRecorder(stream), parts = [];
  mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(trTick);
    const keep = !mr.cancelled && parts.length, at = new Date(T.recAt);
    T.rec = null; render();
    if (!keep) return;
    const type = mr.mimeType || 'audio/webm', ext = /mp4/.test(type) ? 'm4a' : 'webm'; // iPhones record mp4
    const name = `Recording ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${hm(at).replace(':', '.')}.${ext}`;
    T.files = [new File(parts, name, { type })];
    trSend();
  };
  T.rec = mr; T.recAt = Date.now(); T.err = '';
  mr.start(1000);
  trTick = setInterval(() => { const c = document.getElementById('trclock'); if (c) c.textContent = trClock(); }, 500);
  render();
}

// Copying works without HTTPS too (the phones reach the PC over plain http, where navigator.clipboard is missing).
function trCopy(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.focus(); ta.setSelectionRange(0, text.length);
  document.execCommand('copy');
  ta.remove();
}

// Transcribe what a download saved (the Downloader's history has the button).
async function trFromDL(id) {
  await api(`${TRAPI.base}/fromdl/${id}`, {});
  await trRefresh();
  TRAPI.after();
}

document.getElementById('app').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tr]');
  if (!b) return;
  const a = b.dataset.tr, id = b.dataset.id, j = trJobs().find((x) => x.id === id);
  try {
    if (a === 'go') trSend();
    else if (a === 'rec') trRecord();
    else if (a === 'recstop' || a === 'reccancel') { if (T.rec) { T.rec.cancelled = a === 'reccancel'; T.rec.stop(); } }
    else if (a === 'clear') { T.files = []; T.err = ''; render(); }
    else if (a === 'lang') { T.lang = b.dataset.lang; render(); }
    else if (a === 'drop') { T.files.splice(+b.dataset.i, 1); render(); }
    else if (a === 'open') { T.open[id] = !T.open[id]; if (T.open[id] && j && typeof T.text[id] !== 'string') trLoad(j); render(); }
    else if (a === 'copy') { trCopy(T.text[id] || ''); T.copied = id; render(); setTimeout(() => { T.copied = ''; render(); }, 1800); }
    else if (a === 'cancel') { await api(`${TRAPI.base}/cancel/${id}`, {}); await trRefresh(); render(); }
  } catch (err) { T.err = err.message; render(); }
});
document.getElementById('app').addEventListener('change', (e) => { if (e.target.id === 'trto') { T.to = e.target.checked ? 'en' : 'text'; render(); } });
