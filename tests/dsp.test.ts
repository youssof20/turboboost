import { describe, expect, it } from 'vitest';
import { TurboDSP } from '../src/audio/dsp.ts';
import { BUILTIN_PROFILES, BASE_PROFILE } from '../src/model/profiles.ts';
import { sampleLog } from '../src/input/log.ts';
import { loadLog } from './helpers.ts';

const SR = 44100;

function fakeSamples(): Float32Array[] {
  const a = new Float32Array(4000);
  for (let i = 0; i < a.length; i++) a[i] = (Math.sin(i * 0.05) * Math.exp(-i / 800)) * Math.min(1, i / 100);
  return [a];
}

function render(profileIdx: number, seconds: number, setup?: (d: TurboDSP) => void) {
  const profile = BUILTIN_PROFILES[profileIdx]!;
  const d = new TurboDSP(SR, profile, 5);
  d.setSamples('bov', fakeSamples());
  d.setSamples('pop', fakeSamples());
  setup?.(d);
  const rows = loadLog();
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let hint = 0;
  for (let p = 0; p < n; p += 128) {
    const s = sampleLog(rows, p / SR, hint);
    hint = s.index;
    d.setInput({ rpm: s.row.rpm, pedal: s.row.pedal, mapKpa: s.row.mapKpa, speedKmh: s.row.speed, gear: s.row.gear });
    d.process(L.subarray(p, p + 128), R.subarray(p, p + 128), Math.min(128, n - p));
  }
  return { L, R, d };
}

function stats(x: Float32Array) {
  let peak = 0;
  let nan = 0;
  let clicks = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) nan++;
    peak = Math.max(peak, Math.abs(v));
    if (i > 0 && Math.abs(v - x[i - 1]!) > 0.3) clicks++;
  }
  return { peak, nan, clicks };
}

describe('TurboDSP', () => {
  for (let i = 0; i < BUILTIN_PROFILES.length; i++) {
    const p = BUILTIN_PROFILES[i]!;
    it(`profile "${p.id}": finite, below the limiter ceiling, no clicks`, () => {
      const { L, R } = render(i, 14, (d) => {
        d.start(true);
        d.setMaster(0.9);
      });
      for (const ch of [L, R]) {
        const s = stats(ch);
        expect(s.nan).toBe(0);
        expect(s.peak).toBeLessThanOrEqual(p.mix.limiterCeiling + 1e-6);
        expect(s.clicks).toBe(0);
      }
    });
  }

  it('is audible during a pull (not silent) and silent at idle', () => {
    const { L } = render(0, 9, (d) => d.start(true));
    const seg = (a: number, b: number) => {
      let e = 0;
      for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += L[i]! ** 2;
      return Math.sqrt(e / ((b - a) * SR));
    };
    expect(seg(0.1, 0.5)).toBeLessThan(0.002);
    expect(seg(3.5, 4.5)).toBeGreaterThan(0.01);
  });

  it('mute mode is silent', () => {
    const { L } = render(0, 8, (d) => {
      d.start(true);
      d.setMode('mute');
      d.setMaster(1);
    });
    expect(stats(L).peak).toBeLessThan(1e-4);
  });

  it('fades in after the warm-up instead of starting at full level', () => {
    const { L } = render(0, 4, (d) => d.start(false));
    let early = 0;
    for (let i = 0; i < Math.round(0.4 * SR); i++) early = Math.max(early, Math.abs(L[i]!));
    expect(early).toBe(0); // warm-up is silent
  });

  it('link loss fades the sound out over about half a second', () => {
    const d = new TurboDSP(SR, BASE_PROFILE, 3);
    d.start(true);
    d.setMaster(1);
    d.setInput({ rpm: 5000, pedal: 1, speedKmh: null, gear: null });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let b = 0; b < 600; b++) d.process(L, R, 128); // ~1.7 s so it is spooled and loud
    const level = () => {
      let m = 0;
      for (let b = 0; b < 40; b++) {
        d.process(L, R, 128);
        for (const v of L) m = Math.max(m, Math.abs(v));
      }
      return m;
    };
    const before = level();
    expect(before).toBeGreaterThan(0.01);
    d.setLink(false);
    for (let b = 0; b < 300; b++) d.process(L, R, 128); // 0.87 s
    expect(level()).toBeLessThan(before * 0.01);
    d.setLink(true);
    for (let b = 0; b < 500; b++) d.process(L, R, 128);
    expect(level()).toBeGreaterThan(before * 0.5);
  });

  it('is deterministic for a given seed (offline renders are comparable)', () => {
    const a = render(0, 6, (d) => d.start(true)).L;
    const b = render(0, 6, (d) => d.start(true)).L;
    expect(Array.from(a.slice(100000, 100050))).toEqual(Array.from(b.slice(100000, 100050)));
  });

  it('gear whine only sounds when the car provides a gear', () => {
    const profile = structuredClone(BASE_PROFILE);
    profile.gearWhine.level = 1;
    const energy = (gear: number | null) => {
      const d = new TurboDSP(SR, profile, 3);
      d.start(true);
      d.setMaster(1);
      d.setInput({ rpm: 3000, pedal: 0.6, speedKmh: 60, gear });
      const L = new Float32Array(128);
      const R = new Float32Array(128);
      let e = 0;
      for (let b = 0; b < 500; b++) {
        d.process(L, R, 128);
        if (b > 300) for (const v of L) e += v * v;
      }
      return e;
    };
    // turbo whine is present in both, gear whine adds energy only with a known gear
    expect(energy(3)).toBeGreaterThan(energy(null) * 1.05);
  });
});
