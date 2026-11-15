// CSV drive logs: t,rpm,pedal,map,speed,gear,expect (only t and rpm are required).

export interface LogRow {
  t: number;
  rpm: number;
  /** 0..1 */
  pedal: number;
  mapKpa: number | null;
  speed: number | null;
  /** true gear if the log has it (for tests); the app estimates gear from rpm and speed instead */
  gear: number | null;
  expect: number;
}

export function parseCsv(text: string): LogRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length < 2) throw new Error('Log needs a header and at least one row');
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const it = idx('t');
  const ir = idx('rpm');
  if (it < 0 || ir < 0) throw new Error('Log header must contain t and rpm');
  const ip = idx('pedal') >= 0 ? idx('pedal') : idx('throttle');
  const im = idx('map');
  const isp = idx('speed');
  const ig = idx('gear');
  const ie = idx('expect');
  const num = (parts: string[], i: number): number | null => {
    if (i < 0) return null;
    const v = parseFloat(parts[i] ?? '');
    return Number.isFinite(v) ? v : null;
  };
  const rows: LogRow[] = [];
  for (let n = 1; n < lines.length; n++) {
    const parts = lines[n]!.split(',');
    const t = num(parts, it);
    const rpm = num(parts, ir);
    if (t === null || rpm === null) continue;
    let pedal = num(parts, ip) ?? 0;
    if (pedal > 1.0001) pedal /= 100; // allow percent
    rows.push({ t, rpm, pedal, mapKpa: num(parts, im), speed: num(parts, isp), gear: num(parts, ig), expect: num(parts, ie) ?? 0 });
  }
  if (rows.length < 2) throw new Error('Log has no usable rows');
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/** linear interpolation of a log at time t (seconds) */
export function sampleLog(rows: LogRow[], t: number, hint = 0): { row: LogRow; index: number } {
  let i = Math.min(Math.max(hint, 0), rows.length - 2);
  while (i > 0 && rows[i]!.t > t) i--;
  while (i < rows.length - 2 && rows[i + 1]!.t <= t) i++;
  const a = rows[i]!;
  const b = rows[i + 1]!;
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const mix = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : x + (y - x) * f);
  return {
    index: i,
    row: {
      t,
      rpm: a.rpm + (b.rpm - a.rpm) * f,
      pedal: a.pedal + (b.pedal - a.pedal) * f,
      mapKpa: mix(a.mapKpa, b.mapKpa),
      speed: mix(a.speed, b.speed),
      gear: f < 0.5 ? a.gear : b.gear,
      expect: a.expect,
    },
  };
}
