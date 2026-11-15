import './style.css';
import { App, type Screen } from './app.ts';
import { buildStart, buildCheck, type View } from './ui/start.ts';
import { buildDrive } from './ui/drive.ts';
import { buildSetup } from './ui/setup.ts';
import { buildLab } from './ui/lab.ts';
import { buildDiag } from './ui/diag.ts';
import { registerSW } from 'virtual:pwa-register';

const app = new App();
document.body.classList.toggle('dim', app.settings.dim);

const views: Record<Screen, View> = {
  start: buildStart(app),
  check: buildCheck(app),
  drive: buildDrive(app),
  setup: buildSetup(app),
  lab: buildLab(app),
  diag: buildDiag(app),
};
const root = document.getElementById('app')!;
for (const v of Object.values(views)) root.append(v.el);

function show(s: Screen): void {
  for (const [name, v] of Object.entries(views)) v.el.classList.toggle('on', name === s);
  views[s].refresh();
  if (s === 'drive') (views.drive as ReturnType<typeof buildDrive>).refresh();
}
app.onScreen(show);
app.onChange(() => {
  if (app.screen === 'drive' || app.screen === 'start') views[app.screen].refresh();
});
show('start');

function loop(now: number): void {
  const v = views[app.screen];
  if (app.screen !== 'start') v.frame?.(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Updates install in the background and apply on the next launch, never mid-drive.
registerSW({ immediate: true });

// handy for debugging in the console
(window as unknown as { turboboost: App }).turboboost = app;
