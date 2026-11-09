// The PDF editor's engine (the screen is /m/pdf-edit.js). It reads the text on a page straight from the page's own
// drawing commands, so a line can be changed in the file itself, and draws added text, pictures and marks on top.
// Everything here is in "view points": the page as it shows on screen, 1 point per unit, top left is 0,0.
import { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFContentStream, decodePDFRawStream, StandardFonts, StandardFontEmbedder,
  rgb, BlendMode, LineCapStyle, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from './pdf-lib.min.mjs';

// ---------- matrices: [a b c d e f], points are rows, as in PDF ----------
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const at = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
const ID = [1, 0, 0, 1, 0, 0];

// The page as it shows: PDF.js's viewport at scale 1 (crop box, then the page's turn).
export function view(page) {
  const { x, y, width, height } = page.getCropBox(), r = ((page.getRotation().angle % 360) + 360) % 360;
  const [A, B, C, D] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[r] || [1, 0, 0, -1];
  const cx = x + width / 2, cy = y + height / 2, side = A === 0;
  const W = side ? height : width, H = side ? width : height;
  const ox = side ? Math.abs(cy - y) : Math.abs(cx - x), oy = side ? Math.abs(cx - x) : Math.abs(cy - y);
  return { W, H, m: [A, B, C, D, ox - A * cx - C * cy, oy - B * cx - D * cy] };
}

// ---------- reading drawing commands ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const latin = (b, s, e) => String.fromCharCode(...b.subarray(s, e));
const ESC = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };

// Splits a content stream into operators with their operands and where they sit in the bytes.
// Strings come back as { s: bytes }, names as { n }, arrays as arrays, dictionaries as { d }.
export function parseOps(b) {
  const out = [], stack = [];
  let i = 0, args = [], start = -1;
  const push = (v, s) => { if (start < 0) start = s; (stack.length ? stack[stack.length - 1] : args).push(v); };
  while (i < b.length) {
    const c = b[i], s = i;
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < b.length && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 40) {
      const bytes = [];
      let depth = 1;
      i++;
      while (i < b.length) {
        const ch = b[i++];
        if (ch === 92) {
          const e = b[i++];
          if (ESC[e] !== undefined) bytes.push(ESC[e]);
          else if (e >= 48 && e <= 55) { let v = e - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48; bytes.push(v & 255); }
          else if (e === 13) { if (b[i] === 10) i++; } else if (e !== 10) bytes.push(e);
          continue;
        }
        if (ch === 40) depth++;
        else if (ch === 41 && --depth === 0) break;
        bytes.push(ch);
      }
      push({ s: Uint8Array.from(bytes) }, s);
      continue;
    }
    if (c === 60 && b[i + 1] === 60) { if (start < 0) start = s; stack.push([]); i += 2; continue; }
    if (c === 62 && b[i + 1] === 62) { const d = stack.pop() || []; push({ d }, s); i += 2; continue; }
    if (c === 60) {
      let j = i + 1, hex = '';
      while (j < b.length && b[j] !== 62) { if (!WS.has(b[j])) hex += String.fromCharCode(b[j]); j++; }
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
      i = j + 1;
      push({ s: bytes }, s);
      continue;
    }
    if (c === 91) { if (start < 0) start = s; stack.push([]); i++; continue; }
    if (c === 93) { const a = stack.pop() || []; push(a, s); i++; continue; }
    if (c === 47) { i++; while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++; push({ n: latin(b, s + 1, i) }, s); continue; }
    while (i < b.length && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === s) { i++; continue; } // a stray ) > { or }
    const word = latin(b, s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push(+word, s); continue; }
    if (stack.length || word === 'true' || word === 'false' || word === 'null') { push({ k: word }, s); continue; }
    out.push({ op: word, args, start: start < 0 ? s : start, end: i });
    args = []; start = -1;
    if (word === 'ID') { // a picture inside the stream: its bytes run up to " EI "
      i++;
      while (i < b.length && !(b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= b.length || WS.has(b[i + 2])))) i++;
    }
  }
  return out;
}

// ---------- fonts ----------
const WIN = { 128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160, 139: 0x2039, 140: 0x152, 142: 0x17d,
  145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x2dc, 153: 0x2122, 154: 0x161, 155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178 };
const winChar = (c) => c < 32 ? '' : String.fromCharCode(WIN[c] || c);
const GLYPH = { space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”', ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', copyright: '©', registered: '®', degree: '°', Euro: '€' };
const glyphChar = (g) => GLYPH[g] ?? (g.length === 1 ? g : /^uni[0-9A-F]{4}$/.test(g) ? String.fromCharCode(parseInt(g.slice(3), 16)) : '');

const codeOf = (bytes) => bytes.reduce((v, x) => v * 256 + x, 0);
function toUnicodeMap(src) {
  const map = new Map(), txt = latin(src, 0, src.length);
  const hex = (h) => parseInt(h, 16);
  const str = (h) => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(hex(h.substr(i, 4))); return s; };
  for (const sec of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hex(m[1]), str(m[2]));
  for (const sec of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = hex(m[1]), hi = hex(m[2]);
      if (hi - lo > 65535) continue;
      if (m[3][0] === '[') { [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, k) => map.set(lo + k, str(d[1]))); continue; }
      const base = m[3].slice(1, -1), first = str(base);
      for (let c = lo; c <= hi; c++) map.set(c, first.slice(0, -1) + String.fromCharCode(first.charCodeAt(first.length - 1) + c - lo));
    }
  }
  return map;
}

const bytesOf = (ctx, s) => s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s instanceof PDFContentStream ? s.getUnencodedContents() : s.getContents?.() || new Uint8Array();

function readFont(ctx, dict) {
  const get = (d, k) => d && ctx.lookup(d.get(PDFName.of(k)));
  const name = (v) => v instanceof PDFName ? v.decodeText() : '';
  const num = (v) => v instanceof PDFNumber ? v.asNumber() : 0;
  const base = name(get(dict, 'BaseFont')), type0 = name(get(dict, 'Subtype')) === 'Type0';
  const desc = type0 ? ctx.lookup(get(dict, 'DescendantFonts')?.get(0)) : dict;
  const fd = get(desc, 'FontDescriptor');
  const embedded = !!(get(fd, 'FontFile') || get(fd, 'FontFile2') || get(fd, 'FontFile3'));
  const f = { base, type0, embedded, subset: /^[A-Z]{6}\+/.test(base), uni: new Map(), widths: new Map(), dw: 0, seen: new Set() };
  const tu = get(dict, 'ToUnicode');
  if (tu instanceof PDFRawStream || tu instanceof PDFContentStream) f.tu = toUnicodeMap(bytesOf(ctx, tu));
  if (type0) {
    f.dw = get(desc, 'DW') ? num(get(desc, 'DW')) : 1000;
    const w = get(desc, 'W');
    for (let i = 0; w instanceof PDFArray && i < w.size();) {
      const a = num(ctx.lookup(w.get(i))), b = ctx.lookup(w.get(i + 1));
      if (b instanceof PDFArray) { for (let k = 0; k < b.size(); k++) f.widths.set(a + k, num(ctx.lookup(b.get(k)))); i += 2; }
      else { const v = num(ctx.lookup(w.get(i + 2))); for (let c = a; c <= num(b) && c - a < 65536; c++) f.widths.set(c, v); i += 3; }
    }
  } else {
    const enc = get(dict, 'Encoding'), flags = num(get(fd, 'Flags'));
    // A font that says it has its own letters (symbolic), no encoding and a ToUnicode map uses codes of its own:
    // guessing WinAnsi for the codes the map leaves out reads Arabic marks as $ & ' (LibreOffice).
    if (enc || !f.tu || !(flags & 4) || flags & 32) for (let c = 0; c < 256; c++) f.uni.set(c, winChar(c)); // ponytail: Mac and Standard encodings read as WinAnsi; they agree on plain letters
    const diffs = enc instanceof PDFDict ? get(enc, 'Differences') : null;
    for (let i = 0, c = 0; diffs instanceof PDFArray && i < diffs.size(); i++) {
      const v = ctx.lookup(diffs.get(i));
      if (v instanceof PDFNumber) c = v.asNumber(); else f.uni.set(c++, glyphChar(name(v)));
    }
    const first = num(get(dict, 'FirstChar')), ws = get(dict, 'Widths');
    if (ws instanceof PDFArray) for (let k = 0; k < ws.size(); k++) f.widths.set(first + k, num(ctx.lookup(ws.get(k))));
    else if (Object.values(StandardFonts).includes(base)) { // the 14 built-in fonts often come without widths
      const std = StandardFontEmbedder.for(base);
      for (let c = 32; c < 256; c++) { try { f.widths.set(c, std.widthOfTextAtSize(winChar(c), 1000)); } catch (e) { /* not in this font */ } }
    }
    f.dw = get(fd, 'MissingWidth') ? num(get(fd, 'MissingWidth')) : 500;
  }
  f.text = (code) => f.tu?.get(code) ?? (type0 ? '' : f.uni.get(code) || '');
  f.width = (code) => f.widths.get(code) ?? f.dw;
  return f;
}

// Turns text into this font's codes, or null when a letter isn't in it (a font cut down to the letters the PDF
// used has no others, so then the only codes trusted are the ones the page already shows).
function encode(f, text) {
  if (RTL.test(text)) return null; // its letters change shape with their neighbours, which only a picture of it gets right
  const back = new Map();
  if (f.tu) for (const [c, s] of f.tu) if (s.length === 1 && !back.has(s)) back.set(s, c);
  if (!f.type0) for (const [c, s] of f.uni) if (s && !back.has(s) && !f.tu?.has(c) && f.widths.has(c)) back.set(s, c); // never a code the map says is another letter
  const codes = [];
  for (const ch of text) {
    const c = back.get(ch);
    if (c === undefined) return null;
    if (f.embedded && f.subset && !f.seen.has(c) && !(f.tu?.has(c) && f.type0)) return null;
    if (!f.width(c) && ch !== ' ') return null;
    codes.push(c);
  }
  return codes;
}

// ---------- the text on a page ----------
const ASC = 0.8, DESC = -0.2;

// PDFs keep right-to-left writing (Arabic, Hebrew) in the order it shows, left to right, often as the letters'
// joined shapes. logical() gives a line back as it was typed: a line mostly in those letters turns round as a whole,
// keeping its numbers and other words as they show; any other line only turns its right-to-left words round.
// ponytail: mirrored brackets, and a number that belongs to the Arabic beside it in a mostly English line, read as
// they show; the Unicode bidi algorithm in reverse if that matters.
const R = '\u0590-\u065f\u066a-\u06ef\u06fa-\u08ff\ufb1d-\ufdff\ufe70-\ufefc'; // letters and marks, not digits
const RTL = new RegExp(`[${R}]`), rev = (w) => [...w].reverse().join('');
const flip = (s) => rev(s).replace(new RegExp(`[^\\s${R}](?:[^${R}]*[^\\s${R}])?`, 'g'), (w) => /\p{L}/u.test(w) ? rev(w) : w.replace(/\S+/g, rev));
export function logical(s) {
  const r = (s.match(new RegExp(`(?=\\p{L})[${R}]`, 'gu')) || []).length;
  if (!r) return s;
  const out = r >= (s.match(/\p{L}/gu) || []).length - r ? flip(s) : s.replace(new RegExp(`[${R}](?:[^\\p{L}${R}]*[${R}])*`, 'gu'), flip);
  return out.replace(/[\ufb50-\ufdff\ufe70-\ufefc]/g, (c) => c.normalize('NFKC'));
}
const rtlFirst = (s) => new RegExp(`^[^\\p{L}${R}]*[${R}]`, 'u').test(s); // a line that reads right to left, as dir="auto" decides

// Reads every line of text the page draws. Each block is one line: { id, text, rtl, unseen, x, y, w, h (view points),
// size, color, family, bold, italic, angle }; unseen is a scan's text layer, letters that don't show over the picture.
// The page's text inside embedded drawings (forms) isn't read.
export function readText(doc, page) {
  const ctx = doc.context, V = view(page);
  const cs = page.node.Contents();
  const parts = cs instanceof PDFArray ? cs.asArray().map((r) => ctx.lookup(r)) : cs ? [cs] : [];
  const chunks = parts.map((s) => bytesOf(ctx, s));
  const src = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
  chunks.reduce((o, c) => { src.set(c, o); src[o + c.length] = 10; return o + c.length + 1; }, 0);
  const fontsDict = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
  const fonts = {};
  const font = (key) => fonts[key] ??= (() => { const d = fontsDict?.lookup(PDFName.of(key)); return d instanceof PDFDict ? readFont(ctx, d) : null; })();

  const list = parseOps(src), runs = [], gstack = [];
  let g = { ctm: ID, color: [0, 0, 0], tr: 0 }, t = null, tm = ID, tlm = ID;
  const ts = { fk: '', fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const nextLine = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  const show = (o, items) => {
    const f = font(ts.fk);
    if (!f) return;
    const r = { op: o, f, size: ts.fs, th: ts.th, rise: ts.rise, tc: ts.tc, tw: ts.tw, tm, ctm: g.ctm, color: g.color, text: '', adv: 0, unseen: g.tr % 4 === 3 };
    for (const it of items) {
      if (typeof it === 'number') { const dx = -it / 1000 * ts.fs * ts.th; r.adv += dx; if (it < -180) r.text += ' '; continue; }
      if (!it?.s) continue;
      const b = it.s, step = f.type0 ? 2 : 1;
      for (let i = 0; i + step <= b.length; i += step) {
        const code = codeOf(b.subarray(i, i + step));
        f.seen.add(code);
        const t = f.text(code); // one shape for several right-to-left letters (لا) is turned round with the rest of the line
        r.text += t.length > 1 && RTL.test(t) ? rev(t) : t;
        r.adv += (f.width(code) / 1000 * ts.fs + ts.tc + (step === 1 && code === 32 ? ts.tw : 0)) * ts.th;
      }
    }
    tm = mul([1, 0, 0, 1, r.adv, 0], tm);
    runs.push(r);
  };
  for (const o of list) {
    const a = o.args, n = (k) => typeof a[k] === 'number' ? a[k] : 0;
    switch (o.op) {
      case 'q': gstack.push(g); break;
      case 'Q': g = gstack.pop() || g; break;
      case 'cm': g = { ...g, ctm: mul([n(0), n(1), n(2), n(3), n(4), n(5)], g.ctm) }; break;
      case 'g': g = { ...g, color: [n(0), n(0), n(0)] }; break;
      case 'rg': g = { ...g, color: [n(0), n(1), n(2)] }; break;
      case 'Tr': g = { ...g, tr: n(0) }; break; // 3: letters that don't show, like a scan's text layer
      case 'k': g = { ...g, color: [0, 1, 2].map((i) => (1 - n(i)) * (1 - n(3))) }; break;
      case 'sc': case 'scn': if (a.length === 1) g = { ...g, color: [n(0), n(0), n(0)] }; else if (a.length === 3) g = { ...g, color: [n(0), n(1), n(2)] }; break;
      case 'BT': t = true; tm = tlm = ID; break;
      case 'ET': t = null; break;
      case 'Tf': ts.fk = a[0]?.n || ''; ts.fs = n(1); break;
      case 'Tc': ts.tc = n(0); break;
      case 'Tw': ts.tw = n(0); break;
      case 'Tz': ts.th = n(0) / 100; break;
      case 'TL': ts.tl = n(0); break;
      case 'Ts': ts.rise = n(0); break;
      case 'Td': nextLine(n(0), n(1)); break;
      case 'TD': ts.tl = -n(1); nextLine(n(0), n(1)); break;
      case 'Tm': tlm = tm = [n(0), n(1), n(2), n(3), n(4), n(5)]; break;
      case 'T*': nextLine(0, -ts.tl); break;
      case 'Tj': if (t) show(o, [a[0]]); break;
      case 'TJ': if (t) show(o, Array.isArray(a[0]) ? a[0] : []); break;
      case "'": if (t) { nextLine(0, -ts.tl); show(o, [a[0]]); } break;
      case '"': if (t) { ts.tw = n(0); ts.tc = n(1); nextLine(0, -ts.tl); show(o, [a[2]]); } break;
    }
  }

  // Runs that carry on along the same line make one block, its text as it shows from left to right. Right-to-left
  // words can come right to left (LibreOffice), and an Arabic mark, which has no width, comes raised or lowered
  // before its letter (Chrome): it goes with the block its letter is in, which takes its line from the letter.
  const blocks = [];
  let b = null, marks = [];
  for (const r of runs) {
    const m = mul(r.tm, r.ctm), sz = Math.hypot(m[2], m[3]) * r.size;
    if (b) {
      const [px, py] = at(inv(b.frame), ...at(m, 0, r.rise));
      const s0 = b.size, gap = px - b.end, back = b.start - px - r.adv, near = (g) => g > -0.5 * s0 && g < s0; // further is a tab: "Label:   value" is two
      if ((Math.abs(py) < 0.3 * s0 || !r.adv) && Math.abs(sz - b.vsize) < 0.35 * b.vsize && (near(gap) || near(back))) {
        const sp = (g, a, z) => g > 0.18 * s0 && !/\s$/.test(a) && !/^\s/.test(z) ? ' ' : '';
        if (near(gap)) { b.text += sp(gap, b.text, r.text) + r.text; b.end = Math.max(b.end, px + r.adv); }
        else { b.text = r.text + sp(back, r.text, b.text) + b.text; b.start = px; }
        b.runs.push(r); b.pts.push(...corners(m, r, V));
        continue;
      }
      blocks.push(b); b = null;
    }
    if (!r.text.trim()) continue;
    if (!r.adv) { marks.push([r, corners(m, r, V)]); continue; }
    b = { runs: [r, ...marks.map((k) => k[0])], text: marks.map((k) => k[0].text).join('') + r.text, frame: m, start: 0, end: r.adv, size: r.size, vsize: sz,
      pts: [...corners(m, r, V), ...marks.flatMap((k) => k[1])] };
    marks = [];
  }
  if (b) blocks.push(b);
  return { src, list, blocks: blocks.filter((x) => x.text.trim()).map((x, i) => {
    const xs = x.pts.map((p) => p[0]), ys = x.pts.map((p) => p[1]), r = x.runs[0], f = r.f, text = logical(x.text.trim());
    const vm = mul(x.frame, V.m), [ox, oy] = at(vm, 0, r.rise);
    return { id: i, text, rtl: rtlFirst(text), unseen: x.runs.every((q) => q.unseen), runs: x.runs, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      ox, oy, size: x.vsize, angle: Math.atan2(vm[1], vm[0]) * 180 / Math.PI, color: '#' + r.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join(''),
      family: /times|serif|roman|georgia|garamond|cambria|book/i.test(f.base) && !/sans/i.test(f.base) ? 'serif' : /courier|mono|consol/i.test(f.base) ? 'mono' : 'sans',
      bold: /bold|black|heavy|semibold|demi/i.test(f.base), italic: /italic|oblique/i.test(f.base) };
  }) };
}
function corners(m, r, V) {
  const a = r.rise + DESC * r.size, b = r.rise + ASC * r.size;
  return [[0, a], [r.adv, a], [r.adv, b], [0, b]].map(([x, y]) => at(V.m, ...at(m, x, y)));
}

const fmt = (v) => (Math.round(v * 1000) / 1000).toString();
const hexOf = (f, codes) => '<' + codes.map((c) => c.toString(16).padStart(f.type0 ? 4 : 2, '0')).join('') + '>';
// What a run's command becomes: the same move along the line, with no letters, or with the new ones.
function swap(r, codes) {
  const a = r.op.args, pre = r.op.op === "'" ? 'T* ' : r.op.op === '"' ? `${fmt(a[0])} Tw ${fmt(a[1])} Tc T* ` : '';
  if (codes) return pre + hexOf(r.f, codes) + ' Tj';
  return pre + (r.size * r.th ? `[${fmt(-r.adv * 1000 / (r.size * r.th))}] TJ` : '');
}

// A run's command with each letter whose middle is under one of rects (view points) swapped for the space it took,
// so the words around it stay put; null when none is.
function unshow(r, V, rects) {
  const f = r.f, step = f.type0 ? 2 : 1, k = r.size * r.th, m = mul(r.tm, r.ctm), mid = r.rise + (ASC + DESC) / 2 * r.size;
  const a = r.op.args, items = r.op.op === 'TJ' ? (Array.isArray(a[0]) ? a[0] : []) : [r.op.op === '"' ? a[2] : a[0]];
  if (!k) return null;
  const out = [];
  let x = 0, hit = false, codes = [];
  const flush = () => { if (codes.length) out.push(hexOf(f, codes)); codes = []; };
  for (const it of items) {
    if (typeof it === 'number') { flush(); out.push(fmt(it)); x -= it / 1000 * k; continue; }
    if (!it?.s) continue;
    for (let i = 0; i + step <= it.s.length; i += step) {
      const code = codeOf(it.s.subarray(i, i + step)), w = (f.width(code) / 1000 * r.size + r.tc + (step === 1 && code === 32 ? r.tw : 0)) * r.th;
      const [px, py] = at(V.m, ...at(m, x + w / 2, mid));
      if (rects.some((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h)) { flush(); out.push(fmt(-w * 1000 / k)); hit = true; } else codes.push(code);
      x += w;
    }
  }
  flush();
  const pre = r.op.op === "'" ? 'T* ' : r.op.op === '"' ? `${fmt(a[0])} Tw ${fmt(a[1])} Tc T* ` : '';
  return hit ? pre + `[${out.join(' ')}] TJ` : null;
}

// Changes lines in the page's own text. edits: { blockId: newText }. A line whose font has every letter keeps
// that font; any other line is taken out and comes back as added text in the closest built-in font: those are
// returned, for drawItems to draw. hide: the page's white-outs, whose letters leave the file, not just the view.
// ponytail: pictures (a scan) under a white-out stay in the file under the white box.
export function editText(doc, page, read, edits, hide = []) {
  const reps = [], extra = [], V = view(page);
  for (const [id, text] of Object.entries(edits)) {
    const b = read.blocks[id];
    if (!b || text === b.text) continue;
    const codes = !text ? [] : b.unseen ? null : encode(b.runs[0].f, text);
    b.runs.forEach((r, i) => reps.push({ s: r.op.start, e: r.op.end, to: swap(r, i === 0 && codes && text ? codes : null) }));
    if (b.unseen) extra.push({ type: 'white', x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 }); // on a scan the words are in the picture: covered, as the screen shows
    if (!codes && text) extra.push({ type: 'text', text, x: b.ox, y: b.oy - b.size, size: b.size, color: b.color, family: b.family, bold: b.bold, italic: b.italic, angle: b.angle,
      ...(b.rtl && { end: b.x + b.w }) }); // a right-to-left line keeps its right edge
  }
  if (hide.length) for (const b of read.blocks) {
    if (b.id in edits) continue;
    for (const r of b.runs) { const to = unshow(r, V, hide); if (to) reps.push({ s: r.op.start, e: r.op.end, to }); }
  }
  if (!reps.length) return extra;
  reps.sort((p, q) => p.s - q.s);
  const enc = new TextEncoder(), parts = [];
  let o = 0;
  for (const r of reps) { parts.push(read.src.subarray(o, r.s), enc.encode(r.to)); o = r.e; }
  parts.push(read.src.subarray(o));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((k, p) => { out.set(p, k); return k + p.length; }, 0);
  const list = page.node.normalizedEntries().Contents; // pdf-lib keeps this array and adds its own drawing to it
  while (list.size()) list.remove(0);
  list.push(doc.context.register(doc.context.flateStream(out)));
  return extra;
}

// ---------- drawing on top ----------
const colorOf = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const STD = { sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'], serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] };

// Draws the added things on a page. items are in view points; pictures: { [id]: { bytes, png } }. textPng(item, line)
// draws a line the built-in fonts can't (Arabic, emoji…) as a picture: { bytes, w, h, pad } in points, pad being the
// room left on each side of the letters. Text with an end
// (a changed right-to-left line) ends there instead of starting at x.
export async function drawItems(doc, page, items, pics, textPng) {
  if (!items.length) return;
  const ctx = doc.context, { H, m } = view(page);
  doc._ptFonts ??= {}; doc._ptPics ??= {};
  const font = async (it) => doc._ptFonts[it.family + it.bold + it.italic] ??= await doc.embedFont(StandardFonts[STD[it.family || 'sans'][(it.bold ? 1 : 0) + (it.italic ? 2 : 0)]]);
  const pic = async (id) => doc._ptPics[id] ??= await (pics[id].png ? doc.embedPng(pics[id].bytes) : doc.embedJpg(pics[id].bytes));
  page.node.wrapContentStreams(ctx.register(ctx.contentStream([pushGraphicsState()])), ctx.register(ctx.contentStream([popGraphicsState()])));
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...mul([1, 0, 0, -1, 0, H], inv(m))));
  const Y = (y) => H - y;
  for (const it of items) {
    const color = it.color ? colorOf(it.color) : undefined, bw = it.width || 2;
    if (it.type === 'text') {
      const f = await font(it), lines = it.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const base = it.y + it.size * (1 + 1.2 * i);
        f._set ??= new Set(f.getCharacterSet());
        if ([...lines[i]].every((ch) => f._set.has(ch.codePointAt(0)))) {
          page.drawText(lines[i], { x: it.end === undefined ? it.x : it.end - f.widthOfTextAtSize(lines[i], it.size), y: Y(base), size: it.size, font: f, color });
        } else if (textPng && lines[i]) {
          const p = await textPng(it, lines[i]), img = await doc.embedPng(p.bytes), pad = p.pad || 0;
          page.drawImage(img, { x: it.end === undefined ? it.x - pad : it.end - p.w + pad, y: Y(it.y + it.size * 1.2 * (i + 1)), width: p.w, height: p.h });
        }
      }
    } else if (it.type === 'pic') page.drawImage(await pic(it.pic), { x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h });
    else if (it.type === 'white') page.drawRectangle({ x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h, color: rgb(1, 1, 1) });
    else if (it.type === 'mark') page.drawRectangle({ x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h, color, opacity: 0.4, blendMode: BlendMode.Multiply });
    else if (it.type === 'box') page.drawRectangle({ x: it.x, y: Y(it.y + it.h), width: it.w, height: it.h, borderColor: color, borderWidth: bw });
    else if (it.type === 'oval') page.drawEllipse({ x: it.x + it.w / 2, y: Y(it.y + it.h / 2), xScale: it.w / 2, yScale: it.h / 2, borderColor: color, borderWidth: bw });
    else if (it.type === 'draw' || it.type === 'line' || it.type === 'arrow') {
      page.drawSvgPath(pathOf(it), { x: 0, y: H, borderColor: color, borderWidth: bw, borderLineCap: LineCapStyle.Round });
    }
  }
  page.pushOperators(popGraphicsState());
}

// The SVG path of a stroke, line or arrow (the screen draws the same path).
export function pathOf(it) {
  const p = it.pts, f = (v) => Math.round(v * 100) / 100;
  if (it.type === 'draw') return p.map((q, i) => `${i ? 'L' : 'M'}${f(q[0])} ${f(q[1])}`).join(' ');
  const [[x1, y1], [x2, y2]] = p;
  let d = `M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)}`;
  if (it.type === 'arrow') {
    const a = Math.atan2(y2 - y1, x2 - x1), l = 6 + (it.width || 2) * 3;
    for (const s of [-0.45, 0.45]) d += ` M${f(x2)} ${f(y2)} L${f(x2 - l * Math.cos(a + s))} ${f(y2 - l * Math.sin(a + s))}`;
  }
  return d;
}

// Whether a changed line can keep its own font.
export const fits = (b, text) => !!encode(b.runs[0].f, text);
export { rtlFirst };
