// Offline render: runs the exact same TurboDSP the AudioWorklet runs, driven by a CSV log.
// usage: npm run render -- [--log logs/reference.csv] [--seconds 10] [--profile small-turbo] [--out out/reference.wav]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TurboDSP } from '../src/audio/dsp.ts';
import { parseWav, encodeWav16 } from '../src/audio/wav.ts';
import { parseCsv, sampleLog } from '../src/input/log.ts';
import { GearEstimator } from '../src/model/gear.ts';
import { BUILTIN_PROFILES, BASE_PROFILE } from '../src/model/profiles.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const logPath = args.get('log') ?? 'logs/reference.csv';
const seconds = parseFloat(args.get('seconds') ?? '10');
const out = args.get('out') ?? 'out/reference.wav';
const profile = BUILTIN_PROFILES.find((p) => p.id === (args.get('profile') ?? BASE_PROFILE.id)) ?? BASE_PROFILE;
const SR = 44100;

const rows = parseCsv(readFileSync(logPath, 'utf8'));
const dsp = new TurboDSP(SR, profile, 2024);

const manifest = JSON.parse(readFileSync('public/samples/manifest.json', 'utf8')) as { bov: string[]; pop: string[] };
const load = (names: string[]) => names.map((n) => parseWav(new Uint8Array(readFileSync(`public/samples/${n}.wav`))).channels[0]!);
dsp.setSamples('bov', load(manifest.bov));
dsp.setSamples('pop', load(manifest.pop));
dsp.start(true);

const gear = new GearEstimator(profile.engine);
const total = Math.round(seconds * SR);
const L = new Float32Array(total);
const R = new Float32Array(total);
const BLOCK = 128;
let hint = 0;
const t0 = rows[0]!.t;
for (let pos = 0; pos < total; pos += BLOCK) {
  const n = Math.min(BLOCK, total - pos);
  const t = t0 + pos / SR;
  const s = sampleLog(rows, t, hint);
  hint = s.index;
  const g = gear.update(s.row.rpm, s.row.speed, BLOCK / SR);
  dsp.setInput({ rpm: s.row.rpm, pedal: s.row.pedal, mapKpa: s.row.mapKpa, speedKmh: s.row.speed, gear: g });
  dsp.process(L.subarray(pos, pos + n), R.subarray(pos, pos + n), n);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodeWav16(SR, [L, R]));
let peak = 0;
for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
console.log(`rendered ${seconds}s of ${profile.id} from ${logPath} -> ${out} (peak ${peak.toFixed(3)})`);
