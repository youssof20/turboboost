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
    const lw = R * 0.07;
    const c = this.colors;
    const redlineK = Math.min(1, s.rpm / s.redline);
    const maxK = Math.ceil(s.redline / 1000) * 1000;
    const frac = (rpm: number) => Math.min(1, rpm / maxK);

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

  }
}

