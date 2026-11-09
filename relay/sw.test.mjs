// The phone app's offline copy (pc/ui/m/sw.js): node relay/sw.test.mjs
import fs from 'node:fs';
import assert from 'node:assert';
const on = {}, kept = new Map(), base = 'https://relay.example';
const cache = { put: async (r, res) => { kept.set(r.url, await res.text()); }, addAll: async () => {} };
globalThis.self = { addEventListener: (t, f) => { on[t] = f; } };
globalThis.location = new URL(base + '/m/sw.js');
globalThis.caches = { open: async () => cache, match: async (r) => { const t = kept.get(typeof r === 'string' ? base + r : r.url); return t && new Response(t); } };
new Function(fs.readFileSync(new URL('../pc/ui/m/sw.js', import.meta.url), 'utf8'))();
let waits = [];
const get = (path, net) => {
  globalThis.fetch = net;
  waits = [];
  return new Promise((ok) => on.fetch({ request: { url: base + path, method: 'GET' }, waitUntil: (p) => waits.push(p), respondWith: (p) => p.then((r) => r.text()).then(ok) }));
};
const never = () => new Promise(() => {});
assert.equal(await get('/m/m.js', async () => new Response('new')), 'new', 'the relay answers');
await Promise.all(waits);
assert.equal(kept.get(base + '/m/m.js'), 'new', 'and that copy is kept');
assert.equal(await get('/m/m.js', async () => { throw new TypeError('offline'); }), 'new', 'no signal: the kept copy');
let t = Date.now();
assert.equal(await Promise.race([get('/m/m.js', never), new Promise((ok) => setTimeout(ok, 3500, 'stuck'))]), 'new', 'a weak signal: the kept copy');
assert.ok(Date.now() - t < 3400, 'within 3 s');
t = Date.now();
assert.equal(await get('/m/new.js', () => new Promise((ok) => setTimeout(() => ok(new Response('late')), 3200))), 'late', 'nothing kept: it waits for the relay');
console.log('sw ok');
