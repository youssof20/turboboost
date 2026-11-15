// The one canvas: RPM arc, inner boost arc, shaft-speed glow. Everything else is plain DOM.

export interface GaugeState {
  rpm: number;
  redline: number;
  /** 0..1 */
  shaft: number;
  /** boost as fraction of the profile's max boost, 0..1.2 */
  boostN: number;
  /** 0..1 flash on blow-off */
  flash: number;
  limiting: boolean;
}

const START = Math.PI * 0.75; // 135 deg
const SWEEP = Math.PI * 1.5; // 270 deg

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Gauge {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private colors = { text: '#f4f5f7', dim: '#8a919c', track: '#1c2027', accent: '#ffa64d', accentDeep: '#7a3a00' };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  refreshColors(): void {
    this.colors = {
      text: css('--text') || this.colors.text,
      dim: css('--dim') || this.colors.dim,
      track: css('--track') || this.colors.track,
      accent: css('--accent-hi') || this.colors.accent,
      accentDeep: css('--accent-lo') || this.colors.accentDeep,
    };
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);
  }

  draw(s: GaugeState): void {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = (Math.min(w, h) / 2) * 0.94;
    const lw = R * 0.115;
    const c = this.colors;
    const redlineK = Math.min(1, s.rpm / s.redline);
    const maxK = Math.ceil(s.redline / 1000) * 1000;
    const frac = (rpm: number) => Math.min(1, rpm / maxK);

    // shaft-speed glow: the only decoration, brighter with boost
    const glow = Math.min(1, s.shaft * 0.6 + s.boostN * 0.5 + s.flash * 0.6);
    if (glow > 0.01) {
      const g = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.04);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.8, hexA(c.accentDeep, 0.1 + glow * 0.35));
      g.addColorStop(1, hexA(c.accent, glow * 0.55));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.04, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineCap = 'butt';
    // track
    ctx.lineWidth = lw;
    ctx.strokeStyle = c.track;
    ctx.beginPath();
    ctx.arc(cx, cy, R - lw / 2, START, START + SWEEP);
    ctx.stroke();

    // redline zone (brighter track segment)
    ctx.strokeStyle = s.limiting ? c.text : c.dim;
    ctx.globalAlpha = s.limiting ? 0.9 : 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, R - lw / 2, START + SWEEP * frac(s.redline * 0.92), START + SWEEP * frac(s.redline));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // rpm value arc
    if (redlineK > 0.002) {
      ctx.strokeStyle = c.text;
      ctx.beginPath();
      ctx.arc(cx, cy, R - lw / 2, START, START + SWEEP * frac(s.rpm));
      ctx.stroke();
    }

    // ticks + labels every 1000 rpm
    ctx.fillStyle = c.dim;
    ctx.strokeStyle = c.dim;
    ctx.font = `800 ${Math.round(R * 0.095)}px ${css('--font') || 'system-ui'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k * 1000 <= maxK; k++) {
      const a = START + SWEEP * frac(k * 1000);
      const r1 = R - lw - R * 0.02;
      const r2 = R - lw - R * 0.075;
      ctx.lineWidth = Math.max(2, R * 0.012);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
      const rl = R - lw - R * 0.15;
      ctx.fillText(String(k), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
    }

    // inner boost arc (accent, brighter as boost rises)
    const ri = R * 0.58;
    const lwi = R * 0.055;
    ctx.lineWidth = lwi;
    ctx.strokeStyle = c.track;
    ctx.beginPath();
    ctx.arc(cx, cy, ri, START, START + SWEEP);
    ctx.stroke();
    const b = Math.min(1.2, Math.max(0, s.boostN));
    if (b > 0.004) {
      ctx.strokeStyle = mix(c.accentDeep, c.accent, Math.min(1, b));
      ctx.beginPath();
      ctx.arc(cx, cy, ri, START, START + (SWEEP * Math.min(1, b)));
      ctx.stroke();
    }
  }
}

function parse(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0];
}
function hexA(hex: string, a: number): string {
  const [r, g, b] = parse(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
}
