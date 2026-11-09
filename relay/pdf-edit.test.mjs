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
// White-out takes the letters under it out of the file, and the rest of the line stays where it was.
{
  const d2 = await PDFDocument.create(), f2 = await d2.embedFont(StandardFonts.Helvetica), pg = d2.addPage([400, 300]);
  pg.drawText('IBAN: DE89 3704 0044', { x: 50, y: 250, size: 12, font: f2 });
  pg.drawText('Name: Rayan', { x: 50, y: 220, size: 12, font: f2 });
  const doc2 = await PDFDocument.load(await d2.save()), p2 = doc2.getPage(0), r2 = readText(doc2, p2), b = r2.blocks[0];
  const x0 = 50 + f2.widthOfTextAtSize('IBAN: ', 12);
  editText(doc2, p2, r2, {}, [{ type: 'white', x: x0 - 1, y: b.y - 2, w: 200, h: b.h + 4 }]);
  const o2 = await PDFDocument.load(await doc2.save()), t2 = readText(o2, o2.getPage(0)).blocks;
  assert.deepEqual(t2.map((x) => x.text), ['IBAN:', 'Name: Rayan']);
  assert.ok(Math.abs(t2[0].x - b.x) < 0.01 && Math.abs(t2[1].y - r2.blocks[1].y) < 0.01, 'what is left stays where it was');
}
console.log('pdf-edit ok');
