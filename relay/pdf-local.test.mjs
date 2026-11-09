import { run, openPdf } from '../pc/ui/m/lib/pdf-local.mjs';
import { PDFDocument } from '../pc/ui/m/lib/pdf-lib.min.mjs';
import assert from 'node:assert';
const mk = async (n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([200 + i, 300]); return { name: `f${n}.pdf`, bytes: await d.save() }; };
const pages = async (b, pw) => (await PDFDocument.load(b, pw ? { password: pw } : {})).getPages();
const a = await mk(3), b = await mk(2);
let r = await run('merge', [a, b]); assert.equal((await pages(r[0].bytes)).length, 5);
r = await run('pages', [a], { pages: '3,1r90' }); let p = await pages(r[0].bytes); assert.equal(p.length, 2); assert.equal(p[0].getWidth(), 202); assert.equal(p[1].getRotation().angle, 90);
r = await run('extract', [a], { pages: '2' }); assert.equal((await pages(r[0].bytes)).length, 1);
r = await run('split', [a]); assert.equal(r.length, 3); assert.equal(r[2].name, 'f3 - page 3.pdf');
r = await run('lock', [a], { pw: 'secret' }); const locked = { name: 'l.pdf', bytes: r[0].bytes };
await assert.rejects(run('unlock', [locked], { pw: 'wrong' }));
r = await run("unlock", [locked], { pw: "secret" }); assert.equal((await pages(r[0].bytes)).length, 3);
await assert.rejects(run('lock', [locked], { pw: 'x' }));
// A PDF that opens without a password but carries restrictions (a bank statement): every tool takes it, and what
// the editor saves from it opens again.
const rd = await PDFDocument.create(); rd.addPage([210, 300]); rd.addPage([220, 300]);
rd.encrypt({ userPassword: '', ownerPassword: "the bank's", permissions: { modifying: false, copying: false } });
const restricted = { name: 'r.pdf', bytes: await rd.save() };
r = await run('merge', [a, restricted]); assert.equal((await pages(r[0].bytes)).length, 5);
r = await run('split', [restricted]); assert.equal(r.length, 2);
r = await run('lock', [restricted], { pw: 'mine' }); assert.equal((await pages(r[0].bytes, 'mine')).length, 2);
const ed = await openPdf(restricted.bytes); ed.getPage(0).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
assert.equal((await pages(await ed.save())).length, 2);
await assert.rejects(openPdf(locked.bytes), /password/i); // a real password still has to be removed first
console.log('pdf-local ok');
