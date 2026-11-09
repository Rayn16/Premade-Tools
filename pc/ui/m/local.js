// The phone's own engines, for when the PC can't be reached: pictures with the phone's own decoder (HEIC too),
// video and sound with FFmpeg built for web pages, the PDF tools with pdf-lib, and Transcribe with a small Whisper.
// Jobs done here live only while the app is open, and Save hands the result to the Share sheet (or the S23 app).
// The heavy engines download once the first time they're used, then the offline copy (sw.js) keeps them.
'use strict';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const FF_CORE = CDN + '@ffmpeg/core@0.12.10/dist/esm/';
const LJ = []; // jobs done on this phone: { id, tool, kind, inputs, target, state, pct, note, files, blobs, text, at, from, local }
const ljOf = (tool) => LJ.filter((j) => j.tool === tool);
const ljBusy = (tool) => ljOf(tool).some((j) => j.state === 'running');
const ljURL = (j, n) => (j.urls ||= [])[n] ||= URL.createObjectURL(j.blobs[n]);
const fileOf = (bytes, name, type) => new File([bytes], name, { type });
const stem = (n) => n.replace(/\.[^.]+$/, '');

// Runs work(job) → File[] and keeps the job in its tool's list while it goes.
function ljRun(tool, fields, work) {
  const j = { id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), tool, state: 'running', pct: 0, note: '', files: [], blobs: [], at: new Date().toISOString(), from: ST?.me || '', local: true, ...fields };
  LJ.unshift(j);
  render();
  work(j).then((blobs) => {
    Object.assign(j, { blobs, files: blobs.map((b) => ({ name: b.name })), size: blobs.reduce((s, b) => s + b.size, 0), state: 'done', pct: 100, note: j.note });
  }).catch((e) => { j.state = 'failed'; j.note = e?.message || String(e); }).finally(render);
  return j;
}
const ljProg = (j, pct) => { j.pct = Math.max(j.pct, Math.min(99, pct)); const bar = document.querySelector(`[data-lj="${j.id}"] .prog i`); if (bar) bar.style.width = j.pct + '%'; };

// Save: the S23 app takes a file as base64; the iPhone opens the Share sheet (Save to Files / Photos, Mail, …).
async function ljSave(id) {
  const j = LJ.find((x) => x.id === id);
  if (!j) return;
  if (NATIVE?.saveLocal) {
    for (const b of j.blobs) NATIVE.saveLocal(b.name, b.type, await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(b); }));
    j.saved = true; render(); return;
  }
  try { await navigator.share({ files: j.blobs }); j.saved = true; render(); } catch (e) {
    if (e?.name !== 'AbortError' && j.blobs.length === 1) { const a = Object.assign(document.createElement('a'), { href: ljURL(j, 0), download: j.blobs[0].name }); a.click(); }
  }
}
const ljSaveBtn = (j) => j.state === 'done' ? `<button type="button" class="btn small ${j.saved ? '' : 'primary'}" data-ljsave="${j.id}">${icon(NATIVE ? 'save' : 'share')}Save</button>` : '';
const ljWhere = (j) => j.state !== 'done' ? '' : j.saved ? 'Saved' : 'On this phone';
document.getElementById('app').addEventListener('click', (e) => { const b = e.target.closest('[data-ljsave]'); if (b) ljSave(b.dataset.ljsave); });

// ---------- pictures ----------
// Drawn on a canvas, so HEIC works wherever the phone shows HEIC (every iPhone). iPhones cap a canvas near
// 16 million pixels, so a 48 MP photo comes out at about 16 MP.
async function lcPicture(f) {
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error(`This phone can't open ${f.name}.`); });
    const k = Math.min(1, Math.sqrt(16e6 / (img.naturalWidth * img.naturalHeight)));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
const canvasBlob = (c, type, q) => new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('The picture was too big for this phone.'))), type, q));
async function lcPictures(j, files, to, small, combine) {
  if (to === 'pdf') {
    const { PDFDocument } = await import('/m/lib/pdf-lib.min.mjs');
    const docs = [], out = [];
    for (const [i, f] of files.entries()) {
      const c = await lcPicture(f), jpg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', small ? 0.6 : 0.85)).arrayBuffer());
      if (!combine || !docs.length) docs.push({ doc: await PDFDocument.create(), name: stem(f.name) + '.pdf' });
      const d = docs.at(-1).doc, im = await d.embedJpg(jpg), w = c.width * 0.75, h = c.height * 0.75; // 96 dpi in points
      d.addPage([w, h]).drawImage(im, { x: 0, y: 0, width: w, height: h });
      ljProg(j, (i + 1) / files.length * 100);
    }
    for (const { doc, name } of docs) out.push(fileOf(await doc.save(), name, 'application/pdf'));
    return out;
  }
  const type = to === 'png' ? 'image/png' : 'image/jpeg', out = [];
  for (const [i, f] of files.entries()) {
    out.push(fileOf(await canvasBlob(await lcPicture(f), type, small ? 0.6 : 0.9), stem(f.name) + '.' + to, type));
    ljProg(j, (i + 1) / files.length * 100);
  }
  return out;
}

// ---------- video and sound (FFmpeg) ----------
let FF = null, ffJob = null;
async function ffmpeg() {
  if (!FF) {
    const { FFmpeg } = await import('/m/ffmpeg/index.js');
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => { if (ffJob && progress > 0 && progress <= 1) ljProg(ffJob, progress * 100); });
    await ff.load({ coreURL: FF_CORE + 'ffmpeg-core.js', wasmURL: FF_CORE + 'ffmpeg-core.wasm' })
      .catch(() => { throw new Error('The video engine (about 30 MB) needs the internet the first time. Try again with a signal.'); });
    FF = ff;
  }
  return FF;
}
const FF_ARGS = { // what the PC does (pc/conv.go), kept light enough for a phone
  mp4: (s) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', s ? '30' : '24', '-vf', "scale='min(1920,iw)':-2", '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  mov: (s) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', s ? '30' : '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  webm: (s) => ['-c:v', 'libvpx', '-b:v', s ? '800k' : '2M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libvorbis'],
  gif: () => ['-t', '20', '-vf', 'fps=12,scale=480:-1:flags=lanczos', '-loop', '0'],
  mp3: (s) => ['-vn', '-c:a', 'libmp3lame', '-q:a', s ? '6' : '2'],
  m4a: (s) => ['-vn', '-c:a', 'aac', '-b:a', s ? '96k' : '192k'],
  wav: () => ['-vn', '-c:a', 'pcm_s16le'],
  flac: () => ['-vn', '-c:a', 'flac'],
  ogg: (s) => ['-vn', '-c:a', 'libvorbis', '-q:a', s ? '3' : '6'],
};
const FF_TYPE = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', gif: 'image/gif', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg' };
async function ffRun(j, f, args, out) {
  const ff = await ffmpeg(), inName = 'in.' + (f.name.split('.').pop() || 'bin').toLowerCase();
  await ff.writeFile(inName, new Uint8Array(await f.arrayBuffer()));
  ffJob = j;
  try {
    if (await ff.exec(['-i', inName, ...args, '-y', out]) !== 0) throw new Error(`This phone couldn't convert ${f.name}.`);
    return await ff.readFile(out);
  } finally { ffJob = null; ff.deleteFile(inName).catch(() => {}); ff.deleteFile(out).catch(() => {}); }
}
async function lcMedia(j, files, to, small) {
  const out = [];
  for (const f of files) {
    // A MOV into MP4 (or the other way) first tries just moving the streams, which takes seconds instead of minutes.
    let bytes = (to === 'mp4' || to === 'mov') && /\.(mov|mp4|m4v)$/i.test(f.name) && !small
      ? await ffRun(j, f, ['-c', 'copy', '-movflags', '+faststart', '-tag:v', 'avc1'], 'out.' + to).catch(() => null) : null;
    bytes ||= await ffRun(j, f, FF_ARGS[to](small), 'out.' + to);
    out.push(fileOf(bytes, stem(f.name) + '.' + to, FF_TYPE[to]));
  }
  return out;
}

// What the Converter does on the phone (the same shape as the PC's list, pc/conv.go).
const tg = (id, label, note = '') => ({ id, label, note });
const CV_LOCAL = {
  local: true, ready: { local: true }, office: 'no', dir: '',
  kinds: [
    { id: 'image', label: 'Picture', engine: 'local', exts: 'heic heif jpg jpeg png webp avif gif bmp tif tiff'.split(' '), targets: [tg('jpg', 'JPG', 'Opens everywhere'), tg('png', 'PNG', 'Sharp edges, see-through parts kept'), tg('pdf', 'PDF')] },
    { id: 'video', label: 'Video', engine: 'local', exts: 'mov mp4 m4v mkv webm avi 3gp'.split(' '), targets: [tg('mp4', 'MP4', 'Plays on everything. On the phone it takes a while for long videos.'), tg('mov', 'MOV'), tg('gif', 'GIF', 'The first 20 seconds'), tg('mp3', 'MP3', 'Sound only'), tg('m4a', 'M4A', 'Sound only'), tg('webm', 'WebM', 'Slow on a phone')] },
    { id: 'audio', label: 'Sound', engine: 'local', exts: 'mp3 m4a aac wav flac ogg opus aiff aif caf amr'.split(' '), targets: [tg('mp3', 'MP3', 'Plays on everything'), tg('m4a', 'M4A'), tg('wav', 'WAV', 'Uncompressed'), tg('flac', 'FLAC', 'Lossless'), tg('ogg', 'OGG')] },
    { id: 'doc', label: 'Document', engine: 'soffice', exts: 'docx doc odt rtf txt pages'.split(' '), targets: [tg('pdf', 'PDF')] },
    { id: 'sheet', label: 'Spreadsheet', engine: 'soffice', exts: 'xlsx xls ods csv numbers'.split(' '), targets: [tg('pdf', 'PDF')] },
    { id: 'slides', label: 'Slides', engine: 'soffice', exts: 'pptx ppt odp key'.split(' '), targets: [tg('pdf', 'PDF')] },
  ],
  get jobs() { return []; },
};
function localConvert(kind, files, to, small, combine) {
  return ljRun('cv', { kind: kind.id, inputs: files.map((f) => f.name), target: to, inSize: files.reduce((s, f) => s + f.size, 0) },
    (j) => kind.id === 'image' ? lcPictures(j, files, to, small, combine) : lcMedia(j, files, to, small));
}

// ---------- PDF tools (pdf-lib; page pictures for Compress come from PDF.js, as for the page grid) ----------
const PDF_LOCAL = { local: true, gs: 'ok', dir: '', jobs: [], ops: [tg('edit', 'Edit', 'Change the text, add text, pictures, a signature or drawings'), tg('merge', 'Merge', 'Put PDFs together into one, in the order you pick'), tg('pages', 'Pages', 'Reorder, turn or delete pages'),
  tg('extract', 'Pick pages', 'Save only the pages you pick as a new PDF'), tg('split', 'Split', 'Every page as its own PDF'), tg('compress', 'Compress', 'Make it smaller to send. On the phone, pages become pictures.'),
  tg('lock', 'Add password', 'It asks for the password to open'), tg('unlock', 'Remove password', 'Opens without asking')] };
async function pdfShots(bytes, level) {
  const lib = await pdfLib(), task = lib.getDocument({ data: bytes.slice(), ...PDFJS_OPT }), doc = await task.promise, out = [];
  const dpi = level === 'smallest' ? 96 : 144, q = level === 'smallest' ? 0.5 : 0.7;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i), vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    out.push({ jpg: new Uint8Array(await (await canvasBlob(c, 'image/jpeg', q)).arrayBuffer()), w: vp1.width, h: vp1.height });
    page.cleanup(); c.width = c.height = 0;
  }
  task.destroy();
  return out;
}
function localPdf() {
  const files = [...P.files], op = P.op, opts = { pages: pdfSpec(), pw: P.pw, level: P.level, shots: pdfShots };
  ljRun('pdf', { inputs: files.map((f) => f.name), target: op, inSize: files.reduce((s, f) => s + f.size, 0) }, async (j) => {
    const { run } = await import('/m/lib/pdf-local.mjs');
    const ins = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    return (await run(op, ins, opts)).map((r) => fileOf(r.bytes, r.name, 'application/pdf'));
  });
  P.gen++; Object.assign(P, { files: [], pages: [], thumbs: {}, pagesOf: null, pw: '', err: '' });
  render();
}

// ---------- Transcribe (Whisper base, in a worker so the screen stays quick) ----------
const TR_LOCAL = { local: true, jobs: [], engine: { state: 'ok', translate: true } };
let trWorker = null, trWaiting = {};
function whisper(audio, task, onLoad) {
  if (!trWorker) {
    trWorker = new Worker('/m/whisper.js', { type: 'module' });
    trWorker.onmessage = ({ data: d }) => { const w = trWaiting[d.id]; if (!w) return; if (d.load) w.onLoad(d.load); else { delete trWaiting[d.id]; d.err ? w.no(new Error(d.err)) : w.ok(d.out); } };
  }
  const id = Math.random().toString(36).slice(2);
  return new Promise((ok, no) => { trWaiting[id] = { ok, no, onLoad }; trWorker.postMessage({ id, audio, task }, [audio.buffer]); });
}
// 16 kHz mono, as Whisper wants. The phone decodes most sound and video itself; anything else goes through FFmpeg.
async function trAudio(j, f) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    let buf;
    try { buf = await ctx.decodeAudioData(await f.arrayBuffer()); } catch (e) {
      buf = await ctx.decodeAudioData((await ffRun(j, f, ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'], 'out.wav')).buffer);
    }
    const ch = buf.getChannelData(0);
    if (buf.numberOfChannels > 1) { const r = buf.getChannelData(1); for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] + r[i]) / 2; }
    return new Float32Array(ch);
  } finally { ctx.close(); }
}
const srtTime = (s) => { const ms = Math.round((s || 0) * 1000), p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600e3))}:${p(Math.floor(ms / 60e3) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
function localTranscribe(files, to) {
  ljRun('tr', { inputs: files.map((f) => f.name), target: to }, async (j) => {
    const out = [], texts = [];
    for (const f of files) {
      j.note = 'Getting the sound out…'; render();
      const audio = await trAudio(j, f);
      j.note = 'Listening on this phone…'; render();
      const secs = audio.length / 16000, t0 = Date.now();
      const tick = setInterval(() => ljProg(j, (Date.now() - t0) / 1000 / Math.max(10, secs * 0.6) * 100), 1000); // ponytail: a guess, Whisper doesn't report progress
      let r;
      try {
        r = await whisper(audio, to === 'en' ? 'translate' : 'transcribe', (p) => { if (p.status === 'progress' && p.file?.endsWith('.onnx')) { j.note = `Getting the speech engine once (${Math.round(p.progress || 0)}%)…`; render(); } });
      } finally { clearInterval(tick); }
      const text = (r.text || '').trim(), chunks = r.chunks || [];
      texts.push(text);
      out.push(fileOf(text, stem(f.name) + '.txt', 'text/plain'));
      out.push(fileOf(chunks.map((c, i) => `${i + 1}\n${srtTime(c.timestamp[0])} --> ${srtTime(c.timestamp[1] ?? c.timestamp[0] + 2)}\n${c.text.trim()}\n`).join('\n'), stem(f.name) + '.srt', 'application/x-subrip'));
    }
    j.note = '';
    T.text[j.id] = texts.join('\n\n');
    return out;
  });
}

// ---------- File drop while the PC is off ----------
// The phone sends through the Friends relay to its own person, marking the device it's for and which phone it came
// from ("pc@phoneid"). The PC picks it up from the relay when it's back and puts it in File drop as usual.
// Needs the PC to have joined Friends; the key comes with the PC's state (kept in localStorage as ptfr).
const frKey = () => { try { return localStorage.getItem('ptfr') || ''; } catch (e) { return ''; } };
async function relayCall(method, path, body) {
  const r = await fetch((HOSTED ? '' : ST?.relay || '') + path, { method, headers: { Authorization: 'Bearer ' + frKey(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || "Can't reach the internet right now.");
  return out;
}
function relayPart(path, blob, onp) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('PUT', (HOSTED ? '' : ST?.relay || '') + path);
    x.setRequestHeader('Authorization', 'Bearer ' + frKey());
    x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded);
    x.onload = () => x.status === 200 ? ok(JSON.parse(x.responseText)) : no(new Error(JSON.parse(x.responseText || '{}').error || "That didn't send."));
    x.onerror = () => no(new Error("Can't reach the internet right now."));
    x.send(blob);
  });
}
async function localDrop() {
  const files = [...FD.files];
  if (FD.text.trim()) files.push(new File([FD.text], /^https?:\/\/\S+$/.test(FD.text.trim()) ? 'Link.txt' : 'Note.txt', { type: 'text/plain' }));
  const to = FD.to, total = files.reduce((n, f) => n + f.size, 0) || 1;
  FD.up = 0; FD.err = ''; FD.sent = ''; render();
  try {
    const me = (await relayCall('GET', '/people')).id;
    let before = 0;
    for (const f of files) {
      const st = await relayCall('POST', '/send', { to: me, dev: `${to}@${ST?.me || ''}`, name: f.name, size: f.size });
      const parts = [];
      for (let off = 0, n = 1; off < f.size || n === 1; off += st.part, n++) {
        parts.push(await relayPart(`/send/${st.id}/${n}`, f.slice(off, off + st.part), (l) => { FD.up = Math.floor((before + off + l) / total * 100); render(); }));
        if (!f.size) break;
      }
      await relayCall('POST', `/send/${st.id}/done`, { parts });
      before += f.size;
    }
    FD.files = []; FD.text = '';
    FD.sent = `Sent. It reaches ${dropName(to)} when your PC is back on.`;
  } catch (e) { FD.err = e.message; }
  FD.up = -1; render();
}
