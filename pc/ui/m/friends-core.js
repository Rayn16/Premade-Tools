// Friends: the page and the Share sheet, shared by the PC window (friends-ui.js) and the phones (mfriends.js),
// which set FRAPI: { base, hdr, touch, sheet(label, body) }. Share buttons on tool results call frShareBtn(tool, job).
'use strict';

ICON.friends = '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.6 14.2c2.6-.5 4.6 1 5 4.8"/>';
ICON.send = '<path d="M4 12l16-7-6 15-3-6z"/><path d="M11 14l9-9"/>';

let FRST = null; // GET FRAPI.base: { ready, joined, name, pc, err, sends, me: { approved, admin, people, waiting, used, cap } }
const FR = { share: null, to: '', err: '', msg: '', name: '', up: -1 };

const frMe = () => FRST?.me;
const frOn = () => !!frMe()?.approved;
const frPeople = () => frMe()?.people || [];
const frPerson = (id) => frPeople().find((p) => p.id === id);
const frDevIcon = (d) => d.kind === 'pc' ? 'folder' : 'phones';
const frSeen = (p) => p.online ? 'Online' : p.seen ? 'Seen ' + ago(new Date(p.seen).toISOString()) : 'Not seen yet';

async function frRefresh() {
  try { FRST = await api(FRAPI.base); } catch (e) {}
}

// Friends sits apart from the tools: one button at the top right of Home. attr is data-go (PC) or data-tool (phone).
function frHomeBtn(attr) {
  const waiting = (frMe()?.waiting || []).length, on = frPeople().filter((p) => p.online).length;
  const sub = !FRST?.joined ? 'Not joined yet' : waiting ? `${waiting} asking to join` : frOn() ? `${on} online` : 'Waiting for approval';
  return `<button type="button" class="frhome" ${attr}="friends">${icon('friends')}<span class="frhome-text"><b>Friends</b><span>${esc(sub)}</span></span>${waiting ? `<i class="frhome-dot">${waiting}</i>` : ''}</button>`;
}

// The button on a finished result. Nothing shows until this person is in Friends.
const frShareBtn = (tool, j) => frOn() && j.state === 'done' && (j.files || []).length
  ? `<button type="button" class="btn small" data-fr="share" data-tool="${tool}" data-id="${j.id}" data-title="${esc((j.files[0] || {}).name || '')}">${icon('send')}Send</button>` : '';

function frJoinBox() {
  if (!FRST?.ready) return `<div class="empty">${icon('friends')}<h2>Friends isn't on yet</h2><p>It switches on with the next update.</p></div>`;
  return `<div class="dlbox cvbox"><h2 class="block-title">Join Friends</h2>
    <p class="block-hint">Everyone who has Premade Tools shows up here, and you can send them anything you make. Type the name they'll see.</p>
    <div class="frjoin"><input id="frname" class="field" maxlength="40" autocomplete="name" placeholder="Your name" value="${esc(FR.name)}"><button type="button" class="btn primary" data-fr="join">Join</button></div>
    <p class="block-hint">Rayan approves each new person, so strangers who find the app can't see anyone.</p></div>`;
}

function frPersonRow(p) {
  return `<div class="row frperson"><span class="thumb frface" style="--h:${pdfHue(p.id)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
    <div class="row-text grow"><span class="row-title">${esc(p.name)}</span>
      <div class="hmeta"><span class="frdot ${p.online ? 'is-on' : ''}"></span><span>${esc(frSeen(p))}</span><span>${esc(p.devices.map((d) => d.name).join(' · '))}</span></div></div>
    <div class="hacts"><button type="button" class="btn small" data-fr="pickfile" data-to="${p.id}">${icon('send')}Send a file</button>
      ${frMe().admin ? `<button type="button" class="iconbtn" data-fr="remove" data-id="${p.id}" data-name="${esc(p.name)}" aria-label="Remove ${esc(p.name)}" title="Remove from Friends">${icon('x')}</button>` : ''}</div></div>`;
}

function frSendRow(s) {
  const state = s.state === 'failed' ? `<div class="hmeta bad">${icon('alert')}${esc(s.note)}</div>` : s.state === 'running' ? `<div class="prog"><i style="width:${Math.max(3, s.pct)}%"></i></div>` : '';
  return `<div class="row"><span class="thumb" style="--h:${pdfHue(s.id)}">${icon('send')}</span><div class="row-text grow"><span class="row-title clip">${esc(s.name)}</span>
    <div class="hmeta"><span>To ${esc(s.to)} · ${esc(s.dev)} · ${hm(new Date(s.at))}</span>${s.state === 'done' ? `<span class="where">${icon('check')}Sent</span>` : s.state === 'running' ? `<span class="jobstate">${Math.floor(s.pct)}%</span>` : ''}</div>${state}</div></div>`;
}

// The page body (the host adds the title and the frame).
function frPage() {
  if (!FRST) return '<p class="pagelede">Loading…</p>';
  const err = FR.err || FRST.err;
  const note = err ? `<div class="notebox">${icon('alert')}<div>${esc(err)}</div></div>` : FR.msg ? `<div class="notebox is-good">${icon('check')}<div>${esc(FR.msg)}</div></div>` : '';
  if (!FRST.joined) return note + frJoinBox();
  const me = frMe();
  if (!me) return note + `<p class="pagelede">Connecting to Friends…</p>`;
  if (!me.approved) return note + `<div class="empty">${icon('clock')}<h2>Waiting for approval</h2><p>You asked to join as <b>${esc(FRST.name)}</b>. You'll see everyone here once Rayan approves you.</p></div>`;
  const waiting = me.admin && me.waiting.length ? `<section class="sec"><h2 class="group-label">Asking to join</h2><div class="rows hrows">${me.waiting.map((w) =>
    `<div class="row"><span class="thumb frface">${esc(w.name.slice(0, 1).toUpperCase())}</span><div class="row-text grow"><span class="row-title">${esc(w.name)}</span><div class="hmeta"><span>Asked ${esc(ago(new Date(w.asked).toISOString()))}</span></div></div>
      <div class="hacts"><button type="button" class="btn small primary" data-fr="approve" data-id="${w.id}">${icon('check')}Approve</button><button type="button" class="btn small" data-fr="remove" data-id="${w.id}" data-name="${esc(w.name)}">Turn away</button></div></div>`).join('')}</div></section>` : '';
  const people = frPeople().length ? `<div class="rows hrows">${frPeople().map(frPersonRow).join('')}</div>`
    : `<div class="empty">${icon('friends')}<h2>Nobody else yet</h2><p>Share the app with people you trust. They show up here once ${me.admin ? 'you approve them' : 'Rayan approves them'}.</p></div>`;
  const sends = FRST.sends.length ? `<section class="sec"><h2 class="group-label">Sending</h2><div class="rows hrows">${FRST.sends.map(frSendRow).join('')}</div></section>` : '';
  const pct = me.cap ? Math.min(100, me.used / me.cap * 100) : 0;
  return `${note}${waiting}<section class="sec"><h2 class="group-label">People</h2>${people}</section>${sends}
    <section class="sec"><h2 class="group-label">You</h2><div class="rows">
      <div class="row"><div class="row-text grow"><span class="row-title">Your name</span><span class="row-hint">What friends see. Your devices show under it.</span></div>
        <input id="frmyname" class="field small" maxlength="40" value="${esc(FRST.name)}"><button type="button" class="btn small" data-fr="rename">Save</button></div>
      ${FRAPI.touch ? '' : `<div class="row"><div class="row-text grow"><span class="row-title">This PC's name</span></div><input id="frpcname" class="field small" maxlength="40" value="${esc(FRST.pc)}"><button type="button" class="btn small" data-fr="rename">Save</button></div>`}
      <div class="row"><div class="row-text grow"><span class="row-title">Waiting to be picked up</span><span class="row-hint">${size(me.used)} of ${size(me.cap)}, shared by everyone. Files wait up to 7 days; 1 GB per file.</span>
        <div class="prog"><i style="width:${Math.max(1, pct)}%"></i></div></div></div>
    </div></section>`;
}

// The Share sheet: pick a person, then one of their devices or all of them.
function frSheet() {
  if (!FR.share) return '';
  const p = frPerson(FR.to);
  const what = FR.share.files ? (FR.share.files.length > 1 ? `${FR.share.files.length} files` : FR.share.files[0].name) : FR.share.title || 'This';
  const body = FR.up >= 0 ? `<p class="sheet-text">${icon('spin', 'spin')} Sending to your PC… ${FR.up}%</p>`
    : !p ? `<p class="sheet-text">Send <b>${esc(what)}</b> to</p><div class="rows frpick">${frPeople().map((q) =>
      `<button type="button" class="row frpickrow" data-fr="to" data-id="${q.id}"><span class="thumb frface" style="--h:${pdfHue(q.id)}">${esc(q.name.slice(0, 1).toUpperCase())}</span><span class="row-text grow"><span class="row-title">${esc(q.name)}</span><span class="row-hint"><span class="frdot ${q.online ? 'is-on' : ''}"></span>${esc(frSeen(q))}</span></span>${icon('down', 'frchev')}</button>`).join('') || '<p class="row-hint">Nobody else is in Friends yet.</p>'}</div>`
    : `<p class="sheet-text">Send <b>${esc(what)}</b> to <b>${esc(p.name)}</b>'s</p><div class="rows frpick">
      <button type="button" class="row frpickrow" data-fr="dev" data-id="all"><span class="thumb">${icon('friends')}</span><span class="row-text grow"><span class="row-title">All devices</span><span class="row-hint">${esc(p.devices.map((d) => d.name).join(', '))}</span></span></button>
      ${p.devices.map((d) => `<button type="button" class="row frpickrow" data-fr="dev" data-id="${esc(d.id)}"><span class="thumb">${icon(frDevIcon(d))}</span><span class="row-text grow"><span class="row-title">${esc(d.name)}</span></span></button>`).join('')}</div>
      <button type="button" class="btn small" data-fr="back">Back</button>`;
  return FRAPI.sheet('Send to a friend', `${FR.err ? `<div class="notebox">${icon('alert')}<div>${esc(FR.err)}</div></div>` : ''}${body}`);
}

const frInput = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
frInput.style.cssText = 'position:fixed;left:-200px;width:1px;height:1px;opacity:0';
document.body.append(frInput);
frInput.addEventListener('change', () => {
  if (!frInput.files.length) return;
  FR.share = { files: [...frInput.files] }; FR.err = ''; frInput.value = ''; render();
});

// Any file goes up to my PC first, which sends it on (so it keeps going if the phone locks).
function frUpload(files, to, dev) {
  return files.reduce((p, f, i) => p.then(() => new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${FRAPI.base}/upload?to=${encodeURIComponent(to)}&dev=${encodeURIComponent(dev)}&name=${encodeURIComponent(f.name)}`);
    for (const [k, v] of Object.entries(FRAPI.hdr)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => { if (e.lengthComputable) { FR.up = Math.floor((i + e.loaded / e.total) / files.length * 100); render(); } };
    x.onload = () => x.status === 200 ? ok() : bad(new Error(x.responseText.trim() || "That didn't send."));
    x.onerror = () => bad(new Error("Couldn't reach your PC."));
    x.send(f);
  })), Promise.resolve());
}

async function frSend(dev) {
  const sh = FR.share, to = FR.to, p = frPerson(to);
  try {
    if (sh.files) { FR.up = 0; render(); await frUpload(sh.files, to, dev); }
    else await api(FRAPI.base + '/send', { tool: sh.tool, id: sh.id, to, dev });
    FR.share = null; FR.to = ''; FR.up = -1; FR.err = '';
    FR.msg = `Sending to ${p?.name || 'them'}. It shows under Friends › Sending.`;
    setTimeout(() => { FR.msg = ''; render(); }, 5000);
  } catch (e) { FR.up = -1; FR.err = e.message; }
  await frRefresh(); render();
}

document.getElementById('app').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fr]');
  if (!b) { if (FR.share && e.target.matches('[data-frclose]')) { FR.share = null; FR.to = ''; FR.err = ''; render(); } return; }
  const a = b.dataset.fr, id = b.dataset.id;
  try {
    if (a === 'share') { FR.share = { tool: b.dataset.tool, id, title: b.dataset.title }; FR.to = ''; FR.err = ''; render(); }
    else if (a === 'pickfile') { FR.to = b.dataset.to || ''; frInput.click(); }
    else if (a === 'to') { FR.to = id; FR.err = ''; render(); }
    else if (a === 'back') { FR.to = ''; render(); }
    else if (a === 'dev') frSend(id);
    else if (a === 'close') { FR.share = null; FR.to = ''; FR.err = ''; render(); }
    else if (a === 'join') { FR.err = ''; await api(FRAPI.base + '/join', { name: document.getElementById('frname').value }); await frRefresh(); render(); }
    else if (a === 'rename') { await api(FRAPI.base + '/name', { name: document.getElementById('frmyname')?.value || '', pc: document.getElementById('frpcname')?.value || '' }); FR.msg = 'Saved.'; await frRefresh(); render(); setTimeout(() => { FR.msg = ''; render(); }, 2500); }
    else if (a === 'approve') { await api(`${FRAPI.base}/approve/${id}`, {}); await frRefresh(); render(); }
    else if (a === 'remove') { if (!confirm(`Remove ${b.dataset.name} from Friends? They'd have to ask again.`)) return; await api(`${FRAPI.base}/remove/${id}`, {}); await frRefresh(); render(); }
  } catch (err) { FR.err = err.message; render(); }
});
document.getElementById('app').addEventListener('input', (e) => { if (e.target.id === 'frname') FR.name = e.target.value; });
