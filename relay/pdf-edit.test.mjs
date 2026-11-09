// The PDF editor's engine: node relay/pdf-edit.test.mjs
import { readText, editText, drawItems } from '../pc/ui/m/lib/pdf-edit.mjs';
import { PDFDocument, StandardFonts, degrees } from '../pc/ui/m/lib/pdf-lib.min.mjs';
import assert from 'node:assert';
const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
const a = d.addPage([400, 300]);
a.drawText('Hello world', { x: 50, y: 250, size: 20, font: f });
a.drawText('Total: 450', { x: 50, y: 200, size: 12, font: f });
d.addPage([400, 300]).setRotation(degrees(90));
const doc = await PDFDocument.load(await d.save()), p = doc.getPage(0);
const r = readText(doc, p);
assert.deepEqual(r.blocks.map((b) => b.text), ['Hello world', 'Total: 450']);
assert.equal(Math.round(r.blocks[0].y), 34); // 300 - 250 - 0.8 × 20, from the top
const extra = editText(doc, p, r, { 0: 'Hello there', 1: 'Total: 540 ✓' }); // ✓ isn't in Helvetica: it comes back to be drawn
assert.deepEqual(extra.map((x) => x.text), ['Total: 540 ✓']);
await drawItems(doc, p, [{ type: 'box', x: 10, y: 10, w: 50, h: 20, color: '#d0222d' }], {});
await drawItems(doc, doc.getPage(1), [{ type: 'text', text: 'On a turned page', x: 10, y: 10, size: 12, color: '#111111' }], {});
const out = await PDFDocument.load(await doc.save());
assert.deepEqual(readText(out, out.getPage(0)).blocks.map((b) => b.text), ['Hello there']);
const t = readText(out, out.getPage(1)).blocks[0];
assert.equal(t.text, 'On a turned page');
assert.ok(Math.abs(t.angle) < 1 && t.x > 9 && t.x < 11, 'added text reads upright where it was put'); // the page is turned, the text isn't
console.log('pdf-edit ok');
