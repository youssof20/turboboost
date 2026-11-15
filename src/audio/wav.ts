// Minimal WAV reader/writer for the offline render + spectrum scripts and tests (16-bit PCM / 32-bit float).

export interface Wav {
  sampleRate: number;
  channels: Float32Array[];
}

export function parseWav(bytes: Uint8Array): Wav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12;
  let fmt = { format: 1, ch: 1, sr: 44100, bits: 16 };
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= bytes.byteLength) {
    const id = tag(pos);
    const len = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(pos + 8, true), ch: dv.getUint16(pos + 10, true), sr: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = Math.min(len, bytes.byteLength - dataOff);
      break;
    }
    pos += 8 + len + (len & 1);
  }
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  const bps = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bps * fmt.ch));
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const o = dataOff + (i * fmt.ch + c) * bps;
      let v: number;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
      else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else if (fmt.bits === 24) v = (dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608;
      else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`);
      channels[c]![i] = v;
    }
  }
  return { sampleRate: fmt.sr, channels };
}

export function encodeWav16(sampleRate: number, channels: Float32Array[]): Uint8Array {
  const ch = channels.length;
  const n = channels[0]!.length;
  const out = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, n * ch * 2, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      dv.setInt16(44 + (i * ch + c) * 2, Math.round(v * 32767), true);
    }
  }
  return out;
}
