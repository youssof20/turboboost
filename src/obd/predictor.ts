// Turns jumpy 15-30 Hz OBD samples into a smooth 60 Hz stream:
// linear extrapolation from the last two readings (capped), then a one-pole filter.
// Also rejects garbled RPM spikes and applies the RPM exaggeration setting.

export const PREDICT = {
  /** never extrapolate further than this past the newest reading (ms) */
  maxExtrapMs: 60,
  /** smoothing time constant (ms) */
  smoothMs: 35,
  /** reject RPM jumps faster than this per 100 ms unless confirmed by a second reading */
  maxRpmJumpPer100ms: 3000,
  /** two readings this close count as "agreeing" */
  agreeRpm: 600,
  /** treat the link as dead if no frame for this long (ms) */
  watchdogMs: 400,
};

export class Channel {
  private t1 = 0;
  private v1 = 0;
  private t0 = 0;
  private v0 = 0;
  private n = 0;
  private out = 0;
  private lastT = 0;
  private lo: number;
  private hi: number;
  constructor(lo = -Infinity, hi = Infinity) {
    this.lo = lo;
    this.hi = hi;
  }

  push(tMs: number, v: number): void {
    if (this.n > 0 && tMs <= this.t1) return;
    this.t0 = this.t1;
    this.v0 = this.v1;
    this.t1 = tMs;
    this.v1 = v;
    this.n++;
    if (this.n === 1) this.out = v;
  }

  has(): boolean {
    return this.n > 0;
  }

  last(): number {
    return this.v1;
  }

  /** value at time nowMs, led ahead by leadMs (latency compensation) */
  value(nowMs: number, leadMs = 0): number {
    if (this.n === 0) return 0;
    let target = this.v1;
    if (this.n >= 2 && this.t1 > this.t0) {
      const slope = (this.v1 - this.v0) / (this.t1 - this.t0);
      const ahead = Math.min(PREDICT.maxExtrapMs + leadMs, Math.max(0, nowMs - this.t1) + leadMs);
      target = this.v1 + slope * ahead;
    }
    target = Math.min(this.hi, Math.max(this.lo, target));
    const dt = this.lastT === 0 ? 16 : Math.max(0, nowMs - this.lastT);
    this.lastT = nowMs;
    this.out += (target - this.out) * (1 - Math.exp(-dt / PREDICT.smoothMs));
    return this.out;
  }

  reset(): void {
    this.n = 0;
    this.lastT = 0;
  }
}

/** Rejects RPM spikes: a big jump is only accepted once a second reading agrees with it. */
export class RpmValidator {
  private lastGood: number | null = null;
  private lastT = 0;
  private pending: number | null = null;
  rejected = 0;

  accept(tMs: number, rpm: number): number | null {
    if (!Number.isFinite(rpm) || rpm < 0 || rpm > 20000) {
      this.rejected++;
      return null;
    }
    if (this.lastGood === null) {
      this.lastGood = rpm;
      this.lastT = tMs;
      return rpm;
    }
    const dtMs = Math.max(1, tMs - this.lastT);
    const allowed = PREDICT.maxRpmJumpPer100ms * Math.max(1, dtMs / 100);
    const jump = Math.abs(rpm - this.lastGood);
    if (jump <= allowed) {
      this.lastGood = rpm;
      this.lastT = tMs;
      this.pending = null;
      return rpm;
    }
    if (this.pending !== null && Math.abs(rpm - this.pending) <= PREDICT.agreeRpm) {
      this.lastGood = rpm;
      this.lastT = tMs;
      this.pending = null;
      return rpm;
    }
    this.pending = rpm;
    this.rejected++;
    return null;
  }

  reset(): void {
    this.lastGood = null;
    this.pending = null;
  }
}

/**
 * RPM exaggeration (SoundRacer trick): multiplies rpm *changes* relative to a slow average,
 * so steady cruising still sounds busy. Idle stays honest.
 */
export class Exaggerator {
  private avg = 0;
  private init = false;
  apply(rpm: number, k: number, idle: number, dtS: number): number {
    if (!this.init) {
      this.avg = rpm;
      this.init = true;
    }
    this.avg += (rpm - this.avg) * (1 - Math.exp(-dtS / 2.5));
    if (k <= 1.0001) return rpm;
    const honest = Math.min(1, Math.max(0, (rpm - (idle + 150)) / 400));
    const out = rpm + (rpm - this.avg) * (k - 1) * honest;
    return Math.max(0, out);
  }
}
