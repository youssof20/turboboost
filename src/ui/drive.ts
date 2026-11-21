// Drive screen. Glanceable: RPM, gear, boost. One bottom bar: mute, volume, and a sheet for everything else.
// No pop-up event labels: you hear the blow-off, you don't need to read it.
// Every text here is at least 20 px, every target at least 56 px.

import type { App } from '../app.ts';
import { h, segmented, fmt } from './dom.ts';
import { Gauge } from './gauge.ts';
import type { Mode } from '../audio/dsp.ts';

const SVG = (d: string) => '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const ICON = {
  speaker: SVG('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>'),
  muted: SVG('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  close: SVG('<path d="M6 6l12 12M18 6L6 18"/>'),
  settings: SVG('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
};

export interface DriveView {
  el: HTMLElement;
  frame(now: number): void;
  refresh(): void;
}

export function buildDrive(app: App): DriveView {
  // ---- status line (long-press opens diagnostics) ----
  const dot = h('span', { class: 'dot' });
  const srcLabel = h('span', { class: 'src' });
  const status = h('div', { class: 'status' }, dot, srcLabel);
  let pressTimer = 0;
  status.addEventListener('pointerdown', () => (pressTimer = window.setTimeout(() => app.go('diag'), 700)));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) status.addEventListener(ev, () => clearTimeout(pressTimer));
  const banner = h('div', { class: 'banner hidden' }, 'Reconnecting…');
  const setBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Settings', onclick: () => openSheet() });
  setBtn.innerHTML = ICON.settings;

  // ---- gauge ----
  const canvas = h('canvas');
  const rpmNum = h('div', { class: 'rpm-num' }, '0');
  const gearNum = h('div', { class: 'gear-num' }, '');
  const gaugeWrap = h('div', { class: 'gauge-wrap' }, canvas, h('div', { class: 'gauge-center' }, rpmNum, h('div', { class: 'cap' }, 'rpm')), gearNum);
  const gauge = new Gauge(canvas);

  // ---- boost ----
  const boostFill = h('div', { class: 'fill' });
  const boostVal = h('div', { class: 'val' }, '0.00');
  const boost = h('div', { class: 'boost' }, h('div', { class: 'cap' }, 'Boost'), h('div', { class: 'bar' }, boostFill), boostVal, h('div', { class: 'unit' }, 'bar'));

  // ---- throttle pad (demo only) ----
  const padFill = h('div', { class: 'fill' });
  const pad = h('div', { class: 'pad', role: 'button', 'aria-label': 'Hold for throttle' }, padFill, h('div', { class: 'lbl' }, 'Hold to rev'));
  const setHeld = (v: boolean) => {
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
  window.addEventListener('keydown', (e) => {
    if (app.screen !== 'drive' || e.repeat) return;
    if ((e.code === 'Space' || e.code === 'ArrowUp') && (e.target as HTMLElement)?.tagName !== 'INPUT') {
      e.preventDefault();
      setHeld(true);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') setHeld(false);
  });
  window.addEventListener('blur', () => setHeld(false));

  // ---- bottom bar ----
  const muteBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Mute', onclick: () => app.setMode(app.settings.mode === 'mute' ? lastLoud : 'mute') });
  let lastLoud: Mode = app.settings.mode === 'mute' ? 'full' : app.settings.mode;
  const volInput = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Volume' });
  volInput.addEventListener('input', () => app.setMaster(+volInput.value));
  const soundBtn = h('button', { class: 'btn sheet-btn', type: 'button', onclick: () => openSheet() }, 'Sound');
  const bar = h('div', { class: 'bottombar' }, muteBtn, volInput, soundBtn);

  // ---- sheet ----
  const sheetBody = h('div', { class: 'sheet-body' });
  const sheet = h('div', { class: 'sheet', hidden: true, onclick: (e: Event) => { if (e.target === sheet) closeSheet(); } }, h('div', { class: 'sheet-panel' }, sheetBody));
  function closeBtn() { const b = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: closeSheet }); b.innerHTML = ICON.close; return b; }
  function closeSheet() { sheet.hidden = true; }
  function openSheet() { buildSheet(); sheet.hidden = false; }

  function buildSheet() {
    const parked = app.isParked();
    const go = (s: Parameters<App['go']>[0]) => () => { closeSheet(); app.go(s); };
    sheetBody.replaceChildren(
      h('div', { class: 'sheet-head' }, h('div', { class: 'sheet-title' }, 'Sound'), closeBtn()),
      h('div', { class: 'field' }, h('div', { class: 'cap' }, 'Car'),
        h('div', { class: 'choices' }, ...app.profiles.map((p) =>
          h('button', { class: 'choice' + (p.id === app.active.id ? ' on' : ''), type: 'button', onclick: () => { app.setActiveProfile(p.id); buildSheet(); } }, p.name)))),
      h('div', { class: 'field' }, h('div', { class: 'cap' }, 'Listen from'),
        segmented<'cabin' | 'bay'>([{ value: 'cabin', label: 'Cabin' }, { value: 'bay', label: 'Engine bay' }], app.settings.cabin ? 'cabin' : 'bay', (v) => app.setCabin(v === 'cabin')).el),
      h('div', { class: 'field' }, h('div', { class: 'cap' }, 'Intensity'),
        segmented<'sport' | 'full'>([{ value: 'sport', label: 'Subtle' }, { value: 'full', label: 'Full' }], app.settings.mode === 'sport' ? 'sport' : 'full', (m) => { lastLoud = m; app.setMode(m); }).el),
      h('div', { class: 'sheet-links' },
        h('button', { class: 'btn', type: 'button', disabled: !parked, onclick: go('setup') }, 'Settings'),
        h('button', { class: 'btn', type: 'button', disabled: !parked, onclick: go('lab') }, 'Tuning lab'),
        h('button', { class: 'btn', type: 'button', onclick: () => { app.setDim(!app.settings.dim); buildSheet(); } }, app.settings.dim ? 'Undim screen' : 'Dim screen'),
        h('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); app.stopSource(); app.go('start'); } }, 'Stop'),
      ),
      h('div', { class: 'note', hidden: parked }, 'Settings open when the car is stopped.'),
    );
  }

  const main = h('div', { class: 'drive-main' }, gaugeWrap, boost, pad);
  const el = h('section', { id: 'drive', class: 'screen' }, h('div', { class: 'top' }, status, setBtn), banner, main, bar, sheet);

  let lastBoostVar = -1;

  function refresh() {
    pad.style.display = app.source?.kind === 'demo' ? '' : 'none';
    srcLabel.textContent = app.source?.label ?? '';
    const link = app.link;
    const isObd = app.source?.kind === 'obd';
    const demoLike = app.source?.kind === 'demo' || app.source?.kind === 'manual';
    dot.className = 'dot ' + (isObd ? (link.state === 'live' ? 'live' : 'wait') : demoLike ? 'demo' : 'live');
    banner.classList.toggle('hidden', !(isObd && link.state !== 'live'));
    banner.textContent = link.state === 'error' ? 'Adapter problem: ' + link.message : 'Reconnecting…';
    const muted = app.settings.mode === 'mute';
    if (!muted) lastLoud = app.settings.mode;
    muteBtn.innerHTML = muted ? ICON.muted : ICON.speaker;
    muteBtn.classList.toggle('on', muted);
    volInput.value = String(app.settings.master);
    volInput.disabled = muted;
    if (!sheet.hidden) buildSheet();
    gauge.refreshColors();
  }

  function frame() {
    const f = app.frame;
    const s = app.snap;
    const p = app.active;
    const boostBar = s ? Math.max(0, s.boost) : 0;
    const boostN = Math.min(1.2, boostBar / Math.max(0.2, p.turbo.maxBoost));
    gauge.draw({ rpm: f.rpm, redline: p.engine.redline, shaft: s ? s.shaft : 0, boostN, flash: 0, limiting: app.source?.kind === 'demo' && app.demo.limiting });
    rpmNum.textContent = fmt(f.rpm, 0);
    const g = app.gear;
    gearNum.textContent = g === null ? '' : g === 0 ? 'N' : String(g);
    boostFill.style.width = Math.min(100, boostN * 100) + '%';
    boostVal.textContent = fmt(boostBar, 2);
    padFill.style.height = f.pedal * 100 + '%';
    const bv = Math.round(Math.min(1, boostN) * 50) / 50;
    if (bv !== lastBoostVar) {
      lastBoostVar = bv;
      document.documentElement.style.setProperty('--boost', String(bv));
    }
  }

  return { el, frame, refresh };
}
