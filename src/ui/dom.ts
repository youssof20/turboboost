// Tiny DOM helpers and reusable controls. No framework, no component library.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: any) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function clear(e: Element): void {
  while (e.firstChild) e.removeChild(e.firstChild);
}

export function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

// ---- controls ---------------------------------------------------------------------------------

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(v: T): void;
}

/** Big touch-friendly segmented choice. */
export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, cls = ''): Segmented<T> {
  const el = h('div', { class: 'seg ' + cls, role: 'radiogroup' });
  const buttons = new Map<T, HTMLButtonElement>();
  const set = (v: T) => {
    for (const [k, b] of buttons) {
      b.classList.toggle('on', k === v);
      b.setAttribute('aria-checked', String(k === v));
    }
  };
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'radio', onclick: () => { set(o.value); onChange(o.value); } }, o.label);
    buttons.set(o.value, b);
    el.append(b);
  }
  set(value);
  return { el, set };
}

export interface Stepper {
  el: HTMLElement;
  set(v: number): void;
}

/** − value + with big buttons. */
export function stepper(opts: { value: number; min: number; max: number; step: number; digits?: number; unit?: string; onChange: (v: number) => void }): Stepper {
  const digits = opts.digits ?? 0;
  let v = opts.value;
  const out = h('output', { class: 'step-val' });
  const render = () => {
    out.textContent = v.toFixed(digits) + (opts.unit ? ' ' + opts.unit : '');
  };
  const bump = (dir: number) => {
    const next = Math.min(opts.max, Math.max(opts.min, Math.round((v + dir * opts.step) / opts.step) * opts.step));
    v = +next.toFixed(6);
    render();
    opts.onChange(v);
  };
  const el = h(
    'div',
    { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'decrease', onclick: () => bump(-1) }, '−'),
    out,
    h('button', { type: 'button', 'aria-label': 'increase', onclick: () => bump(1) }, '+'),
  );
  render();
  return {
    el,
    set(n: number) {
      v = n;
      render();
    },
  };
}

export interface Slider {
  el: HTMLElement;
  set(v: number): void;
}

/** Slider with numeric readout and double-tap to reset. */
export function slider(opts: { label: string; value: number; def: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }): Slider {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(opts.step))));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step });
  input.value = String(opts.value);
  const out = h('output', { class: 'slider-val' });
  const show = () => {
    out.textContent = (+input.value).toFixed(decimals) + (opts.unit ? ' ' + opts.unit : '');
  };
  input.addEventListener('input', () => {
    show();
    opts.onChange(+input.value);
  });
  const reset = () => {
    input.value = String(opts.def);
    show();
    opts.onChange(opts.def);
  };
  input.addEventListener('dblclick', reset);
  let lastTap = 0;
  input.addEventListener('pointerup', () => {
    const n = performance.now();
    if (n - lastTap < 320) reset();
    lastTap = n;
  });
  show();
  const el = h('label', { class: 'slider' }, h('span', { class: 'slider-label' }, opts.label), input, out);
  return {
    el,
    set(v: number) {
      input.value = String(v);
      show();
    },
  };
}

export function row(label: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-label' }, label), hint ? h('div', { class: 'row-hint' }, hint) : null), control);
}

export function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}
