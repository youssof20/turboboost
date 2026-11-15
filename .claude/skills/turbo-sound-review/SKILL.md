---
name: turbo-sound-review
description: Run after any change to src/audio or src/model. Renders reference audio offline and checks it.
---
1. Run `npm run render` to produce out/reference.wav from logs/reference.csv.
2. Run `npm run spectrum` and compare band energies (0.2-0.6k, 0.6-2k, 2-5k, 5-10k) to out/baseline.json.
   Flag any band that moved more than 3 dB unless the task asked for it.
3. Run `npm test` (turbo.ts event tests: blow-off count must equal shift count in each log).
4. Check for clicks: count samples where |x[n]-x[n-1]| > 0.3; must be 0 (`npm run spectrum` prints it).
5. Report: what changed audibly, numbers before/after, and whether the baseline should be updated
   (`npm run spectrum -- --update`).
