// Virtual turbo state model. Pure: no DOM, no audio, no globals.
// Runs once per audio block inside the AudioWorklet and is unit-tested against logs/*.csv.

import type { Profile, StageParams } from './profiles.ts';

export interface Input {
  rpm: number;
  /** 0..1 */
  pedal: number;
  mapKpa: number | null;
  baroKpa: number;
  speedKmh: number | null;
  /** 0 = neutral/clutch, 1.. = gear, null = unknown (demo mode, no speed data) */
  gear: number | null;
}

export type TurboEventType = 'bov' | 'flutter' | 'pop' | 'bang' | 'shift' | 'blip';

export interface TurboEvent {
  type: TurboEventType;
  /** bar at the moment of the event */
  boost: number;
  /** 0..1.2 relative loudness */
  strength: number;
  /** recirculating / quiet bypass valve */
  muffled?: boolean;
  /** number of repeats for blip */
  count?: number;
}

export interface State {
  shafts: number[];
  /** combined shaft speed 0..1 (max over stages) */
  shaft: number;
  boost: number;
  /** recent peak boost (decays ~250 ms): what was stored just before a lift */
  boostPeak: number;
  flow: number;
  /** d(shaft)/dt, smoothed, 1/s */
  spoolRate: number;
  /** 0..1, closes below idle so a quiet car stays quiet */
  gate: number;
  venting: boolean;
  shifting: boolean;
  antiLagActive: boolean;
  lastPedal: number;
  pedalPeak: number;
  liftArmed: number;
  shiftTimer: number;
  antiLagTimer: number;
  bangAcc: number;
  lastRpm: number;
  rpmRate: number;
  lastGear: number | null;
  sinceVent: number;
  hist: { t: number; rpm: number; speed: number }[];
  histIdx: number;
  time: number;
}

const HIST = 128;

export function createState(): State {
  const hist: State['hist'] = [];
  for (let i = 0; i < HIST; i++) hist.push({ t: -10, rpm: 0, speed: 0 });
  return {
    shafts: [0, 0],
    shaft: 0,
    boost: 0,
    boostPeak: 0,
    flow: 0,
    spoolRate: 0,
    gate: 0,
    venting: false,
    shifting: false,
    antiLagActive: false,
    lastPedal: 0,
    pedalPeak: 0,
    liftArmed: 0,
    shiftTimer: 0,
    antiLagTimer: 0,
    bangAcc: 0,
    lastRpm: 0,
    rpmRate: 0,
    lastGear: null,
    sinceVent: 99,
    hist,
    histIdx: 0,
    time: 0,
  };
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function stagesOf(p: Profile): { params: StageParams; weight: number }[] {
  const t = p.turbo;
  const sec = t.secondary;
  const primary: StageParams = {
    rpmBoostStart: t.rpmBoostStart,
    rpmFullBoost: t.rpmFullBoost,
    tauUp: t.tauUp,
    tauDown: t.tauDown,
    whineHzMin: t.whineHzMin,
    whineHzMax: t.whineHzMax,
    weight: sec ? 1 - sec.weight : 1,
  };
  return sec ? [{ params: primary, weight: primary.weight }, { params: sec, weight: sec.weight }] : [{ params: primary, weight: 1 }];
}

/** Tunables that are model-internal but not worth a slider. Kept together so they are not "magic". */
export const MODEL = {
  idleGateOffsetRpm: 300,
  idleGatePedal: 0.05,
  gateTau: 0.12,
  ventTau: 0.15,
  boostPeakTau: 0.25,
  restPedalDrive: 0.15,
  spoolRateTau: 0.08,
  pedalPeakDecay: 2,
  liftArmDrop: 0.15,
  liftArmTime: 0.3,
  liftCloseLevel: 0.3,
  liftPeakMin: 0.45,
  rearmPedal: 0.3,
  shiftWindow: 0.3,
  shiftRpmDrop: 0.2,
  shiftSpeedHold: 0.95,
  shiftHold: 0.5,
  shiftConfidence: 0.5, // threshold multiplier while shifting
  shiftTauDownScale: 0.6,
  antiLagHold: 1.8,
  antiLagMinRpm: 3000,
  antiLagDrive: 0.85,
  antiLagBangHz: 9,
  popMinRpm: 3000,
  popMildHz: 2.5,
  popRallyHz: 8,
  minVentGap: 0.45,
};

/**
 * Advance the model by dt seconds. Pushes any triggered events into `events`.
 * `rng` is injectable so offline renders and tests are deterministic.
 */
export function step(s: State, p: Profile, inp: Input, dt: number, events: TurboEvent[], rng: () => number): void {
  const M = MODEL;
  const t = p.turbo;
  s.time += dt;
  s.sinceVent += dt;

  // ---- history for shift detection -----------------------------------------
  const h = s.hist[s.histIdx]!;
  h.t = s.time;
  h.rpm = inp.rpm;
  h.speed = inp.speedKmh ?? -1;
  s.histIdx = (s.histIdx + 1) % HIST;
  let rpmMax = 0;
  let speedMax = 0;
  for (let i = 0; i < HIST; i++) {
    const e = s.hist[i]!;
    if (s.time - e.t <= M.shiftWindow) {
      if (e.rpm > rpmMax) rpmMax = e.rpm;
      if (e.speed > speedMax) speedMax = e.speed;
    }
  }
  const speedHolds = inp.speedKmh === null || speedMax <= 0 || inp.speedKmh >= speedMax * M.shiftSpeedHold;
  const rpmDropped = rpmMax > 2000 && inp.rpm <= rpmMax * (1 - M.shiftRpmDrop) && inp.pedal < 0.4;
  let shiftNow = rpmDropped && speedHolds && s.shiftTimer <= 0;
  let downshift = false;
  if (inp.gear !== null && inp.gear > 0 && s.lastGear !== null && s.lastGear > 0 && inp.gear !== s.lastGear) {
    shiftNow = s.shiftTimer <= 0 || shiftNow;
    downshift = inp.gear < s.lastGear;
  }
  if (inp.gear !== null && inp.gear > 0) s.lastGear = inp.gear;
  if (shiftNow) {
    s.shiftTimer = M.shiftHold;
    events.push({ type: 'shift', boost: s.boost, strength: 1 });
    if (downshift && p.setup.pops !== 'off') events.push({ type: 'blip', boost: s.boost, strength: 0.7, count: 3 });
  }
  s.shiftTimer = Math.max(0, s.shiftTimer - dt);
  s.shifting = s.shiftTimer > 0;

  // ---- idle gate ------------------------------------------------------------
  const gateOpen = !(inp.rpm < p.engine.idle + M.idleGateOffsetRpm && inp.pedal < M.idleGatePedal);
  s.gate += ((gateOpen ? 1 : 0) - s.gate) * (1 - Math.exp(-dt / M.gateTau));

  // ---- spool ----------------------------------------------------------------
  const prevShaft = s.shaft;
  const isSC = p.kind === 'supercharger';
  const stages = stagesOf(p);

  // anti-lag keeps the turbine spun after a lift
  s.antiLagTimer = Math.max(0, s.antiLagTimer - dt);
  s.antiLagActive = p.lift.antiLag && s.antiLagTimer > 0 && inp.pedal < 0.2 && inp.rpm > M.antiLagMinRpm;

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]!.params;
    let drive: number;
    if (isSC) {
      drive = Math.min(1, inp.rpm / p.engine.redline) * (gateOpen ? 1 : 0);
    } else {
      const spool = smoothstep(st.rpmBoostStart, st.rpmFullBoost, inp.rpm);
      drive = spool * (M.restPedalDrive + (1 - M.restPedalDrive) * inp.pedal);
      if (s.antiLagActive) drive = Math.max(drive, spool * M.antiLagDrive);
      if (!gateOpen) drive = 0;
    }
    const cur = s.shafts[i]!;
    let tau = drive > cur ? st.tauUp : st.tauDown;
    if (s.shifting && drive <= cur) tau *= M.shiftTauDownScale;
    s.shafts[i] = cur + (drive - cur) * (1 - Math.exp(-dt / tau));
    if (!gateOpen && s.shafts[i]! < 0.004) s.shafts[i] = 0; // decays to true zero
  }
  if (stages.length === 1) s.shafts[1] = 0;
  s.shaft = Math.max(s.shafts[0]!, stages.length > 1 ? s.shafts[1]! : 0);

  // ---- boost ----------------------------------------------------------------
  const exp = isSC ? 1 : t.boostExponent;
  let virtualBoost = 0;
  for (let i = 0; i < stages.length; i++) virtualBoost += stages[i]!.weight * Math.pow(s.shafts[i]!, exp);
  virtualBoost *= t.maxBoost * Math.min(1, inp.pedal * 1.5);
  const useReal = p.setup.boostSource === 'map' && inp.mapKpa !== null;
  const realBoost = useReal ? Math.max(0, (inp.mapKpa! - inp.baroKpa) / 100) : null;
  if (s.venting) s.boost *= Math.exp(-dt / M.ventTau);
  else s.boost = realBoost ?? virtualBoost;

  s.boostPeak = Math.max(s.boost, s.boostPeak * Math.exp(-dt / M.boostPeakTau));
  s.flow = s.shaft * inp.pedal;
  const rawRate = (s.shaft - prevShaft) / dt;
  s.spoolRate += (rawRate - s.spoolRate) * (1 - Math.exp(-dt / M.spoolRateTau));

  // ---- lift detection -------------------------------------------------------
  s.pedalPeak = Math.max(inp.pedal, s.pedalPeak - M.pedalPeakDecay * dt);
  const pedalRate = (inp.pedal - s.lastPedal) / dt;
  if (pedalRate < p.lift.liftRate && s.pedalPeak - inp.pedal > M.liftArmDrop) s.liftArmed = M.liftArmTime;
  else s.liftArmed = Math.max(0, s.liftArmed - dt);

  const threshold = p.lift.bovThreshold * (s.shifting ? M.shiftConfidence : 1);
  const lifted = s.liftArmed > 0 && inp.pedal < M.liftCloseLevel && s.pedalPeak > M.liftPeakMin;
  // a detected shift with the pedal already closed also counts (pedal PID missing or slow)
  const shiftLift = shiftNow && inp.pedal < M.liftCloseLevel && s.pedalPeak > M.liftPeakMin;
  if ((lifted || shiftLift) && s.boostPeak > threshold && !s.venting && s.sinceVent > M.minVentGap) {
    const confidence = s.shifting ? 1.1 : 1;
    const stored = s.boostPeak;
    const strength = Math.min(1.2, (stored / Math.max(0.2, t.maxBoost)) * confidence + 0.15);
    const mode = p.lift.mode;
    if (p.lift.antiLag) {
      s.antiLagTimer = M.antiLagHold;
      events.push({ type: 'bang', boost: stored, strength: Math.min(1, strength) });
    }
    if (mode === 'bov' || mode === 'both') events.push({ type: 'bov', boost: stored, strength });
    if (mode === 'recirc') events.push({ type: 'bov', boost: stored, strength: strength * 0.4, muffled: true });
    if (mode === 'flutter' || mode === 'both') events.push({ type: 'flutter', boost: stored, strength });
    s.venting = true; // boost drains quickly; the shaft keeps coasting
    s.sinceVent = 0;
    s.liftArmed = 0;
    s.boostPeak = 0;
  }
  if (inp.pedal > M.rearmPedal) s.venting = false;
  s.lastPedal = inp.pedal;

  // ---- anti-lag bangs and overrun pops --------------------------------------
  s.rpmRate += ((inp.rpm - s.lastRpm) / dt - s.rpmRate) * (1 - Math.exp(-dt / 0.1));
  s.lastRpm = inp.rpm;
  if (s.antiLagActive) {
    s.bangAcc += dt * M.antiLagBangHz;
    while (s.bangAcc >= 1) {
      s.bangAcc -= 1;
      if (rng() < 0.75) events.push({ type: 'bang', boost: s.boost, strength: 0.5 + 0.5 * rng() });
    }
  }
  if (p.setup.pops !== 'off' && inp.pedal < 0.04 && inp.rpm > M.popMinRpm && s.rpmRate < -150) {
    const base = p.setup.pops === 'rally' ? M.popRallyHz : M.popMildHz;
    const density = base * Math.min(1.2, Math.max(0.15, (inp.rpm - M.popMinRpm) / 3000));
    if (rng() < density * dt) events.push({ type: 'pop', boost: s.boost, strength: 0.4 + 0.6 * rng() });
  }
}
