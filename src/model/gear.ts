// Gear estimate from engine rpm and road speed (OBD has no standard gear PID that cars reliably answer).
// Pure and unit-tested. The sound engine uses the result for shift detection, gear whine and rev-match blips.

export interface GearConfig {
  gearRatios: number[];
  finalDrive: number;
  tireCircumferenceM: number;
}

export const GEAR = {
  /** below this road speed we report neutral/stopped */
  stoppedKmh: 3,
  /** max log-ratio error to accept a gear (0.09 = about 9%) */
  tolerance: 0.09,
  /** candidate must hold this long before the reported gear changes */
  settleS: 0.22,
  /** while the clutch is in (no gear matches) keep the last gear this long, then report neutral */
  holdS: 1.2,
};

/** engine rpm per km/h for each gear */
export function rpmPerKmh(cfg: GearConfig): number[] {
  const wheelRevPerKmh = 1000 / (60 * cfg.tireCircumferenceM);
  return cfg.gearRatios.map((r) => wheelRevPerKmh * r * cfg.finalDrive);
}

export class GearEstimator {
  private k: number[];
  private current = 0;
  private candidate = 0;
  private candidateFor = 0;
  private unmatched = 0;

  constructor(cfg: GearConfig) {
    this.k = rpmPerKmh(cfg);
  }

  configure(cfg: GearConfig): void {
    this.k = rpmPerKmh(cfg);
    this.reset();
  }

  reset(): void {
    this.current = 0;
    this.candidate = 0;
    this.candidateFor = 0;
    this.unmatched = 0;
  }

  /** @returns 0 for neutral/stopped, 1.. for a gear, null when speed is unknown */
  update(rpm: number, speedKmh: number | null, dt: number): number | null {
    if (speedKmh === null) return null;
    if (speedKmh < GEAR.stoppedKmh || rpm < 300) {
      this.current = 0;
      this.candidate = 0;
      this.candidateFor = 0;
      this.unmatched = 0;
      return 0;
    }
    const ratio = rpm / speedKmh;
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < this.k.length; i++) {
      const err = Math.abs(Math.log(ratio / this.k[i]!));
      if (err < bestErr) {
        bestErr = err;
        best = i + 1;
      }
    }
    if (bestErr > GEAR.tolerance) {
      // clutch in or wheel slip: hold the previous gear for a moment
      this.unmatched += dt;
      this.candidate = 0;
      this.candidateFor = 0;
      if (this.unmatched > GEAR.holdS) this.current = 0;
      return this.current;
    }
    this.unmatched = 0;
    if (best === this.current) {
      this.candidate = best;
      this.candidateFor = 0;
      return this.current;
    }
    if (best === this.candidate) this.candidateFor += dt;
    else {
      this.candidate = best;
      this.candidateFor = dt;
    }
    if (this.candidateFor >= GEAR.settleS) {
      this.current = best;
      this.candidateFor = 0;
    }
    return this.current;
  }
}
