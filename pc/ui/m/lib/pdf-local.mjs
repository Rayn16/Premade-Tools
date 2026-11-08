// The PDF tools done on the phone, when the PC can't be reached. Same choices as the PC's (pc/pdf.go):
// inputs are [{ name, bytes }], the result is [{ name, bytes }]. Compress needs page pictures, which the page
// draws with PDF.js and hands in as shots(bytes) → [{ jpg, w, h }] in points.
import { PDFDocument, degrees } from './pdf-lib.min.mjs';

const base = (n) => n.replace(/\.pdf$/i, '');
const open = (f, password) => PDFDocument.load(f.bytes, password === undefined ? { ignoreEncryption: false } : { password });
const save = (doc) => doc.save({ useObjectStreams: true });

async function pick(f, spec) { // spec: "3,1r90,2"
  const src = await open(f), out = await PDFDocument.create();
  for (const s of spec.split(',').filter(Boolean)) {
    const [n, r] = s.split('r').map(Number);
    if (!(n >= 1 && n <= src.getPageCount())) throw new Error(`There's no page ${n}.`);
    const [p] = await out.copyPages(src, [n - 1]);
    if (r) p.setRotation(degrees((p.getRotation().angle + r) % 360));
    out.addPage(p);
  }
  return out;
}

export async function run(op, files, { pages = '', pw = '', level = 'smaller', shots } = {}) {
  const one = files[0];
  if (op === 'merge') {
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await open(f);
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    }
    return [{ name: base(one.name) + ' merged.pdf', bytes: await save(out) }];
  }
  if (op === 'pages') return [{ name: base(one.name) + ' (edited).pdf', bytes: await save(await pick(one, pages)) }];
  if (op === 'extract') return [{ name: base(one.name) + ' (picked pages).pdf', bytes: await save(await pick(one, pages)) }];
  if (op === 'split') {
    const src = await open(one), n = src.getPageCount(), out = [];
    for (let i = 0; i < n; i++) {
      const d = await PDFDocument.create();
      d.addPage((await d.copyPages(src, [i]))[0]);
      out.push({ name: `${base(one.name)} - page ${String(i + 1).padStart(String(n).length, '0')}.pdf`, bytes: await save(d) });
    }
    return out;
  }
  if (op === 'lock' || op === 'unlock') {
    return Promise.all(files.map(async (f) => {
      let doc;
      try { doc = await open(f, op === 'unlock' ? pw : undefined); } catch (e) {
        throw new Error(op === 'unlock' ? `That password doesn't open ${f.name}.` : `${f.name} already has a password. Remove it first.`);
      }
      if (op === 'lock') doc.encrypt({ userPassword: pw, ownerPassword: pw });
      else { // a fresh copy of the pages, so no trace of the old lock is saved
        const out = await PDFDocument.create();
        for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
        doc = out;
      }
      return { name: `${base(f.name)} (${op === 'lock' ? 'locked' : 'unlocked'}).pdf`, bytes: await save(doc) };
    }));
  }
  if (op === 'compress') {
    // ponytail: every page becomes a picture, so text can't be selected afterwards; the PC keeps the text.
    return Promise.all(files.map(async (f) => {
      const out = await PDFDocument.create();
      for (const s of await shots(f.bytes, level)) {
        const img = await out.embedJpg(s.jpg);
        out.addPage([s.w, s.h]).drawImage(img, { x: 0, y: 0, width: s.w, height: s.h });
      }
      const bytes = await save(out);
      return { name: base(f.name) + ' (smaller).pdf', bytes: bytes.length < f.bytes.length ? bytes : f.bytes };
    }));
  }
  throw new Error('Unknown PDF tool.');
}
