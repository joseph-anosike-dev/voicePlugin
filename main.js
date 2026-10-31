'use strict';

/*
 * Voice: high-fidelity voice recording for Obsidian.
 *
 *  - Record / Pause / Resume / Stop / Discard controls live in the note header.
 *  - Browser voice DSP (echo cancellation, noise suppression, auto gain) is OFF by default.
 *  - WAV and FLAC are captured as raw PCM through an AudioWorklet (ScriptProcessor fallback).
 *  - WebM/Opus uses MediaRecorder with an explicit bitrate.
 *  - The file is saved with Obsidian's attachment settings and embedded at the cursor.
 */

const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require('obsidian');

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  deviceId: '',                 // '' = system default microphone
  format: 'wav',                // wav | flac | webm
  sampleRate: 0,                // 0 = system default, else 44100 / 48000
  bitrate: 320,                 // kbps, WebM/Opus only (128 | 256 | 320)
  noiseSuppression: false,
  echoCancellation: false,
  autoGainControl: false,
  filenameTemplate: 'Audio_{YYYY}{MM}{DD}_{HH}{mm}{ss}',
};

const FORMAT_LABELS = {
  wav: 'WAV (uncompressed PCM)',
  flac: 'FLAC (lossless)',
  webm: 'WebM / Opus (compressed)',
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function renderFilename(template, date) {
  const d = date || new Date();
  const p = (n, len) => String(n).padStart(len || 2, '0');
  const map = {
    YYYY: p(d.getFullYear(), 4),
    YY: p(d.getFullYear() % 100),
    MM: p(d.getMonth() + 1),
    DD: p(d.getDate()),
    HH: p(d.getHours()),
    mm: p(d.getMinutes()),
    ss: p(d.getSeconds()),
    SSS: p(d.getMilliseconds(), 3),
  };
  const out = String(template || '')
    .replace(/\{(YYYY|YY|MM|DD|HH|mm|ss|SSS)\}/g, (_, key) => map[key])
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (out) return out;
  return 'Audio_' + map.YYYY + map.MM + map.DD + '_' + map.HH + map.mm + map.ss;
}

function formatClock(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

function describeMicError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'microphone access was denied. Allow it in your system privacy settings.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no usable microphone was found.';
  if (name === 'NotReadableError') return 'the microphone is busy or unavailable.';
  return (e && e.message) || String(e);
}

const RECORDER_MIMES = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/mp4', ext: 'm4a' },
];

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const c of RECORDER_MIMES) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * WAV encoder (16-bit PCM, mono)
 * ------------------------------------------------------------------ */

function encodeWav(chunks, totalSamples, sampleRate) {
  const dataBytes = totalSamples * 2;
  if (36 + dataBytes > 0xFFFFFFFF) throw new Error('Recording is too long for a WAV file.');
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const tag = (offset, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt chunk size
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  tag(36, 'data');
  dv.setUint32(40, dataBytes, true);
  const pcm = new Int16Array(buf, 44, totalSamples);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * FLAC encoder (lossless, mono, 16-bit, fixed predictors + Rice coding)
 * ------------------------------------------------------------------ */

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
    t[i] = c;
  }
  return t;
})();

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? (((c << 1) ^ 0x8005) & 0xFFFF) : ((c << 1) & 0xFFFF);
    t[i] = c;
  }
  return t;
})();

function crc8(buf, len) {
  let c = 0;
  for (let i = 0; i < len; i++) c = CRC8_TABLE[c ^ buf[i]];
  return c;
}

function crc16(buf, len) {
  let c = 0;
  for (let i = 0; i < len; i++) c = ((c << 8) & 0xFFFF) ^ CRC16_TABLE[((c >> 8) ^ buf[i]) & 0xFF];
  return c;
}

class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity || 4096);
    this.len = 0;
    this.acc = 0;
    this.nacc = 0;
  }

  reset() {
    this.len = 0;
    this.acc = 0;
    this.nacc = 0;
  }

  pushByte(b) {
    if (this.len === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = b;
  }

  // Write the low n bits of v (0 <= n <= 24).
  bits(v, n) {
    if (n === 0) return;
    this.acc = (this.acc << n) | (v & ((1 << n) - 1));
    this.nacc += n;
    while (this.nacc >= 8) {
      this.nacc -= 8;
      this.pushByte((this.acc >>> this.nacc) & 0xFF);
    }
    this.acc &= (1 << this.nacc) - 1;
  }

  // q zero bits followed by a one bit.
  unary(q) {
    while (q >= 24) {
      this.bits(0, 24);
      q -= 24;
    }
    this.bits(1, q + 1);
  }

  align() {
    if (this.nacc) this.bits(0, 8 - this.nacc);
  }

  bytes() {
    return this.buf.subarray(0, this.len);
  }
}

// FLAC's UTF-8 style variable-length number (used for the frame number).
function writeCodedNumber(w, n) {
  if (n < 0x80) {
    w.bits(n, 8);
    return;
  }
  const nbytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  const payloadBits = 7 - nbytes;
  const first = ((0xFF00 >> nbytes) & 0xFF)
    | (Math.floor(n / Math.pow(2, 6 * (nbytes - 1))) & ((1 << payloadBits) - 1));
  w.bits(first, 8);
  for (let i = nbytes - 2; i >= 0; i--) {
    w.bits(0x80 | (Math.floor(n / Math.pow(2, 6 * i)) & 0x3F), 8);
  }
}

const FLAC_BLOCK = 4096;
const FLAC_RES = [0, 1, 2, 3, 4].map(() => new Int32Array(FLAC_BLOCK));
const FLAC_U = new Uint32Array(FLAC_BLOCK);
const FLAC_PREFIX = new Float64Array(FLAC_BLOCK + 1);
const FLAC_K = new Uint8Array(64);

function riceParam(sum, count) {
  if (count <= 0 || sum <= 0) return 0;
  const k = Math.round(Math.log2((sum / count) * 0.6931471805599453));
  return k < 0 ? 0 : k > 14 ? 14 : k;
}

function encodeSubframe(w, x) {
  const n = x.length;

  // Constant block (digital silence): one sample value.
  let same = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== x[0]) { same = false; break; }
  }
  if (same) {
    w.bits(0, 8);
    w.bits(x[0] & 0xFFFF, 16);
    return;
  }

  // Pick the fixed predictor order (0-4) with the smallest residual magnitude.
  const maxOrder = Math.min(4, n - 1);
  for (let i = 0; i < n; i++) FLAC_RES[0][i] = x[i];
  let order = 0;
  let bestSum = Infinity;
  for (let o = 0; o <= maxOrder; o++) {
    const cur = FLAC_RES[o];
    if (o > 0) {
      const prev = FLAC_RES[o - 1];
      for (let i = o; i < n; i++) cur[i] = prev[i] - prev[i - 1];
    }
    let s = 0;
    for (let i = o; i < n; i++) s += cur[i] < 0 ? -cur[i] : cur[i];
    if (s < bestSum) { bestSum = s; order = o; }
  }

  // Zig-zag the residuals and build a prefix sum for fast partition costs.
  const res = FLAC_RES[order];
  const m = n - order;
  FLAC_PREFIX[0] = 0;
  for (let i = 0; i < m; i++) {
    const v = res[order + i];
    const u = ((v << 1) ^ (v >> 31)) >>> 0;
    FLAC_U[i] = u;
    FLAC_PREFIX[i + 1] = FLAC_PREFIX[i] + u;
  }

  // Choose the Rice partition order by estimated cost.
  let bestP = 0;
  let bestEst = Infinity;
  for (let p = 0; p <= 6; p++) {
    const parts = 1 << p;
    if (n % parts !== 0 || (n >> p) <= order) break;
    const psize = n >> p;
    let est = 0;
    for (let j = 0; j < parts; j++) {
      const s0 = j === 0 ? 0 : j * psize - order;
      const s1 = (j + 1) * psize - order;
      const sum = FLAC_PREFIX[s1] - FLAC_PREFIX[s0];
      const k = riceParam(sum, s1 - s0);
      est += 4 + (s1 - s0) * (k + 1) + Math.floor(sum / (1 << k));
    }
    if (est < bestEst) { bestEst = est; bestP = p; }
  }

  // Exact cost of the chosen layout, to compare with a verbatim block.
  const parts = 1 << bestP;
  const psize = n >> bestP;
  let fixedBits = 8 + order * 16 + 2 + 4;
  for (let j = 0; j < parts; j++) {
    const s0 = j === 0 ? 0 : j * psize - order;
    const s1 = (j + 1) * psize - order;
    const k = riceParam(FLAC_PREFIX[s1] - FLAC_PREFIX[s0], s1 - s0);
    FLAC_K[j] = k;
    let q = 0;
    for (let i = s0; i < s1; i++) q += FLAC_U[i] >>> k;
    fixedBits += 4 + (s1 - s0) * (k + 1) + q;
  }

  if (fixedBits >= 8 + n * 16) {
    // Verbatim: raw samples.
    w.bits(2, 8);
    for (let i = 0; i < n; i++) w.bits(x[i] & 0xFFFF, 16);
    return;
  }

  w.bits(16 + 2 * order, 8);                         // 0 | 001ooo | 0
  for (let i = 0; i < order; i++) w.bits(x[i] & 0xFFFF, 16);
  w.bits(0, 2);                                      // Rice, 4-bit parameters
  w.bits(bestP, 4);
  for (let j = 0; j < parts; j++) {
    const s0 = j === 0 ? 0 : j * psize - order;
    const s1 = (j + 1) * psize - order;
    const k = FLAC_K[j];
    w.bits(k, 4);
    const mask = (1 << k) - 1;
    for (let i = s0; i < s1; i++) {
      const u = FLAC_U[i];
      w.unary(u >>> k);
      if (k) w.bits(u & mask, k);
    }
  }
}

function encodeFlacFrame(fw, x, frameNumber) {
  fw.reset();
  fw.bits(0x3FFE, 14);                 // sync code
  fw.bits(0, 1);                       // reserved
  fw.bits(0, 1);                       // fixed block size
  const standard = x.length === FLAC_BLOCK;
  fw.bits(standard ? 12 : 7, 4);       // 4096 samples, or 16-bit size at end of header
  fw.bits(0, 4);                       // sample rate: see STREAMINFO
  fw.bits(0, 4);                       // mono
  fw.bits(4, 3);                       // 16 bits per sample
  fw.bits(0, 1);                       // reserved
  writeCodedNumber(fw, frameNumber);
  if (!standard) fw.bits(x.length - 1, 16);
  fw.bits(crc8(fw.buf, fw.len), 8);
  encodeSubframe(fw, x);
  fw.align();
  fw.bits(crc16(fw.buf, fw.len), 16);
  return fw.bytes();
}

async function encodeFlac(pcm, sampleRate) {
  const total = pcm.length;
  const head = new BitWriter(64);
  for (const ch of 'fLaC') head.bits(ch.charCodeAt(0), 8);
  head.bits(0x80, 8);                  // last metadata block, type STREAMINFO
  head.bits(34, 24);
  const bs = Math.max(16, Math.min(FLAC_BLOCK, total));
  head.bits(bs, 16);                   // min block size
  head.bits(bs, 16);                   // max block size
  head.bits(0, 24);                    // min frame size (unknown)
  head.bits(0, 24);                    // max frame size (unknown)
  head.bits(sampleRate, 20);
  head.bits(0, 3);                     // channels - 1
  head.bits(15, 5);                    // bits per sample - 1
  const totalMod = total % 4294967296;
  head.bits(Math.floor(total / 4294967296) & 0xF, 4);
  head.bits((totalMod >>> 16) & 0xFFFF, 16);
  head.bits(totalMod & 0xFFFF, 16);
  for (let i = 0; i < 16; i++) head.bits(0, 8);   // MD5 (not computed)

  const parts = [head.bytes().slice()];
  const fw = new BitWriter(1 << 15);
  let frameNumber = 0;
  for (let pos = 0; pos < total; pos += FLAC_BLOCK) {
    const x = pcm.subarray(pos, Math.min(pos + FLAC_BLOCK, total));
    parts.push(encodeFlacFrame(fw, x, frameNumber++).slice());
    if ((frameNumber & 63) === 0) await new Promise((r) => setTimeout(r, 0));   // keep the UI alive
  }

  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Capture engines
 * ------------------------------------------------------------------ */

// Runs on the audio thread. Batches 4096 samples per message; pause/flush
// are handled here so no stale audio leaks across a pause.
const WORKLET_SRC = `
class VoicePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.paused = false;
    this.port.onmessage = (e) => {
      if (e.data === 'pause') { this.flush(); this.paused = true; }
      else if (e.data === 'resume') { this.paused = false; }
      else if (e.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.n = 0;
      this.port.postMessage({ pcm: out }, [out.buffer]);
    }
  }
  process(inputs) {
    if (this.paused) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('voice-pcm-capture', VoicePcmCapture);
`;

class CaptureBase {
  constructor(settings) {
    this.s = settings;
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.levelBuf = null;
    this.nodes = [];
    this.onEnded = null;
    this.t0 = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
  }

  get paused() { return this.pausedAt !== 0; }

  get elapsedMs() {
    if (!this.t0) return 0;
    return Math.max(0, (this.pausedAt || Date.now()) - this.t0 - this.pausedTotal);
  }

  markStarted() { this.t0 = Date.now(); this.pausedAt = 0; this.pausedTotal = 0; }
  markPaused() { if (!this.pausedAt) this.pausedAt = Date.now(); }
  markResumed() {
    if (this.pausedAt) {
      this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = 0;
    }
  }

  // Ask for the raw microphone signal: every browser DSP stage is explicit.
  async openStream() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) throw new Error('Microphone access is not available here.');
    const s = this.s;
    const audio = {
      echoCancellation: s.echoCancellation === true,
      noiseSuppression: s.noiseSuppression === true,
      autoGainControl: s.autoGainControl === true,
      channelCount: { ideal: 1 },
    };
    const rate = Number(s.sampleRate) || 0;
    if (rate) audio.sampleRate = { ideal: rate };

    try {
      const withDevice = s.deviceId ? Object.assign({}, audio, { deviceId: { exact: s.deviceId } }) : audio;
      this.stream = await md.getUserMedia({ audio: withDevice });
    } catch (e) {
      if (s.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        new Notice('Voice: the selected microphone is unavailable, using the system default.');
        this.stream = await md.getUserMedia({ audio });
      } else {
        throw e;
      }
    }

    const track = this.stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => { if (this.onEnded) this.onEnded(); });
      console.debug('[voice] input settings', track.getSettings ? track.getSettings() : {});
    }
  }

  // Build an AudioContext (optionally at a fixed rate) with a level analyser.
  async openContext(rate) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available here.');
    const make = (r) => (r ? new AC({ sampleRate: r, latencyHint: 'interactive' }) : new AC({ latencyHint: 'interactive' }));

    let ctx;
    try { ctx = make(rate); } catch (e) { ctx = make(0); }
    let source;
    try {
      source = ctx.createMediaStreamSource(this.stream);
    } catch (e) {
      try { ctx.close(); } catch (_) { /* ignore */ }
      ctx = make(0);
      source = ctx.createMediaStreamSource(this.stream);
    }
    this.ctx = ctx;
    this.source = source;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) { /* ignore */ }
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    this.analyser = analyser;
    this.levelBuf = new Float32Array(analyser.fftSize);
    this.nodes.push(source, analyser);
  }

  // Peak amplitude (0..1) over the last analyser window.
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  teardown() {
    this.onEnded = null;
    for (const n of this.nodes) {
      try {
        if (n.port) n.port.onmessage = null;
        if ('onaudioprocess' in n) n.onaudioprocess = null;
        n.disconnect();
      } catch (_) { /* ignore */ }
    }
    this.nodes = [];
    if (this.stream) {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      try { this.ctx.close().catch(() => {}); } catch (_) { /* ignore */ }
    }
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.levelBuf = null;
  }
}

// Raw 16-bit PCM capture, encoded to WAV or FLAC on stop.
class PcmEngine extends CaptureBase {
  constructor(settings, format) {
    super(settings);
    this.format = format;           // 'wav' | 'flac'
    this.chunks = [];
    this.samples = 0;
    this.sampleRate = 48000;
    this.worklet = null;
    this.flushDone = null;
  }

  async start() {
    try {
      await this.openStream();
      await this.openContext(Number(this.s.sampleRate) || 0);
      this.sampleRate = this.ctx.sampleRate;
      await this.attachCapture();
    } catch (e) {
      this.teardown();
      throw e;
    }
    this.markStarted();
  }

  async attachCapture() {
    const ctx = this.ctx;
    // Zero-gain sink keeps the graph "pulled" without playing the mic back.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.nodes.push(sink);

    let node = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        node = new AudioWorkletNode(ctx, 'voice-pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
        });
        node.port.onmessage = (e) => this.onMessage(e.data);
        this.worklet = node;
      } catch (err) {
        console.warn('[voice] AudioWorklet unavailable, falling back to ScriptProcessor', err);
        node = null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    if (!node) {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (!this.paused) this.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
    }
    this.source.connect(node);
    node.connect(sink);
    this.nodes.push(node);
  }

  onMessage(d) {
    if (!d) return;
    if (d.pcm) this.push(d.pcm);
    else if (d.flushed && this.flushDone) this.flushDone();
  }

  // Float32 -> Int16, stored immediately so memory stays at ~5.5 MB/min at 48 kHz.
  push(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7FFF);
    }
    this.chunks.push(out);
    this.samples += out.length;
  }

  pause() {
    this.markPaused();
    if (this.worklet) this.worklet.port.postMessage('pause');
  }

  resume() {
    this.markResumed();
    if (this.worklet) this.worklet.port.postMessage('resume');
  }

  async stop() {
    if (this.worklet) {
      await new Promise((resolve) => {
        this.flushDone = resolve;
        this.worklet.port.postMessage('flush');
        setTimeout(resolve, 500);
      });
    }
    const durationMs = this.elapsedMs;
    const rate = this.sampleRate;
    const chunks = this.chunks;
    const total = this.samples;
    this.chunks = [];
    this.samples = 0;
    this.teardown();
    if (!total) return null;

    if (this.format === 'flac') {
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      chunks.length = 0;
      const bytes = await encodeFlac(merged, rate);
      return { data: bytes.buffer, ext: 'flac', durationMs };
    }
    return { data: encodeWav(chunks, total, rate), ext: 'wav', durationMs };
  }

  discard() {
    this.chunks = [];
    this.samples = 0;
    this.teardown();
  }
}

// Compressed capture: MediaRecorder at an explicit Opus bitrate.
class RecorderEngine extends CaptureBase {
  constructor(settings, pick) {
    super(settings);
    this.pick = pick;
    this.rec = null;
    this.parts = [];
  }

  async start() {
    try {
      await this.openStream();
      try { await this.openContext(0); } catch (e) { /* the level meter is optional */ }
      this.rec = new MediaRecorder(this.stream, {
        mimeType: this.pick.mime,
        audioBitsPerSecond: (Number(this.s.bitrate) || 320) * 1000,
      });
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.parts.push(e.data); };
      this.rec.start(1000);
    } catch (e) {
      this.teardown();
      throw e;
    }
    this.markStarted();
  }

  pause() {
    if (this.rec && this.rec.state === 'recording') {
      this.rec.pause();
      this.markPaused();
    }
  }

  resume() {
    if (this.rec && this.rec.state === 'paused') {
      this.rec.resume();
      this.markResumed();
    }
  }

  stop() {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      const durationMs = this.elapsedMs;
      const finish = async () => {
        try {
          const blob = new Blob(this.parts, { type: this.pick.mime });
          this.parts = [];
          this.teardown();
          if (!blob.size) { resolve(null); return; }
          resolve({ data: await blob.arrayBuffer(), ext: this.pick.ext, durationMs });
        } catch (e) {
          reject(e);
        }
      };
      if (!rec || rec.state === 'inactive') { finish(); return; }
      rec.onstop = finish;
      try { rec.stop(); } catch (e) { finish(); }
    });
  }

  discard() {
    if (this.rec) {
      this.rec.ondataavailable = null;
      this.rec.onstop = null;
      try { if (this.rec.state !== 'inactive') this.rec.stop(); } catch (_) { /* ignore */ }
    }
    this.rec = null;
    this.parts = [];
    this.teardown();
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

class VoicePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.engine = null;
    this.state = 'idle';            // idle | recording | paused | saving
    this.busy = false;
    this.unloaded = false;
    this.targetFile = null;
    this.discardArmed = false;
    this.armTimer = 0;
    this.levelDisp = 0;
    this.clipUntil = 0;
    this.headers = new WeakMap();   // view -> { state, els }

    this.statusEl = this.addStatusBarItem();
    this.statusEl.classList.add('voice-status');
    this.registerDomEvent(this.statusEl, 'click', () => this.stopRecording());

    this.addCommand({
      id: 'toggle-recording',
      name: 'Start or stop recording',
      callback: () => (this.engine ? this.stopRecording() : this.startRecording()),
    });
    this.addCommand({
      id: 'pause-resume',
      name: 'Pause or resume recording',
      checkCallback: (checking) => {
        if (!this.isLive()) return false;
        if (!checking) this.togglePause();
        return true;
      },
    });
    this.addCommand({
      id: 'discard',
      name: 'Discard recording',
      checkCallback: (checking) => {
        if (!this.isLive()) return false;
        if (!checking) this.discardRecording();
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncAll()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncAll()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.syncAll()));
    this.app.workspace.onLayoutReady(() => this.syncAll());
    this.registerInterval(window.setInterval(() => this.tick(), 100));

    this.addSettingTab(new VoiceSettingTab(this.app, this));
  }

  onunload() {
    this.unloaded = true;
    window.clearTimeout(this.armTimer);
    if (this.engine) {
      const engine = this.engine;
      this.engine = null;
      engine.discard();              // stops tracks, disconnects nodes, closes the AudioContext
      new Notice('Voice: the unfinished recording was discarded because the plugin was unloaded.');
    }
    this.queryAll('.voice-ctl').forEach((el) => el.remove());
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    const s = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!FORMAT_LABELS[s.format]) s.format = DEFAULT_SETTINGS.format;
    s.sampleRate = [0, 44100, 48000].includes(Number(s.sampleRate)) ? Number(s.sampleRate) : 0;
    s.bitrate = [128, 256, 320].includes(Number(s.bitrate)) ? Number(s.bitrate) : 320;
    this.settings = s;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---- State + header UI ---- */

  isLive() {
    return !!this.engine && (this.state === 'recording' || this.state === 'paused');
  }

  setState(state) {
    this.state = state;
    this.disarmDiscard();
    this.levelDisp = 0;
    this.syncAll();
    const live = state === 'recording' || state === 'paused';
    this.statusEl.classList.toggle('is-active', live);
    if (!live) this.statusEl.textContent = '';
    this.tick();
  }

  eachView(fn) {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) fn(leaf.view);
    });
  }

  queryAll(selector) {
    const found = [];
    this.eachView((view) => view.containerEl.querySelectorAll(selector).forEach((el) => found.push(el)));
    return found;
  }

  syncAll() {
    this.eachView((view) => this.syncView(view));
  }

  // Keep one set of header actions per note view, matching the current state.
  syncView(view) {
    const want = this.state;
    const cur = this.headers.get(view);
    if (cur && cur.state === want && cur.els.length && cur.els.every((el) => el.isConnected)) return;
    if (cur) cur.els.forEach((el) => el.remove());

    const buttons = [];
    const add = (icon, title, cls, fn) => {
      const el = view.addAction(icon, title, fn);
      el.classList.add('voice-ctl', cls);
      buttons.push(el);
      return el;
    };

    const live = want === 'recording' || want === 'paused';
    if (want === 'idle') {
      add('mic', 'Record voice note', 'voice-record', () => this.startRecording(view));
    } else if (want === 'saving') {
      add('loader', 'Saving recording…', 'voice-saving', () => {});
    } else {
      const paused = want === 'paused';
      add(paused ? 'play' : 'pause', paused ? 'Resume recording' : 'Pause recording', 'voice-pause', () => this.togglePause());
      add('square', 'Stop and insert recording', 'voice-stop', () => this.stopRecording());
      add('trash-2', 'Discard recording', 'voice-discard', () => this.discardRecording());
    }

    const ordered = buttons.slice();
    const bar = buttons[0] && buttons[0].parentElement;
    if (bar && live) {
      const doc = view.containerEl.ownerDocument;
      const timer = doc.createElement('span');
      timer.className = 'voice-ctl voice-timer ' + (want === 'paused' ? 'is-paused' : 'is-recording');
      timer.textContent = formatClock(this.engine ? this.engine.elapsedMs : 0);
      const meter = doc.createElement('span');
      meter.className = 'voice-ctl voice-meter';
      const fill = doc.createElement('span');
      fill.className = 'voice-meter-fill';
      meter.appendChild(fill);
      ordered.unshift(meter, timer);
    }
    if (bar) {
      for (let i = ordered.length - 1; i >= 0; i--) bar.prepend(ordered[i]);
    }
    this.headers.set(view, { state: want, els: ordered });
  }

  // 10 Hz: clock, status bar, and input level.
  tick() {
    if (!this.isLive()) return;
    const clock = formatClock(this.engine.elapsedMs);
    this.queryAll('.voice-timer').forEach((el) => { if (el.textContent !== clock) el.textContent = clock; });
    this.statusEl.textContent = (this.state === 'paused' ? '⏸ ' : '● ') + clock;

    const peak = this.state === 'recording' ? this.engine.level() : 0;
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    this.levelDisp = Math.max(level, this.levelDisp - 0.1);
    if (peak >= 0.99) this.clipUntil = Date.now() + 1500;
    const clipping = Date.now() < this.clipUntil;
    this.queryAll('.voice-meter-fill').forEach((el) => {
      el.style.setProperty('--voice-level', this.levelDisp.toFixed(3));
      el.classList.toggle('is-clipping', clipping);
    });
  }

  /* ---- Recording lifecycle ---- */

  createEngine() {
    const s = this.settings;
    if (s.format === 'webm') {
      const pick = pickRecorderMime();
      if (pick) return new RecorderEngine(s, pick);
      new Notice('Voice: Opus recording is not supported here, recording WAV instead.');
      return new PcmEngine(s, 'wav');
    }
    return new PcmEngine(s, s.format === 'flac' ? 'flac' : 'wav');
  }

  async startRecording(fromView) {
    if (this.state !== 'idle' || this.busy) return;
    const view = fromView || this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view && view.file;
    if (!file) {
      new Notice('Voice: open a note first so the recording has somewhere to go.');
      return;
    }

    this.busy = true;
    const engine = this.createEngine();
    try {
      await engine.start();
    } catch (e) {
      engine.discard();
      this.busy = false;
      console.error('[voice] could not start recording', e);
      new Notice('Voice: ' + describeMicError(e));
      return;
    }
    this.busy = false;
    if (this.unloaded) {
      engine.discard();
      return;
    }

    engine.onEnded = () => {
      new Notice('Voice: the microphone was disconnected. Saving what was recorded.');
      this.stopRecording();
    };
    this.engine = engine;
    this.targetFile = file;
    this.setState('recording');
  }

  togglePause() {
    if (!this.engine) return;
    if (this.state === 'recording') {
      this.engine.pause();
      this.setState('paused');
    } else if (this.state === 'paused') {
      this.engine.resume();
      this.setState('recording');
    }
  }

  async stopRecording() {
    if (!this.isLive()) return;
    const engine = this.engine;
    this.engine = null;
    engine.onEnded = null;
    this.setState('saving');
    try {
      const out = await engine.stop();
      if (!out) {
        new Notice('Voice: nothing was recorded.');
      } else {
        await this.saveAndInsert(out);
      }
    } catch (e) {
      console.error('[voice] could not save recording', e);
      new Notice('Voice: could not save the recording. ' + ((e && e.message) || e));
    } finally {
      this.targetFile = null;
      if (!this.unloaded) this.setState('idle');
    }
  }

  // Two-step discard: first click arms it, second click within 3 s confirms.
  discardRecording() {
    if (!this.isLive()) return;
    if (!this.discardArmed) {
      this.discardArmed = true;
      this.queryAll('.voice-discard').forEach((el) => el.classList.add('is-armed'));
      new Notice('Voice: click discard again to delete this recording.', 3000);
      this.armTimer = window.setTimeout(() => this.disarmDiscard(), 3000);
      return;
    }
    const engine = this.engine;
    this.engine = null;
    this.targetFile = null;
    engine.discard();
    this.setState('idle');
    new Notice('Voice: recording discarded.');
  }

  disarmDiscard() {
    window.clearTimeout(this.armTimer);
    this.discardArmed = false;
    this.queryAll('.voice-discard').forEach((el) => el.classList.remove('is-armed'));
  }

  /* ---- Saving + insertion ---- */

  async saveAndInsert(out) {
    const file = this.targetFile;
    const sourcePath = file ? file.path : '';
    const filename = renderFilename(this.settings.filenameTemplate) + '.' + out.ext;

    // Respects "Default location for new attachments" and avoids name clashes.
    const path = await this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
    await this.ensureParent(path);
    const audio = await this.app.vault.createBinary(path, out.data);

    let linkText = audio.name;
    try { linkText = this.app.metadataCache.fileToLinktext(audio, sourcePath, false) || audio.name; } catch (_) { /* keep name */ }
    const inserted = await this.insertEmbed(file, '![[' + linkText + ']]');
    new Notice(inserted
      ? 'Voice: saved ' + audio.name
      : 'Voice: saved ' + audio.path + ' (the note is gone, so it was not embedded).');
  }

  async ensureParent(path) {
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return;
    let cur = '';
    for (const part of path.slice(0, idx).split('/')) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (_) { /* created in the meantime */ }
      }
    }
  }

  async insertEmbed(file, embed) {
    if (!file || !this.app.vault.getAbstractFileByPath(file.path)) return false;

    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    let view = active && active.file === file ? active : null;
    if (!view) {
      this.eachView((v) => { if (!view && v.file === file) view = v; });
    }

    if (view && view.getMode() === 'source') {
      view.editor.replaceSelection(embed);          // at the cursor
      return true;
    }
    await this.app.vault.process(file, (data) => data + (!data || data.endsWith('\n') ? '' : '\n') + embed + '\n');
    new Notice('Voice: that note is in reading view, so the recording was added at the end.');
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Settings tab
 * ------------------------------------------------------------------ */

class VoiceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.deviceDd = null;
  }

  hide() {
    this.deviceDd = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const plugin = this.plugin;
    const s = plugin.settings;
    const save = () => plugin.saveSettings();

    new Setting(containerEl).setName('Input').setHeading();

    const device = new Setting(containerEl)
      .setName('Input device')
      .setDesc('Microphone to record from. Use the refresh button to allow access and show device names.');
    device.addDropdown((dd) => {
      this.deviceDd = dd;
      dd.addOption('', 'System default');
      if (s.deviceId) dd.addOption(s.deviceId, 'Saved device');
      dd.setValue(s.deviceId || '');
      dd.onChange(async (v) => { s.deviceId = v; await save(); });
    });
    device.addExtraButton((btn) => btn
      .setIcon('refresh-cw')
      .setTooltip('Refresh devices')
      .onClick(() => this.loadDevices(true)));
    this.loadDevices(false);

    new Setting(containerEl).setName('Format').setHeading();

    new Setting(containerEl)
      .setName('Audio format')
      .setDesc('WAV and FLAC are lossless. WebM/Opus is smaller but compressed.')
      .addDropdown((dd) => dd
        .addOptions(FORMAT_LABELS)
        .setValue(s.format)
        .onChange(async (v) => {
          s.format = v;
          await save();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Sample rate')
      .setDesc('Most microphones run at 48 kHz natively. A different rate is resampled by the browser. Opus always encodes at 48 kHz internally.')
      .addDropdown((dd) => dd
        .addOptions({ 0: 'System default', 44100: '44.1 kHz', 48000: '48 kHz' })
        .setValue(String(s.sampleRate))
        .onChange(async (v) => { s.sampleRate = Number(v); await save(); }));

    new Setting(containerEl)
      .setName('Opus bitrate')
      .setDesc('Only used for WebM/Opus. WAV and FLAC ignore it.')
      .addDropdown((dd) => dd
        .addOptions({ 128: '128 kbps', 256: '256 kbps', 320: '320 kbps' })
        .setValue(String(s.bitrate))
        .setDisabled(s.format !== 'webm')
        .onChange(async (v) => { s.bitrate = Number(v); await save(); }));

    new Setting(containerEl).setName('Browser audio processing').setHeading();
    containerEl.createEl('p', {
      text: 'Chromium applies these voice filters by default. They are off here so you get the raw microphone signal.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Noise suppression')
      .addToggle((t) => t.setValue(s.noiseSuppression).onChange(async (v) => { s.noiseSuppression = v; await save(); }));
    new Setting(containerEl)
      .setName('Echo cancellation')
      .addToggle((t) => t.setValue(s.echoCancellation).onChange(async (v) => { s.echoCancellation = v; await save(); }));
    new Setting(containerEl)
      .setName('Auto gain control')
      .addToggle((t) => t.setValue(s.autoGainControl).onChange(async (v) => { s.autoGainControl = v; await save(); }));

    new Setting(containerEl).setName('Files').setHeading();

    const nameSetting = new Setting(containerEl).setName('Filename template');
    const describeName = () => {
      const ext = s.format === 'webm' ? 'webm' : s.format;
      nameSetting.setDesc(
        'Tokens: {YYYY} {YY} {MM} {DD} {HH} {mm} {ss} {SSS}. Example: '
        + renderFilename(s.filenameTemplate) + '.' + ext
        + '. Files go to your default attachment folder.',
      );
    };
    describeName();
    nameSetting.addText((text) => text
      .setPlaceholder(DEFAULT_SETTINGS.filenameTemplate)
      .setValue(s.filenameTemplate)
      .onChange(async (v) => {
        s.filenameTemplate = v.trim() || DEFAULT_SETTINGS.filenameTemplate;
        await save();
        describeName();
      }));
  }

  async loadDevices(askAccess) {
    const dd = this.deviceDd;
    const md = navigator.mediaDevices;
    if (!dd || !md || !md.enumerateDevices) return;
    try {
      let inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (askAccess && inputs.every((d) => !d.label)) {
        const probe = await md.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        inputs = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      }
      if (this.deviceDd !== dd) return;              // tab was closed meanwhile

      dd.selectEl.replaceChildren();
      dd.addOption('', 'System default');
      inputs.forEach((d, i) => {
        if (d.deviceId) dd.addOption(d.deviceId, d.label || 'Microphone ' + (i + 1));
      });
      const current = this.plugin.settings.deviceId;
      if (current && !inputs.some((d) => d.deviceId === current)) {
        dd.addOption(current, 'Saved device (not connected)');
      }
      dd.setValue(current || '');
    } catch (e) {
      if (askAccess) new Notice('Voice: ' + describeMicError(e));
    }
  }
}

module.exports = VoicePlugin;
