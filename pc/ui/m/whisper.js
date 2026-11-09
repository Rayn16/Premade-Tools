// Transcribe on the phone: Whisper (base, multilingual) running in this worker. The model (about 80 MB) downloads
// from Hugging Face the first time and the browser keeps it, so later runs work with no signal.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
let asr = null;

self.onmessage = async ({ data: { id, audio, task, lang } }) => {
  try {
    asr ||= await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
      dtype: 'q8', device: 'wasm', progress_callback: (p) => self.postMessage({ id, load: p }),
    });
    // The spoken language must be named: this Whisper doesn't hear it by itself and takes everything for English.
    const out = await asr(audio, { task, language: lang, return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, out: { text: out.text, chunks: out.chunks } });
  } catch (e) {
    self.postMessage({ id, err: /fetch|network|load/i.test(String(e?.message)) && !asr ? 'The speech engine (about 80 MB) needs the internet the first time. Try again with a signal.' : String(e?.message || e) });
  }
};
