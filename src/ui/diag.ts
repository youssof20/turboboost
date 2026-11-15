// Diagnostics: poll rate, latency, rejected frames, raw OBD log with export, and a raw AT terminal.

import type { App } from '../app.ts';
import { h, download, row } from './dom.ts';
import { pageShell } from './page.ts';
import type { View } from './start.ts';

export function buildDiag(app: App): View {
  const body = h('div', { class: 'page-inner' });
  const shell = pageShell(app, 'Diagnostics', 'diag', body);

  const stats = h('div', { class: 'card' }, h('div', { class: 'ro' }));
  const logBox = h('div', { class: 'log' });
  const termIn = h('input', { type: 'text', placeholder: 'ATI  /  010C  /  ATDP', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Raw command' });
  const termOut = h('div', { class: 'log' }, 'Raw commands go straight to the adapter. Polling is paused while you wait for the reply.');
  let shown = 0;

  async function sendRaw() {
    const cmd = termIn.value.trim();
    if (!cmd) return;
    const elm = app.link.elm;
    if (!elm) {
      termOut.textContent = 'No adapter connected.';
      return;
    }
    termIn.value = '';
    try {
      const lines = await elm.send(cmd, 4000);
      termOut.textContent = `> ${cmd}\n${lines.join('\n')}\n\n` + termOut.textContent;
    } catch (e) {
      termOut.textContent = `> ${cmd}\n${e instanceof Error ? e.message : e}\n\n` + termOut.textContent;
    }
  }
  termIn.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void sendRaw();
  });

  function build() {
    body.replaceChildren(
      h('h2', { class: 'sec' }, 'Link'),
      stats,
      h('h2', { class: 'sec' }, 'Raw OBD log'),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn', type: 'button', onclick: () => { app.link.log.length = 0; shown = -1; } }, 'Clear'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => download('obd-log.txt', app.link.log.map((l) => `${l.t.toFixed(0)}\t${l.dir}\t${l.s}`).join('\n'), 'text/plain'),
        }, 'Export log'),
      ),
      logBox,
      h('h2', { class: 'sec' }, 'Terminal'),
      row('Command', termIn),
      h('div', { class: 'btnrow' }, h('button', { class: 'btn', type: 'button', onclick: () => void sendRaw() }, 'Send')),
      termOut,
    );
    shown = -1;
  }

  function frame() {
    const link = app.link;
    const lat = app.engine.latency();
    const elm = link.elm;
    const ro = stats.firstElementChild!;
    const items: [string, string][] = [
      ['state', link.state + (link.message ? ` (${link.message})` : '')],
      ['adapter', link.name || '–'],
      ['poll rate', elm ? elm.hz().toFixed(0) + ' Hz' : '–'],
      ['reply time', elm ? elm.lastRttMs.toFixed(0) + ' ms' : '–'],
      ['frames ok', elm ? String(elm.frames) : '–'],
      ['unparsed', elm ? String(elm.bad) : '–'],
      ['timeouts', elm ? String(elm.timeouts) : '–'],
      ['rpm rejected', String(link.rawRejected)],
      ['reconnects', String(link.reconnects)],
      ['protocol', elm ? `${elm.protocol} (${elm.isCan ? 'CAN, multi-PID' : 'single PID'})` : '–'],
      ['PIDs', elm ? [...elm.supported].map((p) => p.toString(16).toUpperCase().padStart(2, '0')).join(' ') : '–'],
      ['audio', lat ? `${lat.state}, ${lat.sampleRate} Hz` : 'not started'],
      ['output latency', lat ? `${lat.outputMs.toFixed(0)} ms + ${lat.baseMs.toFixed(0)} ms buffer` : '–'],
      ['latency comp', `${app.active.setup.latencyMs} ms`],
      ['blow-offs', String(app.engine.bovCount)],
      ['pops', String(app.engine.popCount)],
      ['gear', app.gear === null ? 'no data' : app.gear === 0 ? 'N' : String(app.gear)],
      ['speed', app.frame.speedKmh === null ? '–' : app.frame.speedKmh.toFixed(0) + ' km/h'],
    ];
    ro.replaceChildren(...items.map(([k, v]) => h('div', {}, h('b', {}, k), v)));
    if (app.deviceChanged) {
      app.deviceChanged = false;
      ro.append(h('div', {}, h('b', {}, 'output'), 'device changed: latency re-measured above'));
    }
    const log = link.log;
    if (shown !== log.length) {
      shown = log.length;
      logBox.replaceChildren(...log.slice(-120).map((l) => h('div', { class: l.dir }, `${l.dir === 'tx' ? '→' : l.dir === 'rx' ? '←' : '·'} ${l.s}`)));
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  return { el: shell, refresh: build, frame };
}
