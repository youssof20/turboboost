import { describe, expect, it } from 'vitest';
import { GearEstimator, rpmPerKmh } from '../src/model/gear.ts';
import { BASE_PROFILE, BUILTIN_PROFILES, PARAM_SPECS, validateProfile, getPath } from '../src/model/profiles.ts';
import { Channel, Exaggerator, PREDICT, RpmValidator } from '../src/obd/predictor.ts';
import { parseCsv } from '../src/input/log.ts';
import { loadLog } from './helpers.ts';

describe('gear estimator', () => {
  const cfg = BASE_PROFILE.engine;
  const k = rpmPerKmh(cfg);

  it('reports unknown without speed and neutral when stopped', () => {
    const g = new GearEstimator(cfg);
    expect(g.update(3000, null, 0.05)).toBeNull();
    expect(g.update(900, 0, 0.05)).toBe(0);
  });

  it('finds each gear from rpm/speed after settling', () => {
    for (let gear = 1; gear <= 6; gear++) {
      const e = new GearEstimator(cfg);
      let out: number | null = 0;
      for (let i = 0; i < 20; i++) out = e.update(k[gear - 1]! * 50, 50, 0.05);
      expect(out).toBe(gear);
    }
  });

  it('holds the previous gear while the clutch is in, then drops to neutral', () => {
    const e = new GearEstimator(cfg);
    for (let i = 0; i < 20; i++) e.update(k[1]! * 60, 60, 0.05);
    expect(e.update(k[1]! * 60 * 1.4, 60, 0.05)).toBe(2);
    let out: number | null = 2;
    for (let i = 0; i < 40; i++) out = e.update(k[1]! * 60 * 1.4, 60, 0.05);
    expect(out).toBe(0);
  });

  it('follows the reference log within a settle time of the true gear', () => {
    const rows = loadLog();
    const e = new GearEstimator(cfg);
    let wrong = 0;
    let counted = 0;
    let lastT = rows[0]!.t;
    let lastChange = -10;
    let prevTrue = rows[0]!.gear;
    for (const r of rows) {
      const g = e.update(r.rpm, r.speed, r.t - lastT);
      lastT = r.t;
      if (r.gear !== prevTrue) lastChange = r.t;
      prevTrue = r.gear;
      if (r.t - lastChange > 1.5 && r.gear !== null && r.gear > 0) {
        counted++;
        if (g !== r.gear) wrong++;
      }
    }
    expect(counted).toBeGreaterThan(100);
    expect(wrong / counted).toBeLessThan(0.03);
  });
});

describe('predictor', () => {
  it('extrapolates linearly but never past the cap, and smooths', () => {
    const c = new Channel();
    c.push(0, 1000);
    c.push(50, 1500);
    let v = 0;
    for (let t = 50; t <= 400; t += 8) v = c.value(t);
    // slope 10 rpm/ms, capped at 60 ms ahead => 1500 + 600
    expect(v).toBeGreaterThan(2000);
    expect(v).toBeLessThan(2150);
  });

  it('does not step: output moves gradually toward a new reading', () => {
    const c = new Channel();
    c.push(0, 1000);
    c.value(0);
    c.push(50, 1000);
    for (let t = 0; t <= 96; t += 8) c.value(t);
    c.push(100, 3000);
    const first = c.value(104);
    expect(first).toBeLessThan(2500);
  });

  it('latency lead moves the value ahead', () => {
    const a = new Channel();
    const b = new Channel();
    for (const c of [a, b]) {
      c.push(0, 1000);
      c.push(50, 1500);
    }
    let va = 0;
    let vb = 0;
    for (let t = 50; t <= 300; t += 8) {
      va = a.value(t, 0);
      vb = b.value(t, 100);
    }
    expect(vb).toBeGreaterThan(va + 500);
  });

  it('rpm validator rejects a single garbled spike but accepts a confirmed jump', () => {
    const v = new RpmValidator();
    expect(v.accept(0, 2000)).toBe(2000);
    expect(v.accept(50, 2100)).toBe(2100);
    expect(v.accept(100, 9500)).toBeNull(); // spike
    expect(v.accept(150, 2200)).toBe(2200); // back to normal: spike was noise
    expect(v.accept(200, 8000)).toBeNull(); // jump, unconfirmed
    expect(v.accept(250, 8100)).toBe(8100); // confirmed by a second reading
    expect(v.rejected).toBe(2);
  });

  it('rpm validator allows fast but physical changes', () => {
    const v = new RpmValidator();
    v.accept(0, 3000);
    expect(v.accept(100, 5900)).toBe(5900);
    expect(PREDICT.maxRpmJumpPer100ms).toBe(3000);
  });

  it('exaggeration leaves idle honest and amplifies changes', () => {
    const ex = new Exaggerator();
    for (let i = 0; i < 100; i++) ex.apply(2000, 1.5, 800, 0.05);
    expect(ex.apply(2000, 1.5, 800, 0.05)).toBeCloseTo(2000, 0);
    expect(ex.apply(2600, 1.5, 800, 0.05)).toBeGreaterThan(2800);
    const idle = new Exaggerator();
    for (let i = 0; i < 100; i++) idle.apply(800, 1.5, 800, 0.05);
    expect(idle.apply(900, 1.5, 800, 0.05)).toBeCloseTo(900, 0);
  });
});

describe('profiles', () => {
  it('every built-in profile validates cleanly', () => {
    for (const p of BUILTIN_PROFILES) {
      const r = validateProfile(p);
      expect(r.errors, p.id).toEqual([]);
    }
  });

  it('built-ins have unique ids and 6+ entries', () => {
    expect(new Set(BUILTIN_PROFILES.map((p) => p.id)).size).toBe(BUILTIN_PROFILES.length);
    expect(BUILTIN_PROFILES.length).toBeGreaterThanOrEqual(6);
  });

  it('every slider spec points at a real number in the base profile and its default is in range', () => {
    for (const s of PARAM_SPECS) {
      const v = getPath(BASE_PROFILE, s.path);
      expect(typeof v, s.path).toBe('number');
      expect(v, s.path).toBeGreaterThanOrEqual(s.min);
      expect(v, s.path).toBeLessThanOrEqual(s.max);
    }
  });

  it('falls back to defaults and names the failing field', () => {
    const r = validateProfile({ turbo: { tauUp: 'fast', maxBoost: 99 }, lift: { mode: 'banana' } });
    expect(r.errors.some((e) => e.startsWith('turbo.tauUp'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('turbo.maxBoost'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('lift.mode'))).toBe(true);
    expect(r.profile.turbo.tauUp).toBe(BASE_PROFILE.turbo.tauUp);
    expect(r.profile.lift.mode).toBe('bov');
  });

  it('rejects non-objects and keeps valid fields from partial input', () => {
    expect(validateProfile(null).errors.length).toBeGreaterThan(0);
    const r = validateProfile({ name: 'Mine', turbo: { tauUp: 1.4 } });
    expect(r.errors).toEqual([]);
    expect(r.profile.name).toBe('Mine');
    expect(r.profile.turbo.tauUp).toBe(1.4);
  });

  it('fixes an impossible spool window', () => {
    const r = validateProfile({ turbo: { rpmBoostStart: 5000, rpmFullBoost: 3000 } });
    expect(r.errors.some((e) => e.includes('rpmFullBoost'))).toBe(true);
    expect(r.profile.turbo.rpmFullBoost).toBeGreaterThan(r.profile.turbo.rpmBoostStart);
  });
});

describe('csv log parsing', () => {
  it('parses a minimal log and percent pedals', () => {
    const rows = parseCsv('t,rpm,throttle\n0,800,0\n1,3000,80\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.pedal).toBeCloseTo(0.8, 5);
    expect(rows[0]!.speed).toBeNull();
  });
  it('rejects logs without the required columns', () => {
    expect(() => parseCsv('a,b\n1,2\n3,4\n')).toThrow();
  });
});
