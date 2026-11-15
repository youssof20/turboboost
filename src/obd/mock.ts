// A pretend ELM327 that answers like the real thing, replaying a drive log.
// Used for the "Fake adapter" button (full OBD stack with no car) and in tests.

import type { Transport } from './elm327.ts';
import { sampleLog, type LogRow } from '../input/log.ts';

export interface MockOptions {
  rows: LogRow[];
  /** reply delay in ms (a tuned BLE adapter is 20-60 ms) */
  latencyMs?: number;
  /** if true the ECU only supports a subset and uses a non-CAN protocol */
  nonCan?: boolean;
  /** inject occasional garbage replies and RPM spikes */
  glitches?: boolean;
  loop?: boolean;
  now?: () => number;
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();

export class MockElm327 implements Transport {
  onData: ((chunk: string) => void) | null = null;
  onClose: (() => void) | null = null;
  private opts: MockOptions;
  private t0: number;
  private closed = false;
  private buf = '';
  private hint = 0;
  private counter = 0;
  private spikeNext = false;

  constructor(opts: MockOptions) {
    this.opts = opts;
    this.t0 = (opts.now ?? (() => performance.now()))();
  }

  private clock(): number {
    return ((this.opts.now ?? (() => performance.now()))() - this.t0) / 1000;
  }

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.buf += data;
    let i: number;
    while ((i = this.buf.indexOf('\r')) >= 0) {
      const cmd = this.buf.slice(0, i).trim().toUpperCase().replace(/\s/g, '');
      this.buf = this.buf.slice(i + 1);
      const delay = this.opts.latencyMs ?? 25;
      const reply = this.answer(cmd);
      setTimeout(() => {
        if (this.closed || reply === null) return;
        // deliver in 20-byte BLE-sized pieces like a real adapter
        const out = reply + '\r\r>';
        for (let p = 0; p < out.length; p += 20) this.onData?.(out.slice(p, p + 20));
      }, cmd === 'ATZ' ? delay + 50 : delay);
    }
  }

  private row() {
    const { rows, loop } = this.opts;
    const dur = rows[rows.length - 1]!.t - rows[0]!.t;
    let t = this.clock() + rows[0]!.t;
    if (loop !== false && dur > 0) t = rows[0]!.t + (this.clock() % dur);
    const r = sampleLog(rows, Math.min(t, rows[rows.length - 1]!.t), this.hint);
    this.hint = r.index;
    return r.row;
  }

  private pidBytes(pid: number): string | null {
    const r = this.row();
    switch (pid) {
      case 0x0c: {
        let rpm = r.rpm;
        if (this.opts.glitches && this.spikeNext) rpm = 11000;
        return (hex2(Math.floor((rpm * 4) / 256)) + hex2(Math.round(rpm * 4) % 256)).toUpperCase();
      }
      case 0x0d: return r.speed === null ? null : hex2(r.speed);
      case 0x11: return hex2(5 + r.pedal * 95 * 2.55 * 0.9);
      case 0x49: return hex2(r.pedal * 255);
      case 0x0b: return r.mapKpa === null ? null : hex2(r.mapKpa);
      case 0x04: return hex2(40 + r.pedal * 150);
      case 0x33: return hex2(101);
      default: return null;
    }
  }

  private supportedMask(base: number): string {
    // supported: 04 0B 0C 0D 11 (0x00 range), 33 (0x20 range), 49 (0x40 range)
    const sets: Record<number, number[]> = { 0x00: [0x04, 0x0b, 0x0c, 0x0d, 0x11, 0x20], 0x20: [0x33, 0x40], 0x40: [0x49] };
    const pids = (sets[base] ?? []).filter((p) => !(this.opts.nonCan && p === 0x49));
    let mask = 0;
    for (const p of pids) mask |= 1 << (32 - (p - base));
    const m = mask >>> 0;
    return hex2(m >>> 24) + hex2((m >>> 16) & 255) + hex2((m >>> 8) & 255) + hex2(m & 255);
  }

  private answer(cmd: string): string | null {
    this.counter++;
    if (this.opts.glitches) this.spikeNext = this.counter % 41 === 0;
    if (this.opts.glitches && this.counter % 53 === 0) return 'NO DATA';
    if (cmd === 'ATZ') return '\r\rELM327 v1.5';
    if (cmd.startsWith('AT')) return cmd === 'ATDPN' ? (this.opts.nonCan ? 'A5' : 'A6') : 'OK';
    if (cmd === '0902') return 'NO DATA';
    if (/^01(00|20|40|60|80|A0|C0)$/.test(cmd)) {
      const base = parseInt(cmd.slice(2), 16);
      if (base > 0x40) return 'NO DATA';
      return `${cmd === '0100' ? 'SEARCHING...\r' : ''}41${hex2(base)}${this.supportedMask(base)}`;
    }
    if (/^01([0-9A-F]{2})+$/.test(cmd)) {
      const pids: number[] = [];
      for (let i = 2; i < cmd.length; i += 2) pids.push(parseInt(cmd.slice(i, i + 2), 16));
      if (this.opts.nonCan && pids.length > 1) return '?';
      let body = '41';
      let any = false;
      for (const p of pids) {
        const b = this.pidBytes(p);
        if (b === null) continue;
        body += hex2(p) + b;
        any = true;
      }
      if (!any) return 'NO DATA';
      // multi-frame formatting for replies over 7 bytes, as a CAN ELM327 with headers off prints it
      const bytes = body.match(/../g)!;
      if (bytes.length > 7) {
        const lenLine = bytes.length.toString(16).toUpperCase().padStart(3, '0');
        const first = bytes.slice(0, 6).join(' ');
        const rest = bytes.slice(6);
        const lines = [`${lenLine}`, `0: ${first}`];
        for (let k = 0, n = 1; k < rest.length; k += 7, n++) lines.push(`${n}: ${rest.slice(k, k + 7).join(' ')}`);
        return lines.join('\r');
      }
      return bytes.join(' ');
    }
    return '?';
  }

  close(): void {
    this.closed = true;
  }
}
