// Friends on the phone: everyone who has Premade Tools, and the Share sheet. It all goes through your PC, which
// is home base. The page and sheet are /m/friends-core.js.
'use strict';

const FRAPI = {
  get base() { return PCURL + '/api/phone/friends'; }, // PCURL can change (home, Tailscale, the relay link), so read it each time
  hdr: { Authorization: 'Bearer ' + TOKEN },
  touch: true,
  sheet: (label, body) => `<div class="msheet" data-frclose><div class="msheet-card" role="dialog" aria-modal="true" aria-label="${label}"><div class="grab"><span></span></div>
    <div class="msheet-body scroller frsheet"><h2 class="sheet-title">${label}</h2>${body}</div>
    <div class="msheet-acts"><button type="button" class="btn block" data-fr="close">Cancel</button></div></div></div>`,
};

const frToolsView = () => OFFLINE ? `<p class="tip">Friends goes through your PC, so it needs to be on and reachable.</p>` : frPage();

setInterval(async () => {
  if (document.hidden || !TOKEN || (S.page !== 'friends' && !FRST?.sends?.some((s) => s.state === 'running'))) return;
  const was = JSON.stringify(FRST);
  await frRefresh();
  if (JSON.stringify(FRST) !== was && !['frname', 'frmyname'].includes(document.activeElement?.id) && !FR.share) render();
}, 5000);
frRefresh().then(() => { if (ST) render(); }); // m.js's first refresh ran before this file loaded
