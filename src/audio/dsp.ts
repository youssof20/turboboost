// All continuous DSP voices + the turbo state model, as a plain class with no AudioWorklet
// dependency. worklet.ts wraps it for the browser; scripts/render.ts runs the very same code offline.
// Never call this from the main thread in the app: audio math lives on the audio thread.

import { createState, step, stagesOf, type Input, type State, type TurboEvent } from '../model/turbo.ts';
import type { Profile } from '../model/profiles.ts';

const CHUNK = 32; // samples between coefficient updates; all gains ramp linearly across a chunk
const MODEL_BLOCK = 128; // model runs once per 128 samples (~2.9 ms)
const TWO_PI = Math.PI * 2;

export type Mode = 'mute' | 'sport' | 'full';

export const DSP = {
  inputTauRpm: 0.012,
  inputTauPedal: 0.012,
  inputTauSpeed: 0.05,
  masterTau: 0.03,
  warmupS: 0.5,
  fadeInS: 1.0,
  fadeOutS: 0.5,
  duckAmount: 0.2,
  duckHoldS: 0.3,
  duckReleaseS: 0.15,
  headphoneLowPassHz: 9000,
  bayLowPassHz: 9000,
  cabinShotHz: 2600,
  cabinBoomHz: 170,
  cabinBoom: 0.35,
  roarNorm: 0.3,
  sportScale: 0.5,
  speedDuckMaxKmh: 120,
  whineNorm: 0.32,
  whooshNorm: 0.62,
  foundationNorm: 0.35,
  twinBoost: 1.5,
  /** real compressor whistle is aerodynamic tonal noise, not a pure sine: share of the whine that is a narrow noise band */
  whineAir: 0.45,
  /** bandwidth of that noise band as a fraction of pitch (Q = 1 / this) */
  whineAirBw: 0.035,
  /** random phase drift of the tone, radians-ish; kills the "synth beep" */
  whinePhaseNoise: 0.18,
  whinePhaseNoiseHz: 35,
  /** upper partials and the octave-down sub read as organ / game; keep them as colour only */
  upperPartialScale: 0.45,
  subScale: 0.35,
  /** foundation is now intake rumble (filtered noise at firing rate), not a saw */
  rumbleHzMin: 70,
  rumbleHzMax: 240,
  maxVoices: 14,
  stateHz: 30,
};

// ---------------------------------------------------------------------------------------------
// small utilities

export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  /** xorshift32, 0..1 */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  /** -1..1 */
  bi(): number {
    return this.next() * 2 - 1;
  }
}

/** TPT state-variable filter (stable up to near-Nyquist). bp output is peak-normalised to 1. */
class Svf {
  ic1 = 0;
  ic2 = 0;
  g = 0;
  k = 1;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  set(f: number, q: number, sr: number): void {
    const fc = Math.min(Math.max(f, 20), sr * 0.45);
    this.g = Math.tan((Math.PI * fc) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  tick(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1 * this.k;
    this.hp = x - this.k * v1 - v2;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
  }
}

const SINE_N = 2048;
const SINE = (() => {
  const t = new Float32Array(SINE_N + 2);
  for (let i = 0; i < SINE_N + 2; i++) t[i] = Math.sin((i / SINE_N) * TWO_PI);
  return t;
})();

function sinT(phase01: number): number {
  const x = (phase01 - Math.floor(phase01)) * SINE_N;
  const i = x | 0;
  const f = x - i;
  const a = SINE[i]!;
  return a + (SINE[i + 1]! - a) * f;
}

function buildPink(rng: Rng, n: number): Float32Array {
  // Paul Kellet's economy pink filter; pre-built so the audio thread never computes it per sample
  const xf = 2048;
  const gen = new Float32Array(n + xf);
  let b0 = 0, b1 = 0, b2 = 0;
  let peak = 0;
  for (let i = 0; i < n + xf; i++) {
    const w = rng.bi();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const v = b0 + b1 + b2 + w * 0.1848;
    gen[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // crossfade the seam so the loop point is click-free
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i < xf ? i / xf : 1;
    out[i] = (i < xf ? gen[i]! * a + gen[n + i]! * (1 - a) : gen[i]!) / (peak * 0.6);
  }
  return out;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------------
// voices

interface StageVoice {
  phase: number;
  subPhase: number;
  fmPhase: number;
  pos: number; // 2nd-order pitch smoother state
  vel: number;
  wobble: number;
  wobbleTarget: number;
  wobbleTimer: number;
  f: number;
  gains: Float64Array; // current gains: 5 partials + sub
  nb: Svf;
  nbNorm: number;
  pj: number;
  targets: Float64Array;
}

function newStage(): StageVoice {
  return {
    phase: 0, subPhase: 0, fmPhase: 0, f: 0, pos: 0, vel: 0, wobble: 0, wobbleTarget: 0, wobbleTimer: 0,
    gains: new Float64Array(6), targets: new Float64Array(6), nb: new Svf(), nbNorm: 1, pj: 0,
  };
}

interface BovVoice {
  active: boolean;
  t: number;
  tau: number;
  gain: number;
  muffled: boolean;
  hp: Svf;
  bp: Svf;
}

interface ShotVoice {
  buf: Float32Array | null;
  pos: number;
  rate: number;
  gain: number;
  l: number;
  r: number;
}

interface Scheduled {
  delay: number;
  kind: 'pop' | 'bang';
  strength: number;
}

export interface Snapshot {
  rpm: number;
  pedal: number;
  shaft: number;
  shafts: number[];
  boost: number;
  flow: number;
  gate: number;
  spoolRate: number;
  venting: boolean;
  shifting: boolean;
  gear: number | null;
  speed: number | null;
  level: number;
}

export class TurboDSP {
  readonly sr: number;
  profile: Profile;
  readonly rng: Rng;
  readonly model: State = createState();
  readonly modelEvents: TurboEvent[] = [];
  /** events since last drain, for UI flashes */
  readonly uiEvents: TurboEvent[] = [];

  // inputs (targets) and smoothed copies
  private inRpm = 0;
  private inPedal = 0;
  private inMap: number | null = null;
  private inBaro = 101.3;
  private inSpeed: number | null = null;
  private inGear: number | null = null;
  private rpmS = 0;
  private pedalS = 0;
  private speedS = 0;
  private modelAcc = 0;
  private modelInput: Input = { rpm: 0, pedal: 0, mapKpa: null, baroKpa: 101.3, speedKmh: null, gear: null };

  // global
  private mode: Mode = 'full';
  private masterVol = 0.7;
  private masterS = 0;
  private headphone = false;
  private linkAlive = true;
  private started = false;
  private warmup = 0;
  private fade = 0;
  private fadeTarget = 0;
  private duckTimer = 0;
  private duck = 1;
  private levelEnv = 0;
  private speedGain = 1;

  // voices
  private stages: StageVoice[] = [newStage(), newStage()];
  private pink: Float32Array;
  private pinkPos = 0;
  private noiseRng: Rng;
  private whooshBp = new Svf();
  private whooshLp = 0;
  private firePhase = 0;
  private flowJitter = 0;
  private flowJitterTarget = 0;
  private flowJitterTimer = 0;
  private foundLp = new Svf();
  private foundGain = 0;
  private whooshGain = 0;
  private wgGain = 0;
  private wgHp = new Svf();
  private res: Svf[] = [new Svf(), new Svf(), new Svf(), new Svf()];
  private interior = new Svf();
  private cabin = true;
  private boom = new Svf();
  private shotL = new Svf();
  private shotR = new Svf();
  private roarLp = new Svf();
  private roarGain = 0;
  private scPhase = 0;
  private scBp = new Svf();
  private scGain = 0;
  private gwPhase = 0;
  private gwGain = 0;
  // flutter
  private flutActive = false;
  private flutLeft = 0;
  private flutTotal = 0;
  private flutTimer = 0;
  private flutEnv = 0;
  private flutAmp = 0;
  private flutBoostN = 0;
  private flutBp = new Svf();
  private flutStrength = 0;
  private pitchDip = 0;
  private flutLo = new Svf();
  private flutPhase = 0;
  private flutDecayC = 0.9990;
  private flutCenter = 1;
  // one-shots
  private bov: BovVoice[] = [0, 1, 2].map(() => ({ active: false, t: 0, tau: 0.1, gain: 0, muffled: false, hp: new Svf(), bp: new Svf() }));
  private shots: ShotVoice[] = [];
  private banks: { bov: Float32Array[]; pop: Float32Array[] } = { bov: [], pop: [] };
  private scheduled: Scheduled[] = [];
  // stereo
  private delayBuf: Float32Array;
  private delayPos = 0;
  private limEnv = 0;
  private limGain = 1;
  private incs = new Float64Array(12);

  constructor(sampleRate: number, profile: Profile, seed = 12345) {
    this.sr = sampleRate;
    this.profile = profile;
    this.rng = new Rng(seed);
    this.noiseRng = new Rng(seed ^ 0xa5a5a5a5);
    this.pink = buildPink(new Rng(seed ^ 0x1234567), 1 << 17);
    for (let i = 0; i < DSP.maxVoices; i++) this.shots.push({ buf: null, pos: 0, rate: 1, gain: 0, l: 0, r: 0 });
    this.delayBuf = new Float32Array(Math.ceil(sampleRate * 0.02) + 4);
    this.setProfile(profile);
  }

  // ---- control API ------------------------------------------------------------------------

  setProfile(p: Profile): void {
    this.profile = p;
    const sr = this.sr;
    for (let i = 0; i < 4; i++) {
      const r = p.body.resonators[i];
      if (r) this.res[i]!.set(r[0], r[1], sr);
    }
    this.applyView();
    this.wgHp.set(3000, 0.7, sr);
    for (let i = 0; i < 2; i++) this.stages[i]!.wobbleTimer = 0;
  }

  setInput(i: { rpm?: number; pedal?: number; mapKpa?: number | null; baroKpa?: number; speedKmh?: number | null; gear?: number | null }): void {
    if (i.rpm !== undefined) this.inRpm = i.rpm;
    if (i.pedal !== undefined) this.inPedal = clamp(i.pedal, 0, 1);
    if (i.mapKpa !== undefined) this.inMap = i.mapKpa;
    if (i.baroKpa !== undefined) this.inBaro = i.baroKpa;
    if (i.speedKmh !== undefined) this.inSpeed = i.speedKmh;
    if (i.gear !== undefined) this.inGear = i.gear;
  }

  setMode(m: Mode): void {
    this.mode = m;
  }
  setMaster(v: number): void {
    this.masterVol = clamp(v, 0, 1);
  }
  /** cabin = heard from inside the car (muffled, boomy); false = engine bay (open, bright) */
  setCabin(on: boolean): void {
    this.cabin = on;
    this.applyView();
  }
  private bright(): boolean {
    return this.headphone || !this.cabin;
  }
  private applyView(): void {
    const sr = this.sr;
    this.interior.set(this.bright() ? (this.cabin ? DSP.headphoneLowPassHz : DSP.bayLowPassHz) : this.profile.body.interiorLowPassHz, 0.6, sr);
    this.boom.set(DSP.cabinBoomHz, 0.7, sr);
    const shotHz = this.bright() ? 12000 : DSP.cabinShotHz;
    this.shotL.set(shotHz, 0.6, sr);
    this.shotR.set(shotHz, 0.6, sr);
  }
  setHeadphone(on: boolean): void {
    this.headphone = on;
    this.applyView();
  }
  /** link = OBD data is arriving. false fades the sound out over 500 ms; true brings it back */
  setLink(alive: boolean): void {
    this.linkAlive = alive;
    if (this.started) this.fadeTarget = alive ? 1 : 0;
  }
  /** begin: silent warm-up first (worklet compile spike), then a soft fade-in. `instant` skips both (offline render). */
  start(instant = false): void {
    this.started = true;
    this.fadeTarget = this.linkAlive ? 1 : 0;
    if (instant) {
      this.warmup = 0;
      this.fade = this.fadeTarget;
      this.masterS = this.masterVol;
    } else {
      this.warmup = Math.round(DSP.warmupS * this.sr);
    }
  }
  stop(): void {
    this.started = false;
    this.fadeTarget = 0;
  }

  setSamples(kind: 'bov' | 'pop', bufs: Float32Array[]): void {
    this.banks[kind] = bufs;
  }
  sampleCount(kind: 'bov' | 'pop'): number {
    return this.banks[kind].length;
  }

  drainUiEvents(): TurboEvent[] {
    const out = this.uiEvents.slice();
    this.uiEvents.length = 0;
    return out;
  }

  snapshot(): Snapshot {
    const m = this.model;
    return {
      rpm: this.rpmS,
      pedal: this.pedalS,
      shaft: m.shaft,
      shafts: m.shafts.slice(),
      boost: m.boost,
      flow: m.flow,
      gate: m.gate,
      spoolRate: m.spoolRate,
      venting: m.venting,
      shifting: m.shifting,
      gear: this.inGear,
      speed: this.inSpeed,
      level: this.levelEnv,
    };
  }

  // ---- events -----------------------------------------------------------------------------

  private handleEvent(e: TurboEvent): void {
    const p = this.profile;
    const sport = this.mode === 'sport';
    this.uiEvents.push(e);
    const boostN = clamp(e.boost / Math.max(0.2, p.turbo.maxBoost), 0, 1.3);
    switch (e.type) {
      case 'bov': {
        const muffled = !!e.muffled;
        const gain = e.strength * p.mix.bov * (sport ? 0.6 : 1);
        this.startBovSynth(gain, boostN, muffled);
        if (this.banks.bov.length > 0) {
          const rate = (0.9 + 0.2 * clamp(boostN, 0, 1)) * (0.97 + 0.06 * this.rng.next()) * (muffled ? 0.8 : 1);
          this.startShot(this.banks.bov, rate, gain * 0.65 * (muffled ? 0.5 : 1), 0);
        }
        this.duckTimer = DSP.duckHoldS;
        break;
      }
      case 'flutter': {
        const f = p.lift.flutter;
        this.flutActive = true;
        this.flutTotal = Math.max(3, Math.round(f.pulses * (0.7 + 0.5 * clamp(boostN, 0, 1.2))));
        this.flutLeft = this.flutTotal;
        this.flutTimer = 0;
        this.flutStrength = e.strength * p.mix.flutter * (sport ? 0.6 : 1);
        this.flutBoostN = clamp(boostN, 0, 1);
        this.duckTimer = DSP.duckHoldS * 2;
        break;
      }
      case 'pop':
      case 'bang': {
        if (sport) break;
        const bank = this.banks.pop;
        const loud = e.type === 'bang' ? 1.4 : 1;
        const rate = e.type === 'bang' ? 0.8 + 0.2 * this.rng.next() : 0.85 + 0.35 * this.rng.next();
        if (bank.length > 0) this.startShot(bank, rate, e.strength * p.mix.pops * loud * 0.8, (this.rng.next() * 2 - 1) * 0.6);
        break;
      }
      case 'blip': {
        if (sport) break;
        const n = e.count ?? 3;
        for (let i = 0; i < n; i++) {
          this.scheduled.push({ delay: Math.round((0.05 + i * 0.07 + this.rng.next() * 0.03) * this.sr), kind: 'pop', strength: e.strength });
        }
        break;
      }
      case 'shift':
        break;
    }
  }

  private startBovSynth(gain: number, boostN: number, muffled: boolean): void {
    let v = this.bov.find((x) => !x.active);
    if (!v) v = this.bov[0]!;
    v.active = true;
    v.t = 0;
    v.tau = (0.08 + 0.17 * clamp(boostN, 0, 1)) * (muffled ? 1.3 : 1);
    v.gain = gain * (this.banks.bov.length > 0 ? 0.35 : 1) * (muffled ? 0.5 : 1);
    v.muffled = muffled;
    v.hp.reset();
    v.bp.reset();
  }

  private startShot(bank: Float32Array[], rate: number, gain: number, pan: number): void {
    const buf = bank[Math.floor(this.rng.next() * bank.length)]!;
    let v = this.shots.find((s) => s.buf === null);
    if (!v) v = this.shots.reduce((a, b) => (a.pos > b.pos ? a : b));
    v.buf = buf;
    v.pos = 0;
    v.rate = rate;
    v.gain = gain;
    const a = ((pan + 1) * Math.PI) / 4;
    v.l = Math.cos(a);
    v.r = Math.sin(a);
  }

  // ---- audio ------------------------------------------------------------------------------

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    let pos = 0;
    while (pos < n) {
      const m = Math.min(CHUNK, n - pos);
      this.chunk(outL, outR, pos, m);
      pos += m;
    }
  }

  private chunk(outL: Float32Array, outR: Float32Array, off: number, m: number): void {
    const sr = this.sr;
    const dt = m / sr;
    const p = this.profile;
    const t = p.turbo;

    // ---- smooth inputs (one-pole per chunk; nothing jumps) ----
    this.rpmS += (this.inRpm - this.rpmS) * (1 - Math.exp(-dt / DSP.inputTauRpm));
    this.pedalS += (this.inPedal - this.pedalS) * (1 - Math.exp(-dt / DSP.inputTauPedal));
    if (this.inSpeed !== null) this.speedS += (this.inSpeed - this.speedS) * (1 - Math.exp(-dt / DSP.inputTauSpeed));
    this.masterS += (this.masterVol - this.masterS) * (1 - Math.exp(-dt / DSP.masterTau));

    // ---- model once per block ----
    this.modelAcc += m;
    if (this.modelAcc >= MODEL_BLOCK) {
      const mi = this.modelInput;
      mi.rpm = this.rpmS;
      mi.pedal = this.pedalS;
      mi.mapKpa = this.inMap;
      mi.baroKpa = this.inBaro;
      mi.speedKmh = this.inSpeed === null ? null : this.speedS;
      mi.gear = this.inGear;
      this.modelEvents.length = 0;
      step(this.model, p, mi, this.modelAcc / sr, this.modelEvents, () => this.rng.next());
      this.modelAcc = 0;
      for (const e of this.modelEvents) this.handleEvent(e);
    }
    const s = this.model;

    // scheduled pops (rev-match blips)
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const sc = this.scheduled[i]!;
      sc.delay -= m;
      if (sc.delay <= 0) {
        this.scheduled.splice(i, 1);
        this.handleEvent({ type: sc.kind, boost: s.boost, strength: sc.strength });
      }
    }

    // ---- global gain: mode, fade, duck, speed ----
    const modeScale = this.mode === 'mute' ? 0 : this.mode === 'sport' ? DSP.sportScale : 1;
    if (this.warmup > 0) {
      this.warmup -= m;
    } else if (this.started || this.fade > 0) {
      const rate = this.fadeTarget > this.fade ? 1 / DSP.fadeInS : 1 / DSP.fadeOutS;
      this.fade += clamp(this.fadeTarget - this.fade, -rate * dt, rate * dt);
    }
    const fadeG = this.warmup > 0 ? 0 : this.fade * this.fade * (3 - 2 * this.fade);
    this.duckTimer = Math.max(0, this.duckTimer - dt);
    const duckTarget = this.duckTimer > 0 ? 1 - DSP.duckAmount : 1;
    const duckTau = duckTarget < this.duck ? 0.005 : DSP.duckReleaseS;
    this.duck += (duckTarget - this.duck) * (1 - Math.exp(-dt / duckTau));
    let speedTarget = 1;
    if (this.inSpeed !== null) {
      const sp = clamp(this.speedS / DSP.speedDuckMaxKmh, 0, 1);
      if (p.setup.speedDucking === 'duck') speedTarget = 1 - 0.4 * sp;
      else if (p.setup.speedDucking === 'boost') speedTarget = 1 + 0.5 * sp;
    }
    this.speedGain += (speedTarget - this.speedGain) * (1 - Math.exp(-dt / 0.3));
    const master = this.masterS * p.mix.master * modeScale * fadeG * this.speedGain;

    // ---- per-chunk control values ----
    const stg = stagesOf(p);
    const ns = stg.length;
    const pedal = this.pedalS;
    const boostN = clamp(s.boost / Math.max(0.2, t.maxBoost), 0, 1.3);
    const chirp = 1 + 1.5 * clamp(s.spoolRate, 0, 1.5);
    const gate = s.gate;
    const sumP = Math.max(1, t.partials.reduce((a, b) => a + b, 0));
    const whineBase = (DSP.whineNorm / sumP) * 2.2 * p.mix.whine * gate * this.duck;
    const nyq = sr * 0.45;
    const isSC = p.kind === 'supercharger';
    const twin = ns > 1 ? DSP.twinBoost : 1;
    const omega = TWO_PI * t.pitchInertiaHz;

    for (let si = 0; si < ns; si++) {
      const sv = this.stages[si]!;
      const st = stg[si]!.params;
      const shaft = s.shafts[si]!;
      // critically damped 2nd-order pitch smoother: momentum, not a one-pole
      const acc = omega * omega * (shaft - sv.pos) - 2 * omega * sv.vel;
      sv.vel += acc * dt;
      sv.pos += sv.vel * dt;
      sv.pos = clamp(sv.pos, -0.05, 1.2);

      sv.wobbleTimer -= dt;
      if (sv.wobbleTimer <= 0) {
        sv.wobbleTimer = 1 / (3 + 5 * this.noiseRng.next()); // 3-8 Hz
        sv.wobbleTarget = this.noiseRng.bi();
      }
      sv.wobble += (sv.wobbleTarget - sv.wobble) * (1 - Math.exp(-dt / 0.05));

      const level = Math.pow(Math.max(0, shaft), 1.5) * (0.3 + 0.7 * pedal) * chirp * whineBase * stg[si]!.weight * twin;
      const f = this.stageFreq(st.whineHzMin, st.whineHzMax, sv.pos) * (1 + t.wobble * sv.wobble) * (1 - 0.12 * this.pitchDip);
      sv.targets[0] = t.partials[0]! * level * this.partialFade(f, 1, nyq);
      sv.targets[1] = t.partials[1]! * (0.4 + 0.6 * pedal) * level * this.partialFade(f, 2, nyq);
      sv.targets[2] = DSP.upperPartialScale * t.partials[2]! * pedal * level * this.partialFade(f, 3, nyq);
      sv.targets[3] = DSP.upperPartialScale * t.partials[3]! * pedal * level * this.partialFade(f, 4, nyq);
      sv.targets[4] = DSP.upperPartialScale * t.partials[4]! * clamp(boostN, 0, 1) * level * this.partialFade(f, 5, nyq);
      sv.targets[5] = DSP.subScale * t.subHarmonic * clamp(boostN, 0, 1) * level;
      sv.f = f;
      // noise band around the pitch; normalise so its loudness matches a sine of the same gain
      const bw = Math.max(20, f * DSP.whineAirBw);
      sv.nb.set(f, f / bw, sr);
      sv.nbNorm = Math.sqrt((sr * 0.5) / bw) * 0.7;
    }
    if (ns === 1) this.stages[1]!.targets.fill(0);

    const mainShaft = this.stages[0]!.pos;

    // whoosh
    const flowJ = this.flowJitter;
    this.flowJitterTimer -= dt;
    if (this.flowJitterTimer <= 0) {
      this.flowJitterTimer = 0.08 + 0.15 * this.noiseRng.next();
      this.flowJitterTarget = this.noiseRng.bi();
    }
    this.flowJitter += (this.flowJitterTarget - this.flowJitter) * (1 - Math.exp(-dt / 0.06));
    const flowN = clamp(s.flow, 0, 1);
    const whooshT = DSP.whooshNorm * p.mix.whoosh * flowN * flowN * gate * this.duck * (1 + 0.15 * flowJ);
    const wc = lerp(p.whoosh.centerMin, p.whoosh.centerMax, clamp(Math.max(mainShaft, this.stages[1]!.pos * (ns > 1 ? 1 : 0)), 0, 1));
    this.whooshBp.set(wc, p.whoosh.q, sr);
    const fireHz = (this.rpmS / 60) * (p.engine.cylinders / 2);
    const tiltA = p.whoosh.tilt;
    const lpCoef = 1 - Math.exp((-TWO_PI * 700) / sr);

    // intake roar: low-mid air rush that gives the sound depth
    const roarT = DSP.roarNorm * p.mix.whoosh * flowN * (0.35 + 0.65 * flowN) * gate * this.duck;
    this.roarLp.set(300 + 1100 * clamp(s.shaft, 0, 1), 0.6, sr);
    // foundation (quiet saw at fundamental / 4)
    const foundT = DSP.foundationNorm * p.mix.foundation * Math.pow(Math.max(0, s.shaft), 1.5) * (0.4 + 0.6 * pedal) * gate * this.duck;
    this.foundLp.set(lerp(DSP.rumbleHzMin, DSP.rumbleHzMax, clamp(mainShaft, 0, 1)), 1.1, sr);

    // supercharger
    const scF = (this.rpmS * p.supercharger.pulleyRatio * p.supercharger.lobes) / 60;
    const scT = isSC ? p.supercharger.level * 0.35 * (0.25 + 0.75 * pedal) * clamp((this.rpmS - p.engine.idle) / 800, 0, 1) * gate * this.duck : 0;
    if (isSC) this.scBp.set(clamp(scF * 3, 300, 6000), 2.5, sr);

    // gear whine (needs gear data from the car)
    const gear = this.inGear;
    const gwT = gear !== null && gear > 0 ? p.gearWhine.level * 0.12 * (0.3 + 0.7 * pedal) * clamp(this.rpmS / 3000, 0, 1) * this.duck : 0;
    const gwF = (this.rpmS / 60) * p.gearWhine.teeth;

    // wastegate hiss
    const wgT = clamp((s.boost - p.turbo.wastegatePoint * p.turbo.maxBoost) / Math.max(0.01, 0.05 * p.turbo.maxBoost), 0, 1) * 0.12 * p.mix.wastegate * gate;

    // flutter band
    this.flutBp.set(lerp(p.lift.flutter.bandLow, p.lift.flutter.bandHigh, 0.2 + 0.8 * this.flutBoostN * (this.flutTotal > 0 ? this.flutLeft / this.flutTotal : 0)) * this.flutCenter, 0.8, sr);

    // BOV voices: sweep high-pass per chunk
    for (const v of this.bov) {
      if (!v.active) continue;
      const sweep = 450 + 650 * Math.exp(-v.t / 0.09);
      if (v.muffled) {
        v.hp.set(300 + 300 * Math.exp(-v.t / 0.08), 0.7, sr);
        v.bp.set(1200, 3, sr);
      } else {
        v.hp.set(sweep, 0.7, sr);
        v.bp.set(1200 + 900 * Math.exp(-v.t / 0.15), 2.2, sr);
      }
    }

    // stereo + width
    const pan = clamp(p.mix.pan, -1, 1);
    const pa = ((pan + 1) * Math.PI) / 4;
    const panL = Math.cos(pa) * Math.SQRT2;
    const panR = Math.sin(pa) * Math.SQRT2;
    const delaySamples = Math.round(clamp(p.mix.width, 0, 1) * 0.012 * sr);

    // headroom + sat
    const satA = 1 + 4 * p.body.saturation;
    const resMix = p.body.resonatorMix;

    // ---- ramps ----
    const invM = 1 / m;
    const roarInc = (roarT - this.roarGain) * invM;
    const incs = this.incs;
    for (let si = 0; si < 2; si++) {
      const sv = this.stages[si]!;
      for (let k = 0; k < 6; k++) incs[si * 6 + k] = (sv.targets[k]! - sv.gains[k]!) * invM;
    }
    const whooshInc = (whooshT - this.whooshGain) * invM;
    const foundInc = (foundT - this.foundGain) * invM;
    const scInc = (scT - this.scGain) * invM;
    const gwInc = (gwT - this.gwGain) * invM;
    const wgInc = (wgT - this.wgGain) * invM;
    const sv0 = this.stages[0]!;
    const sv1 = this.stages[1]!;
    const f0 = sv0.f;
    const f1 = ns > 1 ? sv1.f : 0;
    const fmR = 1; // harmonic vibrato only: an inharmonic ratio sounds metallic
    const pjCoef = 1 - Math.exp((-TWO_PI * DSP.whinePhaseNoiseHz) / sr);
    const air = DSP.whineAir;

    // flutter pulse step (per chunk resolution is plenty for 40-120 ms pulses)
    if (this.flutActive) {
      this.flutTimer -= dt;
      if (this.flutTimer <= 0) {
        if (this.flutLeft <= 0) {
          this.flutActive = false;
        } else {
          const fl = p.lift.flutter;
          const prog = 1 - this.flutLeft / this.flutTotal;
          const hz = fl.hzStart * Math.pow(fl.hzEnd / fl.hzStart, prog);
          // irregular, like a real stalling compressor: jittered spacing, uneven pulse size and length
          this.flutTimer = (1 / hz) * (0.7 + 0.6 * this.noiseRng.next());
          this.flutEnv = 1;
          const weak = this.noiseRng.next() < 0.18 ? 0.45 : 1;
          this.flutAmp = this.flutStrength * Math.pow(this.flutLeft / this.flutTotal, 0.6) * (0.55 + 0.6 * this.noiseRng.next()) * weak;
          this.flutDecayC = Math.exp(-1 / (sr * (0.04 + 0.04 * this.noiseRng.next())));
          this.flutCenter = 0.75 + 0.5 * this.noiseRng.next();
          this.pitchDip = 1;
          this.flutLeft--;
        }
      }
    }
    const dipDecay = Math.exp(-1 / (sr * 0.07));
    this.flutLo.set(160, 0.8, sr);
    const pinkMask = this.pink.length - 1;

    // ---- sample loop ----
    for (let i = 0; i < m; i++) {
      // pink noise from the pre-built table
      const pn = this.pink[this.pinkPos]!;
      this.pinkPos = (this.pinkPos + 1) & pinkMask;
      const wn = this.noiseRng.bi();

      // whine stages
      let whine = 0;
      for (let si = 0; si < ns; si++) {
        const sv = si === 0 ? sv0 : sv1;
        const f = si === 0 ? f0 : f1;
        const g = sv.gains;
        const inv = f / sr;
        sv.phase += inv;
        if (sv.phase >= 1) sv.phase -= 1;
        sv.subPhase += inv * 0.5;
        if (sv.subPhase >= 1) sv.subPhase -= 1;
        sv.fmPhase += inv * fmR;
        if (sv.fmPhase >= 1) sv.fmPhase -= 1;
        sv.pj += (this.noiseRng.bi() - sv.pj) * pjCoef;
        const ph = sv.phase + t.fmIndex * sinT(sv.fmPhase) + DSP.whinePhaseNoise * sv.pj;
        let x = 0;
        if (g[0]! > 1e-5) x += g[0]! * sinT(ph);
        if (g[1]! > 1e-5) x += g[1]! * sinT(ph * 2);
        if (g[2]! > 1e-5) x += g[2]! * sinT(ph * 3);
        if (g[3]! > 1e-5) x += g[3]! * sinT(ph * 4);
        if (g[4]! > 1e-5) x += g[4]! * sinT(ph * 5);
        if (g[5]! > 1e-5) x += g[5]! * sinT(sv.subPhase);
        sv.nb.tick(wn);
        whine += x * (1 - air) + sv.nb.bp * sv.nbNorm * g[0]! * air;
        for (let k = 0; k < 6; k++) g[k]! += incs[si * 6 + k]!;
      }
      // soft saturation on the whine bus: harmonics that move with level
      whine = Math.tanh(whine * satA) / satA;
      whine *= 1 - 0.5 * this.flutEnv * (this.flutActive ? 1 : 0.4);

      // whoosh: pink -> tilt -> bandpass -> AM at firing frequency
      this.whooshLp += (pn - this.whooshLp) * lpCoef;
      const tilt = tiltA * flowN;
      const tilted = this.whooshLp * (1 - 0.7 * tilt) + (pn - this.whooshLp) * (0.3 + 0.7 * tilt);
      this.whooshBp.tick(tilted);
      this.firePhase += fireHz / sr;
      if (this.firePhase >= 1) this.firePhase -= 1;
      const am = 1 - p.whoosh.amDepth + p.whoosh.amDepth * (0.5 + 0.5 * sinT(this.firePhase));
      const whoosh = this.whooshBp.bp * 2.2 * this.whooshGain * am;
      this.whooshGain += whooshInc;

      // foundation: intake rumble, low band of pink noise pulsed by the firing frequency
      this.foundLp.tick(pn);
      const found = this.foundLp.bp * this.foundGain * 2.6 * (0.6 + 0.4 * am);
      this.foundGain += foundInc;

      // supercharger
      let sc = 0;
      if (this.scGain > 1e-5 || scT > 0) {
        this.scPhase += scF / sr;
        if (this.scPhase >= 1) this.scPhase -= 1;
        this.scBp.tick(this.scPhase * 2 - 1);
        sc = (this.scBp.bp * 1.2 + (this.scPhase * 2 - 1) * 0.12) * this.scGain;
        this.scGain += scInc;
      }

      // gear whine
      let gw = 0;
      if (this.gwGain > 1e-5 || gwT > 0) {
        this.gwPhase += gwF / sr;
        if (this.gwPhase >= 1) this.gwPhase -= 1;
        gw = (sinT(this.gwPhase) + 0.35 * sinT(this.gwPhase * 2)) * this.gwGain;
        this.gwGain += gwInc;
      }

      // wastegate hiss
      let wg = 0;
      if (this.wgGain > 1e-5 || wgT > 0) {
        this.wgHp.tick(wn);
        wg = this.wgHp.hp * this.wgGain;
        this.wgGain += wgInc;
      }

      // flutter bursts
      let flut = 0;
      if (this.flutEnv > 1e-4) {
        this.flutBp.tick(wn);
        this.flutLo.tick(wn);
        const att = Math.min(1, (1 - this.flutEnv) * 9 + 0.03);
        const e = this.flutEnv * att;
        // chuff of air (mid band + low thump) plus the stalling wheel tone dropping in pitch
        this.flutPhase += (f0 * (1 - 0.3 * (1 - this.flutEnv))) / sr;
        if (this.flutPhase >= 1) this.flutPhase -= 1;
        const tone = sinT(this.flutPhase) + 0.3 * sinT(this.flutPhase * 2);
        flut = (this.flutBp.bp * 0.9 + this.flutLo.lp * 2.0 + tone * 0.04) * e * this.flutAmp;
        this.flutEnv *= this.flutDecayC;
      }
      this.pitchDip *= dipDecay;

      this.roarLp.tick(pn);
      const roar = this.roarLp.lp * 2.2 * this.roarGain * am;
      this.roarGain += roarInc;
      // modal resonator bank in parallel with the dry signal
      const body = whine + whoosh + found + sc + roar;
      let resSum = 0;
      for (let k = 0; k < 4; k++) {
        const r = this.res[k]!;
        r.tick(body);
        resSum += r.bp;
      }
      let bus = body + resMix * resSum * 0.5 + gw + wg + flut;
      // interior low-pass
      this.interior.tick(bus);
      bus = this.interior.lp;
      if (this.cabin) {
        // cabin boom: low-frequency pressure inside the shell
        this.boom.tick(bus);
        bus += this.boom.lp * DSP.cabinBoom;
      }

      // stereo placement of the turbo bus (width = short delay on the right)
      this.delayBuf[this.delayPos] = bus;
      const dIdx = (this.delayPos - delaySamples + this.delayBuf.length) % this.delayBuf.length;
      const delayed = this.delayBuf[dIdx]!;
      this.delayPos = (this.delayPos + 1) % this.delayBuf.length;
      let l = bus * panL;
      let r = delayed * panR;

      // synth blow-off voices
      for (const v of this.bov) {
        if (!v.active) continue;
        const att = Math.min(1, v.t / 0.012);
        const env = att * Math.exp(-v.t / v.tau);
        const nz = this.noiseRng.bi();
        v.hp.tick(nz);
        v.bp.tick(nz);
        const o = (v.muffled ? v.hp.lp * 0.6 + v.bp.bp * 0.8 : v.hp.hp + v.bp.bp * 0.9) * env;
        const y = o * v.gain * 0.35;
        l += y;
        r += y;
        v.t += 1 / sr;
        if (v.t > v.tau * 9) v.active = false;
      }

      // recorded one-shots (blow-off, pops, bangs), heard through the same cabin/bay filter
      let shotInL = 0;
      let shotInR = 0;
      for (const sh of this.shots) {
        const buf = sh.buf;
        if (buf === null) continue;
        const ip = sh.pos | 0;
        if (ip >= buf.length - 1) {
          sh.buf = null;
          continue;
        }
        const fr = sh.pos - ip;
        const y = (buf[ip]! + (buf[ip + 1]! - buf[ip]!) * fr) * sh.gain;
        shotInL += y * sh.l;
        shotInR += y * sh.r;
        sh.pos += sh.rate;
      }
      this.shotL.tick(shotInL);
      this.shotR.tick(shotInR);
      l += this.shotL.lp;
      r += this.shotR.lp;

      // master + soft limiter (envelope-driven gain, then a tanh clip as the final guarantee)
      l *= master;
      r *= master;
      const ceil = p.mix.limiterCeiling;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      this.limEnv = pk > this.limEnv ? pk : this.limEnv * 0.9997;
      const thr = ceil * 0.75;
      const wantG = this.limEnv > thr ? thr / this.limEnv : 1;
      this.limGain += (wantG - this.limGain) * (wantG < this.limGain ? 0.2 : 0.0008);
      l = ceil * Math.tanh((l * this.limGain) / ceil);
      r = ceil * Math.tanh((r * this.limGain) / ceil);
      outL[off + i] = l;
      outR[off + i] = r;
      const lv = Math.abs(l);
      this.levelEnv = lv > this.levelEnv ? lv : this.levelEnv * 0.9999;
    }

    // commit ramp ends exactly (avoid float drift)
    for (let si = 0; si < 2; si++) {
      const sv = this.stages[si]!;
      for (let k = 0; k < 6; k++) sv.gains[k] = sv.targets[k]!;
    }
    this.whooshGain = whooshT;
    this.foundGain = foundT;
    this.scGain = scT;
    this.gwGain = gwT;
    this.wgGain = wgT;
    this.roarGain = roarT;

    // interior LP follows the profile/headphone setting smoothly (set() is cheap and stateless wrt memory)
    this.applyView();
  }

  /** shaft (0..1, can overshoot slightly) -> whine Hz via the perceptual map */
  private stageFreq(hzMin: number, hzMax: number, shaft: number): number {
    return Math.min(this.sr * 0.45, hzMin + clamp(shaft, 0, 1.1) * (hzMax - hzMin));
  }

  /** fade partials out as they approach Nyquist (no aliasing) */
  private partialFade(f: number, k: number, nyq: number): number {
    return clamp((nyq - f * k) / (this.sr * 0.08), 0, 1);
  }
}
