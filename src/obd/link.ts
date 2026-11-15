// Keeps one OBD connection alive: connect -> init -> poll, watchdog, reconnect with backoff,
// and turns raw samples into smooth values for the sound engine.

import { Elm327, type LogDir, type Sample, type Transport } from './elm327.ts';
import { Channel, PREDICT, RpmValidator } from './predictor.ts';

export type LinkState = 'idle' | 'connecting' | 'initializing' | 'live' | 'reconnecting' | 'error';

export interface LogLine {
  t: number;
  dir: LogDir;
  s: string;
}

export interface LinkReading {
  alive: boolean;
  rpm: number;
  /** 0..1 */
  pedal: number;
  mapKpa: number | null;
  speed: number | null;
  baro: number;
  hasPedalPid: boolean;
}

export const LINK = {
  backoffMs: [500, 1000, 2000, 4000, 5000],
  logMax: 600,
  /** data older than this is not used for pedal PID preference */
  pedalFreshMs: 600,
};

export class ObdLink {
  state: LinkState = 'idle';
  message = '';
  name = '';
  elm: Elm327 | null = null;
  readonly log: LogLine[] = [];
  onState: ((s: LinkState, msg: string) => void) | null = null;

  private rpm = new Channel(0, 12000);
  private pedal = new Channel(0, 1);
  private throttle = new Channel(0, 1);
  private map = new Channel(0, 400);
  private speed = new Channel(0, 400);
  private validator = new RpmValidator();
  private baro = 101.3;
  private lastFrame = -1e9;
  private lastPedalPid = -1e9;
  private haveMap = false;
  private haveSpeed = false;
  private stopped = true;
  private factory: (() => Promise<Transport>) | null = null;
  private wake: (() => void) | null = null;
  reconnects = 0;
  rawRejected = 0;

  private setState(s: LinkState, msg = ''): void {
    this.state = s;
    this.message = msg;
    this.onState?.(s, msg);
  }

  private addLog = (dir: LogDir, s: string): void => {
    this.log.push({ t: performance.now(), dir, s });
    if (this.log.length > LINK.logMax) this.log.splice(0, this.log.length - LINK.logMax);
  };

  /** Begin (and keep) a connection. The factory is called again on every reconnect. */
  start(name: string, factory: () => Promise<Transport>): void {
    this.stop();
    this.name = name;
    this.factory = factory;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.elm?.close();
    this.elm = null;
    this.setState('idle');
  }

  private reset(): void {
    this.rpm.reset();
    this.pedal.reset();
    this.throttle.reset();
    this.map.reset();
    this.speed.reset();
    this.validator.reset();
    this.lastFrame = -1e9;
    this.haveMap = false;
    this.haveSpeed = false;
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.setState(attempt === 0 ? 'connecting' : 'reconnecting', attempt === 0 ? 'Connecting…' : 'Reconnecting…');
        const transport = await this.factory!();
        if (this.stopped) {
          transport.close();
          return;
        }
        const elm = new Elm327(transport, { log: this.addLog });
        this.elm = elm;
        this.reset();
        elm.onSample = (s) => this.ingest(s);
        const down = new Promise<void>((resolve) => {
          const prevClose = transport.onClose;
          transport.onClose = () => {
            prevClose?.();
            resolve();
          };
          elm.onStalled = () => resolve();
          this.wake = resolve;
        });
        this.setState('initializing', 'Starting adapter…');
        await elm.init();
        this.setState('live', '');
        attempt = 0;
        elm.start();
        await down;
        elm.close();
        if (this.stopped) return;
        this.reconnects++;
        this.addLog('info', 'link lost');
      } catch (e) {
        if (this.stopped) return;
        const msg = e instanceof Error ? e.message : String(e);
        this.addLog('err', msg);
        this.setState('error', msg);
        this.elm?.close();
      }
      this.setState('reconnecting', 'Reconnecting…');
      const wait = LINK.backoffMs[Math.min(attempt, LINK.backoffMs.length - 1)]!;
      attempt++;
      await new Promise<void>((r) => {
        const id = setTimeout(r, wait);
        this.wake = () => {
          clearTimeout(id);
          r();
        };
      });
    }
  }

  private ingest(s: Sample): void {
    const t = s.t;
    if (s.rpm !== undefined) {
      const ok = this.validator.accept(t, s.rpm);
      this.rawRejected = this.validator.rejected;
      if (ok !== null) this.rpm.push(t, ok);
      else return; // do not treat a rejected frame as fresh data
    }
    if (s.pedal !== undefined) {
      this.pedal.push(t, s.pedal);
      this.lastPedalPid = t;
    }
    if (s.throttle !== undefined) this.throttle.push(t, s.throttle);
    if (s.mapKpa !== undefined) {
      this.map.push(t, s.mapKpa);
      this.haveMap = true;
    }
    if (s.speedKmh !== undefined) {
      this.speed.push(t, s.speedKmh);
      this.haveSpeed = true;
    }
    if (s.baroKpa !== undefined) this.baro = s.baroKpa;
    if (s.rpm !== undefined) this.lastFrame = t;
  }

  /** Smoothed, predicted values for this instant. `leadMs` is the audio latency compensation. */
  read(nowMs: number, leadMs: number, throttleIdlePct: number): LinkReading {
    const alive = this.state === 'live' && nowMs - this.lastFrame < PREDICT.watchdogMs;
    const hasPedalPid = this.pedal.has() && nowMs - this.lastPedalPid < LINK.pedalFreshMs;
    let pedal: number;
    if (hasPedalPid) pedal = this.pedal.value(nowMs, leadMs);
    else if (this.throttle.has()) {
      const idle = throttleIdlePct / 100;
      pedal = Math.min(1, Math.max(0, (this.throttle.value(nowMs, leadMs) - idle) / (1 - idle)));
    } else pedal = 0;
    return {
      alive,
      rpm: this.rpm.has() ? this.rpm.value(nowMs, leadMs) : 0,
      pedal,
      mapKpa: this.haveMap ? this.map.value(nowMs, leadMs) : null,
      speed: this.haveSpeed ? this.speed.value(nowMs, 0) : null,
      baro: this.baro,
      hasPedalPid,
    };
  }

  hz(): number {
    return this.elm?.hz() ?? 0;
  }
}
