// File drop on the phone: send photos, files, links and text to the PC or your other phone, pick up what they
// sent here, and the shared clipboard. The box and rows are /m/drop-core.js.
'use strict';

const DROPAPI = {
  base: PCURL + '/api/phone/drop',
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  after: () => {},
  url: (it, n, dl) => `${PCURL}/api/phone/drop/file/${it.id}/${n}?t=${encodeURIComponent(TOKEN)}${dl ? '&dl=1' : ''}`,
  acts: (it) => {
    if (it.to !== DROPST?.me) return '';
    const copy = `<button type="button" class="btn small" data-dropm="copy" data-id="${it.id}">${icon(FD.copied === it.id ? 'check' : 'copy')}${FD.copied === it.id ? 'Copied' : 'Copy'}</button>`;
    if (it.kind === 'text') return copy;
    if (it.kind === 'link') return `<a class="btn small" href="${esc(it.text)}" target="_blank" rel="noopener" data-dropm="seen" data-id="${it.id}">${icon('link')}Open</a>${copy}`;
    if (NATIVE?.saveDrop) return `<button type="button" class="btn small" data-dropm="save" data-id="${it.id}">${icon('save')}${it.fetched ? 'Save again' : 'Save'}</button>`;
    return it.files.map((f, n) => `<a class="btn small" href="${DROPAPI.url(it, n, !IOS)}" target="_blank" data-dropm="seen" data-id="${it.id}">${icon('save')}${it.files.length > 1 ? esc(ext(f.name) || 'File') + ' ' + (n + 1) : 'Save'}</a>`).join('');
  },
};
const SHORTCUT_DROP = 'Drop to PC';

function dropToolsView(off) {
  const title = dlTitle('File drop', 'Send photos, files, links and text to your PC or other phone.');
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem('ptdrop')); } catch (e) {}
  if ((OFFLINE || !DROPST) && kept && frKey()) DROPST = { ...kept, jobs: [], clip: null, clipSync: false, local: true }; // sent through the relay, picked up by the PC later
  else if (OFFLINE || !DROPST) return title + `<div class="feed scroller">${off}<p class="mhint">${icon('info')}<span>Drops go through your PC, so it needs to be on and reachable${IOS ? ' (at home, or anywhere with Tailscale)' : ''}. To send while it's off, join Friends on the PC once.</span></p></div>`;
  else { try { localStorage.setItem('ptdrop', JSON.stringify({ me: DROPST.me, devices: DROPST.devices })); } catch (e) {} }
  const fresh = dropJobs().filter((j) => j.to === DROPST.me && !j.fetched);
  const note = IOS ? 'Tap Copy to put it on this iPhone. To send this iPhone\'s clipboard, run the Drop to PC Shortcut.' : NATIVE?.dropClip ? 'It syncs by itself while Premade is open.' : 'Update the app to sync it by itself.';
  return `${title}<div class="feed scroller">${off}
    ${FD.err ? `<div class="notebox">${icon('alert')}<div>${esc(FD.err)}</div></div>` : ''}
    ${FD.sent ? `<div class="notebox is-info">${icon('check')}<div>${esc(FD.sent)}</div></div>` : ''}
    ${fresh.length ? `<section class="sec"><h2 class="group-label">New for this phone</h2><div class="rows hrows">${fresh.map(dropRow).join('')}</div></section>` : ''}
    ${DROPST.local ? '' : dropClipCard(note)}
    <div class="dlbox cvbox" style="margin-top:14px">${dropBox()}
      <div class="route"><i class="dotlight"></i><span>${DROPST.local ? 'Your PC is off, so this goes through the internet and waits there (up to 7 days) until the PC picks it up.' : IOS ? `From any app: <b>Share</b> › <b>${SHORTCUT_DROP}</b> (Settings tab shows how).` : 'From any app: <b>Share</b> › <b>Send with Premade</b>.'}</span></div></div>
  </div>`;
}

function dropHistoryView(off) {
  return `${dlTitle('History', 'The last 7 days of drops to and from this phone.')}
    <div class="feed scroller">${off}${dropList(dropJobs(), 'Send something from the Drop tab, or share to Premade from any app.')}</div>`;
}

// iPhone: Home Screen apps can't be a Share target, so a Shortcut is.
function dropShortcutGuide() {
  const base = PCLINK, t = encodeURIComponent(TOKEN);
  const field = (label, v) => `<div class="copyfield"><span>${label}</span><input readonly value="${esc(v)}"><button type="button" class="btn" data-copy>Copy</button></div>`;
  const others = dropTargets().filter((d) => d.id !== 'pc');
  return `<section class="group"><div class="sectionhead"><b>Share button</b><i></i></div>
    <details class="iosguide"><summary>Set up "${SHORTCUT_DROP}"</summary><ol>
      <li>Open <b>Shortcuts</b>, tap <b>+</b> and name it <b>${SHORTCUT_DROP}</b>. Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under <b>Receive</b>, keep <b>Any</b>, and set <b>If there's no input</b> to <b>Get Clipboard</b> (so running it on its own sends what you copied).</li>
      <li>Add <b>Repeat with Each</b> item in <b>Shortcut Input</b>. Inside it: <b>Get Name</b> of <b>Repeat Item</b>.</li>
      <li>Still inside: <b>Get Contents of URL</b> with the address below, with <b>Name</b> put where it says NAME. Method <b>POST</b>, Request Body <b>File</b>, pick <b>Repeat Item</b>.${field('Send', `${base}/api/phone/drop/ios?t=${t}&to=pc&name=NAME`)}${others.length ? `<span class="row-hint">To send to ${esc(others.map((d) => d.name).join(' or '))} instead, change <b>to=pc</b> to ${others.map((d) => `<b>to=${esc(d.id)}</b>`).join(' or ')}.</span>` : ''}</li>
      <li>After the Repeat: <b>Show Notification</b> with <b>Contents of URL</b> (it says “OK: Sent to PC.” or what went wrong).</li>
      <li>Try it: in Photos tap <b>Share</b> › <b>${SHORTCUT_DROP}</b>. Allow access to devices on your network when asked. Put it on your Home Screen or Action Button too, to send your clipboard in one tap.</li>
    </ol></details></section>`;
}

function dropSettingsView(off) {
  return `${dlTitle('Settings', 'Sending, picking up, and the clipboard.')}<div class="headrule"></div>
    <div class="feed scroller">${off}${IOS ? dropShortcutGuide() : ''}
    <section class="group"><div class="sectionhead"><b>On this phone</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Picking up</h2><p class="block-hint">${IOS ? 'Open File drop to see what was sent here. Save opens it in Safari; tap Share › Save Image or Save to Files.' : 'A notification says when something arrives (checked every 15 minutes, and at once while Premade is open). Files save into Pictures, Movies, Music or Downloads › Premade.'}</p></div>
      <div class="block"><h2 class="block-title">Sync the clipboard</h2><div class="chips"><button type="button" class="pill" data-dropm="clip" data-on="1" aria-pressed="${!!DROPST?.clipSync}">${DROPST?.clipSync ? icon('check') : ''}On</button><button type="button" class="pill" data-dropm="clip" data-on="" aria-pressed="${!DROPST?.clipSync}">${!DROPST?.clipSync ? icon('check') : ''}Off</button></div>
        <p class="block-hint">${IOS ? 'iPhones only let apps touch the clipboard when you tap, so the PC\'s copy waits in File drop with a Copy button, and the Shortcut sends yours.' : 'What you copy on the PC lands on this phone, and what you copy here reaches the PC while Premade is open (Android hides the clipboard from apps in the background).'}</p></div>
    </div></section>
    <section class="group"><div class="sectionhead"><b>On the PC</b><i></i></div><div class="panel">
      <div class="block"><h2 class="block-title">Drop folder</h2><p class="vaultpath-m">${esc(DROPST?.dir || '')}</p><p class="block-hint">Files sent to the PC land here. Text goes onto its clipboard. Change the folder on the PC in Settings.</p></div>
    </div></section>
    <div class="appfoot">${crest}<span>Premade Tools ${esc(ST?.version || '')}</span></div></div>`;
}

$app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-dropm]');
  if (!b) return;
  const a = b.dataset.dropm, id = b.dataset.id, it = dropJobs().find((j) => j.id === id);
  try {
    if (a === 'copy') { trCopy(it.text); dropCopied(id); api('/api/phone/drop/fetched/' + id, {}).catch(() => {}); }
    else if (a === 'seen') api('/api/phone/drop/fetched/' + id, {}).then(dropRefresh).then(render).catch(() => {}); // the link still opens
    else if (a === 'save') { NATIVE.saveDrop(id); b.disabled = true; }
    else if (a === 'clip') { await api('/api/phone/settings', { clipSync: !!b.dataset.on }); await dropRefresh(); render(); }
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
  if (now !== dropLast && S.tool === 'drop' && !['droptext'].includes(document.activeElement?.id)) render();
  dropLast = now;
}
setInterval(dropTick, 3000);
dropRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
