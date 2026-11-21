// First screen (a button and a status line) and the one-time parked check after connecting.

import type { App } from '../app.ts';
import { h } from './dom.ts';
import { bleSupported } from '../obd/ble.ts';
import { canInstall, onInstallAvailable, promptInstall, isStandalone } from '../platform.ts';

export interface View {
  el: HTMLElement;
  refresh(): void;
  frame?(now: number): void;
}

export function buildStart(app: App): View {
  const status = h('div', { class: 'status-line' });
  const sub = h('div', { class: 'sub' });
  const connect = h('button', { class: 'btn primary xl', type: 'button' }, 'Connect adapter');
  const other = h('button', { class: 'link', type: 'button' }, 'Use a different adapter');
  const demo = h('button', { class: 'btn xl', type: 'button' }, 'Demo');
  const fake = h('button', { class: 'link', type: 'button' }, 'Fake adapter (replays a drive)');
  const install = h('button', { class: 'link', type: 'button', onclick: () => void promptInstall() }, 'Install app');

  const setStatus = (msg: string, err = false) => {
    status.textContent = msg;
    status.classList.toggle('err', err);
  };

  const begin = async (fn: () => Promise<void>) => {
    setStatus('Starting audio…');
    const audio = app.startAudio(); // must be kicked off inside this tap
    try {
      await fn();
      if (!(await audio)) {
        setStatus('Audio could not start: ' + app.audioError, true);
        return;
      }
      app.go(app.settings.checked || app.source?.kind === 'demo' ? 'drive' : 'check');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setStatus(/cancel|chosen/i.test(m) ? 'No adapter chosen.' : m, true);
    }
  };

  connect.addEventListener('click', () => begin(() => app.connectBle(false)));
  other.addEventListener('click', () => begin(() => app.connectBle(true)));
  demo.addEventListener('click', () => begin(async () => app.useDemo()));
  fake.addEventListener('click', () => begin(() => app.useFakeAdapter()));
  onInstallAvailable(() => refresh());

  const el = h(
    'section',
    { id: 'start', class: 'screen on' },
    h('div', { class: 'inner' }, h('div', { class: 'wordmark' }, 'TURBOBOOST'), status, sub, connect, other, demo, fake, install),
  );

  function refresh() {
    const known = app.settings.adapterId !== null;
    const ble = bleSupported();
    connect.textContent = known ? 'Start' : 'Connect adapter';
    sub.textContent = known && app.settings.adapterName ? app.settings.adapterName : '';
    other.style.display = known ? '' : 'none';
    connect.toggleAttribute('disabled', !ble);
    fake.style.display = import.meta.env.DEV || location.search.includes('dev') ? '' : 'none';
    install.style.display = canInstall() && !isStandalone() ? '' : 'none';
    if (!ble && !status.textContent) setStatus('No Web Bluetooth here. Use Chrome on Android or desktop Chrome. Demo works anywhere.', true);
    else if (!status.textContent) setStatus('Ready');
  }
  refresh();
  return { el, refresh };
}

export function buildCheck(app: App): View {
  const live = h('div', { class: 'big-readout' }, 'Connecting…');
  const detail = h('div', { class: 'note' });
  const latency = h('div', { class: 'note' });
  const tapOut = h('div', { class: 'note' });
  const tiles = h('div', { class: 'tiles' });
  const startBtn = h('button', { class: 'btn primary xl', type: 'button' }, 'Start driving');

  const tapBtn = h('button', { class: 'tapbox', type: 'button' }, 'Tap on each click');
  let clickTimes: number[] = [];
  let taps: number[] = [];
  let tapping = false;
  tapBtn.addEventListener('pointerdown', () => {
    if (!tapping) return;
    taps.push(performance.now());
    if (taps.length >= clickTimes.length) finishTap();
  });
  function finishTap() {
    tapping = false;
    const offsets: number[] = [];
    for (const t of taps) {
      let best = clickTimes[0]!;
      for (const c of clickTimes) if (Math.abs(c - t) < Math.abs(best - t)) best = c;
      offsets.push(t - best);
    }
    const tail = offsets.slice(-6).sort((a, b) => a - b);
    const med = tail.length ? tail[Math.floor(tail.length / 2)]! : 0;
    const ms = Math.round(Math.min(400, Math.max(0, med)) / 5) * 5;
    tapOut.textContent = `Measured about ${ms} ms. Saved as latency compensation.`;
    app.editProfile('setup.latencyMs', ms);
    tapBtn.textContent = 'Tap on each click';
  }

  const checkCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row-label' }, 'Audio check'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn', type: 'button', onclick: () => app.engine.playTestTone('left') }, 'Play left'),
      h('button', { class: 'btn', type: 'button', onclick: () => app.engine.playTestTone('right') }, 'Play right'),
    ),
    latency,
    h('div', { class: 'row-hint' }, 'Hear both tones in the car speakers? Then run the tap test: 8 clicks, tap each as you hear it.'),
    h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        clickTimes = app.engine.scheduleClicks(8);
        taps = [];
        tapping = true;
        tapOut.textContent = 'Listen…';
        tapBtn.textContent = 'TAP';
      },
    }, 'Start tap test'),
    tapBtn,
    tapOut,
  );

  startBtn.addEventListener('click', () => {
    app.settings.checked = true;
    app.persist();
    app.go('drive');
  });

  const el = h(
    'section',
    { id: 'check', class: 'screen' },
    h('div', { class: 'pagebar' }, h('h1', {}, 'First run check')),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('div', { class: 'card' }, live, detail),
      checkCard,
      h('h2', { class: 'sec' }, 'Starting profile'),
      tiles,
      startBtn,
      h('div', { class: 'note' }, 'Settings and the Lab open from the drive screen menu when the car is stopped.'),
    )),
  );

  function updateLive() {
    const link = app.link;
    if (link.state === 'live') {
      live.textContent = `Reading ${link.hz().toFixed(0)} Hz, RPM ${app.frame.rpm.toFixed(0)}`;
      detail.textContent = `${link.name}${link.elm?.vin ? ' · VIN ' + link.elm.vin : ''} · protocol ${link.elm?.protocol ?? '?'} · ${link.elm?.supported.size ?? 0} PIDs`;
      detail.classList.remove('err');
    } else if (app.source?.kind === 'demo') {
      live.textContent = 'Demo mode';
      detail.textContent = '';
    } else {
      live.textContent = link.state === 'error' ? 'Adapter problem' : 'Connecting…';
      detail.textContent = link.message;
      detail.classList.toggle('err', link.state === 'error');
    }
  }

  function refresh() {
    const e = app.engine.latency();
    latency.textContent = e ? `Output latency ${e.outputMs.toFixed(0)} ms + buffer ${e.baseMs.toFixed(0)} ms. ${e.hint}` : '';
    tiles.replaceChildren(
      ...app.profiles.map((p) =>
        h('button', { class: 'tile' + (p.id === app.active.id ? ' on' : ''), type: 'button', onclick: () => app.setActiveProfile(p.id) }, h('div', { class: 'n' }, p.name), h('div', { class: 'd' }, p.blurb)),
      ),
    );
    updateLive();
  }
  return { el, refresh, frame: () => updateLive() };
}
