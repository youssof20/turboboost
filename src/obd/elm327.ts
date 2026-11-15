// ELM327 driver: init, supported-PID discovery, multi-PID polling, response parsing, timing stats.
// Works on any Transport (BLE in the app, a mock in tests and the fake-adapter mode).

export interface Transport {
  write(data: string): Promise<void>;
  onData: ((chunk: string) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

export interface Sample {
  /** performance.now() when the reply arrived, ms */
  t: number;
  rpm?: number;
  /** accelerator pedal D, 0..1 (PID 49) */
  pedal?: number;
  /** throttle position, 0..1 (PID 11) */
  throttle?: number;
  mapKpa?: number;
  speedKmh?: number;
  load?: number;
  baroKpa?: number;
}

export type LogDir = 'tx' | 'rx' | 'info' | 'err';

/** Bytes of data for each Mode 01 PID we know how to read, and how to turn them into a Sample field. */
const PIDS: Record<number, { len: number; apply: (s: Sample, b: number[]) => void }> = {
  0x04: { len: 1, apply: (s, b) => (s.load = b[0]! / 255) },
  0x0b: { len: 1, apply: (s, b) => (s.mapKpa = b[0]!) },
  0x0c: { len: 2, apply: (s, b) => (s.rpm = (b[0]! * 256 + b[1]!) / 4) },
  0x0d: { len: 1, apply: (s, b) => (s.speedKmh = b[0]!) },
  0x11: { len: 1, apply: (s, b) => (s.throttle = b[0]! / 255) },
  0x33: { len: 1, apply: (s, b) => (s.baroKpa = b[0]!) },
  0x49: { len: 1, apply: (s, b) => (s.pedal = b[0]! / 255) },
};

export const ELM = {
  initTimeoutMs: 2500,
  searchTimeoutMs: 9000,
  pollTimeoutMs: 400,
  /** ATST value in 4 ms units: 0x19 = 100 ms max wait for the ECU */
  atst: 0x19,
  maxPidsPerRequest: 6,
  slowEvery: 5,
  maxConsecutiveTimeouts: 6,
};

export class ElmError extends Error {}

export function parseHexBytes(s: string): number[] | null {
  const t = s.replace(/[^0-9A-Fa-f]/g, '');
  if (t.length < 2 || t.length % 2 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  return out;
}

/**
 * Collapse an ELM327 reply (already split into lines) into the OBD payload bytes.
 * Handles: echo/noise lines, "SEARCHING...", multi-ECU duplicates (first wins), and
 * multi-frame replies formatted as "00A" / "0: 41 0C ..." / "1: ...".
 */
export function payloadFromLines(lines: string[]): number[] | null {
  const clean = lines.map((l) => l.trim().toUpperCase()).filter((l) => l.length > 0);
  // multi-frame: lines beginning "N:"
  const framed = clean.filter((l) => /^[0-9A-F]:/.test(l));
  if (framed.length > 0) {
    framed.sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
    const hex = framed.map((l) => l.slice(2)).join('');
    return parseHexBytes(hex);
  }
  for (const l of clean) {
    if (/[G-Z?]/.test(l.replace(/\s/g, ''))) continue; // SEARCHING..., NO DATA, ?, etc. (not hex)
    if (/^[0-9A-F]{3}$/.test(l)) continue; // byte-count line of a multi-frame reply
    const b = parseHexBytes(l);
    if (b && b.length >= 2) return b;
  }
  return null;
}

/** Decode a Mode 01 response payload (first byte 0x41) into a Sample. Returns null if it is not one. */
export function parseMode01(bytes: number[] | null, t: number): Sample | null {
  if (!bytes || bytes[0] !== 0x41) return null;
  const s: Sample = { t };
  let i = 1;
  let any = false;
  while (i < bytes.length) {
    const pid = bytes[i]!;
    const def = PIDS[pid];
    if (!def) break;
    if (i + 1 + def.len > bytes.length) break;
    def.apply(s, bytes.slice(i + 1, i + 1 + def.len));
    any = true;
    i += 1 + def.len;
  }
  return any ? s : null;
}

/** Supported-PID bitmask reply (PID 00/20/40/...) -> list of PIDs, and whether the next range is supported. */
export function parseSupported(bytes: number[] | null, base: number): { pids: number[]; more: boolean } | null {
  if (!bytes || bytes[0] !== 0x41 || bytes[1] !== base || bytes.length < 6) return null;
  const pids: number[] = [];
  for (let k = 0; k < 4; k++) {
    for (let bit = 0; bit < 8; bit++) {
      if (bytes[2 + k]! & (0x80 >> bit)) pids.push(base + k * 8 + bit + 1);
    }
  }
  return { pids, more: pids.includes(base + 0x20) };
}

export function parseVin(lines: string[]): string | null {
  const b = payloadFromLines(lines);
  if (!b || b[0] !== 0x49 || b[1] !== 0x02) return null;
  const chars = b.slice(3).filter((c) => c >= 0x30 && c <= 0x5a);
  const vin = String.fromCharCode(...chars);
  return vin.length >= 11 ? vin.slice(-17) : null;
}

export class Elm327 {
  readonly t: Transport;
  private log: (dir: LogDir, s: string) => void;
  private now: () => number;
  private buf = '';
  private pending: { resolve: (lines: string[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private closed = false;

  supported = new Set<number>();
  protocol = '';
  isCan = false;
  vin: string | null = null;
  adapterName = '';

  // stats
  frames = 0;
  bad = 0;
  timeouts = 0;
  lastRttMs = 0;
  private frameTimes: number[] = [];
  private consecutiveTimeouts = 0;

  onSample: ((s: Sample) => void) | null = null;
  onStalled: (() => void) | null = null;

  constructor(t: Transport, opts: { log?: (dir: LogDir, s: string) => void; now?: () => number } = {}) {
    this.t = t;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => performance.now());
    t.onData = (chunk) => this.onChunk(chunk);
    t.onClose = () => {
      this.closed = true;
      this.running = false;
      this.fail(new ElmError('closed'));
    };
  }

  /** frames per second over the last second */
  hz(): number {
    const cutoff = this.now() - 1000;
    while (this.frameTimes.length && this.frameTimes[0]! < cutoff) this.frameTimes.shift();
    return this.frameTimes.length;
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('>')) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const lines = raw.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l.length > 0);
      this.log('rx', lines.join(' | '));
      const p = this.pending;
      if (p) {
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(lines);
      }
    }
    if (this.buf.length > 4096) this.buf = this.buf.slice(-512); // runaway garbage guard
  }

  private fail(e: Error): void {
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(e);
    }
  }

  /** Send one command and resolve with its reply lines (echo removed). Commands are serialised. */
  send(cmd: string, timeoutMs: number = ELM.pollTimeoutMs): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      if (this.closed) throw new ElmError('closed');
      const started = this.now();
      const reply = new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending) this.pending = null;
          this.timeouts++;
          reject(new ElmError(`timeout: ${cmd}`));
        }, timeoutMs);
        this.pending = { resolve, reject, timer };
      });
      this.log('tx', cmd);
      try {
        await this.t.write(cmd + '\r');
      } catch (e) {
        this.fail(e instanceof Error ? e : new ElmError('write failed'));
      }
      const lines = await reply;
      this.lastRttMs = this.now() - started;
      return lines.filter((l) => l.toUpperCase() !== cmd.toUpperCase());
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Full init sequence. Throws if the adapter never answers. */
  async init(): Promise<void> {
    this.buf = '';
    this.log('info', 'init');
    const first = await this.send('ATZ', ELM.initTimeoutMs).catch(() => this.send('ATZ', ELM.initTimeoutMs));
    this.adapterName = first.find((l) => /ELM|OBD|STN|V\d/i.test(l)) ?? first.join(' ');
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) await this.send(c, ELM.initTimeoutMs);
    // triggers the protocol search
    const probe = await this.send('0100', ELM.searchTimeoutMs);
    const first01 = parseSupported(payloadFromLines(probe), 0x00);
    if (!first01) throw new ElmError(`No answer from the ECU (is the ignition on?): ${probe.join(' ')}`);
    this.supported = new Set(first01.pids);
    const dpn = await this.send('ATDPN', ELM.initTimeoutMs);
    this.protocol = (dpn[0] ?? '').replace(/^A/i, '');
    this.isCan = /^[6-9A-C]$/i.test(this.protocol);
    // speed: stop adaptive timing, fixed short timeout
    await this.send('ATAT0', ELM.initTimeoutMs).catch(() => {});
    await this.send('ATST' + ELM.atst.toString(16).padStart(2, '0'), ELM.initTimeoutMs).catch(() => {});
    let more = first01.more;
    for (let base = 0x20; more && base <= 0xc0; base += 0x20) {
      const r = await this.send('01' + base.toString(16).padStart(2, '0').toUpperCase(), ELM.pollTimeoutMs * 2).catch(() => []);
      const p = parseSupported(payloadFromLines(r), base);
      if (!p) break;
      p.pids.forEach((x) => this.supported.add(x));
      more = p.more;
    }
    this.log('info', `protocol ${this.protocol} can=${this.isCan} pids=${[...this.supported].map((p) => p.toString(16)).join(',')}`);
    // one-shot reads
    const baro = await this.send('0133').catch(() => []);
    const bs = parseMode01(payloadFromLines(baro), this.now());
    if (bs?.baroKpa !== undefined && this.onSample) this.onSample(bs);
    const vin = await this.send('0902', 4000).catch(() => []);
    this.vin = parseVin(vin);
  }

  private fastPids(): number[] {
    const sup = this.supported;
    const out = [0x0c];
    if (sup.has(0x49)) out.push(0x49);
    else if (sup.size === 0 || sup.has(0x11)) out.push(0x11);
    if (sup.size === 0 || sup.has(0x0d)) out.push(0x0d);
    if (sup.has(0x0b)) out.push(0x0b);
    return out;
  }

  /** Build the request strings for one poll cycle. On CAN everything fast goes in one multi-PID request. */
  buildCycle(cycle: number): string[] {
    const fast = this.fastPids();
    const slow: number[] = [];
    if (cycle % ELM.slowEvery === 0 && this.supported.has(0x04)) slow.push(0x04);
    const hex = (p: number) => p.toString(16).padStart(2, '0').toUpperCase();
    if (this.isCan) {
      const pids = [...fast, ...slow].slice(0, ELM.maxPidsPerRequest);
      return ['01' + pids.map(hex).join('')];
    }
    // non-CAN (K-line, J1850): one PID per request, rpm twice as often
    const order = [0x0c, ...fast.filter((p) => p !== 0x0c), 0x0c, ...slow];
    return order.map((p) => '01' + hex(p));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    let cycle = 0;
    this.consecutiveTimeouts = 0;
    while (this.running && !this.closed) {
      const reqs = this.buildCycle(cycle++);
      for (const req of reqs) {
        if (!this.running) break;
        try {
          const lines = await this.send(req);
          const s = parseMode01(payloadFromLines(lines), this.now());
          if (s) {
            this.frames++;
            this.frameTimes.push(s.t);
            this.consecutiveTimeouts = 0;
            this.onSample?.(s);
          } else {
            this.bad++;
            this.log('err', `unparsed: ${lines.join(' | ')}`);
          }
        } catch (e) {
          if (this.closed) return;
          this.consecutiveTimeouts++;
          if (this.consecutiveTimeouts >= ELM.maxConsecutiveTimeouts) {
            this.consecutiveTimeouts = 0;
            this.onStalled?.();
          }
          this.log('err', e instanceof Error ? e.message : 'error');
        }
      }
    }
  }

  close(): void {
    this.running = false;
    this.closed = true;
    this.t.close();
  }
}
