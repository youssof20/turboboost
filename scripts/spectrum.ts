// Band energies + click check for a rendered WAV, compared against out/baseline.json.
// usage: npm run spectrum -- [--wav out/reference.wav] [--update]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseWav } from '../src/audio/wav.ts';

const argv = process.argv.slice(2);
const wavPath = argv.includes('--wav') ? argv[argv.indexOf('--wav') + 1]! : 'out/reference.wav';
const update = argv.includes('--update');
const BASELINE = 'out/baseline.json';
const BANDS: [string, number, number][] = [
  ['0.2-0.6k', 200, 600],
  ['0.6-2k', 600, 2000],
  ['2-5k', 2000, 5000],
  ['5-10k', 5000, 10000],
];

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function bandEnergiesDb(x: Float32Array, sr: number): Record<string, number> {
  const N = 4096;
  const hop = N / 2;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const power = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += hop) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i]! * win[i]!;
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k]! += re[k]! ** 2 + im[k]! ** 2;
    frames++;
  }
  const out: Record<string, number> = {};
  for (const [name, lo, hi] of BANDS) {
    let sum = 0;
    for (let k = Math.floor((lo * N) / sr); k < Math.ceil((hi * N) / sr); k++) sum += power[k]!;
    out[name] = 10 * Math.log10(sum / Math.max(1, frames) / N / N + 1e-20);
  }
  return out;
}

export function countClicks(x: Float32Array, threshold = 0.3): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (Math.abs(x[i]! - x[i - 1]!) > threshold) n++;
  return n;
}

const wav = parseWav(new Uint8Array(readFileSync(wavPath)));
const mono = new Float32Array(wav.channels[0]!.length);
for (const c of wav.channels) for (let i = 0; i < mono.length; i++) mono[i]! += c[i]! / wav.channels.length;
const bands = bandEnergiesDb(mono, wav.sampleRate);
const clicks = Math.max(...wav.channels.map((c) => countClicks(c)));
let peak = 0;
for (const c of wav.channels) for (const v of c) peak = Math.max(peak, Math.abs(v));

console.log(`file ${wavPath}  (${(mono.length / wav.sampleRate).toFixed(1)} s, peak ${peak.toFixed(3)})`);
let flagged = 0;
const base: Record<string, number> | null = existsSync(BASELINE) && !update ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
for (const [name] of BANDS) {
  const now = bands[name]!;
  if (base && base[name] !== undefined) {
    const d = now - base[name]!;
    const flag = Math.abs(d) > 3;
    if (flag) flagged++;
    const sign = d >= 0 ? '+' : '';
    console.log(`  ${name.padEnd(9)} ${now.toFixed(1).padStart(7)} dB   baseline ${base[name]!.toFixed(1).padStart(7)}   delta ${sign}${d.toFixed(1)} dB${flag ? '   <-- moved more than 3 dB' : ''}`);
  } else {
    console.log(`  ${name.padEnd(9)} ${now.toFixed(1).padStart(7)} dB`);
  }
}
console.log(`  clicks (|x[n]-x[n-1]| > 0.3): ${clicks}${clicks > 0 ? '   <-- must be 0' : ''}`);
if (update || !base) {
  writeFileSync(BASELINE, JSON.stringify(bands, null, 2) + '\n');
  console.log(`baseline ${update ? 'updated' : 'created'}: ${BASELINE}`);
} else if (flagged > 0 || clicks > 0) {
  process.exitCode = 1;
}
