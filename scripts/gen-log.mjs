// Generates logs/reference.csv: a deterministic fake drive with real gear changes, full lifts,
// feathering and a gentle low-boost lift. Columns: t,rpm,pedal,map,speed,gear,expect
// `expect` = 1 on the row where a blow-off is expected (shift or full lift with stored boost).
import { writeFileSync, mkdirSync } from 'node:fs';

const RATIOS = [3.58, 2.19, 1.52, 1.13, 0.91, 0.76];
const FINAL = 3.94;
const CIRC = 1.99;
const K = RATIOS.map((r) => (1000 / (60 * CIRC)) * r * FINAL); // rpm per km/h
const ACC = [19, 14, 10.5, 8, 6, 4.5]; // km/h per s at full throttle
const IDLE = 820;
const LOG_DT = 0.05;
const SIM_DT = 0.005;

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const s = { t: 0, v: 0, g: 1, clutch: false, pedal: 0, pedalTarget: 0, pedalRate: 12, boost: 0, expect: 0 };
const rows = [];
let nextLog = 0;

function rpmNow() {
  if (s.clutch) return s.rpmClutch;
  return Math.max(IDLE, K[s.g - 1] * s.v);
}
function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function tick() {
  // pedal slews toward target
  const d = s.pedalTarget - s.pedal;
  const m = s.pedalRate * SIM_DT;
  s.pedal += Math.abs(d) <= m ? d : Math.sign(d) * m;
  // speed
  if (!s.clutch) {
    const power = 0.6 + 0.4 * smooth(1500, 4500, rpmNow());
    const a = s.pedal * ACC[s.g - 1] * power - (1.2 + s.v * 0.02);
    s.v = Math.max(0, s.v + a * SIM_DT);
  } else {
    s.v = Math.max(0, s.v - (1.2 + s.v * 0.02) * SIM_DT);
    const target = Math.max(IDLE, K[s.gTo - 1] * s.v);
    s.rpmClutch += (target - s.rpmClutch) * (1 - Math.exp(-SIM_DT / 0.18));
  }
  // boost
  const rpm = rpmNow();
  const want = s.pedal > 0.3 ? 1.2 * smooth(2200, 3800, rpm) * Math.min(1, s.pedal * 1.2) : 0;
  const tau = want > s.boost ? 0.55 : 0.12;
  s.boost += (want - s.boost) * (1 - Math.exp(-SIM_DT / tau));
  s.t += SIM_DT;
  if (s.t >= nextLog - 1e-9) {
    const noisy = rpm + rnd() * 6;
    const map = s.boost > 0.02 ? 101.3 + 100 * s.boost : 30 + 71 * Math.min(1, s.pedal * 1.2);
    rows.push([s.t, noisy, s.pedal, map, s.v + rnd() * 0.1, s.clutch ? 0 : s.v < 3 ? 0 : s.g, s.expect]);
    s.expect = 0;
    nextLog += LOG_DT;
  }
}
const run = (secs, fn) => {
  const n = Math.round(secs / SIM_DT);
  for (let i = 0; i < n; i++) {
    if (fn) fn(i / n);
    tick();
  }
};

const idle = (secs) => { s.pedalTarget = 0; run(secs); };
const pull = (until) => {
  s.pedalTarget = 1; s.pedalRate = 6;
  let guard = 0;
  while (rpmNow() < until && guard++ < 20000) tick();
};
const shift = (to) => {
  s.expect = 1;
  s.pedalRate = 14; s.pedalTarget = 0;
  run(0.12);
  s.clutch = true; s.gTo = to; s.rpmClutch = K[s.g - 1] * s.v;
  run(0.38);
  s.clutch = false; s.g = to;
  s.pedalRate = 6; s.pedalTarget = 1;
};
const lift = (secs) => { s.expect = 1; s.pedalRate = 14; s.pedalTarget = 0; run(secs); };
const cruise = (p, secs) => { s.pedalRate = 3; s.pedalTarget = p; run(secs); };
const feather = (center, amp, hz, secs) => {
  s.pedalRate = 4;
  const n = Math.round(secs / SIM_DT);
  for (let i = 0; i < n; i++) { s.pedalTarget = center + amp * Math.sin(2 * Math.PI * hz * i * SIM_DT); tick(); }
};

// ---- scenario (first 10 s has: idle, pull, shift, pull, shift, pull) ----
idle(0.6);
pull(6300); shift(2);
pull(6200); shift(3);
pull(5200); lift(1.6);          // full lift in gear with stored boost -> blow-off
cruise(0.55, 1.2);
feather(0.62, 0.12, 1.5, 3.0);  // feathering: must NOT fire
s.pedalRate = 10; s.pedalTarget = 0.85; run(0.4); s.pedalTarget = 0.5; run(0.6); // stab down, not closed: no blow-off
cruise(0.25, 1.5);
cruise(0.0, 0.2);                // low-boost lift: nothing stored, no blow-off
pull(6000); shift(4);
pull(5800); shift(5);
pull(5000); lift(2.0);
idle(1.0);

mkdirSync('logs', { recursive: true });
const out = ['t,rpm,pedal,map,speed,gear,expect'];
for (const r of rows) out.push([r[0].toFixed(3), r[1].toFixed(1), r[2].toFixed(3), r[3].toFixed(1), r[4].toFixed(2), r[5], r[6]].join(','));
writeFileSync('logs/reference.csv', out.join('\n') + '\n');
console.log(`wrote logs/reference.csv: ${rows.length} rows, ${rows.at(-1)[0].toFixed(1)} s, expected blow-offs: ${rows.filter((r) => r[6]).length}`);
