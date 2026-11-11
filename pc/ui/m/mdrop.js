// File drop on the phone: send photos, files, links and text to the PC or your other phone, pick up what they
// sent here, and the shared clipboard. The box and rows are /m/drop-core.js.
'use strict';

const DROPAPI = {
  get base() { return PCURL + '/api/phone/drop'; }, // PCURL can change (home, Tailscale, the relay link), so read it each time
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => {},
  url: (it, n, dl) => `${PCURL}/api/phone/drop/file/${it.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`,
  thumb: (it, n) => it.files[n].kind === 'photo' && !OFFLINE ? DROPAPI.url(it, n) : '', // photos only, as in every list here
  // What was sent here: Copy a text, Open a link (Copy is in its ⋯), Save files (the iPhone opens each in Safari).
  acts: (it) => {
    if (it.to !== DROPST?.me) return '';
    if (it.kind === 'text') return `<button type="button" class="btn text" data-dropm="copy" data-id="${it.id}">${FD.copied === it.id ? 'Copied' : 'Copy'}</button>`;
    if (it.kind === 'link') return `<a class="btn text" href="${esc(it.text)}" target="_blank" rel="noopener" data-dropm="seen" data-id="${it.id}">Open</a>`;
    if (NATIVE?.saveDrop) return `<button type="button" class="btn text" data-dropm="save" data-id="${it.id}">${it.fetched ? 'Save again' : 'Save'}</button>`;
    const a = (n, label) => `<a ${label ? 'role="menuitem"' : 'class="btn text"'} href="${DROPAPI.url(it, n, !IOS)}" target="_blank" data-dropm="seen" data-id="${it.id}">${label || 'Save'}</a>`;
    return it.files.length === 1 ? a(0) : more('dropsave' + it.id, it.files.map((f, n) => a(n, `${icon(f.kind === 'photo' || f.kind === 'video' ? f.kind : 'file')}${esc(f.name)}`)), 'Save');
  },
  menu: (it) => it.kind === 'link' && it.to === DROPST?.me ? [`<button type="button" role="menuitem" data-dropm="copy" data-id="${it.id}">${icon('copy')}${FD.copied === it.id ? 'Copied' : 'Copy the link'}</button>`] : [],
};
const SHORTCUT_DROP = 'Drop to PC';

function dropToolsView() {
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem('ptdrop')); } catch (e) {}
  if ((OFFLINE || !DROPST) && kept && frKey()) DROPST = { ...kept, jobs: [], clip: null, clipSync: false, local: true }; // sent through the relay, picked up by the PC later
  else if (OFFLINE || !DROPST) return `<p class="tip">Drops go through your PC, so it needs to be on and reachable. To send while it's off, join Friends on the PC once.</p>`;
  else { try { localStorage.setItem('ptdrop', JSON.stringify({ me: DROPST.me, devices: DROPST.devices })); } catch (e) {} }
  const jobs = [...dropJobs()].sort(newest);
  return `${note(esc(FD.err))}${FD.sent ? note(esc(FD.sent), 'check') : ''}${IOS && !DROPST.local ? pushBlock(true) : ''}
    <div class="dlbox cvbox">${dropBox()}</div>
    <p class="tip">${DROPST.local ? 'Your PC is off, so this goes through the internet and waits there (up to 7 days) until your PC picks it up.'
      : IOS ? `From any app: Share › ${SHORTCUT_DROP}. <button type="button" class="link" data-go="dropsettings">Set it up</button>` : 'From any app: Share › Send with Premade.'}</p>
    ${DROPST.local ? '' : dropClipCard(IOS ? 'Tap Copy to put it on this iPhone. To send this iPhone\'s clipboard, run the Drop to PC Shortcut.' : NATIVE?.dropClip ? 'It syncs by itself while Premade is open.' : 'Update the app to sync it by itself.')}
    ${jobs.length ? byDay(jobs, (j) => j.at, dropRow) : ''}`;
}

// iPhone: Home Screen apps can't be a Share target, so a Shortcut is.
function dropShortcutGuide() {
  const base = PCLINK, t = encodeURIComponent(TOKEN);
  const others = dropTargets().filter((d) => d.id !== 'pc');
  return `<section class="sec"><h2>Share button</h2><p class="tip">Make the <b>${SHORTCUT_DROP}</b> Shortcut once, and it's in the Share button of every app.</p>
    <details class="iosguide"><summary>Set up "${SHORTCUT_DROP}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_DROP}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, keep <b>Any</b>, and set <b>If there's no input</b> to <b>Get Clipboard</b> (so running it on its own sends what you copied).</li>
      <li>Add <b>Repeat with Each</b> item in <b>Shortcut Input</b>. Inside it: <b>Get Name</b> of <b>Repeat Item</b>.</li>
      <li>Still inside: <b>Get Contents of URL</b> with the address below, with <b>Name</b> put where it says NAME. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Repeat Item</b>.${copyField('Send', `${base}/api/phone/drop/ios?t=${t}&to=pc&name=NAME`)}${others.length ? `<span class="tip">To send to ${esc(others.map((d) => d.name).join(' or '))} instead, change <b>to=pc</b> to ${others.map((d) => `<b>to=${esc(d.id)}</b>`).join(' or ')}.</span>` : ''}</li>
      <li>After the Repeat: <b>Show Notification</b> with <b>Contents of URL</b> (it says “OK: Sent to PC.” or what went wrong).</li>
      <li>Try it: in Photos tap <b>Share</b> › <b>${SHORTCUT_DROP}</b>. Allow access to devices on your network when asked. Put it on your Home Screen or Action Button too, to send your clipboard in one tap.</li>
    </ol></details></section>`;
}

// iPhone pop-ups (web push): only from the Home Screen icon, which comes from the relay over https.
const pushOK = () => HOSTED && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function pushBlock(card) {
  if (NATIVE || !DROPST || OFFLINE) return '';
  const on = DROPST.push && pushOK() && Notification.permission === 'granted';
  if (card && (on || !pushOK())) return ''; // the Drop tab only offers it where it can work; Settings explains the rest
  const hint = !HOSTED ? 'Open Premade from its Home Screen icon to turn these on.'
    : !pushOK() ? 'Open Premade from its Home Screen icon (not Safari) to turn these on. Needs iOS 16.4 or newer.'
    : Notification.permission === 'denied' ? 'Notifications are off for Premade. Turn them on in iPhone Settings › Notifications › Premade.'
    : on ? 'A pop-up shows when your PC or other phone sends something here.' : 'Get a pop-up when your PC or other phone sends something here, even with Premade closed.';
  const btn = !pushOK() || Notification.permission === 'denied' ? '' : on
    ? `<button type="button" class="btn" data-dropm="pushoff">Turn off</button>` : `<button type="button" class="btn ${card ? 'small primary' : ''}" data-dropm="pushon">Turn on</button>`;
  return card ? note(`${hint}<div class="acts">${btn}</div>`, 'info')
    : `<div class="srow"><span class="grow">Notifications<span class="h">${hint}</span></span>${btn}</div>`;
}
async function pushOn() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are off for Premade. Turn them on in iPhone Settings › Notifications › Premade.');
  const reg = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(DROPST.vapid.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let sub;
  try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); } catch (e) {
    await (await reg.pushManager.getSubscription())?.unsubscribe(); // made for another PC's key
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await api('/api/phone/drop/push', sub.toJSON());
}
async function pushOff() {
  await api('/api/phone/drop/push', {});
  await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
}
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.tool) go(e.data.tool === 'drop' ? 'drop' : 'home'); }); // a notification was tapped

function dropSettingsView() {
  return `${IOS ? dropShortcutGuide() : ''}
    <section class="sec"><h2>On ${ME}</h2>
      ${pushBlock(false)}
      <div class="srow"><span class="grow">Picking up<span class="h">${IOS ? 'Open File drop to see what was sent here. Save opens it in Safari; tap Share › Save Image or Save to Files.' : 'A notification says when something arrives (checked every 15 minutes, and at once while Premade is open). Files save into Download › Premade, the same folder every tool uses.'}</span></span></div>
      <label class="srow"><span class="grow">Sync the clipboard<span class="h">${IOS ? "iPhones only let apps touch the clipboard when you tap, so your PC's copy waits in File drop with a Copy button, and the Shortcut sends yours." : 'What you copy on the PC lands on this phone, and what you copy here reaches the PC while Premade is open (Android hides the clipboard from apps in the background).'}</span></span><input type="checkbox" class="switch" role="switch" id="clipsync" ${DROPST?.clipSync ? 'checked' : ''} ${DROPST && !DROPST.local ? '' : 'disabled'}></label>
    </section>
    <section class="sec"><h2>On your PC</h2>
      <div class="srow"><span class="grow">Save folder<span class="h mono">${esc(DROPST?.local ? '' : DROPST?.dir || '')}</span><span class="h">Files sent to the PC land here. Text goes onto its clipboard. Every tool saves into this one folder. Change it on the PC in Settings.</span></span></div>
    </section>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dropm]');
  if (!b) return;
  const a = b.dataset.dropm, id = b.dataset.id, it = dropJobs().find((j) => j.id === id);
  try {
    if (a === 'copy') { trCopy(it.text); dropCopied(id); api('/api/phone/drop/fetched/' + id, {}).catch(() => {}); }
    else if (a === 'seen') api('/api/phone/drop/fetched/' + id, {}).then(dropRefresh).then(render).catch(() => {}); // the link still opens
    else if (a === 'pushon' || a === 'pushoff') { b.disabled = true; await (a === 'pushon' ? pushOn() : pushOff()); await dropRefresh(); render(); }
    else if (a === 'save') { NATIVE.saveDrop(id); b.disabled = true; }
  } catch (err) { FD.err = err.message; render(); }
});

// While Premade is open: new drops show up, and on the S23 the clipboard syncs both ways (the app keeps track
// of what it last sent and got, so a copy never bounces back).
let dropLast = '';
async function dropTick() {
  if (document.hidden || !TOKEN) return;
  await dropRefresh();
  if (NATIVE?.dropClip && DROPST?.clipSync) NATIVE.dropClip(JSON.stringify({ me: DROPST.me, clip: DROPST.clip }), true);
  const now = JSON.stringify(DROPST);
  if (now !== dropLast && ['drop', 'home'].includes(S.page) && !['droptext'].includes(document.activeElement?.id)) render();
  dropLast = now;
}
setInterval(dropTick, 3000);
$app.addEventListener('change', async (e) => {
  if (e.target.id !== 'clipsync') return;
  try { await api('/api/phone/settings', { clipSync: e.target.checked }); await dropRefresh(); } catch (err) { FD.err = err.message; }
  render();
});
dropRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
