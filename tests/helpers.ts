import { readFileSync } from 'node:fs';
import { parseCsv, sampleLog, type LogRow } from '../src/input/log.ts';
import { createState, step, type Input, type TurboEvent } from '../src/model/turbo.ts';
import { GearEstimator } from '../src/model/gear.ts';
import { BASE_PROFILE, type Profile } from '../src/model/profiles.ts';
import { Rng } from '../src/audio/dsp.ts';

export function loadLog(path = 'logs/reference.csv'): LogRow[] {
  return parseCsv(readFileSync(path, 'utf8'));
}

export interface RunResult {
  events: { t: number; e: TurboEvent }[];
  finalState: ReturnType<typeof createState>;
  maxShaft: number;
}

/** Drive the pure model over a log the way the worklet does: 128-sample blocks, one-pole smoothed inputs. */
export function runModel(rows: LogRow[], profile: Profile = BASE_PROFILE, sr = 44100, useGearEstimator = true): RunResult {
  const s = createState();
  const rng = new Rng(99);
  const dt = 128 / sr;
  const gear = new GearEstimator(profile.engine);
  let rpmS = rows[0]!.rpm;
  let pedalS = rows[0]!.pedal;
  const events: RunResult['events'] = [];
  const buf: TurboEvent[] = [];
  let hint = 0;
  let maxShaft = 0;
  const end = rows[rows.length - 1]!.t;
  for (let t = rows[0]!.t; t < end; t += dt) {
    const sm = sampleLog(rows, t, hint);
    hint = sm.index;
    const r = sm.row;
    const kr = 1 - Math.exp(-dt / 0.012);
    rpmS += (r.rpm - rpmS) * kr;
    pedalS += (r.pedal - pedalS) * kr;
    const g = useGearEstimator ? gear.update(rpmS, r.speed, dt) : r.gear;
    const inp: Input = { rpm: rpmS, pedal: pedalS, mapKpa: r.mapKpa, baroKpa: 101.3, speedKmh: r.speed, gear: g };
    buf.length = 0;
    step(s, profile, inp, dt, buf, () => rng.next());
    for (const e of buf) events.push({ t, e: { ...e } });
    if (s.shaft > maxShaft) maxShaft = s.shaft;
  }
  return { events, finalState: s, maxShaft };
}
