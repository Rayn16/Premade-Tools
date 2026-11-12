// Friends in the PC window. app.js draws the frame and calls frView(); /m/friends-core.js does the rest.
'use strict';

const FRAPI = {
  base: '/api/ui/friends',
  hdr: { 'X-Vault': '1' },
  touch: false,
  sheet: (label, body) => `<div class="backdrop" data-frclose><section class="sheet" role="dialog" aria-modal="true" aria-label="${label}">
    <div class="sheet-head"><div><h2 class="sheet-title">${label}</h2></div><button type="button" class="iconbtn" data-fr="close" aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body frsheet">${body}</div></section></div>`,
};

const frView = () => `<section class="main">${head('Friends')}<div class="body scroller"><div class="col">${frPage()}</div></div></section>`;

frRefresh().then(() => { if (ST) render(); }); // app.js's first refresh ran before this file loaded
