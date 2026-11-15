// Shared shell for the parked pages: a back button, tabs, and a scroll area.

import type { App, Screen } from '../app.ts';
import { h } from './dom.ts';

export function pageShell(app: App, title: string, current: Screen, body: HTMLElement): HTMLElement {
  const tab = (s: Screen, label: string) => h('button', { type: 'button', class: s === current ? 'on' : '', onclick: () => app.go(s) }, label);
  return h(
    'section',
    { id: current, class: 'screen' },
    h(
      'div',
      { class: 'pagebar' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Back to driving', onclick: () => app.go('drive') }, '←'),
      h('h1', {}, title),
      h('div', { class: 'tabs' }, tab('setup', 'Setup'), tab('lab', 'Lab'), tab('diag', 'Diag')),
    ),
    h('div', { class: 'page' }, body),
  );
}
