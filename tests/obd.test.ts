import { describe, expect, it } from 'vitest';
import { Elm327, parseMode01, parseSupported, payloadFromLines, parseVin, type Sample } from '../src/obd/elm327.ts';
import { MockElm327 } from '../src/obd/mock.ts';
import { ObdLink } from '../src/obd/link.ts';
import { loadLog } from './helpers.ts';

describe('ELM327 parsing', () => {
  it('parses a single-frame multi-PID reply with spaces', () => {
    const b = payloadFromLines(['41 0C 1A F8 11 7F 49 3E']);
    const s = parseMode01(b, 5)!;
    expect(s.rpm).toBeCloseTo((0x1a * 256 + 0xf8) / 4, 5);
    expect(s.throttle).toBeCloseTo(0x7f / 255, 5);
    expect(s.pedal).toBeCloseTo(0x3e / 255, 5);
  });

  it('parses without spaces and ignores SEARCHING lines', () => {
    const b = payloadFromLines(['SEARCHING...', '410C0FA0']);
    expect(parseMode01(b, 0)!.rpm).toBe(1000);
  });

  it('reassembles a multi-frame reply', () => {
    const b = payloadFromLines(['00A', '0: 41 0C 1A F8 0D 40', '1: 49 3E 0B 78']);
    const s = parseMode01(b, 0)!;
    expect(s.rpm).toBeCloseTo(1726, 0);
    expect(s.speedKmh).toBe(0x40);
    expect(s.pedal).toBeCloseTo(0x3e / 255, 5);
    expect(s.mapKpa).toBe(0x78);
  });

  it('rejects error replies', () => {
    for (const l of ['NO DATA', '?', 'UNABLE TO CONNECT', 'CAN ERROR', 'STOPPED', 'BUS INIT: OK']) {
      expect(parseMode01(payloadFromLines([l]), 0), l).toBeNull();
    }
  });

  it('stops cleanly at an unknown PID and tolerates truncation', () => {
    const s = parseMode01([0x41, 0x0c, 0x0f, 0xa0, 0x99, 0x01], 0)!;
    expect(s.rpm).toBe(1000);
    expect(parseMode01([0x41, 0x0c, 0x0f], 0)).toBeNull();
  });

  it('decodes the supported-PID bitmask', () => {
    const r = parseSupported([0x41, 0x00, 0xbe, 0x3e, 0xb8, 0x10], 0x00)!;
    expect(r.pids).toContain(0x0c);
    expect(r.pids).toContain(0x0d);
    expect(r.pids).not.toContain(0x02);
    expect(r.more).toBe(false);
    expect(parseSupported([0x41, 0x00, 0xbe, 0x3e, 0xb8, 0x11], 0x00)!.more).toBe(true);
  });

  it('decodes a VIN', () => {
    const vin = '1HGCM82633A004352';
    const bytes = [0x49, 0x02, 0x01, ...[...vin].map((c) => c.charCodeAt(0))];
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    expect(parseVin([hex])).toBe(vin);
  });
});

describe('ELM327 over the fake adapter (full stack, no car)', () => {
  it('inits, discovers PIDs and polls at 15+ Hz with values that match the log', async () => {
    const rows = loadLog();
    const mock = new MockElm327({ rows, latencyMs: 8 });
    const elm = new Elm327(mock);
    const samples: Sample[] = [];
    elm.onSample = (s) => samples.push(s);
    await elm.init();
    expect(elm.isCan).toBe(true);
    expect(elm.supported.has(0x0c)).toBe(true);
    expect(elm.supported.has(0x49)).toBe(true);
    expect(elm.buildCycle(0)[0]).toMatch(/^010C490D0B|^010C0D49|^010C49/);
    samples.length = 0;
    elm.start();
    await new Promise((r) => setTimeout(r, 1500));
    elm.close();
    const withRpm = samples.filter((s) => s.rpm !== undefined);
    expect(withRpm.length).toBeGreaterThan(20); // >13 Hz even with a 8 ms adapter + 2 poll steps in CI
    const last = withRpm[withRpm.length - 1]!;
    expect(last.rpm!).toBeGreaterThan(700);
    expect(last.pedal).toBeDefined();
    expect(last.speedKmh).toBeDefined();
  });

  it('uses one PID per request on non-CAN protocols', async () => {
    const mock = new MockElm327({ rows: loadLog(), latencyMs: 2, nonCan: true });
    const elm = new Elm327(mock);
    await elm.init();
    expect(elm.isCan).toBe(false);
    const cycle = elm.buildCycle(0);
    expect(cycle.length).toBeGreaterThan(2);
    expect(cycle.every((c) => c.length === 4)).toBe(true);
    elm.close();
  });

  it('survives glitches: rejected rpm spikes never reach the output', async () => {
    const link = new ObdLink();
    const mock = new MockElm327({ rows: loadLog(), latencyMs: 3, glitches: true });
    link.start('mock', async () => mock);
    const seen: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      await new Promise((r) => setTimeout(r, 20));
      const r = link.read(performance.now(), 0, 12);
      if (r.alive) seen.push(r.rpm);
    }
    link.stop();
    expect(seen.length).toBeGreaterThan(20);
    expect(Math.max(...seen)).toBeLessThan(9000); // the 11000 rpm spikes were rejected
    expect(link.rawRejected).toBeGreaterThan(0);
  });

  it('link watchdog: reading goes not-alive when frames stop', async () => {
    const link = new ObdLink();
    const mock = new MockElm327({ rows: loadLog(), latencyMs: 3 });
    link.start('mock', async () => mock);
    const t0 = performance.now();
    while (performance.now() - t0 < 1500 && link.state !== 'live') await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    expect(link.read(performance.now(), 0, 12).alive).toBe(true);
    expect(link.read(performance.now() + 450, 0, 12).alive).toBe(false);
    link.stop();
  });
});
