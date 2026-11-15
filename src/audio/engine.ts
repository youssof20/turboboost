// Main-thread side of the sound engine: AudioContext, worklet, routing, sample loading, test tones.
// No DSP math here (that lives in the worklet). Parameters are only sent as messages.

import workletUrl from './worklet.ts?worker&url';
import type { Mode, Snapshot } from './dsp.ts';
import type { Profile } from '../model/profiles.ts';
import type { ToWorklet } from './worklet.ts';
import type { TurboEvent } from '../model/turbo.ts';

const BASE = import.meta.env.BASE_URL;

export interface LatencyInfo {
  sampleRate: number;
  baseMs: number;
  outputMs: number;
  state: string;
  hint: string;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  analyser: AnalyserNode | null = null;
  onState: ((s: Snapshot) => void) | null = null;
  onEvent: ((e: TurboEvent) => void) | null = null;
  onDeviceChange: (() => void) | null = null;
  lastSnapshot: Snapshot | null = null;
  bovCount = 0;
  popCount = 0;
  userBov = 0;
  userPop = 0;
  private sum: GainNode | null = null;
  private wet: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private synthGain: GainNode | null = null;
  private refGain: GainNode | null = null;
  private refEl: HTMLAudioElement | null = null;
  private starting: Promise<void> | null = null;
  private currentProfile: Profile | null = null;

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture (autoplay rules). Safe to call twice. */
  start(profile: Profile, opts: { latencyHint?: 'interactive' | 'zero'; master: number; mode: Mode; headphone: boolean }): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart(profile, opts).catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async doStart(profile: Profile, opts: { latencyHint?: 'interactive' | 'zero'; master: number; mode: Mode; headphone: boolean }): Promise<void> {
    const ctx = new AudioContext({ latencyHint: opts.latencyHint === 'zero' ? 0 : 'interactive' });
    this.ctx = ctx;
    // resume inside the gesture, before any await that could lose it
    const resumed = ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(ctx, 'turbo-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (ev) => {
      const d = ev.data as { t: 'state'; s: Snapshot } | { t: 'event'; e: TurboEvent };
      if (d.t === 'state') {
        this.lastSnapshot = d.s;
        this.onState?.(d.s);
      } else if (d.t === 'event') {
        if (d.e.type === 'bov') this.bovCount++;
        if (d.e.type === 'pop' || d.e.type === 'bang') this.popCount++;
        this.onEvent?.(d.e);
      }
    };

    this.synthGain = ctx.createGain();
    this.sum = ctx.createGain();
    this.wet = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.refGain = ctx.createGain();
    this.refGain.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;

    // worklet -> synthGain -> (dry) sum ; -> convolver -> wet -> sum ; sum -> destination (+ analyser)
    this.node.connect(this.synthGain);
    this.synthGain.connect(this.sum);
    this.synthGain.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.wet.connect(this.sum);
    this.refGain.connect(this.sum);
    this.sum.connect(ctx.destination);
    this.sum.connect(this.analyser);

    this.setProfile(profile);
    this.post({ t: 'mode', mode: opts.mode });
    this.post({ t: 'master', v: opts.master });
    this.post({ t: 'headphone', on: opts.headphone });

    await resumed;
    await Promise.all([this.loadSamples(), this.loadIr(profile.body.irFile)]);
    this.post({ t: 'start' });

    if ('mediaDevices' in navigator) navigator.mediaDevices.addEventListener('devicechange', () => this.onDeviceChange?.());
    this.setupMediaSession();
  }

  private post(m: ToWorklet, transfer?: Transferable[]): void {
    this.node?.port.postMessage(m, transfer ?? []);
  }

  private setupMediaSession(): void {
    // Tells Android this is media, which keeps the audio thread alive with the screen dimmed.
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'TurboBoost', artist: 'Turbo sound engine' });
    navigator.mediaSession.playbackState = 'playing';
  }

  // ---- samples ----------------------------------------------------------------------------

  private async decode(buf: ArrayBuffer): Promise<Float32Array> {
    const ab = await this.ctx!.decodeAudioData(buf);
    // fold to mono
    const out = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i]! += d[i]! / ab.numberOfChannels;
    }
    return out;
  }

  private async fetchBuf(url: string): Promise<ArrayBuffer> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  }

  private async loadSamples(): Promise<void> {
    try {
      const man = (await (await fetch(`${BASE}samples/manifest.json`)).json()) as { bov: string[]; pop: string[] };
      for (const kind of ['bov', 'pop'] as const) {
        const bufs: Float32Array[] = [];
        for (const name of man[kind]) {
          try {
            bufs.push(await this.decode(await this.fetchBuf(`${BASE}samples/${name}.wav`)));
          } catch {
            /* a missing file just means one fewer variation */
          }
        }
        this.post({ t: 'samples', kind, bufs }, bufs.map((b) => b.buffer));
      }
    } catch {
      /* no samples: the synth blow-off covers it */
    }
  }

  /** Add user WAV/MP3 files to the blow-off or pop bank (kept for this session; the Lab persists them). */
  async addUserSamples(kind: 'bov' | 'pop', files: ArrayBuffer[], existing: Float32Array[]): Promise<Float32Array[]> {
    const all = existing.slice();
    for (const f of files) {
      try {
        all.push(await this.decode(f.slice(0)));
      } catch {
        /* skip undecodable files */
      }
    }
    this.post({ t: 'samples', kind, bufs: all.map((b) => b.slice()) });
    return all;
  }

  /** replace a bank with the built-in set again */
  async reloadBuiltinSamples(): Promise<void> {
    await this.loadSamples();
  }

  async loadIr(file: string): Promise<void> {
    if (!this.ctx || !this.convolver) return;
    let buf: AudioBuffer | null = null;
    if (file) {
      try {
        buf = await this.ctx.decodeAudioData(await this.fetchBuf(`${BASE}samples/${file}`));
      } catch {
        buf = null;
      }
    }
    if (!buf) buf = this.syntheticIr();
    this.convolver.buffer = buf;
  }

  async loadIrBytes(bytes: ArrayBuffer): Promise<void> {
    if (!this.ctx || !this.convolver) return;
    this.convolver.buffer = await this.ctx.decodeAudioData(bytes);
  }

  private syntheticIr(): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.round(ctx.sampleRate * 0.15);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += ((Math.random() * 2 - 1) - lp) * 0.35;
      d[i] = lp * Math.exp(-i / (ctx.sampleRate * 0.04));
    }
    d[0] = 1;
    return b;
  }

  // ---- control ----------------------------------------------------------------------------

  setProfile(p: Profile): void {
    this.currentProfile = p;
    this.post({ t: 'profile', profile: structuredClone(p) });
    if (this.ctx && this.wet) this.wet.gain.setTargetAtTime(p.body.irWet, this.ctx.currentTime, 0.05);
  }

  profileFile(): string {
    return this.currentProfile?.body.irFile ?? '';
  }

  sendInput(i: { rpm: number; pedal: number; mapKpa: number | null; baroKpa: number; speedKmh: number | null; gear: number | null }): void {
    this.post({ t: 'in', ...i });
  }

  setMode(m: Mode): void {
    this.post({ t: 'mode', mode: m });
  }
  setMaster(v: number): void {
    this.post({ t: 'master', v });
  }
  setHeadphone(on: boolean): void {
    this.post({ t: 'headphone', on });
  }
  setLink(alive: boolean): void {
    this.post({ t: 'link', alive });
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }
  async resume(): Promise<void> {
    await this.ctx?.resume();
  }

  // ---- diagnostics / latency --------------------------------------------------------------

  latency(): LatencyInfo | null {
    const c = this.ctx;
    if (!c) return null;
    const out = (c as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const total = (c.baseLatency + out) * 1000;
    return {
      sampleRate: c.sampleRate,
      baseMs: c.baseLatency * 1000,
      outputMs: out * 1000,
      state: c.state,
      hint: total > 120 ? 'High output latency. Bluetooth audio detected or likely: use the aux cable.' : 'Looks like a wired or built-in output.',
    };
  }

  /** Left/right 1 kHz test tone */
  playTestTone(side: 'left' | 'right' | 'both'): void {
    const c = this.ctx;
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const p = c.createStereoPanner();
    o.frequency.value = 1000;
    p.pan.value = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    const t = c.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.02);
    g.gain.setValueAtTime(0.25, t + 0.45);
    g.gain.linearRampToValueAtTime(0, t + 0.5);
    o.connect(g).connect(p).connect(c.destination);
    o.start(t);
    o.stop(t + 0.55);
  }

  /**
   * Latency tap test: plays `beats` clicks 0.8 s apart; returns each click's expected audible time on the
   * performance clock (ms) so the UI can compare with the user's taps.
   */
  scheduleClicks(beats: number): number[] {
    const c = this.ctx;
    if (!c) return [];
    const ts = c.getOutputTimestamp();
    const ctxNow = ts.contextTime ?? c.currentTime;
    const perfNow = ts.performanceTime ?? performance.now();
    const buf = c.createBuffer(1, Math.round(c.sampleRate * 0.03), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.4) * Math.exp(-i / (c.sampleRate * 0.006)) * 0.6;
    const times: number[] = [];
    const start = c.currentTime + 0.6;
    for (let i = 0; i < beats; i++) {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const at = start + i * 0.8;
      src.start(at);
      times.push(perfNow + (at - ctxNow) * 1000);
    }
    return times;
  }

  // ---- A/B reference clip -----------------------------------------------------------------

  loadReference(file: File): void {
    const c = this.ctx;
    if (!c || !this.refGain) return;
    if (this.refEl) {
      this.refEl.pause();
      URL.revokeObjectURL(this.refEl.src);
    }
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    this.refEl = el;
    if (!this.refSource) {
      this.refSource = c.createMediaElementSource(el);
      this.refSource.connect(this.refGain);
    }
  }
  private refSource: MediaElementAudioSourceNode | null = null;

  referencePlaying(): boolean {
    return !!this.refEl && !this.refEl.paused;
  }
  async referenceToggle(): Promise<boolean> {
    if (!this.refEl) return false;
    if (this.refEl.paused) await this.refEl.play();
    else this.refEl.pause();
    return !this.refEl.paused;
  }
  setAB(mode: 'synth' | 'ref' | 'both'): void {
    const c = this.ctx;
    if (!c || !this.synthGain || !this.refGain) return;
    const t = c.currentTime;
    this.synthGain.gain.setTargetAtTime(mode === 'ref' ? 0 : 1, t, 0.02);
    this.refGain.gain.setTargetAtTime(mode === 'synth' ? 0 : 1, t, 0.02);
  }
}
