// Drive screen: RPM arc, boost bar, gear, throttle pad (demo), volume, mode, profile tiles.
// Every text here is at least 20 px, every target at least 56 px.

import type { App } from '../app.ts';
import { h, segmented, fmt } from './dom.ts';
import { Gauge } from './gauge.ts';
import type { Mode } from '../audio/dsp.ts';

const CHIP: Record<string, string> = { bov: 'BLOW-OFF', flutter: 'FLUTTER', pop: 'POP', bang: 'BANG', shift: 'SHIFT', blip: 'BLIP' };

export interface DriveView {
  el: HTMLElement;
  frame(now: number): void;
  refresh(): void;
}

export function buildDrive(app: App): DriveView {
  // ---- header ----
  const dot = h('span', { class: 'dot' });
  const srcLabel = h('span', { class: 'src' });
  const profLabel = h('span', { class: 'prof' });
  const menuPanel = h('div', { class: 'menu', hidden: true });
  const menuBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Menu', onclick: () => toggleMenu() }, '☰');
  const top = h('div', { class: 'top' }, dot, srcLabel, profLabel, menuBtn);
  const banner = h('div', { class: 'banner hidden' }, 'Reconnecting…');

  // long press on the status area opens diagnostics
  let pressTimer = 0;
  const statusArea = h('div', { class: 'statusarea', style: 'display:contents' });
  for (const e of [dot, srcLabel]) {
    e.addEventListener('pointerdown', () => {
      pressTimer = window.setTimeout(() => app.go('diag'), 700);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) e.addEventListener(ev, () => clearTimeout(pressTimer));
  }
  void statusArea;

  // ---- gauge ----
  const canvas = h('canvas');
  const rpmNum = h('div', { class: 'rpm-num' }, '0');
  const gearNum = h('div', { class: 'gear-num' }, '–');
  const gearBox = h('div', { class: 'gear-box none' }, h('div', { class: 'cap' }, 'Gear'), gearNum);
  const chip = h('div', { class: 'chip' }, '');
  const gaugeWrap = h('div', { class: 'gauge-wrap' }, canvas, h('div', { class: 'gauge-center' }, rpmNum, h('div', { class: 'cap' }, 'RPM')), gearBox, chip);
  const gauge = new Gauge(canvas);

  // ---- boost + stats ----
  const boostFill = h('div', { class: 'fill' });
  const boostVal = h('div', { class: 'val' }, '0.00 bar');
  const boost = h('div', { class: 'boost' }, h('div', { class: 'cap' }, 'Boost'), h('div', { class: 'bar' }, boostFill), boostVal);
  const stPedal = h('div', { class: 'v' }, '0%');
  const stSpeed = h('div', { class: 'v' }, '–');
  const stSpool = h('div', { class: 'v' }, '0%');
  const stats = h(
    'div',
    { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'cap' }, 'Pedal'), stPedal),
    h('div', { class: 'stat' }, h('div', { class: 'cap' }, 'km/h'), stSpeed),
    h('div', { class: 'stat' }, h('div', { class: 'cap' }, 'Spool'), stSpool),
  );

  // ---- throttle pad (demo / sliders) ----
  const padFill = h('div', { class: 'fill' });
  const pad = h('div', { class: 'pad', role: 'button', 'aria-label': 'Hold for throttle' }, padFill, h('div', { class: 'lbl' }, 'Hold for throttle'), h('div', { class: 'hint' }, 'Release to lift. Spacebar works too.'));
  let held = false;
  const setHeld = (v: boolean) => {
    held = v;
    app.demo.held = v;
    pad.classList.toggle('held', v);
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    setHeld(true);
    e.preventDefault();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, () => setHeld(false));
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  const keyDown = (e: KeyboardEvent) => {
    if (app.screen !== 'drive' || e.repeat) return;
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      e.preventDefault();
      setHeld(true);
    }
  };
  const keyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') setHeld(false);
  };
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('blur', () => setHeld(false));

  // ---- controls ----
  const modeSeg = segmented<Mode>(
    [
      { value: 'mute', label: 'Mute' },
      { value: 'sport', label: 'Sport' },
      { value: 'full', label: 'Full' },
    ],
    app.settings.mode,
    (m) => app.setMode(m),
  );
  const viewSeg = segmented<'cabin' | 'bay'>(
    [
      { value: 'cabin', label: 'Cabin' },
      { value: 'bay', label: 'Engine bay' },
    ],
    app.settings.cabin ? 'cabin' : 'bay',
    (v) => app.setCabin(v === 'cabin'),
  );
  const volInput = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Volume' });
  volInput.value = String(app.settings.master);
  volInput.addEventListener('input', () => app.setMaster(+volInput.value));
  const vol = h('div', { class: 'vol' }, h('div', { class: 'cap' }, 'Volume'), volInput);
  const tiles = h('div', { class: 'tiles' });
  const controls = h('div', { class: 'controls' }, modeSeg.el, viewSeg.el, vol, tiles);

  const left = h('div', { class: 'col' }, gaugeWrap, boost, stats);
  const right = h('div', { class: 'col' }, pad, controls);
  const layout = h('div', { class: 'layout' }, left, right);

  const el = h('section', { id: 'drive', class: 'screen' }, top, banner, menuPanel, layout);

  // ---- menu ----
  function toggleMenu(force?: boolean) {
    const show = force ?? menuPanel.hidden;
    menuPanel.hidden = !show;
    if (show) buildMenu();
  }
  function buildMenu() {
    const parked = app.isParked();
    menuPanel.replaceChildren(
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', disabled: !parked, onclick: () => { toggleMenu(false); app.go('setup'); } }, parked ? 'Setup' : 'Setup (stop first)'),
        h('button', { class: 'btn', type: 'button', disabled: !parked, onclick: () => { toggleMenu(false); app.go('lab'); } }, parked ? 'Lab' : 'Lab (stop first)'),
        h('button', { class: 'btn', type: 'button', onclick: () => { toggleMenu(false); app.go('diag'); } }, 'Diagnostics'),
      ),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => { app.setDim(!app.settings.dim); toggleMenu(false); } }, app.settings.dim ? 'Dim: on' : 'Dim: off'),
        h('button', { class: 'btn', type: 'button', onclick: () => { toggleMenu(false); app.stopSource(); app.go('start'); } }, 'Stop'),
      ),
    );
  }

  function buildTiles() {
    tiles.replaceChildren(
      ...app.profiles.map((p) =>
        h(
          'button',
          { class: 'tile' + (p.id === app.active.id ? ' on' : ''), type: 'button', onclick: () => app.setActiveProfile(p.id) },
          h('div', { class: 'n' }, p.name),
          h('div', { class: 'd' }, p.blurb),
        ),
      ),
    );
  }

  let chipTimer = 0;
  let lastEventAt = 0;
  let lastBoostVar = -1;

  function refresh() {
    const demoLike = app.source?.kind === 'demo' || app.source?.kind === 'manual';
    pad.style.display = app.source?.kind === 'demo' ? '' : 'none';
    srcLabel.textContent = app.source?.label ?? '';
    profLabel.textContent = app.active.name;
    const link = app.link;
    const isObd = app.source?.kind === 'obd';
    dot.className = 'dot ' + (isObd ? (link.state === 'live' ? 'live' : 'wait') : demoLike ? 'demo' : 'live');
    banner.classList.toggle('hidden', !(isObd && link.state !== 'live'));
    banner.textContent = link.state === 'error' ? 'Adapter problem: ' + link.message : 'Reconnecting…';
    buildTiles();
    modeSeg.set(app.settings.mode);
    viewSeg.set(app.settings.cabin ? 'cabin' : 'bay');
    volInput.value = String(app.settings.master);
    menuBtn.toggleAttribute('data-locked', !app.isParked());
    gauge.refreshColors();
  }

  function frame(now: number) {
    const f = app.frame;
    const s = app.snap;
    const p = app.active;
    const boostBar = s ? s.boost : 0;
    const boostN = Math.min(1.2, boostBar / Math.max(0.2, p.turbo.maxBoost));
    const shaft = s ? s.shaft : 0;

    let flash = 0;
    const ev = app.lastEvent;
    if (ev && ev.at !== lastEventAt) {
      lastEventAt = ev.at;
      chip.textContent = CHIP[ev.type] ?? ev.type.toUpperCase();
      chip.classList.add('show');
      clearTimeout(chipTimer);
      chipTimer = window.setTimeout(() => chip.classList.remove('show'), ev.type === 'bov' || ev.type === 'flutter' ? 900 : 450);
      if (ev.type === 'bov' || ev.type === 'flutter') {
        gaugeWrap.classList.remove('flash');
        void gaugeWrap.offsetWidth;
        gaugeWrap.classList.add('flash');
      }
    }
    if (ev && now - ev.at < 150 && (ev.type === 'bov' || ev.type === 'flutter')) flash = 1 - (now - ev.at) / 150;

    gauge.draw({ rpm: f.rpm, redline: p.engine.redline, shaft, boostN, flash, limiting: app.source?.kind === 'demo' && app.demo.limiting });
    rpmNum.textContent = fmt(f.rpm, 0);
    const g = app.gear;
    gearNum.textContent = g === null ? '–' : g === 0 ? 'N' : String(g);
    gearBox.classList.toggle('none', g === null);
    boostFill.style.width = Math.min(100, boostN * 100) + '%';
    boostVal.textContent = fmt(boostBar, 2) + ' bar';
    stPedal.textContent = fmt(f.pedal * 100, 0) + '%';
    stSpeed.textContent = f.speedKmh === null ? '–' : fmt(f.speedKmh, 0);
    stSpool.textContent = fmt(shaft * 100, 0) + '%';
    padFill.style.height = f.pedal * 100 + '%';
    const bv = Math.round(Math.min(1, boostN) * 50) / 50;
    if (bv !== lastBoostVar) {
      lastBoostVar = bv;
      document.documentElement.style.setProperty('--boost', String(bv));
    }
    void held;
  }

  return { el, frame, refresh };
}
