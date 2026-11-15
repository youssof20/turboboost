// Input sources that need no car: hold-to-rev demo, manual sliders, CSV log replay.
// Every source yields the same Frame the OBD link does, so the sound engine can't tell the difference.

import { sampleLog, type LogRow } from './log.ts';

export interface Frame {
  rpm: number;
  /** 0..1 */
  pedal: number;
  mapKpa: number | null;
  speedKmh: number | null;
  /** a source can provide a gear directly; otherwise the app estimates it from rpm and speed */
  gear: number | null;
  baro: number;
  alive: boolean;
}

export type SourceKind = 'demo' | 'manual' | 'replay' | 'obd';

export interface Source {
  kind: SourceKind;
  label: string;
  tick(nowMs: number, dtS: number): Frame;
}

export const DEMO = {
  /** rpm/s at full pedal near idle */
  accel: 2500,
  /** accel falls to (1 - this) at redline */
  accelFalloff: 0.45,
  /** extra accel from boost, per unit of boost fraction */
  boostBonus: 0.35,
  decayBase: 500,
  decayPerRpm: 0.5,
  decayMax: 2600,
  pedalRise: 5,
  pedalFall: 14,
  limiterHz: 14,
  limiterDepth: 45,
};

/** A tiny engine: rpm rises while the pedal is held and falls when released. No gears. */
export class DemoSource implements Source {
  kind: SourceKind = 'demo';
  label = 'Demo';
  held = false;
  pedal = 0;
  rpm: number;
  limiting = false;
  private idle: number;
  private redline: number;
  private t = 0;
  /** 0..1 fraction of max boost, fed back from the audio thread so spooled boost adds pull */
  boostN = 0;

  constructor(idle: number, redline: number) {
    this.idle = idle;
    this.redline = redline;
    this.rpm = idle;
  }

  configure(idle: number, redline: number): void {
    this.idle = idle;
    this.redline = redline;
    this.rpm = Math.min(Math.max(this.rpm, idle), redline);
  }

  tick(_now: number, dt: number): Frame {
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const target = this.held ? 1 : 0;
    const rate = target > this.pedal ? DEMO.pedalRise : DEMO.pedalFall;
    const d = target - this.pedal;
    this.pedal += Math.abs(d) <= rate * dt ? d : Math.sign(d) * rate * dt;

    const r = this.rpm;
    const load = this.pedal;
    const accel = load * DEMO.accel * (1 - DEMO.accelFalloff * (r / this.redline)) * (1 + DEMO.boostBonus * this.boostN);
    const decay = Math.min(DEMO.decayMax, DEMO.decayPerRpm * Math.max(0, r - this.idle) + DEMO.decayBase) * (1 - load);
    let next = r + (accel - (r > this.idle ? decay : 0)) * dt;
    if (load < 0.05 && next < this.idle) next = this.idle;
    this.limiting = next >= this.redline;
    if (this.limiting) next = this.redline - DEMO.limiterDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * DEMO.limiterHz * this.t));
    this.rpm = Math.max(this.idle, next);
    return { rpm: this.rpm, pedal: this.pedal, mapKpa: null, speedKmh: null, gear: null, baro: 101.3, alive: true };
  }
}

/** RPM and pedal straight from sliders (the Phase 1 sandbox) */
export class ManualSource implements Source {
  kind: SourceKind = 'manual';
  label = 'Sliders';
  rpm = 3000;
  pedal = 0;
  tick(): Frame {
    return { rpm: this.rpm, pedal: this.pedal, mapKpa: null, speedKmh: null, gear: null, baro: 101.3, alive: true };
  }
}

/** Replays a CSV log with a scrubber. Speed is provided so the gear is estimated like in the car. */
export class ReplaySource implements Source {
  kind: SourceKind = 'replay';
  label: string;
  playing = true;
  loop = true;
  rate = 1;
  pos: number;
  readonly start: number;
  readonly end: number;
  private rows: LogRow[];
  private hint = 0;

  constructor(rows: LogRow[], label: string) {
    this.rows = rows;
    this.label = label;
    this.start = rows[0]!.t;
    this.end = rows[rows.length - 1]!.t;
    this.pos = this.start;
  }

  get duration(): number {
    return this.end - this.start;
  }

  seek(t: number): void {
    this.pos = Math.min(this.end, Math.max(this.start, t));
  }

  tick(_now: number, dt: number): Frame {
    if (this.playing) {
      this.pos += Math.min(dt, 0.05) * this.rate;
      if (this.pos >= this.end) {
        if (this.loop) this.pos = this.start;
        else {
          this.pos = this.end;
          this.playing = false;
        }
      }
    }
    const s = sampleLog(this.rows, this.pos, this.hint);
    this.hint = s.index;
    return { rpm: s.row.rpm, pedal: s.row.pedal, mapKpa: s.row.mapKpa, speedKmh: s.row.speed, gear: null, baro: 101.3, alive: true };
  }
}
