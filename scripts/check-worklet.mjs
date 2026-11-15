// Loads the BUILT worklet bundle in a sandbox that only has what AudioWorkletGlobalScope has
// (no structuredClone, no performance, no DOM) and runs it. Catches "works in Node, dies in the worklet".
// usage: npm run build && node scripts/check-worklet.mjs
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = 'dist/assets';
const file = readdirSync(dir).find((f) => /^worklet-.*\.js$/.test(f));
if (!file) {
  console.error('no worklet bundle in dist/assets: run `npm run build` first');
  process.exit(1);
}

let Processor = null;
let registered = null;
const posted = [];
class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage: (m) => posted.push(m) };
  }
}
const sandbox = {
  sampleRate: 48000,
  currentTime: 0,
  AudioWorkletProcessor,
  registerProcessor: (name, ctor) => {
    registered = name;
    Processor = ctor;
  },
  // JS built-ins (Math, Float32Array, JSON, ...) come with every context; Node/DOM globals do not.
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(`${dir}/${file}`, 'utf8'), sandbox, { filename: file });

if (registered !== 'turbo-processor' || !Processor) {
  console.error('worklet did not register "turbo-processor"');
  process.exit(1);
}
const p = new Processor();
p.port.onmessage({ data: { t: 'start' } });
p.port.onmessage({ data: { t: 'master', v: 1 } });
const l = new Float32Array(128);
const r = new Float32Array(128);
let peak = 0;
for (let b = 0; b < 48000 / 128 * 3; b++) {
  p.port.onmessage({ data: { t: 'in', rpm: 5000, pedal: 1, mapKpa: null, baroKpa: 101.3, speedKmh: null, gear: null } });
  if (!p.process([], [[l, r]])) throw new Error('process() returned false');
  for (const v of l) {
    if (!Number.isFinite(v)) throw new Error('NaN/Infinity in worklet output');
    peak = Math.max(peak, Math.abs(v));
  }
}
const states = posted.filter((m) => m.t === 'state');
if (states.length < 20) throw new Error(`expected state packets at ~30 Hz, got ${states.length} in 3 s`);
if (peak < 0.01) throw new Error(`worklet is silent during a pull (peak ${peak})`);
console.log(`worklet ok: ${file}, peak ${peak.toFixed(3)}, ${states.length} state packets in 3 s`);
