// File drop's send box, clipboard card and rows, shared by the PC window (drop-ui.js) and the phones (mdrop.js),
// which set DROPAPI: { base, hdr, touch, after(), acts(drop), url(drop, n, dl), thumb(drop, n), seen, menu?(drop) }.
'use strict';

ICON.drop = '<path d="M7 4v13M3.5 7.5L7 4l3.5 3.5M17 20V7M13.5 16.5L17 20l3.5-3.5"/>';
ICON.link = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
ICON.text = '<path d="M5 6h14M5 11h14M5 16h9"/>';
ICON.copy = ICON.copy || '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>';

let DROPST = null; // GET DROPAPI.base: { me, devices, jobs, clip, clipSync, dir }
const FD = { files: [], text: '', to: '', up: -1, err: '', copied: '' };

const dropJobs = () => DROPST?.jobs || [];
const dropDev = (id) => (DROPST?.devices || []).find((d) => d.id === id);
const dropName = (id) => id === DROPST?.me ? (DROPAPI.touch ? 'This phone' : 'This PC') : dropDev(id)?.name || String(id || '').replace(/^friend:/, '');
const dropTargets = () => (DROPST?.devices || []).filter((d) => d.id !== DROPST.me);
const dropIcon = (it) => it.kind === 'link' ? 'link' : it.kind === 'text' ? 'text' : it.files.length === 1 && it.files[0].kind === 'photo' ? 'photo' : it.files.length === 1 && it.files[0].kind === 'video' ? 'video' : 'file';
// New for this device: on a phone, not saved yet; on the PC, came in since File drop was last open.
const dropNew = () => dropJobs().filter((j) => j.to === DROPST?.me && (DROPAPI.touch ? !j.fetched : new Date(j.at) > DROPAPI.seen)).length;
function dropTitle(it) {
  if (it.kind !== 'files') return it.text.split('\n')[0];
  return it.files.length > 1 ? `${it.files[0].name} and ${it.files.length - 1} more` : it.files[0]?.name || 'Files';
}

async function dropRefresh() {
  try { DROPST = await api(DROPAPI.base); } catch (e) {}
  if (!DROPST?.local) FD.sent = ''; // "It reaches PC when your PC is back on": it is
  if (DROPST && !dropTargets().some((d) => d.id === FD.to)) FD.to = dropTargets()[0]?.id || '';
}

const dropInput = Object.assign(document.createElement('input'), { type: 'file', id: 'dropfile', multiple: true });
dropInput.style.cssText = 'position:fixed;left:-200px;width:1px;height:1px;opacity:0';
document.body.append(dropInput);
dropInput.addEventListener('change', () => { FD.files = FD.files.concat([...dropInput.files]); FD.err = ''; dropInput.value = ''; render(); });

function dropBox() {
  const targets = dropTargets();
  if (!targets.length) return `<div class="empty">${icon('phones')}<h2>Nothing to send to yet</h2><p>Pair a phone first: Vault › Phones › Add a phone.</p></div>`;
  const files = !FD.files.length
    ? `<label class="cvdrop dropzone" id="dropzone" for="dropfile">${icon('drop')}<b>${DROPAPI.touch ? 'Pick photos or files' : 'Drop files here'}</b>${DROPAPI.touch ? '' : '<span>or</span><span class="btn">Choose files…</span>'}</label>`
    : `<div class="cvpicked"><div class="cvchips">${FD.files.slice(0, 6).map((f, i) => `<span class="cvchip">${icon('file')}<span>${esc(f.name)}</span><button type="button" class="iconbtn" data-drop="unpick" data-i="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></span>`).join('')}${FD.files.length > 6 ? `<span class="cvchip more">+${FD.files.length - 6} more</span>` : ''}</div>
      <label class="btn small" for="dropfile">${icon('plus')}Add</label><button type="button" class="btn small" data-drop="clear">Start over</button></div>`;
  const ready = (FD.files.length || FD.text.trim()) && FD.to && FD.up < 0;
  return `<div class="droprow"><span class="hint">Send to</span><div class="chips droptargets" role="group" aria-label="Send to">${targets.map((d) =>
      `<button type="button" class="pill" data-dropto="${esc(d.id)}" aria-pressed="${FD.to === d.id}">${icon(d.kind === 'pc' ? 'pc' : 'phones')}${esc(d.name)}</button>`).join('')}</div></div>
    ${files}
    <textarea id="droptext" class="droptext" rows="2" dir="auto" placeholder="Or type, or paste a link or text">${esc(FD.text)}</textarea>
    <div class="cvopts"><span class="grow"></span><button type="button" class="btn primary" data-drop="send" ${ready ? '' : 'disabled'}>${FD.up >= 0 ? `${icon('spin', 'spin')}Sending ${FD.up}%` : `Send${FD.to ? ' to ' + esc(dropName(FD.to)) : ''}`}</button></div>`;
}

// The shared clipboard: whatever was copied last on any device.
function dropClipCard(note) {
  const c = DROPST?.clip;
  if (!DROPST?.clipSync) return `<div class="dropclip is-off"><span class="hint">${icon('copy')}Clipboard sync is off. Turn it on in Settings.</span></div>`;
  if (!c?.text) return `<div class="dropclip"><span class="hint">${icon('copy')}Copy something on any device and it shows up here. ${note || ''}</span></div>`;
  return `<div class="dropclip"><div class="dropclip-head"><span class="eyebrow">Clipboard · from ${esc(dropName(c.from))} · ${esc(whenShort(new Date(c.at)))}</span>
      <button type="button" class="btn text" data-drop="clipcopy">${FD.copied === 'clip' ? 'Copied' : 'Copy'}</button></div>
    <div class="dropclip-text" dir="auto">${esc(c.text.length > 600 ? c.text.slice(0, 600) + '…' : c.text)}</div>${note ? `<p class="hint">${note}</p>` : ''}</div>`;
}

// A drop as a row (rowOf in common.js): what it is, who it's from or to, and whether they have it yet.
function dropFields(it) {
  const mine = it.from === DROPST?.me, fs = it.files || [], n = shown1(fs), other = esc(dropName(mine ? it.to : it.from));
  const what = it.kind !== 'files' ? (it.kind === 'link' ? 'Link' : 'Text') : (fs.length > 1 ? plural(fs.length, 'file') : { photo: 'Photo', video: 'Video' }[fs[0]?.kind] || 'File') + ', ' + size(fs.reduce((s, f) => s + f.size, 0));
  const rest = it.kind === 'text' ? it.text.split('\n').slice(1).join(' ') : it.kind === 'files' ? it.text : '';
  return { id: it.id, th: thumb(n >= 0 ? fs[n].kind : dropIcon(it), n >= 0 && DROPAPI.thumb ? DROPAPI.thumb(it, n) : ''), title: esc(dropTitle(it)),
    meta: `${what} ${mine ? 'to' : 'from'} ${other}${rest ? ': ' + esc(rest) : ''}`,
    where: mine ? (it.to === 'pc' ? '' : icon(it.fetched ? 'check' : 'clock') + (it.fetched ? `${other} has it` : `Waiting for ${other} to pick it up`))
      : it.fetched ? icon('check') + (it.kind === 'files' ? 'Saved' : 'Copied') : it.to === 'pc' && it.kind === 'files' ? icon('pc') + 'On this PC' : '',
    when: stamp(new Date(it.at)), pct: -1 };
}

const dropRow = (it) => rowOf({ ...dropFields(it), acts: DROPAPI.acts(it) + more('drop' + it.id, [...(DROPAPI.menu?.(it) || []), it.kind === 'files' && typeof frShareBtn === 'function' ? frShareBtn('drop', it) : '',
  `<button type="button" role="menuitem" data-drop="remove" data-id="${it.id}">${icon('x')}Remove from the list</button>`]) });

async function dropSend() {
  if (DROPST?.local) return localDrop(); // the PC is off: through the relay (local.js)
  FD.up = 0; FD.err = ''; render();
  let x;
  try {
    x = await sendForm(`${DROPAPI.base}/send?to=${encodeURIComponent(FD.to)}`, DROPAPI.hdr, FD.files, FD.text.trim() ? { text: FD.text } : {}, (p) => { FD.up = Math.floor(p * 100); render(); });
  } catch (e) { FD.up = -1; FD.err = e.message; render(); return; }
  FD.up = -1;
  if (x.status === 200) { FD.files = []; FD.text = ''; FD.err = ''; } else FD.err = x.responseText.trim() || "That didn't send.";
  await dropRefresh(); render(); DROPAPI.after();
}

const dropCopied = (key) => { FD.copied = key; render(); setTimeout(() => { FD.copied = ''; render(); }, 1800); };

document.getElementById('app').addEventListener('click', async (e) => {
  // Open the picker ourselves rather than leave it to the label: on Rayan's PC the label alone didn't open it.
  if (e.target.closest('label[for="dropfile"]')) { e.preventDefault(); dropInput.click(); return; }
  const b = e.target.closest('[data-drop],[data-dropto]');
  if (!b) return;
  if (b.dataset.dropto) { FD.to = b.dataset.dropto; render(); return; }
  const a = b.dataset.drop, id = b.dataset.id;
  try {
    if (a === 'send') dropSend();
    else if (a === 'clear') { FD.files = []; render(); }
    else if (a === 'unpick') { FD.files.splice(+b.dataset.i, 1); render(); }
    else if (a === 'clipcopy') { trCopy(DROPST.clip.text); dropCopied('clip'); }
    else if (a === 'remove') { await api(`${DROPAPI.base}/remove/${id}`, {}); await dropRefresh(); render(); }
  } catch (err) { FD.err = err.message; render(); }
});
document.getElementById('app').addEventListener('input', (e) => { if (e.target.id === 'droptext') { FD.text = e.target.value; const s = document.querySelector('[data-drop="send"]'); if (s) s.disabled = !(FD.files.length || FD.text.trim()) || !FD.to || FD.up >= 0; } });
