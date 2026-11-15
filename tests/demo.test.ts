import { describe, expect, it } from 'vitest';
import { DemoSource, ManualSource, ReplaySource } from '../src/input/demo.ts';
import { loadLog } from './helpers.ts';

function run(d: DemoSource, secs: number, held: boolean) {
  d.held = held;
  let f = d.tick(0, 0.016);
  for (let t = 0; t < secs; t += 0.016) f = d.tick(0, 0.016);
  return f;
}

describe('demo source (hold-to-rev, no gears)', () => {
  it('sits at idle with the pedal up', () => {
    const d = new DemoSource(800, 6800);
    const f = run(d, 3, false);
    expect(f.rpm).toBeCloseTo(800, 0);
    expect(f.pedal).toBe(0);
  });

  it('rpm climbs while held and reaches the limiter in a few seconds', () => {
    const d = new DemoSource(800, 6800);
    const mid = run(d, 1.0, true);
    expect(mid.rpm).toBeGreaterThan(1800);
    expect(mid.rpm).toBeLessThan(5000);
    const top = run(d, 6, true);
    expect(top.rpm).toBeGreaterThan(6600);
    expect(top.rpm).toBeLessThanOrEqual(6800);
    expect(d.limiting).toBe(true);
  });

  it('rpm falls back toward idle on release, gently enough not to look like a gear change', () => {
    const d = new DemoSource(800, 6800);
    run(d, 8, true);
    const half = run(d, 0.3, false);
    expect(half.rpm).toBeGreaterThan(6800 * 0.8); // < 20% in 300 ms
    const later = run(d, 6, false);
    expect(later.rpm).toBeLessThan(900);
  });

  it('never reports speed, gear or MAP (demo has no gears)', () => {
    const f = run(new DemoSource(800, 6800), 1, true);
    expect(f.gear).toBeNull();
    expect(f.speedKmh).toBeNull();
    expect(f.mapKpa).toBeNull();
  });

  it('pedal ramps instead of stepping', () => {
    const d = new DemoSource(800, 6800);
    d.held = true;
    const f = d.tick(0, 0.016);
    expect(f.pedal).toBeGreaterThan(0);
    expect(f.pedal).toBeLessThan(0.2);
  });
});

describe('other sources', () => {
  it('manual source returns exactly what was set', () => {
    const m = new ManualSource();
    m.rpm = 4321;
    m.pedal = 0.5;
    expect(m.tick()).toMatchObject({ rpm: 4321, pedal: 0.5, gear: null });
  });

  it('replay source loops and seeks', () => {
    const r = new ReplaySource(loadLog(), 'ref');
    r.seek(r.start + 5);
    const f = r.tick(0, 0.016);
    expect(f.rpm).toBeGreaterThan(800);
    expect(f.speedKmh).not.toBeNull();
    r.seek(r.end - 0.01);
    r.tick(0, 0.5);
    expect(r.pos).toBeLessThan(r.start + 1); // looped
    r.playing = false;
    const p = r.pos;
    r.tick(0, 0.5);
    expect(r.pos).toBe(p);
  });
});
