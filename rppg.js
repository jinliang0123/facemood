'use strict';
/* rPPG(遠端光體積描記法)心率估計:POS 演算法 + 頻譜峰值 + 訊號品質。
 * push(t, r, g, b):每個影格塞入臉部 ROI 的 RGB 平均值(t 為秒)。
 * estimate():取最近約 10 秒,回傳 { bpm, q, ok, span, wave }。 */
class RPPG {
  constructor() {
    this.fs = 30; this.win = 10; this.maxSec = 15; this.minSec = 8;
    this.buf = []; this.okHist = []; this.out = { bpm: null, raw: null, q: 0, ok: false, span: 0, wave: [] };
  }
  reset() { this.buf = []; this.okHist = []; }
  push(t, r, g, b) {
    const last = this.buf[this.buf.length - 1];
    if (last && t - last.t > 1.0) { this.buf = []; this.okHist = []; }   // 人臉中斷過久 → 重新累積
    this.buf.push({ t, r, g, b });
    while (this.buf.length && t - this.buf[0].t > this.maxSec) this.buf.shift();
  }
  _resample(sec) {
    const B = this.buf, t1 = B[B.length - 1].t, t0 = t1 - sec, n = Math.floor(sec * this.fs);
    const R = new Float64Array(n), G = new Float64Array(n), Bl = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const tk = t0 + k / this.fs;
      while (j < B.length - 2 && B[j + 1].t < tk) j++;
      const a = B[j], b = B[j + 1], u = b.t > a.t ? Math.min(1, Math.max(0, (tk - a.t) / (b.t - a.t))) : 0;
      R[k] = a.r + (b.r - a.r) * u; G[k] = a.g + (b.g - a.g) * u; Bl[k] = a.b + (b.b - a.b) * u;
    }
    return [R, G, Bl];
  }
  static _std(a) { let m = 0; for (const x of a) m += x; m /= a.length; let s = 0; for (const x of a) s += (x - m) ** 2; return Math.sqrt(s / a.length); }
  _pos(R, G, B) {
    const n = R.length, L = Math.round(1.6 * this.fs), H = new Float64Array(n);
    for (let s = 0; s + L <= n; s++) {
      let mr = 0, mg = 0, mb = 0;
      for (let i = 0; i < L; i++) { mr += R[s + i]; mg += G[s + i]; mb += B[s + i]; }
      mr /= L; mg /= L; mb /= L; if (mr < 1 || mg < 1 || mb < 1) continue;
      const xs = new Float64Array(L), ys = new Float64Array(L);
      for (let i = 0; i < L; i++) {
        const rn = R[s + i] / mr, gn = G[s + i] / mg, bn = B[s + i] / mb;
        xs[i] = gn - bn; ys[i] = gn + bn - 2 * rn;
      }
      const sy = RPPG._std(ys), alpha = sy > 1e-9 ? RPPG._std(xs) / sy : 0;
      let hm = 0; const h = new Float64Array(L);
      for (let i = 0; i < L; i++) { h[i] = xs[i] + alpha * ys[i]; hm += h[i]; }
      hm /= L; for (let i = 0; i < L; i++) H[s + i] += h[i] - hm;   // overlap-add
    }
    return H;
  }
  estimate() {
    const B = this.buf, span = B.length > 1 ? B[B.length - 1].t - B[0].t : 0;
    if (span < this.minSec) { this.out = { bpm: null, raw: null, q: 0, ok: false, span, wave: [] }; return this.out; }
    const sec = Math.min(this.win, span), [R, G, Bl] = this._resample(sec), H = this._pos(R, G, Bl), n = H.length;
    // 去趨勢 + Hann 窗
    let m = 0; for (const x of H) m += x; m /= n;
    const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = (H[i] - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    // 42–180 bpm,每 1 bpm 一格的 DFT 功率
    const P = []; let total = 0;
    for (let bpm = 42; bpm <= 180; bpm++) {
      const f = bpm / 60; let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const a = 2 * Math.PI * f * i / this.fs; re += w[i] * Math.cos(a); im += w[i] * Math.sin(a); }
      const p = re * re + im * im; P.push(p); total += p;
    }
    let pk = 0; for (let i = 1; i < P.length; i++) if (P[i] > P[pk]) pk = i;
    let band = 0; for (let i = Math.max(0, pk - 6); i <= Math.min(P.length - 1, pk + 6); i++) band += P[i];
    const q = total > 0 ? band / total : 0, raw = 42 + pk, ok = q >= 0.4;
    if (ok) { this.okHist.push(raw); if (this.okHist.length > 5) this.okHist.shift(); }
    const med = this.okHist.length ? [...this.okHist].sort((a, b) => a - b)[this.okHist.length >> 1] : null;
    // 供繪圖的波形(輕度平滑)
    const wave = []; for (let i = 0; i < n; i += 1) { let s = 0, c = 0; for (let k = -2; k <= 2; k++) if (H[i + k] !== undefined) { s += H[i + k]; c++; } wave.push(s / c); }
    this.out = { bpm: ok ? med : null, raw, q, ok, span, wave };
    return this.out;
  }
}
if (typeof module !== 'undefined') module.exports = { RPPG };
