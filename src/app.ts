// App core: owns the sound engine, the active input source, settings and profiles.
// Screens (src/ui/*) read from here and call back in. No DSP here.

import { AudioEngine } from './audio/engine.ts';
import type { Mode, Snapshot } from './audio/dsp.ts';
import { BASE_PROFILE, setPath, type Profile } from './model/profiles.ts';
import { GearEstimator } from './model/gear.ts';
import type { TurboEvent } from './model/turbo.ts';
import { DemoSource, ManualSource, ReplaySource, type Frame, type Source } from './input/demo.ts';
import { parseCsv } from './input/log.ts';
import { ObdLink } from './obd/link.ts';
import { Exaggerator } from './obd/predictor.ts';
import { BleTransport, bleSupported, pickAdapter, rememberedAdapter } from './obd/ble.ts';
import { MockElm327 } from './obd/mock.ts';
import { loadProfiles, loadSettings, saveProfile, saveSettings, listUserSamples, addUserSample, clearUserSamples, type ProfileSet, type Settings } from './store.ts';
import { keepAwake, goFullscreen } from './platform.ts';

export type Screen = 'start' | 'check' | 'drive' | 'setup' | 'lab' | 'diag';

export interface FlashEvent {
  type: TurboEvent['type'];
  at: number;
}

const BASE = import.meta.env.BASE_URL;

export class App {
  settings: Settings = loadSettings();
  profileSet: ProfileSet = loadProfiles();
  profiles: Profile[] = this.profileSet.profiles;
  active: Profile;
  engine = new AudioEngine();
  link = new ObdLink();
  demo: DemoSource;
  manual = new ManualSource();
  replay: ReplaySource | null = null;
  source: Source | null = null;
  frame: Frame = { rpm: 0, pedal: 0, mapKpa: null, speedKmh: null, gear: null, baro: 101.3, alive: true };
  /** gear shown on screen: from the car/estimator, null when no data (demo) */
  gear: number | null = null;
  snap: Snapshot | null = null;
  lastEvent: FlashEvent | null = null;
  screen: Screen = 'start';
  audioError = '';
  startedAudio = false;
  deviceChanged = false;

  private gearEst: GearEstimator;
  private exag = new Exaggerator();
  private lastPump = performance.now();
  private pumpTimer = 0;
  private lastAlive = true;
  private saveTimer = 0;
  private screenListeners: ((s: Screen) => void)[] = [];
  private changeListeners: (() => void)[] = [];
  userSamples = { bov: [] as Float32Array[], pop: [] as Float32Array[] };

  constructor() {
    this.active = this.profiles.find((p) => p.id === this.settings.activeProfile) ?? this.profiles[0] ?? BASE_PROFILE;
    this.demo = new DemoSource(this.active.engine.idle, this.active.engine.redline);
    this.gearEst = new GearEstimator(this.active.engine);
    this.engine.onState = (s) => {
      this.snap = s;
      this.demo.boostN = Math.min(1, s.boost / Math.max(0.2, this.active.turbo.maxBoost));
    };
    this.engine.onEvent = (e) => {
      this.lastEvent = { type: e.type, at: performance.now() };
    };
    this.engine.onDeviceChange = () => {
      this.deviceChanged = true;
      this.emitChange();
    };
    this.link.onState = () => this.emitChange();
  }

  // ---- change / navigation plumbing -------------------------------------------------------

  onScreen(f: (s: Screen) => void): void {
    this.screenListeners.push(f);
  }
  onChange(f: () => void): void {
    this.changeListeners.push(f);
  }
  private emitChange(): void {
    for (const f of this.changeListeners) f();
  }

  go(s: Screen): void {
    if ((s === 'setup' || s === 'lab' || s === 'diag') && !this.isParked() && s !== 'diag') return;
    this.screen = s;
    for (const f of this.screenListeners) f(s);
  }

  /** Setup and Lab only open at 0 km/h (or when there is no car data: demo, sliders, replay) */
  isParked(): boolean {
    if (this.source?.kind !== 'obd') return true;
    return this.frame.speedKmh === null || this.frame.speedKmh < 1;
  }

  // ---- audio ------------------------------------------------------------------------------

  /** Call from a tap. Starts (or resumes) the audio context. */
  async startAudio(): Promise<boolean> {
    if (this.engine.ctx && this.engine.running) return true;
    try {
      if (this.engine.ctx && this.engine.ctx.state !== 'running') {
        await this.engine.resume();
      } else {
        await this.engine.start(this.active, {
          latencyHint: this.settings.latencyHint,
          master: this.settings.master,
          mode: this.settings.mode,
          headphone: this.settings.headphone,
        });
        await this.restoreUserSamples();
      }
      this.startedAudio = true;
      this.audioError = '';
      keepAwake();
      goFullscreen();
      this.startPump();
      return true;
    } catch (e) {
      this.audioError = e instanceof Error ? e.message : String(e);
      this.emitChange();
      return false;
    }
  }

  private async restoreUserSamples(): Promise<void> {
    const saved = await listUserSamples();
    for (const kind of ['bov', 'pop'] as const) {
      const files = saved.filter((s) => s.kind === kind).map((s) => s.data);
      if (files.length) this.userSamples[kind] = await this.engine.addUserSamples(kind, files, []);
    }
    this.engine.userBov = this.userSamples.bov.length;
    this.engine.userPop = this.userSamples.pop.length;
  }

  /** Add user WAVs. They replace the built-in placeholders for that bank and persist on the phone. */
  async importSamples(kind: 'bov' | 'pop', files: File[]): Promise<number> {
    const bufs: ArrayBuffer[] = [];
    for (const f of files) {
      const data = await f.arrayBuffer();
      bufs.push(data);
      await addUserSample({ kind, name: f.name, data: data.slice(0) });
    }
    this.userSamples[kind] = await this.engine.addUserSamples(kind, bufs, this.userSamples[kind]);
    this.engine.userBov = this.userSamples.bov.length;
    this.engine.userPop = this.userSamples.pop.length;
    this.emitChange();
    return this.userSamples[kind].length;
  }

  async clearSamples(): Promise<void> {
    await clearUserSamples();
    this.userSamples = { bov: [], pop: [] };
    this.engine.userBov = 0;
    this.engine.userPop = 0;
    await this.engine.reloadBuiltinSamples();
    this.emitChange();
  }

  setMode(m: Mode): void {
    this.settings.mode = m;
    this.engine.setMode(m);
    this.persist();
  }
  setMaster(v: number): void {
    this.settings.master = v;
    this.engine.setMaster(v);
    this.persist();
  }
  setHeadphone(on: boolean): void {
    this.settings.headphone = on;
    this.engine.setHeadphone(on);
    this.persist();
  }
  setDim(on: boolean): void {
    this.settings.dim = on;
    document.body.classList.toggle('dim', on);
    this.persist();
  }
  persist(): void {
    saveSettings(this.settings);
  }

  // ---- profiles ---------------------------------------------------------------------------

  setActiveProfile(id: string): void {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return;
    this.active = p;
    this.settings.activeProfile = id;
    if (this.settings.adapterId) this.settings.adapterProfiles[this.settings.adapterId] = id;
    this.persist();
    this.applyProfile(true);
  }

  private applyProfile(irChanged: boolean): void {
    const p = this.active;
    this.engine.setProfile(p);
    if (irChanged) void this.engine.loadIr(p.body.irFile);
    this.demo.configure(p.engine.idle, p.engine.redline);
    this.gearEst.configure(p.engine);
    this.emitChange();
  }

  /** Change one numeric/enum field of the active profile by path ("turbo.tauUp") and apply it live. */
  editProfile(path: string, value: unknown): void {
    setPath(this.active, path, value);
    this.engine.setProfile(this.active);
    if (path === 'body.irFile') void this.engine.loadIr(String(value));
    if (path.startsWith('engine.')) {
      this.demo.configure(this.active.engine.idle, this.active.engine.redline);
      this.gearEst.configure(this.active.engine);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => saveProfile(this.active), 400);
    this.emitChange();
  }

  replaceProfiles(set: ProfileSet): void {
    this.profileSet = set;
    this.profiles = set.profiles;
    const a = this.profiles.find((p) => p.id === this.active.id) ?? this.profiles[0]!;
    this.active = a;
    this.applyProfile(true);
  }

  // ---- sources ----------------------------------------------------------------------------

  private setSource(s: Source | null): void {
    if (this.source?.kind === 'obd' && s?.kind !== 'obd') this.link.stop();
    this.source = s;
    this.exag = new Exaggerator();
    this.gearEst.reset();
    this.gear = null;
    this.engine.setLink(true);
    this.lastAlive = true;
    this.emitChange();
  }

  useDemo(): void {
    this.demo.rpm = this.active.engine.idle;
    this.demo.pedal = 0;
    this.demo.held = false;
    this.setSource(this.demo);
  }

  useManual(): void {
    this.setSource(this.manual);
  }

  async useReplay(text: string, label: string): Promise<void> {
    const rows = parseCsv(text);
    this.replay = new ReplaySource(rows, label);
    this.setSource(this.replay);
  }

  async useBundledReplay(): Promise<void> {
    const r = await fetch(`${BASE}logs/reference.csv`);
    if (!r.ok) throw new Error('reference log not found');
    await this.useReplay(await r.text(), 'Reference drive');
  }

  /** Real adapter over Web Bluetooth. `pick` forces the Chrome picker even if an adapter is remembered. */
  async connectBle(pick: boolean): Promise<void> {
    if (!bleSupported()) throw new Error('This browser has no Web Bluetooth. Use Chrome on Android, or desktop Chrome.');
    let device = pick ? null : await rememberedAdapter(this.settings.adapterId);
    if (!device) device = await pickAdapter();
    this.settings.adapterId = device.id;
    this.settings.adapterName = device.name ?? 'OBD adapter';
    const mapped = this.settings.adapterProfiles[device.id];
    if (mapped) this.setActiveProfile(mapped);
    this.persist();
    const dev = device;
    this.setSource({ kind: 'obd', label: dev.name ?? 'Adapter', tick: (now) => this.obdFrame(now) });
    this.link.start(dev.name ?? 'Adapter', async () => {
      const t = new BleTransport(dev);
      await t.open();
      return t;
    });
  }

  /** Full OBD stack against a pretend ELM327 replaying the reference log */
  async useFakeAdapter(): Promise<void> {
    const r = await fetch(`${BASE}logs/reference.csv`);
    const rows = parseCsv(await r.text());
    this.setSource({ kind: 'obd', label: 'Fake adapter', tick: (now) => this.obdFrame(now) });
    this.link.start('Fake adapter', async () => new MockElm327({ rows, latencyMs: 20, glitches: false }));
  }

  private obdFrame(now: number): Frame {
    const s = this.active.setup;
    const r = this.link.read(now, s.latencyMs, s.throttleIdlePct);
    return { rpm: r.rpm, pedal: r.pedal, mapKpa: r.mapKpa, speedKmh: r.speed, gear: null, baro: r.baro, alive: r.alive };
  }

  stopSource(): void {
    this.setSource(null);
  }

  // ---- the 60 Hz pump: source -> conditioning -> worklet ----------------------------------------

  private startPump(): void {
    if (this.pumpTimer) return;
    this.lastPump = performance.now();
    this.pumpTimer = window.setInterval(() => this.pump(), 16);
  }

  private pump(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastPump) / 1000);
    this.lastPump = now;
    const src = this.source;
    if (!src) return;
    const f = src.tick(now, dt);
    this.frame = f;
    const prof = this.active;

    // gear: from the car/estimator when we have road speed, otherwise unknown (demo has no gears)
    let gear = f.gear;
    if (gear === null && f.speedKmh !== null) gear = this.gearEst.update(f.rpm, f.speedKmh, dt);
    this.gear = gear;

    if (f.alive !== this.lastAlive) {
      this.lastAlive = f.alive;
      this.engine.setLink(f.alive);
    }
    if (!f.alive) return; // audio fades out; do not feed stale numbers

    const rpm = this.exag.apply(f.rpm, prof.setup.rpmExaggeration, prof.engine.idle, dt);
    this.engine.sendInput({ rpm, pedal: f.pedal, mapKpa: f.mapKpa, baroKpa: f.baro, speedKmh: f.speedKmh, gear });
  }
}
