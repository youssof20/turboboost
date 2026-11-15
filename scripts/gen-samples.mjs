// Generates the placeholder one-shot samples (blow-off, pops) and a small intake impulse response.
// These are synthesised, NOT recordings. Drop real recorded WAVs into public/samples/ (same names,
// or list new names in public/samples/manifest.json) and the app and render script pick them up.
//
// usage: node scripts/gen-samples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';

const SR = 44100;
const OUT = 'public/samples';
mkdirSync(`${OUT}/ir`, { recursive: true });

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; }
  set(f, q) {
    const g = Math.tan((Math.PI * Math.min(f, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1 * this.k; this.hp = x - this.k * v1 - v2;
  }
}

function writeWav(path, data) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  writeFileSync(path, buf);
}

function normalise(x, peak = 0.7) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  // 3 ms fade at the very start and 20 ms at the end so nothing starts/ends with a click
  const fi = Math.round(0.003 * SR), fo = Math.round(0.02 * SR);
  for (let i = 0; i < fi; i++) x[i] *= i / fi;
  for (let i = 0; i < fo; i++) x[x.length - 1 - i] *= i / fo;
  return x;
}

// ---- blow-off: click + falling-pitch hiss + resonant peak + whine-ish tail ----
function bov(seed) {
  const r = rng(seed * 7919);
  const dur = 0.35 + r() * 0.55;
  const tau = 0.07 + r() * 0.16;
  const peakF = 1100 + r() * 900;
  const sweepTop = 900 + r() * 600;
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const hp = new Svf(), bp = new Svf(), lp = new Svf(), tail = new Svf();
  const stutter = false; // no chatter: it reads as a knock
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) {
      hp.set(380 + (sweepTop - 380) * Math.exp(-t / 0.09), 0.7);
      bp.set(peakF * (0.8 + 0.2 * Math.exp(-t / 0.12)), 2);
      lp.set(4200, 0.6);
      tail.set(700 + 300 * Math.exp(-t / 0.4), 2);
    }
    const nz = r() * 2 - 1;
    hp.tick(nz); bp.tick(nz); tail.tick(nz);
    const att = Math.min(1, t / 0.014);
    let env = att * Math.exp(-t / tau);
    if (stutter) env *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 38 * t) ** 2;
    const click = 0;
    const hiss = (hp.hp + bp.bp * 0.9) * env;
    const whine = tail.bp * 0.15 * Math.exp(-t / (tau * 2.2)) * att;
    lp.tick(hiss + whine + click);
    out[i] = lp.lp;
  }
  return normalise(out, 0.75);
}

// ---- pop / crackle: low thump + a few crackle clicks ----
function pop(seed) {
  const r = rng(seed * 104729 + 13);
  const dur = 0.12 + r() * 0.2;
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const body = new Svf(), mid = new Svf();
  const bodyF = 70 + r() * 200;
  const tau = 0.02 + r() * 0.04;
  const clicks = [];
  const nc = 1 + Math.floor(r() * 3);
  for (let c = 0; c < nc; c++) clicks.push({ at: r() * dur * 0.6, amp: 0.15 + r() * 0.25, f: 250 + r() * 400 });
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) { body.set(bodyF, 3 + r() * 3); mid.set(350 + r() * 300, 1); }
    const nz = r() * 2 - 1;
    body.tick(nz); mid.tick(nz);
    const env = Math.min(1, t / 0.002) * Math.exp(-t / tau);
    let y = (body.bp * 1.6 + mid.bp * 0.45) * env;
    for (const c of clicks) {
      const dt = t - c.at;
      if (dt >= 0 && dt < 0.012) y += Math.sin(2 * Math.PI * c.f * dt) * Math.exp(-dt / 0.008) * c.amp * Math.min(1, dt / 0.003);
    }
    out[i] = y;
  }
  const lpf = new Svf();
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0) lpf.set(1400, 0.6);
    lpf.tick(out[i]);
    out[i] = lpf.lp;
  }
  return normalise(out, 0.7);
}

// ---- intake impulse response: tiny airbox, 180 ms ----
function ir() {
  const r = rng(424242);
  const n = Math.round(0.32 * SR);
  const out = new Float32Array(n);
  const lp = new Svf();
  const early = [0.0021, 0.0043, 0.0079, 0.0121].map((t) => Math.round(t * SR));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) lp.set(5200 * Math.exp(-t / 0.12) + 700, 0.7);
    lp.tick(r() * 2 - 1);
    out[i] = lp.lp * Math.exp(-t / 0.085);
  }
  out[0] = 1;
  for (const [k, e] of early.entries()) out[e] += 0.5 / (k + 1);
  return normalise(out, 0.9);
}

const manifest = { bov: [], pop: [], ir: 'ir/airbox_small.wav' };
for (let i = 1; i <= 8; i++) {
  const name = `bov_${String(i).padStart(2, '0')}`;
  writeWav(`${OUT}/${name}.wav`, bov(i));
  manifest.bov.push(name);
}
for (let i = 1; i <= 16; i++) {
  const name = `pop_${String(i).padStart(2, '0')}`;
  writeWav(`${OUT}/${name}.wav`, pop(i));
  manifest.pop.push(name);
}
writeWav(`${OUT}/ir/airbox_small.wav`, ir());
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.bov.length} blow-off, ${manifest.pop.length} pop samples and 1 IR to ${OUT}/`);
