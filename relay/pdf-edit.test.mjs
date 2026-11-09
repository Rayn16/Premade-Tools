// The PDF editor's engine: node relay/pdf-edit.test.mjs
import { readText, editText, drawItems, logical } from '../pc/ui/m/lib/pdf-edit.mjs';
import { PDFDocument, PDFName, StandardFonts, degrees } from '../pc/ui/m/lib/pdf-lib.min.mjs';
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
// Arabic as PDFs keep it, shown left to right: word by word from the right in plain letters (LibreOffice), or letter
// by letter in joined shapes with a mark before its letter, raised (Chrome). Each line reads in typing order, and
// a changed one keeps its right edge.
{
  const d3 = await PDFDocument.create(), pg = d3.addPage([400, 300]), ctx = d3.context;
  // codes A-E: م ر ح ب ا, F: the one shape for لا, G: a fatha (no width), H: س
  const uni = { 41: '0645', 42: '0631', 43: '062D', 44: '0628', 45: '0627', 46: '06440627', 47: '064E', 48: '0633' };
  const cmap = `begincmap\n${Object.keys(uni).length} beginbfchar\n${Object.entries(uni).map(([c, u]) => `<${c}> <${u}>`).join('\n')}\nendbfchar\nendcmap`;
  const fd = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'BAAAAA+DejaVuSans', Flags: 4 }));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'BAAAAA+DejaVuSans', FirstChar: 65, LastChar: 72,
    Widths: [500, 500, 500, 500, 300, 600, 0, 600], FontDescriptor: fd, ToUnicode: ctx.register(ctx.stream(cmap)) }));
  pg.node.setFontDictionary(PDFName.of('F1'), font);
  // "مرحبا سلام": مرحبا on the right first, then سلام to its left (م لا س, as it shows); then "مَ" with its fatha first
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 20 Tf 1 0 0 1 300 250 Tm <4544434241> Tj 1 0 0 1 260 250 Tm <414648> Tj ET ' +
    'BT /F1 20 Tf 1 0 0 1 306 204 Tm <47> Tj 1 0 0 1 300 200 Tm <41> Tj ET')));
  const doc3 = await PDFDocument.load(await d3.save()), p3 = doc3.getPage(0), r3 = readText(doc3, p3);
  assert.deepEqual(r3.blocks.map((b) => [b.text, b.rtl]), [['مرحبا سلام', true], ['مَ', true]]);
  const b = r3.blocks[0], extra = editText(doc3, p3, r3, { 0: 'مرحبا بكم' });
  assert.ok(extra.length === 1 && Math.abs(extra[0].end - (b.x + b.w)) < 0.01, 'a changed Arabic line ends where it did');
  const o3 = await PDFDocument.load(await doc3.save());
  assert.deepEqual(readText(o3, o3.getPage(0)).blocks.map((x) => x.text), ['مَ'], 'the old line left the file');
  // Chrome's shapes, numbers and English inside Arabic, and Arabic inside English
  assert.equal(logical('ﻢﻟﺎﻌﻟﺎﺑ ﺎﺒﺣﺮﻣ'), 'مرحبا بالعالم');
  assert.equal(logical('لﺎﻳر 450 ﻎﻠﺒﻤﻟا'), 'المبلغ 450 ريال');
  assert.equal(logical('ﺪﻳﺪﺟ PDF 2.0 ﻒﻠﻣ'), 'ملف PDF 2.0 جديد');
  assert.equal(logical('Total 450 لاير'), 'Total 450 ريال');
  assert.equal(logical('Hello world'), 'Hello world');
}
// A value set off from its label, as a tab does, is a line of its own, so changing it leaves it where it was; words
// a space apart stay one line.
{
  const d5 = await PDFDocument.create(), f5 = await d5.embedFont(StandardFonts.Helvetica), pg = d5.addPage([400, 300]);
  const w = (s) => f5.widthOfTextAtSize(s, 12);
  pg.drawText('Amount due:', { x: 40, y: 250, size: 12, font: f5 });
  pg.drawText('450.00', { x: 40 + w('Amount due:') + 16, y: 250, size: 12, font: f5 });
  pg.drawText('Paid', { x: 40, y: 220, size: 12, font: f5 });
  pg.drawText('in full', { x: 40 + w('Paid') + 4, y: 220, size: 12, font: f5 });
  const doc5 = await PDFDocument.load(await d5.save()), r5 = readText(doc5, doc5.getPage(0));
  assert.deepEqual(r5.blocks.map((b) => b.text), ['Amount due:', '450.00', 'Paid in full']);
}
// A scan's text layer (letters that don't show): a changed line is covered and drawn, as the screen shows it, since
// the old words are in the picture. Text after the layer's q … Q shows again.
{
  const d6 = await PDFDocument.create(), pg = d6.addPage([400, 300]), ctx = d6.context;
  pg.node.setFontDictionary(PDFName.of('F1'), ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })));
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q BT 3 Tr /F1 20 Tf 1 0 0 1 40 250 Tm (Total: 450) Tj ET Q BT /F1 20 Tf 1 0 0 1 40 200 Tm (Shown) Tj ET')));
  const doc6 = await PDFDocument.load(await d6.save()), p6 = doc6.getPage(0), r6 = readText(doc6, p6);
  assert.deepEqual(r6.blocks.map((b) => [b.text, b.unseen]), [['Total: 450', true], ['Shown', false]]);
  assert.deepEqual(editText(doc6, p6, r6, { 0: 'Total: 540' }).map((x) => x.type), ['white', 'text']);
}
// A letter the line's font doesn't have is never written as a code the font's own map says is another letter.
{
  const d4 = await PDFDocument.create(), pg = d4.addPage([400, 300]), ctx = d4.context;
  const cmap = 'begincmap\n3 beginbfchar\n<41> <0042>\n<42> <0041>\n<43> <005A>\nendbfchar\nendcmap'; // A shows B, B shows A, C shows Z
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial', FirstChar: 65, LastChar: 67, Widths: [600, 600, 600],
    FontDescriptor: ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'Arial', Flags: 32 })), ToUnicode: ctx.register(ctx.stream(cmap)) }));
  pg.node.setFontDictionary(PDFName.of('F1'), font);
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 20 Tf 1 0 0 1 50 250 Tm <414243> Tj ET')));
  const doc4 = await PDFDocument.load(await d4.save()), p4 = doc4.getPage(0), r4 = readText(doc4, p4);
  assert.equal(r4.blocks[0].text, 'BAZ');
  assert.deepEqual(editText(doc4, p4, r4, { 0: 'CAB' }).map((x) => x.text), ['CAB'], 'C would have come out as Z');
}
// A changed line on a turned page, drawn again because its font lacks a letter, is saved turned, where it was.
{
  const d7 = await PDFDocument.create(), pg = d7.addPage([300, 400]), ctx = d7.context;
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial', FirstChar: 65, LastChar: 67, Widths: [600, 600, 600],
    FontDescriptor: ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'Arial', Flags: 32 })) }));
  pg.node.setFontDictionary(PDFName.of('F1'), font);
  pg.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 20 Tf 1 0 0 1 40 340 Tm (ABC) Tj ET')));
  pg.setRotation(degrees(90));
  const doc7 = await PDFDocument.load(await d7.save()), p7 = doc7.getPage(0), r7 = readText(doc7, p7), b = r7.blocks[0];
  assert.ok(Math.round(b.angle) === 90 && Math.abs(b.len - b.h) < 0.01, 'the line runs down the screen');
  const extra = editText(doc7, p7, r7, { 0: 'ABD' });
  assert.equal(extra.length, 1, 'D is drawn again');
  await drawItems(doc7, p7, extra, {});
  const o7 = await PDFDocument.load(await doc7.save()), t7 = readText(o7, o7.getPage(0)).blocks;
  assert.deepEqual(t7.map((x) => x.text), ['ABD']);
  assert.ok(Math.round(t7[0].angle) === 90 && Math.hypot(t7[0].ox - b.ox, t7[0].oy - b.oy) < 0.5, 'saved turned, where it was');
}
console.log('pdf-edit ok');
