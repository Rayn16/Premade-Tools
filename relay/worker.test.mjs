// The relay against stand-ins for D1 (Node's own SQLite) and R2 (memory): node relay/worker.test.mjs
import worker from './worker.js';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    const st = db.prepare(sql);
    let args = [];
    const q = { bind: (...a) => ((args = a), q), first: async () => st.get(...args) ?? null, run: async () => st.run(...args), all: async () => ({ results: st.all(...args) }) };
    return q;
  },
};
const objects = new Map(), uploads = new Map();
const FILES = {
  createMultipartUpload: async (key) => (uploads.set(key, new Map()), { uploadId: key }),
  resumeMultipartUpload: (key) => ({
    uploadPart: async (n, body) => (uploads.get(key).set(n, new Uint8Array(await new Response(body).arrayBuffer())), { etag: 'e' + n }),
    complete: async (parts) => {
      const size = parts.reduce((s, p) => s + uploads.get(key).get(p.partNumber).length, 0);
      objects.set(key, { size }), uploads.delete(key);
      return { size };
    },
    abort: async () => uploads.delete(key),
  }),
  get: async (key) => objects.get(key) ?? null,
  delete: async (key) => objects.delete(key),
};
const stored = () => [...objects.values()].reduce((s, o) => s + o.size, 0) + [...uploads.values()].reduce((s, m) => s + [...m.values()].reduce((t, b) => t + b.length, 0), 0);

const call = async (method, path, tok, body) => {
  const headers = tok ? { Authorization: 'Bearer ' + tok } : {};
  if (body instanceof Uint8Array) headers['Content-Length'] = String(body.length);
  else if (body) body = JSON.stringify(body);
  const r = await worker.fetch(new Request('https://relay' + path, { method, headers, body }), { DB, FILES });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const owner = (await call('POST', '/join', null, { name: 'Rayan' })).body;
const friend = (await call('POST', '/join', null, { name: 'Sam' })).body;
assert.equal((await call('POST', '/approve/' + friend.id, owner.token)).status, 200);

// Friends storage stops taking files at 9 GB, going by the size each send says it is. So a send must not store
// more than it said, nor say it's less than nothing.
let st = (await call('POST', '/send', friend.token, { to: owner.id, name: 'a.bin', size: 1 })).body;
await call('PUT', `/send/${st.id}/1`, friend.token, new Uint8Array(1 << 20));
await call('PUT', `/send/${st.id}/2`, friend.token, new Uint8Array(1 << 20));
assert.ok(stored() <= 1, `a send that said 1 byte stored ${stored()}`);
assert.equal((await call('POST', '/send', friend.token, { to: owner.id, name: 'b.bin', size: -5e9 })).status, 400, 'a send below zero bytes was taken');

// What the apps send still goes through: two parts, and an empty file in one empty part.
const size = (50 << 20) + 3, file = new Uint8Array(size);
st = (await call('POST', '/send', friend.token, { to: owner.id, name: 'clip.bin', size })).body;
const parts = [];
for (let n = 1, off = 0; off < size; n++, off += st.part) {
  const r = await call('PUT', `/send/${st.id}/${n}`, friend.token, file.subarray(off, off + st.part));
  assert.equal(r.status, 200, `part ${n}: ${JSON.stringify(r.body)}`);
  parts.push(r.body);
}
assert.equal((await call('POST', `/send/${st.id}/done`, friend.token, { parts })).status, 200);
const empty = (await call('POST', '/send', friend.token, { to: owner.id, name: 'empty.txt', size: 0 })).body;
const p = await call('PUT', `/send/${empty.id}/1`, friend.token, new Uint8Array(0));
assert.equal(p.status, 200, JSON.stringify(p.body));
assert.equal((await call('POST', `/send/${empty.id}/done`, friend.token, { parts: [p.body] })).status, 200);
const inbox = (await call('GET', '/inbox', owner.token)).body;
assert.deepEqual(inbox.map((i) => [i.name, i.size]).sort(), [['clip.bin', size], ['empty.txt', 0]]);
assert.equal(objects.get(st.id).size, size);
// Strangers can't fill the "Asking to join" list: 20 can wait, and an ask nobody answered goes after a week.
for (let i = 0; i < 20; i++) assert.equal((await call('POST', '/join', null, { name: 'Stranger ' + i })).status, 200);
assert.equal((await call('POST', '/join', null, { name: 'One more' })).status, 429, 'a 21st waiting ask was taken');
db.exec(`UPDATE people SET made = ${Date.now() - 8 * 864e5} WHERE approved = 0`);
assert.equal((await call('POST', '/join', null, { name: 'Next week' })).status, 200, 'old asks still fill the list');
assert.equal((await call('GET', '/people', owner.token)).body.waiting.length, 1);
console.log('relay ok');
