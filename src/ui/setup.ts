// Setup: the tier-2 settings you visit while parked. Large toggles and steppers.

import type { App } from '../app.ts';
import { getPath, type LiftMode, type PopsMode, type SpeedDucking, type BoostSource } from '../model/profiles.ts';
import { h, row, segmented, stepper } from './dom.ts';
import { pageShell } from './page.ts';
import type { View } from './start.ts';
import { resetProfile, saveProfile } from '../store.ts';

const SENS = { thr: [0.7, 0.56, 0.43, 0.29, 0.15], rate: [-4, -3.4, -2.75, -2.1, -1.5] };

function sensitivityOf(thr: number): number {
  let best = 0;
  for (let i = 1; i < SENS.thr.length; i++) if (Math.abs(SENS.thr[i]! - thr) < Math.abs(SENS.thr[best]! - thr)) best = i;
  return best + 1;
}

export function buildSetup(app: App): View {
  const body = h('div', { class: 'page-inner' });
  const shell = pageShell(app, 'Setup', 'setup', body);

  function build() {
    const p = app.active;
    const errs = app.profileSet.errors[p.id];
    const edit = (path: string) => (v: unknown) => app.editProfile(path, v);

    const tiles = h('div', { class: 'tiles' },
      ...app.profiles.map((x) =>
        h('button', { class: 'tile' + (x.id === p.id ? ' on' : ''), type: 'button', onclick: () => { app.setActiveProfile(x.id); build(); } }, h('div', { class: 'n' }, x.name), h('div', { class: 'd' }, x.blurb)),
      ),
    );

    const lat = app.engine.latency();
    body.replaceChildren(
      h('div', { class: 'note err', style: errs?.length ? '' : 'display:none' }, 'This profile had invalid fields, using defaults for: ' + (errs ?? []).join('; ')),
      h('h2', { class: 'sec' }, 'Profile'),
      tiles,

      h('h2', { class: 'sec' }, 'Lift behaviour'),
      row('On lift', segmented<LiftMode>(
        [
          { value: 'bov', label: 'Blow-off' },
          { value: 'flutter', label: 'Flutter' },
          { value: 'both', label: 'Both' },
          { value: 'recirc', label: 'Recirc' },
        ],
        p.lift.mode, edit('lift.mode')).el, 'Recirc is the muffled factory bypass valve.'),
      row('Blow-off sensitivity', stepper({ value: sensitivityOf(p.lift.bovThreshold), min: 1, max: 5, step: 1, onChange: (v) => { edit('lift.bovThreshold')(SENS.thr[v - 1]); edit('lift.liftRate')(SENS.rate[v - 1]); } }).el, '1 = only hard lifts with lots of boost. 5 = fires on gentle lifts. Lower it if it psshes when you feather the pedal.'),
      row('Anti-lag (rally)', segmented<'off' | 'on'>([{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], p.lift.antiLag ? 'on' : 'off', (v) => edit('lift.antiLag')(v === 'on')).el, 'Keeps the turbo spun on lift and adds bangs.'),
      row('Overrun pops', segmented<PopsMode>([{ value: 'off', label: 'Off' }, { value: 'mild', label: 'Mild' }, { value: 'rally', label: 'Rally' }], p.setup.pops, edit('setup.pops')).el, 'Crackles when you are off the throttle and slowing down.'),

      h('h2', { class: 'sec' }, 'Car'),
      row('Boost source', segmented<BoostSource>([{ value: 'virtual', label: 'Virtual' }, { value: 'map', label: 'Real MAP' }], p.setup.boostSource, edit('setup.boostSource')).el, 'Real MAP only on turbo cars. On a naturally aspirated car pick Virtual.'),
      row('RPM exaggeration', stepper({ value: p.setup.rpmExaggeration, min: 1, max: 1.6, step: 0.05, digits: 2, unit: 'x', onChange: edit('setup.rpmExaggeration') }).el, 'Multiplies rpm changes so cruising sounds busy. Idle stays honest.'),
      row('Redline', stepper({ value: p.engine.redline, min: 3000, max: 10000, step: 100, unit: 'rpm', onChange: edit('engine.redline') }).el),
      row('Idle', stepper({ value: p.engine.idle, min: 500, max: 1500, step: 10, unit: 'rpm', onChange: edit('engine.idle') }).el, 'The turbo is silent below idle + 300 rpm with the pedal up.'),
      row('Cylinders', stepper({ value: p.engine.cylinders, min: 1, max: 12, step: 1, onChange: edit('engine.cylinders') }).el, 'Sets the firing-frequency flutter in the whoosh.'),
      row('Throttle idle offset', stepper({ value: p.setup.throttleIdlePct, min: 0, max: 30, step: 1, unit: '%', onChange: edit('setup.throttleIdlePct') }).el, 'Only used when the car has no accelerator pedal PID.'),
      row('Gear ratios', h('div', { class: 'note' }, p.engine.gearRatios.map((r) => r.toFixed(2)).join(' · ') + ` · final ${p.engine.finalDrive.toFixed(2)}`), 'Used to estimate the gear from rpm and speed. Edit in the Lab (JSON export) for your car.'),

      h('h2', { class: 'sec' }, 'Sound'),
      row('Speed ducking', segmented<SpeedDucking>([{ value: 'off', label: 'Off' }, { value: 'duck', label: 'Quieter' }, { value: 'boost', label: 'Louder' }], p.setup.speedDucking, edit('setup.speedDucking')).el, 'Quieter with speed, or louder to beat road noise.'),
      row('Headphone mode', segmented<'off' | 'on'>([{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], app.settings.headphone ? 'on' : 'off', (v) => app.setHeadphone(v === 'on')).el, 'Opens the interior low-pass so tuning at your desk is judged fairly.'),

      h('h2', { class: 'sec' }, 'Output'),
      row('Latency compensation', stepper({ value: p.setup.latencyMs, min: 0, max: 400, step: 5, unit: 'ms', onChange: edit('setup.latencyMs') }).el, 'Leads pitch and lift events by this much. Measure it with the tap test, or use the aux cable and leave it at 0.'),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => app.go('check') }, 'Run tap test')),
      row('Output check', h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => app.engine.playTestTone('left') }, 'Left'),
        h('button', { class: 'btn', type: 'button', onclick: () => app.engine.playTestTone('right') }, 'Right'),
      ), lat ? `${lat.sampleRate} Hz · output ${lat.outputMs.toFixed(0)} ms · buffer ${lat.baseMs.toFixed(0)} ms. ${lat.hint}` : 'Start audio first.'),

      h('h2', { class: 'sec' }, 'Reset'),
      h('div', { class: 'btnrow' },
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            if (!confirm(`Reset "${p.name}" to its defaults?`)) return;
            const fresh = resetProfile(p.id);
            if (fresh) {
              const i = app.profiles.findIndex((x) => x.id === p.id);
              app.profiles[i] = fresh;
              app.active = fresh;
              app.setActiveProfile(fresh.id);
              saveProfile(fresh);
              build();
            }
          },
        }, 'Reset this profile'),
      ),
    );
    void getPath;
  }

  return { el: shell, refresh: build };
}
