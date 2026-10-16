'use strict';
/* =====================================================================
 * 心語 — 人臉 × 語音 心情分析 Web App
 * 所有運算皆在瀏覽器端完成。
 * ===================================================================== */

/* ---------------------------------------------------------------- 常數 */
const EMO = [
  { k: 'joy',      n: '喜',   c: '#f5b301' },
  { k: 'anger',    n: '怒',   c: '#e5484d' },
  { k: 'sad',      n: '哀',   c: '#4c7ef3' },
  { k: 'pleasure', n: '樂',   c: '#2fb67c' },
  { k: 'calm',     n: '平靜', c: '#8b95a5' },
];
const EMO_BY_KEY = Object.fromEntries(EMO.map(e => [e.k, e]));
const MODEL_URI = 'vendor/models';

/* 以心理學「情緒誘發 / 自傳式回憶」設計的對話腳本:
 * 暖身(基準線) → 喜 → 怒 → 哀 → 樂 → 收尾(情緒修復) */
const SCRIPT = [
  { id: 'base', target: 'calm', title: '暖身 · 基準線', maxListen: 25,
    say: '你好,我是心語。先放鬆,深呼吸一下。請用幾句話告訴我,你今天的心情大概是幾分?一分最低、十分最好,為什麼?',
    reply: '謝謝你,我們慢慢開始。' },
  { id: 'joy', target: 'joy', title: '喜 · 開心的回憶', maxListen: 40,
    say: '請回想最近一次讓你開心到笑出來的事情,可能是一個好消息、一次成就,或是和朋友的趣事。當時發生了什麼?你有什麼感覺?',
    reply: '聽起來那是很棒的時刻。' },
  { id: 'anger', target: 'anger', title: '怒 · 不公平的經驗', maxListen: 40,
    say: '接下來,請想一件讓你覺得不公平、被誤解,或是真的很生氣的事。可以只說你願意說的部分,當時你怎麼想、怎麼反應?',
    reply: '謝謝你願意分享,這種感受很真實。' },
  { id: 'sad', target: 'sad', title: '哀 · 失落與想念', maxListen: 40,
    say: '再來,想一個讓你難過、遺憾,或是很想念的人事物。如果你願意,說說它對你的意義,以及現在想起它的感受。',
    reply: '我聽到了,謝謝你信任我。' },
  { id: 'pleasure', target: 'pleasure', title: '樂 · 放鬆與享受', maxListen: 40,
    say: '最後一個回憶。請描述一個能讓你完全放鬆、做起來樂在其中的活動或地方,讓你覺得很自在。你會怎麼享受它?',
    reply: '光是聽你描述,就覺得很放鬆。' },
  { id: 'close', target: 'calm', title: '收尾 · 情緒修復', maxListen: 20,
    say: '我們快結束了。深呼吸一下,最後請告訴我一件你現在感謝的事,或是你期待的小事。',
    reply: '謝謝你完成這次對話,辛苦了。報告馬上就好。' },
];

const POS_WORDS = ['開心','快樂','高興','幸福','滿意','喜歡','期待','感謝','有趣','放鬆','驕傲','溫暖','很棒','讚','好玩','成功','自在','享受','笑'];
const NEG_WORDS = ['生氣','憤怒','不公平','討厭','難過','傷心','失望','遺憾','後悔','痛苦','孤單','害怕','焦慮','壓力','委屈','想哭','崩潰','氣死','想念','失落'];

/* ---------------------------------------------------------------- 工具 */
const $ = id => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const fmt = (x, d = 1) => (x == null || Number.isNaN(x)) ? '–' : x.toFixed(d);
const pct = x => (x * 100).toFixed(0) + '%';
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

class Welford {
  constructor() { this.n = 0; this.m = 0; this.s = 0; }
  add(x) { this.n++; const d = x - this.m; this.m += d / this.n; this.s += d * (x - this.m); }
  get sd() { return this.n > 1 ? Math.sqrt(this.s / (this.n - 1)) : 0; }
  z(x) { return (this.n >= 40 && this.sd > 1e-6) ? clamp((x - this.m) / this.sd, -3, 3) : 0; }
}

/* ================================================================ 虛擬人 */
class Avatar {
  constructor(canvases) {
    this.canvases = canvases;
    this.speaking = false; this.t = 0; this.mouth = 0; this.smile = 0.2; this.worry = 0; this.blink = 0; this.nextBlink = 2;
    this.targetSmile = 0.2; this.targetWorry = 0; this.gaze = { x: 0, y: 0 };
    this.last = performance.now();
    requestAnimationFrame(() => this.loop());
  }
  setMirror(valence, arousal) { // 依使用者情緒給出同理的表情
    this.targetSmile = clamp(0.25 + valence * 0.6, 0, 1);
    this.targetWorry = clamp(-valence * 0.9, 0, 1);
  }
  loop() {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.t += dt;
    this.smile = lerp(this.smile, this.targetSmile, dt * 2);
    this.worry = lerp(this.worry, this.targetWorry, dt * 2);
    const open = this.speaking ? clamp(0.12 + 0.55 * Math.abs(Math.sin(this.t * 11) * Math.sin(this.t * 4.3 + 1)) + 0.1 * Math.random(), 0, 0.8) : 0;
    this.mouth = lerp(this.mouth, open, dt * 18);
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 1; this.nextBlink = 2 + Math.random() * 3; }
    this.blink = Math.max(0, this.blink - dt * 7);
    this.gaze.x = lerp(this.gaze.x, Math.sin(this.t * 0.7) * 2, dt);
    for (const c of this.canvases) { if (c.offsetParent !== null || c.id === 'avatar-user') this.draw(c); }
    requestAnimationFrame(() => this.loop());
  }
  draw(canvas) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.save(); ctx.clearRect(0, 0, W, H);
    ctx.scale(W / 300, H / 360);
    const sway = Math.sin(this.t * 0.9) * 2, breathe = Math.sin(this.t * 1.4) * 1.5;
    ctx.translate(sway, breathe);
    // 肩膀
    ctx.fillStyle = '#5b7fb5'; ctx.beginPath(); ctx.ellipse(150, 372, 125, 80, 0, Math.PI, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = '#e9ecf5'; ctx.beginPath(); ctx.moveTo(122, 292); ctx.lineTo(150, 322); ctx.lineTo(178, 292); ctx.closePath(); ctx.fill();
    // 脖子
    ctx.fillStyle = '#e9b994'; ctx.fillRect(128, 230, 44, 70);
    // 後髮
    ctx.fillStyle = '#35282a'; ctx.beginPath(); ctx.ellipse(150, 150, 90, 104, 0, 0, 2 * Math.PI); ctx.fill();
    // 臉
    ctx.fillStyle = '#f6d3b6'; ctx.beginPath(); ctx.ellipse(150, 158, 76, 90, 0, 0, 2 * Math.PI); ctx.fill();
    // 瀏海
    ctx.fillStyle = '#35282a'; ctx.beginPath();
    ctx.moveTo(70, 140); ctx.quadraticCurveTo(80, 52, 150, 50); ctx.quadraticCurveTo(222, 52, 232, 140);
    ctx.quadraticCurveTo(200, 98, 150, 96); ctx.quadraticCurveTo(100, 98, 70, 140); ctx.fill();
    // 腮紅
    ctx.fillStyle = `rgba(240,120,120,${0.1 + this.smile * 0.3})`;
    ctx.beginPath(); ctx.ellipse(104, 190, 14, 8, 0, 0, 2 * Math.PI); ctx.ellipse(196, 190, 14, 8, 0, 0, 2 * Math.PI); ctx.fill();
    // 眼睛
    const eo = (1 - this.blink) * (1 - 0.15 * this.smile);
    for (const ex of [114, 186]) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(ex, 160, 15, Math.max(1.5, 11 * eo), 0, 0, 2 * Math.PI); ctx.fill();
      if (eo > 0.2) {
        ctx.fillStyle = '#3b2a22'; ctx.beginPath(); ctx.arc(ex + this.gaze.x, 160, 7.5 * Math.min(1, eo + 0.3), 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + this.gaze.x + 2.5, 157, 2.2, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.strokeStyle = '#35282a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(ex, 160, 15, Math.max(1.5, 11 * eo), 0, Math.PI, 2 * Math.PI); ctx.stroke();
    }
    // 眉毛(擔心時內側上揚)
    ctx.strokeStyle = '#35282a'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    const inner = -this.worry * 9, by = 134 - this.smile * 3;
    ctx.beginPath(); ctx.moveTo(94, by - inner * 0.0 + 2); ctx.lineTo(132, by + inner); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(206, by + 2); ctx.lineTo(168, by + inner); ctx.stroke();
    // 鼻
    ctx.strokeStyle = '#d9a984'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(150, 170); ctx.quadraticCurveTo(144, 196, 152, 200); ctx.stroke();
    // 嘴
    const my = 226, mw = 24 + this.smile * 8, corner = my - this.smile * 9 + this.worry * 4, open = this.mouth * 26;
    ctx.beginPath(); ctx.moveTo(150 - mw, corner);
    ctx.quadraticCurveTo(150, my + 10 * this.smile - open * 0.2 + (open > 1 ? 0 : 0), 150 + mw, corner);
    if (open > 1.5) {
      ctx.quadraticCurveTo(150, my + open + 8 * this.smile, 150 - mw, corner);
      ctx.fillStyle = '#7a2e3a'; ctx.fill();
      ctx.fillStyle = '#f4f4f4'; ctx.fillRect(150 - mw * 0.55, corner + 0.5, mw * 1.1, Math.min(5, open * 0.3));
    }
    ctx.strokeStyle = '#b5524f'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(150 - mw, corner); ctx.quadraticCurveTo(150, my + 10 * this.smile, 150 + mw, corner); ctx.stroke();
    ctx.restore();
  }
}

/* ================================================================ 音訊引擎 */
class AudioEngine {
  constructor() {
    this.ctx = null; this.analyser = null; this.td = null; this.fd = null;
    this.noiseFloor = -70; this.env = 0; this.inPeak = false; this.peaks = [];
    this.f0Hist = []; this.dbHist = [];
    this.statDb = new Welford(); this.statF0 = new Welford(); this.statRate = new Welford();
    this.voice = { db: -100, level: 0, f0: null, f0sd: 0, cen: 0, zcr: 0, rate: 0, vad: false, lastVadT: -99, arousal: 0.5 };
    this.countMode = false; // 僅在「使用者作答中」才納入基準與覺醒度估計
  }
  async attach(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.6;
    src.connect(this.analyser);
    this.td = new Float32Array(this.analyser.fftSize);
    this.fd = new Float32Array(this.analyser.frequencyBinCount);
    this.sr = this.ctx.sampleRate;
  }
  /* 正規化自相關基頻偵測 70–400 Hz */
  pitch(buf) {
    const sr = this.sr, n = buf.length, minLag = Math.floor(sr / 400), maxLag = Math.min(Math.floor(sr / 70), n - 256);
    let e0 = 0; for (let i = 0; i < n - maxLag; i++) e0 += buf[i] * buf[i];
    if (e0 < 1e-7) return null;
    const r = new Float32Array(maxLag + 2); let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0, e1 = 0;
      for (let i = 0; i < n - maxLag; i++) { s += buf[i] * buf[i + lag]; e1 += buf[i + lag] * buf[i + lag]; }
      r[lag] = s / Math.sqrt(e0 * e1 + 1e-12); if (r[lag] > best) best = r[lag];
    }
    if (best < 0.5) return null;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (r[lag] >= 0.88 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
        const a = r[lag - 1], b = r[lag], c = r[lag + 1], d = a - 2 * b + c;
        const shift = d !== 0 ? 0.5 * (a - c) / d : 0;
        return sr / (lag + shift);
      }
    }
    return null;
  }
  step(now, listening) {
    if (!this.analyser) return this.voice;
    this.analyser.getFloatTimeDomainData(this.td);
    this.analyser.getFloatFrequencyData(this.fd);
    const buf = this.td, n = buf.length;
    let sum = 0, zc = 0;
    for (let i = 0; i < n; i++) { sum += buf[i] * buf[i]; if (i && (buf[i] >= 0) !== (buf[i - 1] >= 0)) zc++; }
    const rms = Math.sqrt(sum / n), db = Math.max(-100, 20 * Math.log10(rms + 1e-9));
    // 頻譜重心
    let num = 0, den = 0; const binHz = this.sr / this.analyser.fftSize;
    for (let i = 1; i < this.fd.length; i++) { const m = Math.pow(10, this.fd[i] / 20); num += m * i * binHz; den += m; }
    const cen = den > 0 ? num / den : 0;
    // 噪音底與 VAD(自適應)
    this.noiseFloor = db < this.noiseFloor ? lerp(this.noiseFloor, db, 0.2) : lerp(this.noiseFloor, db, 0.002);
    const vad = db > Math.max(-52, this.noiseFloor + 9);
    if (vad) this.voice.lastVadT = now;
    // 音節包絡(語速)
    this.env = lerp(this.env, rms, 0.35);
    const hi = Math.max(0.006, Math.pow(10, (this.noiseFloor + 12) / 20));
    if (!this.inPeak && this.env > hi * 1.15) { this.inPeak = true; this.peaks.push(now); }
    else if (this.inPeak && this.env < hi * 0.75) this.inPeak = false;
    this.peaks = this.peaks.filter(t => now - t < 3);
    const rate = this.peaks.length / 3;
    // 基頻
    let f0 = null;
    if (vad) f0 = this.pitch(buf);
    if (f0) { this.f0Hist.push(f0); if (this.f0Hist.length > 30) this.f0Hist.shift(); }
    else if (this.f0Hist.length && !vad) this.f0Hist.shift();
    if (vad) { this.dbHist.push(db); if (this.dbHist.length > 30) this.dbHist.shift(); }
    else if (this.dbHist.length) this.dbHist.shift();
    const semis = this.f0Hist.map(f => 12 * Math.log2(f / 100));
    const f0sd = std(semis);
    // 覺醒度:相對於說話者自身基準線的 z 分數
    if (listening && vad) {
      this.statDb.add(db); if (f0) this.statF0.add(12 * Math.log2(f0 / 100)); this.statRate.add(rate);
    }
    let arousal = 0.5;
    if (listening && this.dbHist.length > 5) {
      const zDb = this.statDb.z(mean(this.dbHist));
      const zF0 = this.f0Hist.length > 5 ? this.statF0.z(mean(semis)) : 0;
      const zRate = this.statRate.z(rate);
      const zVar = clamp((f0sd - 1.5) / 2, -1, 1.5);
      arousal = clamp(0.5 + 0.17 * zDb + 0.15 * zF0 + 0.1 * zRate + 0.1 * zVar, 0, 1);
    }
    Object.assign(this.voice, { db, level: clamp((db + 60) / 50), f0, f0sd, cen, zcr: zc / n, rate, vad, arousal });
    return this.voice;
  }
}

/* ================================================================ 人臉引擎 */
const FACE_PTS = {
  jaw: [0, 16], browL: [17, 21], browR: [22, 26], nose: [27, 35], eyeL: [36, 41], eyeR: [42, 47], mouth: [48, 59], lips: [60, 67],
};
function landmarkFeatures(pts, prev) {
  const faceW = dist(pts[0], pts[16]), faceH = dist(pts[27], pts[8]) || 1;
  const mar = dist(pts[62], pts[66]) / (dist(pts[60], pts[64]) || 1);
  const midY = (pts[62].y + pts[66].y) / 2, cornerY = (pts[48].y + pts[54].y) / 2;
  const smile = (midY - cornerY) / faceW;                    // 嘴角相對嘴中線上揚量
  const mouthW = dist(pts[48], pts[54]) / faceW;             // 嘴寬(微笑時變寬)
  const browRaise = (dist(pts[19], pts[37]) + dist(pts[24], pts[44])) / 2 / faceH;
  const furrow = dist(pts[21], pts[22]) / faceW;             // 眉間距(皺眉時縮小)
  const ear = e => (dist(pts[e + 1], pts[e + 5]) + dist(pts[e + 2], pts[e + 4])) / (2 * dist(pts[e], pts[e + 3]) || 1);
  const eyeOpen = (ear(36) + ear(42)) / 2;
  const roll = Math.atan2(pts[45].y - pts[36].y, pts[45].x - pts[36].x) * 180 / Math.PI;
  const yaw = ((pts[30].x - (pts[0].x + pts[16].x) / 2) / faceW);
  const cx = mean(pts.map(p => p.x)), cy = mean(pts.map(p => p.y));
  const motion = prev ? Math.hypot(cx - prev.cx, cy - prev.cy) / faceW : 0;
  return { mar, smile, mouthW, browRaise, furrow, eyeOpen, roll, yaw, motion, cx, cy, faceW };
}

/* ================================================================ 情緒融合 */
function fuse(face, voice, voiceActive) {
  const p = face.p, f = face.feat;
  const arousalFace = clamp(0.2 + 0.9 * (p.surprised + p.angry + p.fearful) + 0.4 * p.happy + 4 * f.motion + 0.5 * clamp(f.mar * 1.5), 0, 1);
  const arousal = voiceActive ? 0.5 * arousalFace + 0.5 * voice.arousal : arousalFace;
  const smileBoost = clamp(f.smile / 0.06);
  const happy = clamp(p.happy * 0.85 + 0.15 * smileBoost);
  const hi = clamp(0.25 + 0.75 * arousal);              // 高喚醒的愉悅 = 喜;低喚醒的愉悅 = 樂
  const raw = {
    joy: happy * hi + (happy > 0.2 ? 0.5 * p.surprised : 0),
    pleasure: happy * (1 - hi),
    anger: p.angry + 0.6 * p.disgusted,
    sad: p.sad + 0.6 * p.fearful,
    calm: p.neutral * 0.9,
  };
  if (voiceActive && voice.arousal > 0.65) raw.anger *= 1.25;
  if (voiceActive && voice.arousal < 0.35) raw.sad *= 1.2;
  const sum = Object.values(raw).reduce((s, x) => s + x, 0) || 1;
  const scores = {}; for (const k in raw) scores[k] = raw[k] / sum;
  const valence = clamp(p.happy + 0.2 * p.surprised - p.sad - p.angry - 0.5 * p.fearful - 0.5 * p.disgusted, -1, 1);
  return { scores, valence, arousal, arousalFace };
}

/* ================================================================ 全域狀態 */
const S = {
  mode: 'user', running: false, stream: null, T0: 0,
  opts: { stt: false, tts: true },
  audio: new AudioEngine(), avatar: null,
  models: { ready: false, error: null },
  lastFace: null, prevFeat: null, faceFps: 0, faceLatency: 0, faceFrames: 0, faceHits: 0,
  smooth: Object.fromEntries(EMO.map(e => [e.k, e.k === 'calm' ? 1 : 0])), smoothVal: 0, smoothAro: 0.3,
  samples: [], blinks: 0, blinkState: false,
  pipe: {},
  dlg: { i: -1, state: 'idle', t0: 0, voiceSec: 0, lastVoice: 0, nudged: false, skip: false, transcripts: [], ttsOk: false },
  texts: [], // {q, text}
  stt: null,
};

/* ================================================================ 處理管線狀態 */
const PIPE_DEF = [
  ['cam', '相機'], ['mic', '麥克風'], ['model', '人臉模型 (TinyFaceDetector / 68點 / 表情CNN)'], ['face', '人臉偵測'],
  ['expr', '表情分類 → 情緒機率'], ['audio', '音訊特徵擷取'], ['fusion', '多模態融合 (5 Hz)'], ['tts', '虛擬人語音 TTS'], ['stt', '語音轉文字 STT'],
];
function setPipe(key, state, detail = '') { S.pipe[key] = { state, detail }; }
function renderPipe() {
  const el = $('pipe'); if (!el.children.length) {
    el.innerHTML = PIPE_DEF.map(([k, n]) => `<div class="row" data-k="${k}"><span class="dot"></span><span>${n}</span><span class="detail"></span></div>`).join('')
      + `<div class="row"><span></span><span>FPS / 延遲</span><span class="detail" id="pipe-fps"></span></div>`;
  }
  for (const row of el.querySelectorAll('.row[data-k]')) {
    const p = S.pipe[row.dataset.k] || { state: '', detail: '待機' };
    row.querySelector('.dot').className = 'dot ' + p.state;
    row.querySelector('.detail').textContent = p.detail;
  }
  $('pipe-fps').textContent = `${fmt(S.faceFps, 1)} fps / ${fmt(S.faceLatency, 0)} ms`;
}

/* ================================================================ UI:分數條 */
function buildScores() {
  $('scores').innerHTML = EMO.map(e => `
    <div class="sc" data-k="${e.k}"><span class="nm" style="color:${e.c}">${e.n}</span>
    <span class="bar"><i style="background:${e.c}"></i></span><span class="num">0%</span></div>`).join('')
    + `<div class="sc-sep"></div>
    <div class="sc" data-k="valence"><span class="nm">效價</span><span class="bar"><i style="background:#9bd"></i></span><span class="num">0</span></div>
    <div class="sc" data-k="arousal"><span class="nm">覺醒</span><span class="bar"><i style="background:#d9b"></i></span><span class="num">0</span></div>
    <div class="dominant">目前主要情緒:<br><b id="dominant">–</b></div>`;
}
function renderScores() {
  let topK = null, top = -1;
  for (const e of EMO) if (S.smooth[e.k] > top) { top = S.smooth[e.k]; topK = e.k; }
  for (const e of EMO) {
    const row = document.querySelector(`.sc[data-k="${e.k}"]`);
    row.querySelector('i').style.width = pct(S.smooth[e.k]);
    row.querySelector('.num').textContent = pct(S.smooth[e.k]);
    row.classList.toggle('top', e.k === topK);
  }
  const v = document.querySelector('.sc[data-k="valence"]'), a = document.querySelector('.sc[data-k="arousal"]');
  v.querySelector('i').style.width = pct((S.smoothVal + 1) / 2); v.querySelector('.num').textContent = fmt(S.smoothVal, 2);
  a.querySelector('i').style.width = pct(S.smoothAro); a.querySelector('.num').textContent = fmt(S.smoothAro, 2);
  $('dominant').textContent = S.lastFace && performance.now() - S.lastFace.tt < 1000 ? `${EMO_BY_KEY[topK].n}(${pct(top)})` : '– (無人臉)';
}

/* ================================================================ UI:特徵說明表 */
function renderFeatTable() {
  const f = S.lastFace && performance.now() - S.lastFace.tt < 1000 ? S.lastFace : null, v = S.audio.voice;
  const F = f ? f.feat : null, P = f ? f.p : null;
  const row = (n, val, use) => `<tr><td>${n}</td><td class="v">${val}</td><td>${use}</td></tr>`;
  const hdr = t => `<tr class="grp"><td colspan="3">${t}</td></tr>`;
  $('feat-table').innerHTML = `<table>
    <tr><th>特徵</th><th>即時值</th><th>用來判斷</th></tr>
    ${hdr('臉部 · 表情分類 CNN(7 類機率)')}
    ${row('開心 / 驚訝', P ? `${pct(P.happy)} / ${pct(P.surprised)}` : '–', '→ 喜、樂(依覺醒度分高低)')}
    ${row('生氣 / 厭惡', P ? `${pct(P.angry)} / ${pct(P.disgusted)}` : '–', '→ 怒')}
    ${row('悲傷 / 恐懼', P ? `${pct(P.sad)} / ${pct(P.fearful)}` : '–', '→ 哀')}
    ${row('中性', P ? pct(P.neutral) : '–', '→ 平靜')}
    ${hdr('臉部 · 68 點特徵點幾何')}
    ${row('嘴角上揚量', F ? fmt(F.smile, 3) : '–', '微笑強度;輔助修正「開心」機率')}
    ${row('嘴開合 MAR', F ? fmt(F.mar, 2) : '–', '張嘴大笑/驚訝 → 提高覺醒度')}
    ${row('眉高 / 眉間距', F ? `${fmt(F.browRaise, 2)} / ${fmt(F.furrow, 2)}` : '–', '揚眉=驚訝;眉間縮小=皺眉(怒/專注)')}
    ${row('眼開度 EAR', F ? fmt(F.eyeOpen, 2) : '–', '睜大(驚訝)/ 眨眼率(緊張或疲勞)')}
    ${row('眨眼次數', S.blinks, '累計;短時間大量眨眼 → 緊張')}
    ${row('頭部運動', F ? fmt(F.motion * 100, 1) + '%' : '–', '大幅動作 → 提高覺醒度')}
    ${hdr('語音 · 聲學特徵(僅在受測者作答時)')}
    ${row('音量', fmt(v.db, 0) + ' dB', '相對自身基準的 z 分數 → 覺醒度')}
    ${row('音高 F0 / 變化', v.f0 ? `${fmt(v.f0, 0)} Hz / ${fmt(v.f0sd, 1)} st` : '–', '音高升高、起伏大 → 覺醒度高')}
    ${row('語速(音節/秒)', fmt(v.rate, 1), '說話變快 → 覺醒度高')}
    ${row('頻譜重心', fmt(v.cen, 0) + ' Hz', '聲音明亮度(緊張時偏高)')}
    ${row('語音覺醒度', fmt(v.arousal, 2), '與臉部覺醒度各佔 50% 融合')}
    ${hdr('語意(選用 STT)')}
    ${row('關鍵詞傾向', S.opts.stt ? fmt(textValence(S.dlg.transcripts.join('')), 2) : '未啟用', '正/負面詞比例,僅供報告參考')}
  </table>
  <div class="fusion-note">融合規則:表情機率決定「情緒類別」(效價),語音與臉部動作決定「強度」(覺醒度)。高覺醒的愉悅=喜,低覺醒的愉悅=樂;怒、哀由對應表情機率加權。分數經 EMA 平滑,每 0.2 秒取樣一次。</div>`;
}
function textValence(t) {
  let p = 0, n = 0; for (const w of POS_WORDS) if (t.includes(w)) p++; for (const w of NEG_WORDS) if (t.includes(w)) n++;
  return (p + n) ? (p - n) / (p + n) : 0;
}

/* ================================================================ UI:音訊面板 / LED */
function buildLed() { $('led').innerHTML = Array.from({ length: 24 }, (_, i) => `<i class="${i < 14 ? 'g' : i < 20 ? 'y' : 'r'}"></i>`).join(''); }
function renderLed(level) {
  const on = Math.round(level * 24);
  [...$('led').children].forEach((el, i) => el.classList.toggle('on', i < on));
}
function drawAudio() {
  const a = S.audio; if (!a.analyser) return;
  const w = $('wave'), wc = w.getContext('2d'); wc.fillStyle = '#0b1020'; wc.fillRect(0, 0, w.width, w.height);
  wc.strokeStyle = '#6aa8ff'; wc.lineWidth = 1.5; wc.beginPath();
  for (let i = 0; i < a.td.length; i += 2) { const x = i / a.td.length * w.width, y = w.height / 2 - a.td[i] * w.height * 2.2; i ? wc.lineTo(x, y) : wc.moveTo(x, y); }
  wc.stroke();
  const s = $('spec'), sc = s.getContext('2d'); sc.fillStyle = '#0b1020'; sc.fillRect(0, 0, s.width, s.height);
  const bins = Math.floor(a.fd.length * 0.35), bw = s.width / bins;
  for (let i = 0; i < bins; i++) {
    const h = clamp((a.fd[i] + 100) / 70) * s.height; sc.fillStyle = `hsl(${200 - h / s.height * 160},80%,55%)`; sc.fillRect(i * bw, s.height - h, Math.max(1, bw - 0.5), h);
  }
  $('meter-fill').style.width = pct(a.voice.level);
  const v = a.voice;
  $('audio-kv').innerHTML = [
    ['音量', fmt(v.db, 0) + ' dB'], ['噪音底', fmt(a.noiseFloor, 0) + ' dB'], ['語音偵測 VAD', v.vad ? '有聲' : '靜音'],
    ['音高 F0', v.f0 ? fmt(v.f0, 0) + ' Hz' : '–'], ['語速', fmt(v.rate, 1) + ' 音節/s'], ['頻譜重心', fmt(v.cen, 0) + ' Hz'],
    ['過零率', fmt(v.zcr, 3)], ['語音覺醒度', fmt(v.arousal, 2)],
  ].map(([k, x]) => `<div>${k}<b>${x}</b></div>`).join('');
}

/* ================================================================ 分析影像繪製 */
function drawAnalysis(det) {
  const cam = $('cam'), c = $('ana');
  if (c.width !== cam.videoWidth) { c.width = cam.videoWidth; c.height = cam.videoHeight; }
  const ctx = c.getContext('2d'); ctx.drawImage(cam, 0, 0, c.width, c.height);
  $('nofacebadge').hidden = !!det;
  if (!det) return;
  const b = det.detection.box, pts = det.landmarks.positions;
  ctx.lineWidth = 2; ctx.strokeStyle = '#6aa8ff'; ctx.strokeRect(b.x, b.y, b.width, b.height);
  const poly = (a, z, close, col) => { ctx.strokeStyle = col; ctx.beginPath(); for (let i = a; i <= z; i++) i === a ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y); if (close) ctx.closePath(); ctx.stroke(); };
  ctx.lineWidth = 1.5;
  poly(0, 16, false, '#9aa7c2'); poly(17, 21, false, '#facc15'); poly(22, 26, false, '#facc15'); poly(27, 30, false, '#9aa7c2'); poly(30, 35, false, '#9aa7c2');
  poly(36, 41, true, '#34d399'); poly(42, 47, true, '#34d399'); poly(48, 59, true, '#f87171'); poly(60, 67, true, '#fb923c');
  ctx.fillStyle = '#fff'; for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, 7); ctx.fill(); }
  // 標示關鍵量測線:嘴角連線、眉到眼距離
  ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ff6'; ctx.beginPath(); ctx.moveTo(pts[48].x, pts[48].y); ctx.lineTo(pts[54].x, pts[54].y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pts[19].x, pts[19].y); ctx.lineTo(pts[37].x, pts[37].y); ctx.moveTo(pts[24].x, pts[24].y); ctx.lineTo(pts[44].x, pts[44].y); ctx.stroke(); ctx.setLineDash([]);
}

/* ================================================================ 人臉偵測迴圈 */
async function faceLoop() {
  const cam = $('cam'); const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
  let fpsT = performance.now(), fpsN = 0;
  while (S.running) {
    const t0 = performance.now();
    if (cam.readyState >= 2 && cam.videoWidth) {
      try {
        const det = await faceapi.detectSingleFace(cam, opts).withFaceLandmarks(true).withFaceExpressions();
        S.faceLatency = performance.now() - t0; S.faceFrames++; fpsN++;
        if (det) {
          S.faceHits++;
          const pts = det.landmarks.positions, feat = landmarkFeatures(pts, S.prevFeat); S.prevFeat = feat;
          const p = det.expressions;
          S.lastFace = { p: { neutral: p.neutral, happy: p.happy, sad: p.sad, angry: p.angry, fearful: p.fearful, disgusted: p.disgusted, surprised: p.surprised }, feat, tt: performance.now() };
          const closed = feat.eyeOpen < 0.19; if (closed && !S.blinkState) S.blinks++; S.blinkState = closed;
          setPipe('face', 'ok', `偵測信心 ${pct(det.detection.score)}`);
          setPipe('expr', 'ok', EMO_TOP7(p));
        } else { S.prevFeat = null; setPipe('face', 'warn', '未偵測到人臉'); setPipe('expr', 'warn', '–'); }
        if (S.mode === 'eng') drawAnalysis(det);
      } catch (e) { setPipe('face', 'err', String(e.message || e)); }
    }
    const now = performance.now(); if (now - fpsT > 1000) { S.faceFps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    await sleep(Math.max(15, 100 - (performance.now() - t0)));
  }
}
function EMO_TOP7(p) {
  const names = { neutral: '中性', happy: '開心', sad: '悲傷', angry: '生氣', fearful: '恐懼', disgusted: '厭惡', surprised: '驚訝' };
  const k = Object.keys(names).sort((a, b) => p[b] - p[a])[0]; return `${names[k]} ${pct(p[k])}`;
}

/* ================================================================ 取樣 / 融合迴圈 */
function sampleTick() {
  if (!S.running) return;
  const now = (performance.now() - S.T0) / 1000, d = S.dlg, listening = d.state === 'listening';
  const v = S.audio.voice;
  const voiceActive = listening && now - v.lastVadT < 1.2;
  const face = S.lastFace && performance.now() - S.lastFace.tt < 1000 ? S.lastFace : null;
  let fused = null;
  if (face) {
    fused = fuse(face, v, voiceActive);
    const a = 0.3;
    for (const k in fused.scores) S.smooth[k] = lerp(S.smooth[k], fused.scores[k], a);
    S.smoothVal = lerp(S.smoothVal, fused.valence, a); S.smoothAro = lerp(S.smoothAro, fused.arousal, a);
    setPipe('fusion', 'ok', `效價 ${fmt(S.smoothVal, 2)} · 覺醒 ${fmt(S.smoothAro, 2)}`);
  } else setPipe('fusion', 'warn', '等待人臉');
  S.avatar.setMirror(S.smoothVal, S.smoothAro);
  S.samples.push({
    t: now, q: d.i, st: d.state, face: !!face,
    s: fused ? { ...S.smooth } : null, val: fused ? S.smoothVal : null, aro: fused ? S.smoothAro : null,
    db: v.db, f0: v.f0, vad: voiceActive, rate: v.rate, cen: v.cen, aroV: v.arousal,
    feat: face ? { smile: face.feat.smile, mar: face.feat.mar, brow: face.feat.browRaise, furrow: face.feat.furrow, ear: face.feat.eyeOpen, motion: face.feat.motion } : null,
    p: face ? face.p : null,
  });
}

/* ================================================================ 對話引擎 */
function logLine(cls, text) {
  const el = document.createElement('div'); el.className = cls; el.textContent = text; $('dlg-log').appendChild(el); $('dlg-log').scrollTop = 1e9;
}
function pickVoice() {
  const vs = speechSynthesis.getVoices(); return vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /zh/i.test(v.lang)) || null;
}
function speak(text) {
  return new Promise(resolve => {
    S.avatar.speaking = true;
    const sub = $('subtitle'); sub.textContent = text; sub.hidden = S.opts.tts && S.dlg.ttsOk;
    logLine('a', '心語:' + text);
    let done = false; const finish = () => { if (done) return; done = true; S.avatar.speaking = false; sub.hidden = true; resolve(); };
    const est = text.length * 280 + 1500;
    if (S.opts.tts && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text); const v = pickVoice(); if (v) u.voice = v; u.lang = v ? v.lang : 'zh-TW'; u.rate = 0.95; u.pitch = 1.05;
      u.onend = finish; u.onerror = finish; speechSynthesis.cancel(); speechSynthesis.speak(u);
      setTimeout(finish, est + 8000);
      S.dlg.ttsOk = !!v; setPipe('tts', v ? 'ok' : 'warn', v ? v.name : '無中文語音,改用字幕');
      if (!v) { setTimeout(finish, est); sub.hidden = false; }
    } else { setPipe('tts', 'warn', '字幕模式'); sub.hidden = false; setTimeout(finish, est); }
  });
}
function startSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!S.opts.stt) return setPipe('stt', '', '未啟用');
  if (!SR) return setPipe('stt', 'warn', '瀏覽器不支援');
  const r = new SR(); r.lang = 'zh-TW'; r.continuous = true; r.interimResults = false;
  r.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) {
    const t = e.results[i][0].transcript.trim(); S.dlg.transcripts.push(t); S.texts.push({ q: S.dlg.i, text: t }); logLine('u', '你:' + t); } };
  r.onend = () => { if (S.stt === r && S.dlg.state === 'listening' && S.running) try { r.start(); } catch (_) {} };
  r.onerror = e => setPipe('stt', 'warn', e.error);
  try { r.start(); S.stt = r; setPipe('stt', 'ok', '辨識中 zh-TW'); } catch (_) {}
}
function stopSTT() { const r = S.stt; S.stt = null; if (r) try { r.stop(); } catch (_) {} }

async function runDialog() {
  const d = S.dlg;
  for (let i = 0; i < SCRIPT.length && S.running; i++) {
    const q = SCRIPT[i]; d.i = i; d.state = 'speaking'; d.transcripts = []; updateHeader();
    await speak(q.say); if (!S.running) break;
    // ---- 聆聽
    d.state = 'listening'; d.t0 = (performance.now() - S.T0) / 1000; d.voiceSec = 0; d.lastVoice = 0; d.nudged = false; d.skip = false; updateHeader();
    startSTT();
    while (S.running && !d.skip) {
      await sleep(100);
      const now = (performance.now() - S.T0) / 1000, el = now - d.t0, v = S.audio.voice;
      if (v.vad && now - v.lastVadT < 0.3) { d.voiceSec += 0.1; d.lastVoice = now; }
      if (d.voiceSec >= 4 && now - d.lastVoice >= 3.2) break;           // 說完了
      if (d.voiceSec < 1 && el > 12 && !d.nudged) { d.nudged = true; logLine('s', '(偵測不到聲音,心語鼓勵你開口)'); await speakNudge(); }
      if (el >= q.maxListen || (d.voiceSec < 1 && el > 28)) break;
    }
    stopSTT();
    if (!S.running) break;
    d.state = 'replying'; updateHeader();
    await speak(q.reply);
  }
  if (S.running) endSession();
}
async function speakNudge() { const was = S.dlg.state; S.dlg.state = 'speaking'; await speak('沒關係,你可以慢慢說,想到什麼就說什麼。'); S.dlg.state = was; }

function updateHeader() {
  const d = S.dlg, q = SCRIPT[d.i];
  $('h-state').textContent = { idle: '待機', speaking: '心語說話中', listening: '聆聽受測者', replying: '心語回應', done: '結束' }[d.state];
  $('h-state').classList.toggle('live', d.state === 'listening');
  $('h-q').textContent = q ? `Q${d.i + 1}/${SCRIPT.length} ${q.title}` : 'Q –';
}

/* ================================================================ 工作階段 */
function setMode(m) {
  S.mode = m; document.body.classList.toggle('mode-user', m === 'user'); document.body.classList.toggle('mode-eng', m === 'eng');
}
async function startSession() {
  const btn = $('btn-start'); btn.disabled = true; $('start-status').textContent = '要求相機與麥克風權限…';
  S.opts.stt = $('opt-stt').checked; S.opts.tts = $('opt-tts').checked;
  setMode(document.querySelector('input[name=mode]:checked').value);
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
  } catch (e) {
    $('start-status').textContent = '無法使用相機/麥克風:' + (e.name === 'NotAllowedError' ? '請允許權限' : e.message); btn.disabled = false; return;
  }
  const cam = $('cam'); cam.srcObject = S.stream; await cam.play().catch(() => {});
  setPipe('cam', 'ok', `${cam.videoWidth || 640}×${cam.videoHeight || 480}`);
  await S.audio.attach(S.stream); setPipe('mic', 'ok', `${Math.round(S.audio.sr / 1000)} kHz`); setPipe('audio', 'ok', 'RMS / F0 / 頻譜重心 / 語速');
  setPipe('model', 'ok', 'tfjs · ' + S.models.backend); setPipe('stt', '', S.opts.stt ? '待命' : '未啟用');
  document.body.dataset.screen = 'session'; $('screen-start').hidden = true; $('screen-session').hidden = false;
  S.running = true; S.T0 = performance.now(); S.samples = []; S.texts = []; S.blinks = 0;
  buildScores(); buildLed();
  if (!S.avatar) S.avatar = new Avatar([$('avatar-user'), $('avatar-eng')]);
  S.timers = [
    setInterval(() => { const v = S.audio.step((performance.now() - S.T0) / 1000, S.dlg.state === 'listening'); renderLed(v.level); if (S.mode === 'eng') drawAudio(); }, 50),
    setInterval(sampleTick, 200),
    setInterval(() => { if (S.mode === 'eng') { renderScores(); renderPipe(); renderFeatTable(); $('h-time').textContent = mmss((performance.now() - S.T0) / 1000); } }, 250),
  ];
  faceLoop(); speechSynthesis && speechSynthesis.getVoices(); runDialog();
}
function endSession() {
  if (!S.running) return; S.running = false; S.dlg.state = 'done'; S.timers.forEach(clearInterval); stopSTT();
  try { speechSynthesis.cancel(); } catch (_) {}
  S.stream && S.stream.getTracks().forEach(t => t.stop());
  try { S.audio.ctx.close(); } catch (_) {}
  $('screen-session').hidden = true; $('screen-report').hidden = false; document.body.dataset.screen = 'report';
  document.body.classList.remove('mode-user'); document.body.classList.add('mode-eng');
  buildReport(); window.scrollTo(0, 0);
}

/* ================================================================ 報告 */
function aggregate(samples) {
  const f = samples.filter(s => s.s);
  const sc = {}; for (const e of EMO) sc[e.k] = mean(f.map(s => s.s[e.k]));
  const peak = {}; for (const e of EMO) peak[e.k] = f.length ? Math.max(...f.map(s => s.s[e.k])) : 0;
  const voiced = samples.filter(s => s.vad);
  return {
    n: samples.length, nFace: f.length, sc, peak, val: mean(f.map(s => s.val)), aro: mean(f.map(s => s.aro)), valSd: std(f.map(s => s.val)),
    db: voiced.length ? mean(voiced.map(s => s.db)) : null, f0: mean(voiced.filter(s => s.f0).map(s => s.f0)) || null,
    rate: voiced.length ? mean(voiced.map(s => s.rate)) : null, voiceSec: voiced.length * 0.2,
  };
}
function dominantOf(sc, excludeCalm = false) {
  return EMO.filter(e => !(excludeCalm && e.k === 'calm')).sort((a, b) => sc[b.k] - sc[a.k])[0];
}
function stackBar(sc) {
  return `<div class="stack">${EMO.map(e => `<i style="width:${sc[e.k] * 100}%;background:${e.c}" title="${e.n} ${pct(sc[e.k])}"></i>`).join('')}</div>`;
}
const legendHtml = () => `<div class="legend">${EMO.map(e => `<span style="--c:${e.c}">${e.n}</span>`).join('')}</div>`;

function buildReport() {
  const answering = S.samples.filter(s => s.st === 'listening');
  const all = aggregate(answering);
  const per = SCRIPT.map((q, i) => ({ q, i, a: aggregate(answering.filter(s => s.q === i)), texts: S.texts.filter(t => t.q === i).map(t => t.text).join('') }));
  const base = per[0].a;
  const totalFaceRate = S.samples.length ? S.samples.filter(s => s.face).length / S.samples.length : 0;
  const warnings = [];
  if (totalFaceRate < 0.6) warnings.push(`人臉偵測率僅 ${pct(totalFaceRate)},結果可信度較低。請確認光線充足、臉部正對鏡頭且不被遮擋。`);
  if (all.voiceSec < 15) warnings.push(`偵測到的說話時間僅約 ${fmt(all.voiceSec, 0)} 秒,語音覺醒度估計不足。請確認麥克風正常並多開口回答。`);
  if (!all.nFace) warnings.push('整段對話幾乎沒有分析到人臉,無法產生情緒分數。');

  const insights = [];
  if (all.nFace) {
    const dom = dominantOf(all.sc, true);
    insights.push(`整體而言,在你作答的過程中,表情偵測到的主要情緒傾向為「<b>${dom.n}</b>」(${pct(all.sc[dom.k])}),平靜(中性表情)占 ${pct(all.sc.calm)}。`);
    insights.push(`平均效價 ${fmt(all.val, 2)}(−1 負面 ~ +1 正面)、平均覺醒度 ${fmt(all.aro, 2)}(0 平穩 ~ 1 激動),情緒起伏(效價標準差)${fmt(all.valSd, 2)}${all.valSd > 0.35 ? ',起伏較大' : ',整體相對平穩'}。`);
    for (const p of per.slice(1, 5)) {
      if (!p.a.nFace) continue;
      const k = p.q.target, delta = p.a.sc[k] - base.sc[k], pk = p.a.peak[k];
      const e = EMO_BY_KEY[k];
      insights.push(delta >= 0.08
        ? `「${e.n}」情境:${e.n}的表情比例比暖身基準高 ${(delta * 100).toFixed(0)} 個百分點(峰值 ${pct(pk)}),對這個主題有明顯的情緒反應。`
        : `「${e.n}」情境:${e.n}的表情變化不明顯(較基準 ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)} 個百分點)。可能是表情較內斂、該主題情緒不強,或光線/角度影響辨識。`);
    }
    const strongest = per.slice(1, 5).filter(p => p.a.nFace).sort((a, b) => (b.a.sc[b.q.target] - base.sc[b.q.target]) - (a.a.sc[a.q.target] - base.sc[a.q.target]))[0];
    if (strongest) insights.push(`四個情境中,反應最明顯的是「${EMO_BY_KEY[strongest.q.target].n}」。`);
    const hiAro = per.slice(1, 5).filter(p => p.a.nFace).sort((a, b) => b.a.aro - a.a.aro)[0];
    if (hiAro) insights.push(`覺醒度最高的題目是「${hiAro.q.title}」(${fmt(hiAro.a.aro, 2)}),代表這個話題最讓你投入或激動。`);
    const close = per[5].a; if (close.nFace) insights.push(`收尾題的平均效價為 ${fmt(close.val, 2)}${close.val >= base.val ? ',情緒已回到不低於起始水準。' : ',情緒尚未完全回到起始水準,結束後可以做點讓自己放鬆的事。'}`);
  }
  const tv = textValence(S.texts.map(t => t.text).join(''));
  if (S.texts.length) insights.push(`語音轉文字的關鍵詞傾向為 ${fmt(tv, 2)}(−1 偏負面詞 ~ +1 偏正面詞),僅作參考。`);

  $('report').innerHTML = `
    <h1>心情分析報告</h1>
    <div class="muted">${new Date().toLocaleString('zh-TW')} · 對話時間 ${mmss(S.samples.length * 0.2)} · 共 ${SCRIPT.length} 個問題</div>
    ${warnings.map(w => `<div class="warn-box">⚠ ${w}</div>`).join('')}
    <div class="report-actions">
      <button id="r-print">列印 / 另存 PDF</button><button id="r-json">下載原始資料 JSON</button><button id="r-csv">下載時序 CSV</button>
      <button id="r-again" class="primary">再做一次</button>
    </div>

    <h2>整體摘要</h2>
    <div class="card">
      <div class="kpis">
        <div class="kpi"><div class="t">主要情緒傾向</div><div class="n">${all.nFace ? dominantOf(all.sc, true).n : '–'}</div></div>
        <div class="kpi"><div class="t">平均效價</div><div class="n">${all.nFace ? fmt(all.val, 2) : '–'}</div></div>
        <div class="kpi"><div class="t">平均覺醒度</div><div class="n">${all.nFace ? fmt(all.aro, 2) : '–'}</div></div>
        <div class="kpi"><div class="t">人臉偵測率</div><div class="n">${pct(totalFaceRate)}</div></div>
        <div class="kpi"><div class="t">說話時間</div><div class="n">${fmt(all.voiceSec, 0)} 秒</div></div>
      </div>
      <h3 style="margin-top:14px;font-size:14px">作答期間情緒組成</h3>${all.nFace ? stackBar(all.sc) : ''}${legendHtml()}
    </div>

    <h2>解讀</h2>
    <div class="card"><ul class="insight">${insights.map(i => `<li>${i}</li>`).join('') || '<li>資料不足,無法產生解讀。</li>'}</ul></div>

    <h2>情緒時間軸</h2>
    <div class="card"><canvas id="r-timeline" width="1000" height="300"></canvas>${legendHtml()}
      <div class="muted small">灰色區塊為虛擬人說話時段、帶標籤的區塊為各題作答時段。曲線為各情緒占比(0–100%)。</div></div>

    <h2>各題分析</h2>
    <div class="card" style="overflow:auto"><table class="qtable">
      <tr><th>題目</th><th>情緒組成(作答時)</th><th>目標情緒反應</th><th>效價 / 覺醒</th><th>語音</th></tr>
      ${per.map(p => {
        const a = p.a, e = EMO_BY_KEY[p.q.target], d = a.sc[p.q.target] - base.sc[p.q.target];
        return `<tr><td><b>Q${p.i + 1} ${p.q.title}</b></td>
        <td style="min-width:200px">${a.nFace ? stackBar(a.sc) : '<span class="muted">無人臉資料</span>'}</td>
        <td>${a.nFace ? (p.i === 0 || p.i === 5 ? '–' : `${e.n} ${pct(a.sc[e.k])}<br><span class="muted">Δ基準 ${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}pp · 峰值 ${pct(a.peak[e.k])}</span>`) : '–'}</td>
        <td>${a.nFace ? `${fmt(a.val, 2)} / ${fmt(a.aro, 2)}` : '–'}</td>
        <td>${a.db != null ? `${fmt(a.db, 0)} dB<br>${a.f0 ? fmt(a.f0, 0) + ' Hz · ' : ''}${fmt(a.rate, 1)} 音節/s<br><span class="muted">說話 ${fmt(a.voiceSec, 0)} 秒</span>` : '<span class="muted">未偵測到說話</span>'}</td></tr>`;
      }).join('')}
    </table></div>

    <h2>效價—覺醒度分布</h2>
    <div class="card"><canvas id="r-va" width="520" height="360" style="max-width:520px"></canvas>
      <div class="muted small">橫軸為效價(左負面、右正面),縱軸為覺醒度(下平穩、上激動)。點上的編號為題號。</div></div>

    <h2>分析方法與限制</h2>
    <div class="card disclaimer">
      臉部:以 TinyFaceDetector 偵測人臉、68 點特徵點擷取嘴角、眉毛、眼睛幾何,並以表情 CNN 輸出 7 類表情機率;
      語音:音量(dB)、音高(F0)、語速、頻譜重心,相對受測者自身基準估計覺醒度;兩者融合為喜、怒、哀、樂、平靜五項分數。<br><br>
      本報告反映的是「表情與聲音的外在表現」,並非內在感受或醫療/心理診斷。每個人的表情幅度、文化、光線、角度、鏡頭與麥克風品質都會影響結果。若你長期感到情緒困擾,請諮詢專業心理或醫療人員。
    </div>`;

  drawTimeline(per); drawVA(per);
  $('r-print').onclick = () => window.print();
  $('r-again').onclick = () => location.reload();
  $('r-json').onclick = () => download('mood-report.json', JSON.stringify({ script: SCRIPT.map(q => q.title), samples: S.samples, texts: S.texts }), 'application/json');
  $('r-csv').onclick = () => {
    const head = ['t', 'question', 'state', 'face', ...EMO.map(e => e.k), 'valence', 'arousal', 'db', 'f0', 'rate', 'voice_arousal'];
    const rows = S.samples.map(s => [s.t.toFixed(1), s.q + 1, s.st, s.face ? 1 : 0, ...EMO.map(e => s.s ? s.s[e.k].toFixed(3) : ''), s.val != null ? s.val.toFixed(3) : '', s.aro != null ? s.aro.toFixed(3) : '', s.db.toFixed(1), s.f0 ? s.f0.toFixed(0) : '', s.rate.toFixed(2), s.aroV.toFixed(2)].join(','));
    download('mood-timeline.csv', '﻿' + [head.join(','), ...rows].join('\n'), 'text/csv');
  };
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function drawTimeline(per) {
  const c = $('r-timeline'), ctx = c.getContext('2d'), W = c.width, H = c.height, L = 40, B = 24, T = 20, R = 10;
  const smp = S.samples; if (!smp.length) return;
  const tMax = smp[smp.length - 1].t || 1, X = t => L + t / tMax * (W - L - R), Y = v => T + (1 - v) * (H - T - B);
  ctx.clearRect(0, 0, W, H); ctx.font = '12px sans-serif';
  // 區段底色
  let start = 0;
  for (let i = 1; i <= smp.length; i++) {
    if (i === smp.length || smp[i].q !== smp[start].q || (smp[i].st === 'listening') !== (smp[start].st === 'listening')) {
      const s = smp[start], x0 = X(s.t), x1 = X(smp[i - 1].t);
      if (s.st === 'listening') { ctx.fillStyle = 'rgba(106,168,255,.13)'; ctx.fillRect(x0, T, x1 - x0, H - T - B); ctx.fillStyle = '#9fb3d9'; ctx.fillText('Q' + (s.q + 1), x0 + 4, T + 12); }
      else { ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(x0, T, x1 - x0, H - T - B); }
      start = i;
    }
  }
  ctx.strokeStyle = '#2c3a58'; ctx.fillStyle = '#93a0ba';
  for (let g = 0; g <= 4; g++) { const y = Y(g / 4); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke(); ctx.fillText((g * 25) + '%', 4, y + 4); }
  for (let t = 0; t <= tMax; t += Math.max(15, Math.ceil(tMax / 8 / 15) * 15)) ctx.fillText(mmss(t), X(t) - 12, H - 6);
  for (const e of EMO) {
    ctx.strokeStyle = e.c; ctx.lineWidth = e.k === 'calm' ? 1.5 : 2.2; ctx.beginPath(); let pen = false;
    for (const s of smp) { if (!s.s) { pen = false; continue; } const x = X(s.t), y = Y(s.s[e.k]); pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; }
    ctx.stroke();
  }
}
function drawVA(per) {
  const c = $('r-va'), ctx = c.getContext('2d'), W = c.width, H = c.height, P = 36;
  ctx.clearRect(0, 0, W, H); ctx.strokeStyle = '#2c3a58'; ctx.fillStyle = '#93a0ba'; ctx.font = '12px sans-serif';
  ctx.strokeRect(P, 10, W - P - 10, H - P - 10); ctx.beginPath(); ctx.moveTo((W + P) / 2, 10); ctx.lineTo((W + P) / 2, H - P); ctx.moveTo(P, (H - P + 10) / 2); ctx.lineTo(W - 10, (H - P + 10) / 2); ctx.stroke();
  ctx.fillText('負面', P + 4, H - P + 16); ctx.fillText('正面', W - 40, H - P + 16); ctx.fillText('激動', 4, 24); ctx.fillText('平穩', 4, H - P - 4);
  for (const p of per) {
    if (!p.a.nFace) continue; const e = EMO_BY_KEY[p.q.target];
    const x = P + (p.a.val + 1) / 2 * (W - P - 10), y = 10 + (1 - p.a.aro) * (H - P - 10);
    ctx.fillStyle = e.c; ctx.beginPath(); ctx.arc(x, y, 12, 0, 7); ctx.fill(); ctx.fillStyle = '#0b1020'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(p.i + 1, x - 3.5, y + 4);
  }
}

/* ================================================================ 啟動 */
async function initBackend() { // WebGL 優先,失敗則退回 CPU(避免預設的 wasm 後端找不到 .wasm 檔)
  for (const b of ['webgl', 'cpu']) {
    try { if (await faceapi.tf.setBackend(b)) { await faceapi.tf.ready(); return b; } } catch (_) {}
  }
  return faceapi.tf.getBackend();
}
async function loadModels() {
  const btn = $('btn-start'), st = $('start-status');
  try {
    S.models.backend = await initBackend();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URI),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URI),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URI),
    ]);
    S.models.ready = true; btn.disabled = false; btn.textContent = '開始對話'; st.textContent = '模型已就緒(' + S.models.backend + ')';
  } catch (e) { S.models.error = e; btn.textContent = '模型載入失敗'; st.textContent = String(e.message || e); }
}
document.addEventListener('DOMContentLoaded', () => {
  $('btn-start').onclick = startSession;
  $('btn-next').onclick = () => { S.dlg.skip = true; };
  $('btn-switch').onclick = () => setMode(S.mode === 'eng' ? 'user' : 'eng');
  $('btn-end').onclick = endSession;
  document.addEventListener('keydown', e => {
    if (!S.running) return;
    if (e.key === 'Escape') endSession();
    else if (e.key === 'e' || e.key === 'E') setMode(S.mode === 'eng' ? 'user' : 'eng');
    else if (e.key === 'n' || e.key === 'N') S.dlg.skip = true;
  });
  setPipe('model', 'warn', '載入中');
  loadModels();
});
