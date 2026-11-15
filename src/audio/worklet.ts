// AudioWorklet entry: one processor runs every continuous voice (see dsp.ts).
// The main thread only sends small state packets and sample buffers. Nothing here touches the DOM.

import { TurboDSP, DSP, type Mode } from './dsp.ts';
import { BASE_PROFILE, type Profile } from '../model/profiles.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type ToWorklet =
  | { t: 'profile'; profile: Profile }
  | { t: 'in'; rpm: number; pedal: number; mapKpa: number | null; baroKpa: number; speedKmh: number | null; gear: number | null }
  | { t: 'samples'; kind: 'bov' | 'pop'; bufs: Float32Array[] }
  | { t: 'mode'; mode: Mode }
  | { t: 'master'; v: number }
  | { t: 'headphone'; on: boolean }
  | { t: 'link'; alive: boolean }
  | { t: 'start' }
  | { t: 'stop' };

class TurboProcessor extends AudioWorkletProcessor {
  private dsp: TurboDSP;
  private blocks = 0;
  private stateEvery: number;

  constructor() {
    super();
    this.dsp = new TurboDSP(sampleRate, BASE_PROFILE, (Math.random() * 0xffffffff) >>> 0);
    this.stateEvery = Math.max(1, Math.round(sampleRate / 128 / DSP.stateHz));
    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => this.onMessage(ev.data);
  }

  private onMessage(m: ToWorklet): void {
    const d = this.dsp;
    switch (m.t) {
      case 'profile': d.setProfile(m.profile); break;
      case 'in': d.setInput(m); break;
      case 'samples': d.setSamples(m.kind, m.bufs); break;
      case 'mode': d.setMode(m.mode); break;
      case 'master': d.setMaster(m.v); break;
      case 'headphone': d.setHeadphone(m.on); break;
      case 'link': d.setLink(m.alive); break;
      case 'start': d.start(); break;
      case 'stop': d.stop(); break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]!;
    const l = out[0]!;
    const r = out[1] ?? out[0]!;
    this.dsp.process(l, r, l.length);
    if (++this.blocks % this.stateEvery === 0) {
      this.port.postMessage({ t: 'state', s: this.dsp.snapshot() });
      const ev = this.dsp.drainUiEvents();
      for (const e of ev) this.port.postMessage({ t: 'event', e });
    }
    return true;
  }
}

registerProcessor('turbo-processor', TurboProcessor as unknown as new () => AudioWorkletProcessor);
