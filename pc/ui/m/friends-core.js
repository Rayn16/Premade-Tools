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
const frDevIcon = (d) => d.kind === 'pc' ? 'pc' : 'phones';
const frSeen = (p) => p.online ? 'Online' : p.seen ? 'Seen ' + ago(new Date(p.seen).toISOString()) : 'Not seen yet';

async function frRefresh() {
  try { FRST = await api(FRAPI.base); } catch (e) {}
}

// The item in a finished result's ⋯ menu. Nothing shows until this person is in Friends.
const frShareBtn = (tool, j) => frOn() && j.state === 'done' && (j.files || []).length
  ? `<button type="button" role="menuitem" data-fr="share" data-tool="${tool}" data-id="${j.id}" data-title="${esc((j.files[0] || {}).name || '')}">${icon('send')}Send to a friend</button>` : '';
const frFace = (p) => `<span class="th">${esc(p.name.slice(0, 1).toUpperCase())}</span>`;
const frDot = (p) => `<i class="frdot ${p.online ? 'is-on' : ''}"></i>${esc(frSeen(p))}`;

function frJoinBox() {
  if (!FRST?.ready) return `<div class="empty">${icon('friends')}<h2>Friends isn't on yet</h2><p>It switches on with the next update.</p></div>`;
  return `<div class="dlbox cvbox"><h2 class="block-title">Join Friends</h2>
    <p class="block-hint">Everyone who has Premade Tools shows up here, and you can send them anything you make. Type the name they'll see.</p>
    <div class="frjoin"><input id="frname" class="field" maxlength="40" autocomplete="name" placeholder="Your name" value="${esc(FR.name)}"><button type="button" class="btn primary" data-fr="join">Join</button></div>
    <p class="block-hint">Rayan approves each new person, so strangers who find the app can't see anyone.</p></div>`;
}

function frPersonRow(p) {
  return rowOf({ cls: 'frrow', th: frFace(p), title: esc(p.name), meta: frDot(p), where: esc(p.devices.map((d) => d.name).join(', ')),
    acts: `<button type="button" class="btn" data-fr="pickfile" data-to="${p.id}">Send a file</button>${frMe().admin ? more('fr' + p.id, [`<button type="button" role="menuitem" class="danger" data-fr="remove" data-id="${p.id}" data-name="${esc(p.name)}">${icon('x')}Remove from Friends</button>`]) : ''}` });
}

const frSendRow = (s) => rowOf({ th: thumb(s.state === 'failed' ? 'alert' : 'send', ''), title: esc(s.name), bad: s.state === 'failed',
  meta: s.state === 'failed' ? esc(s.note) : `To ${esc(s.to)}, ${esc(s.dev)}${s.state === 'running' ? ', ' + Math.floor(s.pct) + '%' : ''}`,
  where: s.state === 'done' ? icon('check') + 'Sent' : '', when: stamp(new Date(s.at)), pct: s.state === 'running' ? s.pct : -1 });

// The page body (the host adds the title and the frame).
function frPage() {
  if (!FRST) return '<p class="hint">Loading…</p>';
  const err = FR.err || FRST.err;
  const note = err ? `<div class="notebox">${icon('alert')}<div>${esc(err)}</div></div>` : FR.msg ? `<div class="notebox is-good">${icon('check')}<div>${esc(FR.msg)}</div></div>` : '';
  if (!FRST.joined) return note + frJoinBox();
  const me = frMe();
  if (!me) return note + '<p class="hint">Connecting to Friends…</p>';
  if (!me.approved) return note + `<div class="empty">${icon('clock')}<h2>Waiting for approval</h2><p>You asked to join as <b>${esc(FRST.name)}</b>. You'll see everyone here once Rayan approves you.</p></div>`;
  const waiting = me.admin && me.waiting.length ? `<section class="sec"><h2>Asking to join</h2><div class="rows">${me.waiting.map((w) => rowOf({ cls: 'frrow', th: frFace(w), title: esc(w.name),
    meta: esc(ago(new Date(w.asked).toISOString()).replace(/^j/, 'J')), acts: `<button type="button" class="btn primary" data-fr="approve" data-id="${w.id}">Approve</button><button type="button" class="btn text" data-fr="remove" data-id="${w.id}" data-name="${esc(w.name)}">Turn away</button>` })).join('')}</div></section>` : '';
  const people = frPeople().length ? `<div class="rows">${frPeople().map(frPersonRow).join('')}</div>`
    : `<div class="empty">${icon('friends')}<h2>Nobody else yet</h2><p>Share the app with people you trust. They show up here once ${me.admin ? 'you approve them' : 'Rayan approves them'}.</p></div>`;
  const sends = FRST.sends.length ? `<section class="sec"><h2>Sending</h2><div class="rows">${FRST.sends.map(frSendRow).join('')}</div></section>` : '';
  return `${note}${waiting}<section class="sec"><h2>People</h2>${people}</section>${sends}
    <section class="sec"><h2>You</h2>
      <div class="srow"><span class="grow">Your name<span class="h">What friends see. Your devices show under it.</span></span><span class="acts"><input id="frmyname" class="field small" maxlength="40" value="${esc(FRST.name)}" aria-label="Your name"><button type="button" class="btn" data-fr="rename">Save</button></span></div>
      ${FRAPI.touch ? '' : `<div class="srow"><span class="grow">This PC's name</span><span class="acts"><input id="frpcname" class="field small" maxlength="40" value="${esc(FRST.pc)}" aria-label="This PC's name"><button type="button" class="btn" data-fr="rename">Save</button></span></div>`}
      <div class="srow"><span class="grow">Waiting to be picked up<span class="h">${size(me.used)} of ${size(me.cap)}, shared by everyone. Files wait up to 7 days, and each can be up to 1 GB.</span></span></div>
    </section>`;
}

// The Share sheet: pick a person, then one of their devices or all of them.
function frSheet() {
  if (!FR.share) return '';
  const p = frPerson(FR.to);
  const what = FR.share.files ? (FR.share.files.length > 1 ? `${FR.share.files.length} files` : FR.share.files[0].name) : FR.share.title || 'This';
  const body = FR.up >= 0 ? `<p class="sheet-text">${icon('spin', 'spin')} Sending to your PC… ${FR.up}%</p>`
    : !p ? `<p class="sheet-text">Send <b>${esc(what)}</b> to</p><div class="rows frpick">${frPeople().map((q) => rowOf({ go: `data-fr="to" data-id="${q.id}"`, cls: 'frrow', th: frFace(q), title: esc(q.name), meta: frDot(q) })).join('')
      || '<p class="hint">Nobody else is in Friends yet.</p>'}</div>`
    : `<p class="sheet-text">Send <b>${esc(what)}</b> to <b>${esc(p.name)}</b>'s</p><div class="rows frpick">
      ${rowOf({ go: 'data-fr="dev" data-id="all"', cls: 'frrow', th: `<span class="th">${icon('friends')}</span>`, title: 'All devices', meta: esc(p.devices.map((d) => d.name).join(', ')) })}
      ${p.devices.map((d) => rowOf({ go: `data-fr="dev" data-id="${esc(d.id)}"`, cls: 'frrow', th: `<span class="th">${icon(frDevIcon(d))}</span>`, title: esc(d.name) })).join('')}</div>
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

// Any file goes up to my PC first, which sends it on (so it keeps going if the phone locks). A phone's file over
// 90 MB goes in pieces (sendPieces).
async function frUpload(files, to, dev) {
  for (const [i, f] of files.entries()) {
    const url = `${FRAPI.base}/upload?to=${encodeURIComponent(to)}&dev=${encodeURIComponent(dev)}&name=${encodeURIComponent(f.name)}`;
    const onp = (n) => { FR.up = Math.floor((i + Math.min(1, n / (f.size || 1))) / files.length * 100); render(); };
    const big = url.includes('/api/phone/') && f.size > 90 << 20;
    const x = await xhr('POST', big ? `${url}&piece=${await sendPieces(url, FRAPI.hdr, f, onp)}` : url, FRAPI.hdr, big ? null : f, big ? () => {} : onp);
    if (x.status !== 200) {
      let msg = x.responseText.trim();
      try { msg = JSON.parse(msg).error || msg; } catch (e) {} // a relay answer is JSON
      throw new Error(x.status === 401 ? "Couldn't send it through your PC. Close Premade and open it again, then try once more." : msg || "That didn't send.");
    }
  }
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
