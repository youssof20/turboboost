// Profile = the single source of truth for every tunable number in the app.
// No magic constants live in turbo.ts or the DSP; they read from here.

export type LiftMode = 'bov' | 'flutter' | 'both' | 'recirc';
export type PopsMode = 'off' | 'mild' | 'rally';
export type BoostSource = 'virtual' | 'map';
export type SpeedDucking = 'off' | 'duck' | 'boost';
export type Kind = 'turbo' | 'supercharger';

export interface StageParams {
  rpmBoostStart: number;
  rpmFullBoost: number;
  tauUp: number;
  tauDown: number;
  whineHzMin: number;
  whineHzMax: number;
  weight: number;
}

export interface Profile {
  id: string;
  name: string;
  blurb: string;
  kind: Kind;
  engine: {
    cylinders: number;
    redline: number;
    idle: number;
    gearRatios: number[];
    finalDrive: number;
    tireCircumferenceM: number;
  };
  turbo: {
    rpmBoostStart: number;
    rpmFullBoost: number;
    maxBoost: number;
    tauUp: number;
    tauDown: number;
    boostExponent: number;
    wastegatePoint: number;
    whineHzMin: number;
    whineHzMax: number;
    /** gains for 1x, 2x, 3x, 4x, 5x of the whine fundamental */
    partials: number[];
    subHarmonic: number;
    wobble: number;
    fmIndex: number;
    pitchInertiaHz: number;
    /** second turbo (twin / sequential). null = single turbo */
    secondary: StageParams | null;
  };
  supercharger: { level: number; pulleyRatio: number; lobes: number };
  whoosh: { tilt: number; q: number; amDepth: number; centerMin: number; centerMax: number };
  body: {
    resonators: [number, number][];
    resonatorMix: number;
    interiorLowPassHz: number;
    saturation: number;
    irFile: string;
    irWet: number;
  };
  lift: {
    mode: LiftMode;
    bovThreshold: number;
    liftRate: number;
    antiLag: boolean;
    samples: string[];
    flutter: { hzStart: number; hzEnd: number; pulses: number; bandLow: number; bandHigh: number };
  };
  gearWhine: { level: number; teeth: number };
  mix: {
    whine: number;
    whoosh: number;
    foundation: number;
    bov: number;
    flutter: number;
    pops: number;
    wastegate: number;
    master: number;
    pan: number;
    width: number;
    limiterCeiling: number;
  };
  setup: {
    boostSource: BoostSource;
    rpmExaggeration: number;
    speedDucking: SpeedDucking;
    pops: PopsMode;
    latencyMs: number;
    throttleIdlePct: number;
  };
}

const BOV_SAMPLES = Array.from({ length: 8 }, (_, i) => `bov_${String(i + 1).padStart(2, '0')}`);

export const BASE_PROFILE: Profile = {
  id: 'small-turbo',
  name: 'Small turbo',
  blurb: 'Quick spool, high whine, sharp pssh',
  kind: 'turbo',
  engine: {
    cylinders: 4,
    redline: 6800,
    idle: 800,
    gearRatios: [3.58, 2.19, 1.52, 1.13, 0.91, 0.76],
    finalDrive: 3.94,
    tireCircumferenceM: 1.99,
  },
  turbo: {
    rpmBoostStart: 2200,
    rpmFullBoost: 3800,
    maxBoost: 1.2,
    tauUp: 0.9,
    tauDown: 2.2,
    boostExponent: 2,
    wastegatePoint: 0.95,
    whineHzMin: 650,
    whineHzMax: 3600,
    partials: [1, 0.5, 0.22, 0.1, 0.06],
    subHarmonic: 0.3,
    wobble: 0.003,
    fmIndex: 0.03,
    pitchInertiaHz: 2.2,
    secondary: null,
  },
  supercharger: { level: 0, pulleyRatio: 2.4, lobes: 3 },
  whoosh: { tilt: 0.45, q: 0.9, amDepth: 0.15, centerMin: 450, centerMax: 2400 },
  body: {
    resonators: [
      [230, 6],
      [520, 8],
      [1150, 10],
      [2300, 8],
    ],
    resonatorMix: 0.35,
    interiorLowPassHz: 3600,
    saturation: 0.15,
    irFile: 'ir/airbox_small.wav',
    irWet: 0.28,
  },
  lift: {
    mode: 'bov',
    bovThreshold: 0.35,
    liftRate: -2.5,
    antiLag: false,
    samples: BOV_SAMPLES,
    flutter: { hzStart: 14, hzEnd: 6, pulses: 10, bandLow: 300, bandHigh: 1000 },
  },
  gearWhine: { level: 0, teeth: 21 },
  mix: {
    whine: 0.8,
    whoosh: 0.6,
    foundation: 0.7,
    bov: 1.0,
    flutter: 0.8,
    pops: 0.7,
    wastegate: 0.5,
    master: 0.9,
    pan: -0.2,
    width: 0.3,
    limiterCeiling: 0.89,
  },
  setup: {
    boostSource: 'virtual',
    rpmExaggeration: 1.0,
    speedDucking: 'off',
    pops: 'off',
    latencyMs: 0,
    throttleIdlePct: 12,
  },
};

// structuredClone is not available in AudioWorkletGlobalScope, and this module is loaded there
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return clone(base);
  const out: any = clone(base);
  const walk = (dst: any, src: any) => {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
        walk(dst[k], v);
      } else {
        dst[k] = clone(v);
      }
    }
  };
  walk(out, over);
  return out;
}

function make(over: DeepPartial<Profile> & { id: string; name: string; blurb: string }): Profile {
  return merge(BASE_PROFILE, over as DeepPartial<Profile>);
}

export const BUILTIN_PROFILES: Profile[] = [
  make({
    id: 'small-turbo',
    name: 'Small turbo',
    blurb: 'Quick spool, high whine, sharp pssh',
  }),
  make({
    id: 'big-single',
    name: 'Big single',
    blurb: 'Slow spool, deep whine, long flutter',
    turbo: {
      rpmBoostStart: 3000,
      rpmFullBoost: 4800,
      maxBoost: 1.6,
      tauUp: 1.5,
      tauDown: 3.2,
      whineHzMin: 500,
      whineHzMax: 2800,
      partials: [1, 0.45, 0.25, 0.12, 0.08],
      subHarmonic: 0.35,
    },
    lift: {
      mode: 'flutter',
      bovThreshold: 0.4,
      flutter: { hzStart: 12, hzEnd: 5, pulses: 14, bandLow: 300, bandHigh: 900 },
    },
    whoosh: { tilt: 0.4, q: 0.8, amDepth: 0.2, centerMin: 350, centerMax: 2000 },
    mix: { whoosh: 0.7, foundation: 0.5 },
  }),
  make({
    id: 'twin-scroll',
    name: 'Twin-scroll',
    blurb: 'Early, linear boost, clean mid-range whine',
    turbo: {
      rpmBoostStart: 1800,
      rpmFullBoost: 3200,
      maxBoost: 1.1,
      tauUp: 0.7,
      tauDown: 1.9,
      whineHzMin: 750,
      whineHzMax: 3900,
      partials: [1, 0.4, 0.18, 0.08, 0.05],
    },
    lift: { mode: 'both', bovThreshold: 0.3 },
  }),
  make({
    id: 'sequential-twin',
    name: 'Sequential twin',
    blurb: 'Small turbo early, big turbo takes over',
    turbo: {
      rpmBoostStart: 1700,
      rpmFullBoost: 3000,
      maxBoost: 1.4,
      tauUp: 0.5,
      tauDown: 1.6,
      whineHzMin: 1000,
      whineHzMax: 4600,
      secondary: {
        rpmBoostStart: 3600,
        rpmFullBoost: 5200,
        tauUp: 1.3,
        tauDown: 2.8,
        whineHzMin: 550,
        whineHzMax: 2800,
        weight: 0.55,
      },
    },
    lift: { mode: 'bov' },
  }),
  make({
    id: 'rally-anti-lag',
    name: 'Rally anti-lag',
    blurb: 'Stays spooled on lift, bangs and flutter',
    turbo: {
      rpmBoostStart: 2600,
      rpmFullBoost: 4200,
      maxBoost: 1.8,
      tauUp: 0.8,
      tauDown: 2.8,
      whineHzMin: 700,
      whineHzMax: 4200,
      partials: [1, 0.55, 0.3, 0.14, 0.1],
    },
    lift: {
      mode: 'both',
      antiLag: true,
      bovThreshold: 0.3,
      flutter: { hzStart: 16, hzEnd: 7, pulses: 12, bandLow: 350, bandHigh: 1100 },
    },
    mix: { pops: 1.0, bov: 1.1, whine: 0.85 },
    setup: { pops: 'rally' },
  }),
  make({
    id: 'supercharger',
    name: 'Supercharger',
    blurb: 'No lag, whine rides engine rpm',
    kind: 'supercharger',
    turbo: { maxBoost: 0.8, tauUp: 0.05, tauDown: 0.12, rpmBoostStart: 1000, rpmFullBoost: 2500 },
    supercharger: { level: 0.9, pulleyRatio: 2.4, lobes: 3 },
    lift: { mode: 'recirc', bovThreshold: 0.2 },
    mix: { whine: 0.0, whoosh: 0.3, foundation: 0.2 },
  }),
  make({
    id: 'subtle-oem',
    name: 'Subtle OEM',
    blurb: 'Quiet and factory-like, for daily use',
    turbo: { maxBoost: 0.9, tauUp: 0.7, tauDown: 1.8, whineHzMin: 600, whineHzMax: 3000, subHarmonic: 0.2 },
    lift: { mode: 'recirc', bovThreshold: 0.4 },
    body: { interiorLowPassHz: 3000 },
    mix: { whine: 0.45, whoosh: 0.4, foundation: 0.3, bov: 0.5, master: 0.7 },
  }),
];

// ----- parameter specs: used for validation AND for the Lab sliders ---------

export interface ParamSpec {
  path: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const S = (group: string, path: string, label: string, min: number, max: number, step: number, unit?: string): ParamSpec => ({
  group, path, label, min, max, step, unit,
});

export const PARAM_SPECS: ParamSpec[] = [
  S('Spool', 'turbo.rpmBoostStart', 'Spool starts', 800, 6000, 50, 'rpm'),
  S('Spool', 'turbo.rpmFullBoost', 'Full boost', 1500, 8000, 50, 'rpm'),
  S('Spool', 'turbo.maxBoost', 'Max boost', 0.1, 3, 0.05, 'bar'),
  S('Spool', 'turbo.tauUp', 'Spool-up lag (tauUp)', 0.02, 4, 0.02, 's'),
  S('Spool', 'turbo.tauDown', 'Coast-down (tauDown)', 0.05, 8, 0.05, 's'),
  S('Spool', 'turbo.boostExponent', 'Boost curve exponent', 1, 4, 0.1),
  S('Spool', 'turbo.wastegatePoint', 'Wastegate point', 0.5, 1, 0.01),
  S('Whine', 'turbo.whineHzMin', 'Pitch min', 300, 4000, 50, 'Hz'),
  S('Whine', 'turbo.whineHzMax', 'Pitch max', 1500, 12000, 50, 'Hz'),
  S('Whine', 'turbo.partials.0', 'Partial 1x', 0, 1, 0.01),
  S('Whine', 'turbo.partials.1', 'Partial 2x', 0, 1, 0.01),
  S('Whine', 'turbo.partials.2', 'Partial 3x', 0, 1, 0.01),
  S('Whine', 'turbo.partials.3', 'Partial 4x', 0, 1, 0.01),
  S('Whine', 'turbo.partials.4', 'Partial 5x', 0, 1, 0.01),
  S('Whine', 'turbo.subHarmonic', 'Sub-harmonic (0.5x)', 0, 1, 0.01),
  S('Whine', 'turbo.wobble', 'Pitch wobble', 0, 0.02, 0.0005),
  S('Whine', 'turbo.fmIndex', 'FM amount', 0, 0.3, 0.005),
  S('Whine', 'turbo.pitchInertiaHz', 'Pitch inertia', 0.5, 12, 0.1, 'Hz'),
  S('Whoosh', 'whoosh.tilt', 'Brightness tilt', 0, 1, 0.01),
  S('Whoosh', 'whoosh.q', 'Bandwidth Q', 0.3, 4, 0.05),
  S('Whoosh', 'whoosh.amDepth', 'Firing AM depth', 0, 0.6, 0.01),
  S('Whoosh', 'whoosh.centerMin', 'Center min', 200, 3000, 50, 'Hz'),
  S('Whoosh', 'whoosh.centerMax', 'Center max', 1000, 8000, 50, 'Hz'),
  S('Body', 'body.resonatorMix', 'Resonator mix', 0, 1, 0.01),
  S('Body', 'body.resonators.0.0', 'Resonator 1 center', 200, 8000, 10, 'Hz'),
  S('Body', 'body.resonators.0.1', 'Resonator 1 Q', 1, 40, 0.5),
  S('Body', 'body.resonators.1.0', 'Resonator 2 center', 200, 8000, 10, 'Hz'),
  S('Body', 'body.resonators.1.1', 'Resonator 2 Q', 1, 40, 0.5),
  S('Body', 'body.resonators.2.0', 'Resonator 3 center', 200, 8000, 10, 'Hz'),
  S('Body', 'body.resonators.2.1', 'Resonator 3 Q', 1, 40, 0.5),
  S('Body', 'body.resonators.3.0', 'Resonator 4 center', 200, 8000, 10, 'Hz'),
  S('Body', 'body.resonators.3.1', 'Resonator 4 Q', 1, 40, 0.5),
  S('Body', 'body.interiorLowPassHz', 'Interior low-pass', 1200, 12000, 100, 'Hz'),
  S('Body', 'body.saturation', 'Saturation drive', 0, 1, 0.01),
  S('Body', 'body.irWet', 'Intake IR wet', 0, 0.6, 0.01),
  S('Flutter', 'lift.flutter.hzStart', 'Pulse rate start', 3, 30, 0.5, 'Hz'),
  S('Flutter', 'lift.flutter.hzEnd', 'Pulse rate end', 2, 20, 0.5, 'Hz'),
  S('Flutter', 'lift.flutter.pulses', 'Pulse count', 3, 40, 1),
  S('Flutter', 'lift.flutter.bandLow', 'Band low', 150, 1500, 10, 'Hz'),
  S('Flutter', 'lift.flutter.bandHigh', 'Band high', 600, 4000, 10, 'Hz'),
  S('Lift', 'lift.bovThreshold', 'Boost needed to fire', 0.05, 1.5, 0.01, 'bar'),
  S('Lift', 'lift.liftRate', 'Lift rate', -8, -0.5, 0.1, '/s'),
  S('Mix', 'mix.whine', 'Whine level', 0, 1.5, 0.01),
  S('Mix', 'mix.whoosh', 'Whoosh level', 0, 1.5, 0.01),
  S('Mix', 'mix.foundation', 'Foundation level', 0, 1.5, 0.01),
  S('Mix', 'mix.bov', 'Blow-off level', 0, 1.5, 0.01),
  S('Mix', 'mix.flutter', 'Flutter level', 0, 1.5, 0.01),
  S('Mix', 'mix.pops', 'Pops level', 0, 1.5, 0.01),
  S('Mix', 'mix.wastegate', 'Wastegate hiss', 0, 1.5, 0.01),
  S('Mix', 'mix.master', 'Profile master', 0, 1, 0.01),
  S('Mix', 'mix.pan', 'Turbo pan (L-R)', -1, 1, 0.01),
  S('Mix', 'mix.width', 'Stereo width', 0, 1, 0.01),
  S('Mix', 'mix.limiterCeiling', 'Limiter ceiling', 0.3, 1, 0.01),
  S('Supercharger', 'supercharger.level', 'Level', 0, 1.5, 0.01),
  S('Supercharger', 'supercharger.pulleyRatio', 'Pulley ratio', 0.5, 6, 0.05),
  S('Supercharger', 'supercharger.lobes', 'Lobes', 2, 6, 1),
  S('Gear whine', 'gearWhine.level', 'Level', 0, 1, 0.01),
  S('Gear whine', 'gearWhine.teeth', 'Tooth count', 8, 40, 1),
  S('Engine', 'engine.cylinders', 'Cylinders', 1, 12, 1),
  S('Engine', 'engine.redline', 'Redline', 3000, 10000, 100, 'rpm'),
  S('Engine', 'engine.idle', 'Idle', 500, 1500, 10, 'rpm'),
  S('Engine', 'engine.finalDrive', 'Final drive', 2, 6, 0.01),
  S('Engine', 'engine.tireCircumferenceM', 'Tire circumference', 1.4, 3.0, 0.01, 'm'),
  S('Setup', 'setup.rpmExaggeration', 'RPM exaggeration', 1, 1.6, 0.05, 'x'),
  S('Setup', 'setup.latencyMs', 'Latency compensation', 0, 400, 5, 'ms'),
  S('Setup', 'setup.throttleIdlePct', 'Throttle idle offset', 0, 30, 1, '%'),
];

const ENUMS: Record<string, string[]> = {
  kind: ['turbo', 'supercharger'],
  'lift.mode': ['bov', 'flutter', 'both', 'recirc'],
  'setup.boostSource': ['virtual', 'map'],
  'setup.speedDucking': ['off', 'duck', 'boost'],
  'setup.pops': ['off', 'mild', 'rally'],
};

export function getPath(obj: any, path: string): any {
  let o = obj;
  for (const k of path.split('.')) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

export function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]!];
  o[keys[keys.length - 1]!] = value;
}

export interface ValidationResult {
  profile: Profile;
  errors: string[];
}

/**
 * Validate an untrusted profile object (from localStorage or an imported file).
 * Anything missing or invalid falls back to the default and is reported by field path.
 */
export function validateProfile(raw: unknown, fallback: Profile = BASE_PROFILE): ValidationResult {
  const errors: string[] = [];
  const out = clone(fallback);
  if (raw === null || typeof raw !== 'object') {
    errors.push('profile: not an object');
    return { profile: out, errors };
  }
  const r = raw as any;

  for (const key of ['id', 'name', 'blurb'] as const) {
    if (typeof r[key] === 'string' && r[key].length > 0 && r[key].length < 120) out[key] = r[key];
    else if (r[key] !== undefined) errors.push(`${key}: expected a short string`);
  }
  for (const [path, allowed] of Object.entries(ENUMS)) {
    const v = getPath(r, path);
    if (v === undefined) continue;
    if (typeof v === 'string' && allowed.includes(v)) setPath(out, path, v);
    else errors.push(`${path}: must be one of ${allowed.join(', ')}`);
  }
  for (const spec of PARAM_SPECS) {
    const v = getPath(r, spec.path);
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max) {
      setPath(out, spec.path, v);
    } else {
      errors.push(`${spec.path}: expected a number between ${spec.min} and ${spec.max}`);
    }
  }
  if (r.lift && typeof r.lift.antiLag === 'boolean') out.lift.antiLag = r.lift.antiLag;
  else if (r.lift && r.lift.antiLag !== undefined) errors.push('lift.antiLag: expected true or false');

  const strList = (path: string) => {
    const v = getPath(r, path);
    if (v === undefined) return;
    if (Array.isArray(v) && v.every((s) => typeof s === 'string' && /^[\w./-]{1,60}$/.test(s))) {
      setPath(out, path, v.slice(0, 64));
    } else errors.push(`${path}: expected a list of file names`);
  };
  strList('lift.samples');
  const ir = getPath(r, 'body.irFile');
  if (typeof ir === 'string' && /^[\w./-]{0,60}$/.test(ir)) out.body.irFile = ir;
  else if (ir !== undefined) errors.push('body.irFile: expected a file name');

  const gr = getPath(r, 'engine.gearRatios');
  if (gr !== undefined) {
    if (Array.isArray(gr) && gr.length >= 1 && gr.length <= 10 && gr.every((x) => typeof x === 'number' && x > 0.3 && x < 8)) {
      out.engine.gearRatios = gr.slice();
    } else errors.push('engine.gearRatios: expected 1-10 numbers between 0.3 and 8');
  }
  const sec = r.turbo?.secondary;
  if (sec === null) out.turbo.secondary = null;
  else if (sec !== undefined) {
    const base: StageParams = out.turbo.secondary ?? {
      rpmBoostStart: 3600, rpmFullBoost: 5200, tauUp: 1.3, tauDown: 2.8, whineHzMin: 1300, whineHzMax: 6000, weight: 0.5,
    };
    const s = { ...base };
    for (const k of Object.keys(base) as (keyof StageParams)[]) {
      const v = sec[k];
      if (v === undefined) continue;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 20000) s[k] = v;
      else errors.push(`turbo.secondary.${k}: invalid number`);
    }
    out.turbo.secondary = s;
  }
  // cross-field sanity
  if (out.turbo.rpmFullBoost <= out.turbo.rpmBoostStart) {
    errors.push('turbo.rpmFullBoost must be above rpmBoostStart; using defaults for both');
    out.turbo.rpmBoostStart = fallback.turbo.rpmBoostStart;
    out.turbo.rpmFullBoost = fallback.turbo.rpmFullBoost;
  }
  if (out.turbo.whineHzMax <= out.turbo.whineHzMin) {
    errors.push('turbo.whineHzMax must be above whineHzMin; using defaults for both');
    out.turbo.whineHzMin = fallback.turbo.whineHzMin;
    out.turbo.whineHzMax = fallback.turbo.whineHzMax;
  }
  return { profile: out, errors };
}

export function findBuiltin(id: string): Profile | undefined {
  return BUILTIN_PROFILES.find((p) => p.id === id);
}
