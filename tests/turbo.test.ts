import { describe, expect, it } from 'vitest';
import { createState, step, smoothstep, type Input, type TurboEvent } from '../src/model/turbo.ts';
import { BASE_PROFILE, BUILTIN_PROFILES, type Profile } from '../src/model/profiles.ts';
import { loadLog, runModel } from './helpers.ts';

const rng = () => 0.5;
const base: Input = { rpm: 4500, pedal: 1, mapKpa: null, baroKpa: 101.3, speedKmh: null, gear: null };
const DT = 0.003;

function run(seconds: number, inp: Input, s = createState(), p: Profile = BASE_PROFILE, events: TurboEvent[] = []) {
  for (let t = 0; t < seconds; t += DT) step(s, p, inp, DT, events, rng);
  return s;
}

function liftFrom(s: ReturnType<typeof createState>, p: Profile, inp: Input, events: TurboEvent[], secs = 0.6, fall = 0.08) {
  for (let t = 0; t < secs; t += DT) step(s, p, { ...inp, pedal: Math.max(0, 1 - t / fall) }, DT, events, rng);
}

describe('turbo state model', () => {
  it('smoothstep clamps', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('spools up with lag: not instant, then near full', () => {
    expect(run(0.2, base).shaft).toBeLessThan(0.35);
    expect(run(4, base).shaft).toBeGreaterThan(0.95);
  });

  it('boost follows shaft squared and caps at maxBoost', () => {
    const s = run(5, base);
    expect(s.boost).toBeGreaterThan(BASE_PROFILE.turbo.maxBoost * 0.9);
    expect(s.boost).toBeLessThanOrEqual(BASE_PROFILE.turbo.maxBoost + 1e-6);
    const early = run(0.5, base);
    expect(early.boost / BASE_PROFILE.turbo.maxBoost).toBeLessThan(early.shaft);
  });

  it('no spool below the spool window', () => {
    expect(run(4, { ...base, rpm: 1500 }).shaft).toBeLessThan(0.2);
  });

  it('coasts down slowly after lift: boost vents, the shaft keeps spinning', () => {
    const events: TurboEvent[] = [];
    const s = run(4, base, createState(), BASE_PROFILE, events);
    const before = s.shaft;
    run(0.5, { ...base, pedal: 0 }, s, BASE_PROFILE, events);
    expect(s.shaft).toBeGreaterThan(before * 0.5);
    expect(s.boost).toBeLessThan(0.1);
  });

  it('fires exactly one blow-off on a fast lift with stored boost', () => {
    const events: TurboEvent[] = [];
    const s = run(4, base, createState(), BASE_PROFILE, events);
    events.length = 0;
    liftFrom(s, BASE_PROFILE, base, events);
    expect(events.filter((e) => e.type === 'bov')).toHaveLength(1);
  });

  it('does not fire without stored boost', () => {
    const events: TurboEvent[] = [];
    const s = run(0.1, base, createState(), BASE_PROFILE, events);
    events.length = 0;
    liftFrom(s, BASE_PROFILE, base, events, 0.4);
    expect(events.filter((e) => e.type === 'bov')).toHaveLength(0);
  });

  it('does not fire when feathering (slow, shallow pedal changes)', () => {
    const events: TurboEvent[] = [];
    const s = run(4, base, createState(), BASE_PROFILE, events);
    events.length = 0;
    for (let t = 0; t < 3; t += DT) {
      step(s, BASE_PROFILE, { ...base, pedal: 0.7 + 0.15 * Math.sin(2 * Math.PI * 1.5 * t) }, DT, events, rng);
    }
    expect(events.filter((e) => e.type === 'bov' || e.type === 'flutter')).toHaveLength(0);
  });

  it('flutter profile emits flutter, not bov', () => {
    const p = BUILTIN_PROFILES.find((x) => x.id === 'big-single')!;
    const events: TurboEvent[] = [];
    const inp = { ...base, rpm: 5500 };
    const s = run(6, inp, createState(), p, events);
    events.length = 0;
    liftFrom(s, p, inp, events);
    expect(events.filter((e) => e.type === 'flutter')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'bov')).toHaveLength(0);
  });

  it('idle gate: shaft decays to true zero at idle with no pedal', () => {
    const s = run(4, base);
    run(15, { ...base, rpm: 850, pedal: 0 }, s);
    expect(s.shaft).toBe(0);
    expect(s.gate).toBeLessThan(0.01);
  });

  it('uses real MAP boost when selected', () => {
    const p = structuredClone(BASE_PROFILE);
    p.setup.boostSource = 'map';
    const s = run(1, { ...base, mapKpa: 161.3 }, createState(), p);
    expect(s.boost).toBeCloseTo(0.6, 1);
  });

  it('supercharger has no lag', () => {
    const p = BUILTIN_PROFILES.find((x) => x.kind === 'supercharger')!;
    expect(run(0.5, { ...base, rpm: 4000 }, createState(), p).shaft).toBeGreaterThan(0.5);
  });

  it('twin turbo: secondary stage spools later than the primary', () => {
    const p = BUILTIN_PROFILES.find((x) => x.id === 'sequential-twin')!;
    const s = run(1.5, { ...base, rpm: 3200 }, createState(), p);
    expect(s.shafts[0]!).toBeGreaterThan(0.5);
    expect(s.shafts[1]!).toBeLessThan(0.1);
  });

  it('anti-lag keeps the shaft spun and bangs after a lift', () => {
    const p = BUILTIN_PROFILES.find((x) => x.id === 'rally-anti-lag')!;
    const events: TurboEvent[] = [];
    const s = run(6, { ...base, rpm: 5500 }, createState(), p, events);
    events.length = 0;
    const noAL = structuredClone(p);
    noAL.lift.antiLag = false;
    const s2 = run(6, { ...base, rpm: 5500 }, createState(), noAL, []);
    run(1.0, { ...base, rpm: 5200, pedal: 0 }, s, p, events);
    run(1.0, { ...base, rpm: 5200, pedal: 0 }, s2, noAL, []);
    expect(s.shaft).toBeGreaterThan(s2.shaft + 0.1);
    expect(events.filter((e) => e.type === 'bang').length).toBeGreaterThan(0);
  });

  it('overrun pops only on closed-throttle deceleration, and only when enabled', () => {
    const lowRng = () => 0.001; // always under the density threshold
    const drive = (p: Profile) => {
      const events: TurboEvent[] = [];
      const s = createState();
      let rpm = 6000;
      for (let t = 0; t < 2; t += DT) {
        rpm -= 1200 * DT;
        step(s, p, { ...base, rpm, pedal: 0 }, DT, events, lowRng);
      }
      return events.filter((e) => e.type === 'pop').length;
    };
    const on = structuredClone(BASE_PROFILE);
    on.setup.pops = 'rally';
    expect(drive(on)).toBeGreaterThan(5);
    expect(drive(BASE_PROFILE)).toBe(0);
  });

  it('a gear change from the car marks a shift and a downshift adds a rev-match blip', () => {
    const p = structuredClone(BASE_PROFILE);
    p.setup.pops = 'mild';
    const events: TurboEvent[] = [];
    const s = createState();
    step(s, p, { ...base, rpm: 3000, pedal: 0.2, gear: 4 }, DT, events, rng);
    step(s, p, { ...base, rpm: 3000, pedal: 0.2, gear: 3 }, DT, events, rng);
    expect(events.some((e) => e.type === 'shift')).toBe(true);
    expect(events.some((e) => e.type === 'blip')).toBe(true);
  });
});

describe('reference log: blow-off count equals shift/lift count', () => {
  const rows = loadLog();
  const expected = rows.filter((r) => r.expect === 1).map((r) => r.t);

  it('fires a blow-off on every real shift and lift, and never while feathering', () => {
    const res = runModel(rows);
    const bov = res.events.filter((x) => x.e.type === 'bov');
    expect(bov).toHaveLength(expected.length);
    for (const m of expected) expect(bov.some((b) => b.t >= m - 0.05 && b.t <= m + 0.8)).toBe(true);
  });

  it('detects the shifts using the gear estimate and rpm drop', () => {
    const res = runModel(rows);
    expect(res.events.filter((x) => x.e.type === 'shift').length).toBeGreaterThanOrEqual(4);
  });

  it('is still correct with the true gear column instead of the estimate', () => {
    expect(runModel(rows, BASE_PROFILE, 44100, false).events.filter((x) => x.e.type === 'bov')).toHaveLength(expected.length);
  });

  it('is robust at 48 kHz', () => {
    expect(runModel(rows, BASE_PROFILE, 48000).events.filter((x) => x.e.type === 'bov')).toHaveLength(expected.length);
  });
});
