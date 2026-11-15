// Lab: every slider, a live spectrum, sandbox drive sources, sample import, A/B reference, log replay.

import type { App } from '../app.ts';
import { PARAM_SPECS, getPath } from '../model/profiles.ts';
import { h, row, segmented, slider, download, pickFile } from './dom.ts';
import { pageShell } from './page.ts';
import type { View } from './start.ts';
import { deleteCustomProfile, duplicateProfile, importProfile, isBuiltin, loadProfiles, resetProfile, saveProfile } from '../store.ts';
import { BUILTIN_PROFILES } from '../model/profiles.ts';

export function buildLab(app: App): View {
  const body = h('div', { class: 'page-inner' });
  const shell = pageShell(app, 'Lab', 'lab', body);

  const readout = h('div', { class: 'ro' });
  const spectrum = h('canvas', { class: 'spectrum' });
  const scrub = h('input', { type: 'range', min: 0, max: 1, step: 0.01 });
  const scrubTime = h('output', { class: 'slider-val' }, '0:00');
  let freq: Uint8Array<ArrayBuffer> | null = null;
  let scrubbing = false;
  scrub.addEventListener('pointerdown', () => (scrubbing = true));
  scrub.addEventListener('pointerup', () => (scrubbing = false));
  scrub.addEventListener('input', () => {
    const r = app.replay;
    if (r) r.seek(r.start + (+scrub.value / 1) * r.duration);
  });
  const notices = h('div', { class: 'note' });

  function build() {
    const p = app.active;
    const sliders: ReturnType<typeof slider>[] = [];

    // ---- sandbox ----

    const sandbox = h('div', { class: 'card' },
      h('div', { class: 'row-label' }, 'Sandbox: drive the synth by hand'),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => { app.useDemo(); app.go('drive'); } }, 'Hold-throttle demo'),
        h('button', { class: 'btn', type: 'button', onclick: () => { app.useManual(); build(); } }, 'RPM + pedal sliders'),
      ),
    );
    const manual = h('div', { class: 'card', style: app.source?.kind === 'manual' ? '' : 'display:none' },
      slider({ label: 'RPM', value: app.manual.rpm, def: 3000, min: 500, max: p.engine.redline, step: 10, unit: 'rpm', onChange: (v) => (app.manual.rpm = v) }).el,
      slider({ label: 'Pedal', value: app.manual.pedal, def: 0, min: 0, max: 1, step: 0.01, onChange: (v) => (app.manual.pedal = v) }).el,
      h('div', { class: 'note' }, 'Slide the pedal up to spool, then snap it to zero for the blow-off.'),
    );

    // ---- profile management ----
    const profTiles = h('div', { class: 'tiles' },
      ...app.profiles.map((x) =>
        h('button', { class: 'tile' + (x.id === p.id ? ' on' : ''), type: 'button', onclick: () => { app.setActiveProfile(x.id); build(); } }, h('div', { class: 'n' }, x.name), h('div', { class: 'd' }, x.blurb)),
      ),
    );
    const nameInput = h('input', { type: 'text', value: p.name, 'aria-label': 'Profile name' });
    nameInput.addEventListener('change', () => { app.editProfile('name', nameInput.value.trim() || p.name); build(); });
    const profActions = h('div', { class: 'btnrow' },
      h('button', { class: 'btn', type: 'button', onclick: () => { const c = duplicateProfile(app.active); app.replaceProfiles(loadProfiles()); app.setActiveProfile(c.id); build(); } }, 'Duplicate'),
      h('button', { class: 'btn', type: 'button', onclick: () => download(`${p.id}.json`, JSON.stringify(app.active, null, 2)) }, 'Export JSON'),
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          const [f] = await pickFile('.json,application/json');
          if (!f) return;
          const r = importProfile(await f.text());
          app.replaceProfiles(loadProfiles());
          app.setActiveProfile(r.profile.id);
          notices.textContent = r.errors.length ? 'Imported with fixes: ' + r.errors.join('; ') : `Imported "${r.profile.name}".`;
          notices.className = r.errors.length ? 'note err' : 'note';
          build();
        },
      }, 'Import JSON'),
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          if (isBuiltin(p.id)) {
            const fresh = resetProfile(p.id)!;
            const i = app.profiles.findIndex((x) => x.id === p.id);
            app.profiles[i] = fresh;
            app.active = fresh;
            app.setActiveProfile(fresh.id);
            saveProfile(fresh);
          } else {
            if (!confirm(`Delete "${p.name}"?`)) return;
            deleteCustomProfile(p.id);
            app.replaceProfiles(loadProfiles());
            app.setActiveProfile(BUILTIN_PROFILES[0]!.id);
          }
          build();
        },
      }, isBuiltin(p.id) ? 'Reset to default' : 'Delete'),
    );

    // ---- slider groups ----
    const groups = new Map<string, HTMLElement[]>();
    const defaults = BUILTIN_PROFILES.find((x) => x.id === p.id) ?? BUILTIN_PROFILES[0]!;
    for (const spec of PARAM_SPECS) {
      const cur = getPath(p, spec.path) as number;
      const def = getPath(defaults, spec.path) as number;
      const s = slider({
        label: spec.label,
        value: cur,
        def: typeof def === 'number' ? def : cur,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
        onChange: (v) => app.editProfile(spec.path, v),
      });
      sliders.push(s);
      if (!groups.has(spec.group)) groups.set(spec.group, []);
      groups.get(spec.group)!.push(s.el);
    }
    const groupEls = [...groups.entries()].map(([name, els], i) =>
      h('details', { class: 'group', open: i === 0 }, h('summary', {}, name), h('div', { class: 'body' }, ...els)),
    );

    // ---- samples ----
    const sampleCard = h('div', { class: 'card' },
      h('div', { class: 'row-label' }, 'Sample sets'),
      h('div', { class: 'note' }, `Blow-off: ${app.userSamples.bov.length ? app.userSamples.bov.length + ' of yours' : 'built-in set'} · Pops: ${app.userSamples.pop.length ? app.userSamples.pop.length + ' of yours' : 'built-in set'}. Yours are randomised automatically and replace the built-in ones.`),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { const f = await pickFile('audio/*', true); if (f.length) { await app.importSamples('bov', f); build(); } } }, 'Add blow-off WAVs'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { const f = await pickFile('audio/*', true); if (f.length) { await app.importSamples('pop', f); build(); } } }, 'Add pop WAVs'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { await app.clearSamples(); build(); } }, 'Clear mine'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { const [f] = await pickFile('audio/*'); if (f) { await app.engine.loadIrBytes(await f.arrayBuffer()); notices.textContent = 'Intake impulse response loaded for this session.'; } } }, 'Load intake IR'),
      ),
    );

    // ---- A/B ----
    const abSeg = segmented<'synth' | 'ref' | 'both'>([{ value: 'synth', label: 'A: synth' }, { value: 'ref', label: 'B: reference' }, { value: 'both', label: 'Both' }], 'synth', (v) => app.engine.setAB(v));
    const playBtn = h('button', { class: 'btn', type: 'button', onclick: async () => { const on = await app.engine.referenceToggle(); playBtn.textContent = on ? 'Pause reference' : 'Play reference'; } }, 'Play reference');
    const ab = h('div', { class: 'card' },
      h('div', { class: 'row-label' }, 'A/B reference'),
      h('div', { class: 'note' }, 'Load a clip of the target car, start both, then switch A/B while you hold the same rpm.'),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: async () => { const [f] = await pickFile('audio/*'); if (f) { app.engine.loadReference(f); notices.textContent = `Reference: ${f.name}`; } } }, 'Load clip'), playBtn),
      abSeg.el,
    );

    // ---- replay ----
    const r = app.replay;
    const replayCard = h('div', { class: 'card' },
      h('div', { class: 'row-label' }, 'Log replay'),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { await app.useBundledReplay(); app.go('drive'); } }, 'Reference drive'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { const [f] = await pickFile('.csv,text/csv'); if (!f) return; try { await app.useReplay(await f.text(), f.name); app.go('drive'); } catch (e) { notices.textContent = String(e instanceof Error ? e.message : e); notices.className = 'note err'; } } }, 'Open CSV'),
        h('button', { class: 'btn', type: 'button', disabled: !r, onclick: () => { if (app.replay) { app.replay.playing = !app.replay.playing; build(); } } }, r?.playing ? 'Pause' : 'Play'),
      ),
      h('div', { class: 'slider' }, h('span', { class: 'slider-label' }, r ? r.label : 'No log loaded'), scrubTime, scrub),
      h('div', { class: 'note' }, 'CSV columns: t,rpm,pedal,map,speed. Gear is estimated from rpm and speed, like in the car.'),
    );

    body.replaceChildren(
      notices,
      h('h2', { class: 'sec' }, 'Live'),
      h('div', { class: 'card' }, readout),
      spectrum,
      h('h2', { class: 'sec' }, 'Sandbox'),
      sandbox,
      manual,
      replayCard,
      h('h2', { class: 'sec' }, 'Profile'),
      profTiles,
      row('Name', nameInput),
      profActions,
      h('h2', { class: 'sec' }, 'Tuning'),
      ...groupEls,
      h('h2', { class: 'sec' }, 'Assets'),
      sampleCard,
      ab,
    );
  }

  function drawSpectrum() {
    const an = app.engine.analyser;
    if (!an) return;
    if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(new ArrayBuffer(an.frequencyBinCount));
    an.getByteFrequencyData(freq);
    const c = spectrum;
    const w = (c.width = c.clientWidth * (window.devicePixelRatio || 1));
    const hgt = (c.height = c.clientHeight * (window.devicePixelRatio || 1));
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, hgt);
    const sr = app.engine.ctx?.sampleRate ?? 44100;
    const bins = freq.length;
    const fLo = 100;
    const fHi = Math.min(12000, sr / 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text');
    const N = 96;
    for (let i = 0; i < N; i++) {
      const f0 = fLo * Math.pow(fHi / fLo, i / N);
      const f1 = fLo * Math.pow(fHi / fLo, (i + 1) / N);
      const b0 = Math.floor((f0 / (sr / 2)) * bins);
      const b1 = Math.max(b0 + 1, Math.ceil((f1 / (sr / 2)) * bins));
      let m = 0;
      for (let b = b0; b < b1 && b < bins; b++) m = Math.max(m, freq[b]!);
      const bh = (m / 255) * hgt;
      ctx.fillRect((i / N) * w + 1, hgt - bh, w / N - 2, bh);
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--dim');
    ctx.font = `${Math.round(hgt * 0.1)}px sans-serif`;
    for (const f of [200, 500, 1000, 2000, 5000, 10000]) {
      if (f > fHi) continue;
      const x = (Math.log(f / fLo) / Math.log(fHi / fLo)) * w;
      ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x, hgt * 0.14);
    }
  }

  function frame() {
    const s = app.snap;
    if (s) {
      readout.replaceChildren(
        ...[
          ['shaft', s.shaft.toFixed(2)],
          ['boost', s.boost.toFixed(2) + ' bar'],
          ['flow', s.flow.toFixed(2)],
          ['spool', s.spoolRate.toFixed(2) + '/s'],
          ['gate', s.gate.toFixed(2)],
          ['venting', s.venting ? 'yes' : 'no'],
          ['out', s.level.toFixed(2)],
          ['blow-offs', String(app.engine.bovCount)],
        ].map(([k, v]) => h('div', {}, h('b', {}, k!), v!)),
      );
    }
    drawSpectrum();
    const r = app.replay;
    if (r && app.source?.kind === 'replay' && !scrubbing) {
      scrub.value = String((r.pos - r.start) / r.duration);
      const t = r.pos - r.start;
      scrubTime.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    }
  }

  return { el: shell, refresh: build, frame };
}
