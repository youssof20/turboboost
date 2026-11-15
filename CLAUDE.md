# TurboBoost
Personal web app: real-time turbo sound layered over my real engine, driven by OBD-II over BLE.
Deployed to GitHub Pages. No backend. One user: me.

## Non-negotiables
- DSP lives in the AudioWorklet. `src/audio/worklet.ts` is the entry; the voices are in `src/audio/dsp.ts`
  (a plain class so `npm run render` runs the exact same code offline). Never put audio math on the main thread.
- The worklet scope has no `structuredClone`, `performance`, or DOM. `npm run check:worklet` loads the built bundle in
  a sandbox with only worklet globals. Run it after `npm run build`.
- Every audio parameter is smoothed inside the worklet. No direct gain/frequency sets.
- `src/model/turbo.ts` is pure and unit-tested against `logs/*.csv`.
- After ANY change to model or DSP: run `npm run render` and `npm run spectrum`; compare with `out/baseline.json`
  before claiming done (see `.claude/skills/turbo-sound-review`).
- UI: no taglines, no hero, one accent color (means boost), tabular numerals, 56 px touch targets, drive-screen text >= 20 px.
  Settings/Lab only at 0 km/h (or demo/replay).
- Profile JSON (`src/model/profiles.ts`) is the source of truth for all tunable numbers; no magic constants in code.
- Gear is data, not decoration: shift detection, rev-match blips, gear whine and the coast-down all read it. Demo has no gears.

## Commands
npm run dev | npm test | npm run render | npm run spectrum | npm run build | npm run check:worklet | npm run ci
npm run samples | npm run log | npm run icons   (regenerate placeholder samples, reference log, icons)
