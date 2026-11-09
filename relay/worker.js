// Premade Tools' Friends relay: who has the app, and files waiting for them.
// D1 keeps people and the list of waiting files; R2 keeps the files themselves.
// Every call but /join needs "Authorization: Bearer <token>". The phone-only page (public/, made by build.sh) is
// served as static files before any of this runs.

const DAY = 864e5;
const KEEP = 7 * DAY;      // files wait a week, then the daily clean-up deletes them
const MAX = 1 << 30;       // 1 GB per file
const CAP = 9 * (1 << 30); // R2 is free up to 10 GB; stop taking files well before that
const PART = 50 << 20;     // uploads come in 50 MB parts (the free plan takes 100 MB per request)
const ONLINE = 3 * 60e3;   // seen in the last 3 minutes = online

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' };
const rid = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

function cleanDevices(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((d) => ({ id: clean(d.id, 40), name: clean(d.name, 40), kind: clean(d.kind, 10) })).filter((d) => d.id && d.name);
}

const view = (p, now) => ({ id: p.id, name: p.name, devices: JSON.parse(p.devices), online: now - p.seen < ONLINE, seen: p.seen });

// Android pop-ups through Firebase Cloud Messaging (free). The FIREBASE_SERVICE_ACCOUNT secret is the service account
// JSON from the Firebase console; a signed token from it buys an access token that lasts an hour.
let fcmAuth = { tok: '', until: 0 };
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function fcmToken(sa) {
  if (fcmAuth.until > Date.now()) return fcmAuth.tok;
  const now = Math.floor(Date.now() / 1000), enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const msg = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const jwt = msg + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(msg)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  const t = await r.json();
  if (!t.access_token) throw new Error('Firebase sign-in failed');
  fcmAuth = { tok: t.access_token, until: Date.now() + (t.expires_in - 120) * 1000 };
  return fcmAuth.tok;
}

async function used(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM items').first();
  return r.b;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url), path = url.pathname, now = Date.now();
    // A PC's link: /pc/<its id>/… goes to that PC's Link, which passes phone calls along to it (see Link below).
    const pc = path.match(/^\/pc\/([0-9a-f]{32})\/(link|phones|body\/\d+|api\/phone\/.*)$/);
    if (pc) return env.LINK.get(env.LINK.idFromName(pc[1])).fetch(req);
    // A phone asks where its PC is, by a hash of its own key, so it never needs pairing again when addresses change.
    const find = path.match(/^\/find\/([0-9a-f]{64})$/);
    if (find) {
      const r = await env.DB.prepare('SELECT pc FROM phones WHERE h = ?').bind(find[1]).first();
      return r ? json({ link: `${url.origin}/pc/${r.pc}` }) : fail('not found', 404);
    }

    // Anyone with the app can ask to join. The very first person becomes the one who approves everyone else. So that
    // strangers can't fill the list, at most 20 wait at once, and an ask nobody answered goes after a week.
    if (req.method === 'POST' && path === '/join') {
      const b = await req.json().catch(() => ({}));
      const name = clean(b.name, 40);
      if (!name) return fail('Type your name.');
      await env.DB.prepare('DELETE FROM people WHERE approved = 0 AND made < ?').bind(now - 7 * 864e5).run();
      if ((await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE approved = 0').first()).n >= 20) return fail('Too many people are asking to join right now. Try again in a few days.', 429);
      const tok = rid(32), id = rid(8);
      const first = !(await env.DB.prepare('SELECT 1 FROM people LIMIT 1').first());
      await env.DB.prepare('INSERT INTO people (id, name, tok, approved, admin, devices, seen, made) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, name, await hash(tok), first ? 1 : 0, first ? 1 : 0, JSON.stringify(cleanDevices(b.devices)), now, now).run();
      return json({ id, token: tok, approved: first, admin: first });
    }

    const tok = (req.headers.get('Authorization') || '').replace(/^Bearer /, '') || url.searchParams.get('t') || '';
    const me = tok && await env.DB.prepare('SELECT * FROM people WHERE tok = ?').bind(await hash(tok)).first();
    if (!me) return fail('Not joined, or removed.', 401);

    // Check in: the PC sends its name and devices (itself plus its phones) about once a minute.
    if (req.method === 'PUT' && path === '/me') {
      const b = await req.json().catch(() => ({}));
      const name = clean(b.name, 40) || me.name;
      const devices = b.devices ? JSON.stringify(cleanDevices(b.devices)) : me.devices;
      await env.DB.prepare('UPDATE people SET name = ?, devices = ?, seen = ? WHERE id = ?').bind(name, devices, now, me.id).run();
      return json({ id: me.id, name, approved: !!me.approved, admin: !!me.admin });
    }
    if (!me.approved) return json({ id: me.id, name: me.name, approved: false, admin: false, people: [], waiting: [] }, path === '/people' ? 200 : 403);

    // A PC asking for a pop-up on one of its Android phones: { token, title, body }. 410 = that phone's token is dead.
    if (req.method === 'POST' && path === '/push') {
      if (!env.FIREBASE_SERVICE_ACCOUNT) return fail('Push is not set up on the relay yet.', 501);
      const b = await req.json().catch(() => ({})), sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + await fcmToken(sa), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: clean(b.token, 4096), android: { priority: 'high' }, data: { title: clean(b.title, 200), body: clean(b.body, 500), tool: 'drop' } } }),
      });
      if (r.status === 404 || r.status === 400) return fail('That phone is no longer registered.', 410);
      return r.ok ? json('ok') : fail('Firebase said ' + r.status, 502);
    }

    if (req.method === 'GET' && path === '/people') {
      const { results } = await env.DB.prepare('SELECT * FROM people ORDER BY name').all();
      return json({
        id: me.id, name: me.name, approved: true, admin: !!me.admin, used: await used(env), cap: CAP, max: MAX,
        people: results.filter((p) => p.approved && p.id !== me.id).map((p) => view(p, now)),
        waiting: me.admin ? results.filter((p) => !p.approved).map((p) => ({ id: p.id, name: p.name, asked: p.made })) : [],
      });
    }
    let m;
    if (req.method === 'POST' && (m = path.match(/^\/(approve|remove)\/(\w+)$/))) {
      if (!me.admin) return fail('Only the owner can do that.', 403);
      if (m[2] === me.id) return fail("You can't remove yourself.");
      if (m[1] === 'approve') await env.DB.prepare('UPDATE people SET approved = 1 WHERE id = ?').bind(m[2]).run();
      else await env.DB.prepare('DELETE FROM people WHERE id = ?').bind(m[2]).run();
      return json('ok');
    }

    // Sending: start, then PUT each 50 MB part, then done. Only then does the friend see it.
    if (req.method === 'POST' && path === '/send') {
      const b = await req.json().catch(() => ({}));
      const name = clean(b.name, 200).replace(/[\\/]/g, '_'), size = Number(b.size ?? 0), dev = clean(b.dev, 40) || 'all';
      const to = await env.DB.prepare('SELECT id FROM people WHERE id = ? AND approved = 1').bind(clean(b.to, 40)).first();
      if (!to) return fail("That person isn't here any more.");
      if (!name) return fail('The file has no name.');
      if (!Number.isSafeInteger(size) || size < 0) return fail('The file has no size.');
      if (size > MAX) return fail('That file is over 1 GB, the most one send can be.');
      if ((await used(env)) + size > CAP) return fail('Friends storage is full right now. Files free up when friends pick them up, or after 7 days.', 507);
      const id = rid(12);
      const up = await env.FILES.createMultipartUpload(id);
      await env.DB.prepare('INSERT INTO items (id, src, dst, dev, name, size, up, made) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, me.id, to.id, dev, name, size, up.uploadId, now).run();
      return json({ id, part: PART });
    }
    if ((m = path.match(/^\/send\/(\w+)(?:\/(\d+)|\/(done))$/))) {
      const it = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND src = ? AND ready = 0').bind(m[1], me.id).first();
      if (!it) return fail('That send is gone.', 404);
      const up = env.FILES.resumeMultipartUpload(it.id, it.up);
      if (req.method === 'PUT' && m[2]) {
        // The storage limit goes by the size the send said, so no part may hold more than its share of that.
        const n = Number(m[2]), room = Math.min(PART, it.size - (n - 1) * PART);
        if (n < 1 || !(Number(req.headers.get('content-length') ?? NaN) <= room)) return fail('That part is bigger than the file.');
        const part = await up.uploadPart(n, req.body);
        return json({ n, etag: part.etag });
      }
      if (req.method === 'POST' && m[3]) {
        const b = await req.json().catch(() => ({}));
        await up.complete((b.parts || []).map((p) => ({ partNumber: p.n, etag: p.etag })));
        await env.DB.prepare('UPDATE items SET ready = 1, up = NULL, made = ? WHERE id = ?').bind(now, it.id).run();
        return json('ok');
      }
    }

    // Receiving: what's waiting for me, the file itself, then delete once it's safe on my device.
    if (req.method === 'GET' && path === '/inbox') {
      const { results } = await env.DB.prepare('SELECT i.id, i.dev, i.name, i.size, i.made, i.src, p.name AS fromName FROM items i LEFT JOIN people p ON p.id = i.src WHERE i.dst = ? AND i.ready = 1 ORDER BY i.made').bind(me.id).all();
      return json(results.map((r) => ({ id: r.id, dev: r.dev, name: r.name, size: r.size, at: r.made, from: r.src, fromName: r.fromName || 'Someone' })));
    }
    if ((m = path.match(/^\/file\/(\w+)$/))) {
      const it = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND (dst = ? OR src = ?)').bind(m[1], me.id, me.id).first();
      if (!it) return fail('That file is gone.', 404);
      if (req.method === 'DELETE') {
        await env.FILES.delete(it.id);
        await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(it.id).run();
        return json('ok');
      }
      if (req.method === 'GET' && it.dst === me.id) {
        const o = await env.FILES.get(it.id);
        if (!o) return fail('That file is gone.', 404);
        return new Response(o.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(it.name)}`, ...CORS } });
      }
    }
    return fail('not found', 404);
  },

  // Once a day: delete files older than a week, and sends that never finished.
  async scheduled(ev, env) {
    const now = Date.now();
    const { results } = await env.DB.prepare('SELECT id, up FROM items WHERE (ready = 1 AND made < ?) OR (ready = 0 AND made < ?)').bind(now - KEEP, now - DAY).all();
    for (const it of results) {
      if (it.up) await env.FILES.resumeMultipartUpload(it.id, it.up).abort().catch(() => {});
      else await env.FILES.delete(it.id);
      await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(it.id).run();
    }
  },
};

// Link lets phones use a PC with no Tailscale and no setup, at home or away. The PC keeps a WebSocket open here;
// each phone call becomes a "req" message, the PC pulls the phone's upload from /body/<n>, and sends the answer back
// as "res", binary pieces (4-byte call number first) and "end". Calls only reach /api/phone/*, which still needs a
// phone's key, so the relay only ever passes along what a paired phone could send anyway.
// The socket uses hibernation, so an idle link costs nothing; "ping" is answered without waking it.
// ponytail: the free plan takes 100 MB per request, so the phone app sends bigger files in 50 MB pieces
// (PUT /api/phone/piece); a Shortcut can't, so the backup Shortcut uses the home address.
const NOBODY = [101, 204, 205, 304];
const SAY = { 502: "Your PC couldn't answer.", 503: "Can't reach your PC.", 504: "Your PC didn't answer." };
// The relay's own answers. A Shortcut (an /ios/ call) reads only the words, so for it they start with ERR, and with
// ERR OFF when the PC isn't linked: the Downloader then downloads on the iPhone instead.
const said = (s, ios) => new Response((ios ? (s === 503 ? 'ERR OFF: ' : 'ERR: ') : '') + SAY[s], { status: s, headers: s === 503 ? { 'X-Premade-Link': 'off' } : {} });
export class Link {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.calls = new Map(); // call number → { done, body, w }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const path = new URL(req.url).pathname.split('/').slice(3).join('/'), url = new URL(req.url);
    if (path === 'link' || path === 'phones' || path.startsWith('body/')) { // the PC, with its key; the first key a PC links with is kept
      const key = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
      const want = await this.ctx.storage.get('key'), got = key && await hash(key);
      if (!got || (want && want !== got)) return fail('wrong key', 401);
      if (!want) await this.ctx.storage.put('key', got);
      if (path === 'link') {
        if (req.headers.get('Upgrade') !== 'websocket') return fail('websocket only', 426);
        for (const old of this.ctx.getWebSockets()) old.close(1000, 'replaced');
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (path === 'phones') { // the PC's paired phones, as hashes of their keys
        const id = url.pathname.split('/')[2], hs = ((await req.json().catch(() => ({}))).h || []).filter((h) => /^[0-9a-f]{64}$/.test(h)).slice(0, 50);
        await this.env.DB.batch([this.env.DB.prepare('DELETE FROM phones WHERE pc = ?').bind(id),
          ...hs.map((h) => this.env.DB.prepare('INSERT OR REPLACE INTO phones (h, pc, seen) VALUES (?, ?, ?)').bind(h, id, Date.now()))]);
        return json('ok');
      }
      const c = this.calls.get(Number(path.slice(5)));
      const body = c?.body;
      if (!body) return fail('gone', 404);
      c.body = null;
      clearTimeout(c.slow); // the PC has started on it: a big upload takes as long as it takes
      return new Response(body);
    }
    const ws = this.ctx.getWebSockets()[0], ios = url.pathname.includes('/ios/');
    if (!ws) return said(503, ios);
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    const h = {};
    for (const [k, v] of req.headers) if (!/^(cf-|x-forwarded|x-real-ip|host$|connection$|accept-encoding$)/i.test(k)) h[k] = v;
    const res = new Promise((done) => this.calls.set(n, { done, body: req.body, m: req.method }));
    ws.send(JSON.stringify({ t: 'req', n, m: req.method, p: url.pathname.replace(/^\/pc\/\w+/, '') + url.search, h, b: !!req.body }));
    const slow = this.calls.get(n).slow = setTimeout(() => this.finish(n, 504), 60e3);
    const r = await res;
    clearTimeout(slow);
    return typeof r === 'number' ? said(r, ios) : r;
  }

  finish(n, r) {
    const c = this.calls.get(n);
    if (c?.done) { c.done(r); c.done = null; }
    if (!c?.w) this.calls.delete(n);
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') { // a piece of an answer; the ack tells the PC the phone took it, so it sends more
      const n = new DataView(msg).getUint32(0), c = this.calls.get(n);
      if (!c?.w) return;
      try { await c.w.write(new Uint8Array(msg, 4)); ws.send(JSON.stringify({ t: 'ack', n })); } catch (e) { this.calls.delete(n); ws.send(JSON.stringify({ t: 'stop', n })); }
      return;
    }
    const m = JSON.parse(msg), c = this.calls.get(m.n);
    if (!c) return;
    if (m.t === 'res') {
      if (NOBODY.includes(m.s)) return this.finish(m.n, new Response(null, { status: m.s, headers: m.h }));
      const len = Number(m.h['content-length'] ?? m.h['Content-Length']);
      const { readable, writable } = len >= 0 && c.m !== 'HEAD' ? new FixedLengthStream(len) : new TransformStream(); // a known length lets videos seek
      c.w = writable.getWriter();
      this.finish(m.n, new Response(readable, { status: m.s, headers: m.h }));
    } else if (m.t === 'end' || m.t === 'err') {
      if (c.w) (m.t === 'end' ? c.w.close() : c.w.abort()).catch(() => {});
      else this.finish(m.n, 502);
      this.calls.delete(m.n);
    }
  }

  webSocketClose() { this.dropAll(); }
  webSocketError() { this.dropAll(); }
  dropAll() {
    for (const [n, c] of this.calls) {
      if (c.w) c.w.abort().catch(() => {});
      else this.finish(n, 503);
    }
    this.calls.clear();
  }
}
