// Web Bluetooth transport for BLE ELM327 adapters (OBDLink CX, Vgate iCar Pro BLE, most "BLE 4.0" clones).
// Classic-Bluetooth adapters cannot work in a browser: this only speaks Bluetooth Low Energy.

import type { Transport } from './elm327.ts';

type Uuid = number | string;

interface Layout {
  name: string;
  service: Uuid;
  notify: Uuid;
  write: Uuid;
}

/** Known adapter layouts, tried in order. Unknown adapters fall back to scanning for any notify+write pair. */
export const KNOWN_LAYOUTS: Layout[] = [
  { name: 'FFE0/FFE1', service: 0xffe0, notify: 0xffe1, write: 0xffe1 },
  { name: 'FFF0/FFF1/FFF2', service: 0xfff0, notify: 0xfff1, write: 0xfff2 },
  { name: '18F0/2AF0/2AF1', service: 0x18f0, notify: 0x2af0, write: 0x2af1 },
  {
    name: 'OBDLink',
    service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
];

const OPTIONAL_SERVICES: Uuid[] = [...KNOWN_LAYOUTS.map((l) => l.service), 0xfee7, 0xffb0, 0xff00, 0x1101];

export function bleSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export async function pickAdapter(): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES as BluetoothServiceUUID[] });
}

/** Previously-permitted adapter (Chrome's getDevices), so launching the app needs no picker. */
export async function rememberedAdapter(id: string | null): Promise<BluetoothDevice | null> {
  if (!id || !bleSupported() || typeof navigator.bluetooth.getDevices !== 'function') return null;
  try {
    const list = await navigator.bluetooth.getDevices();
    return list.find((d) => d.id === id) ?? null;
  } catch {
    return null;
  }
}

export class BleTransport implements Transport {
  onData: ((chunk: string) => void) | null = null;
  onClose: (() => void) | null = null;
  layoutName = '';
  private device: BluetoothDevice;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private chunk = 20;
  private closing = false;
  private listener = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (dv) this.onData?.(this.decoder.decode(dv));
  };
  private disconnectListener = () => {
    if (!this.closing) this.onClose?.();
  };

  constructor(device: BluetoothDevice) {
    this.device = device;
  }

  get name(): string {
    return this.device.name ?? 'OBD adapter';
  }

  async open(): Promise<void> {
    this.closing = false;
    this.device.addEventListener('gattserverdisconnected', this.disconnectListener);
    const server = await this.device.gatt!.connect();
    let layout: { service: BluetoothRemoteGATTService; notify: BluetoothRemoteGATTCharacteristic; write: BluetoothRemoteGATTCharacteristic; name: string } | null = null;

    for (const l of KNOWN_LAYOUTS) {
      try {
        const svc = await server.getPrimaryService(l.service as BluetoothServiceUUID);
        const notify = await svc.getCharacteristic(l.notify as BluetoothCharacteristicUUID);
        const write = l.write === l.notify ? notify : await svc.getCharacteristic(l.write as BluetoothCharacteristicUUID);
        layout = { service: svc, notify, write, name: l.name };
        break;
      } catch {
        /* try the next known layout */
      }
    }
    if (!layout) layout = await this.scan(server);
    if (!layout) throw new Error('Connected, but no serial characteristics found on this adapter. Is it a Bluetooth LE model?');

    this.layoutName = layout.name;
    this.notifyChar = layout.notify;
    this.writeChar = layout.write;
    this.notifyChar.addEventListener('characteristicvaluechanged', this.listener);
    await this.notifyChar.startNotifications();
  }

  /** Fallback for unknown clones: first characteristic with notify, first with write/writeWithoutResponse. */
  private async scan(server: BluetoothRemoteGATTServer) {
    let services: BluetoothRemoteGATTService[] = [];
    try {
      services = await server.getPrimaryServices();
    } catch {
      return null;
    }
    for (const svc of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await svc.getCharacteristics();
      } catch {
        continue;
      }
      const notify = chars.find((c) => c.properties.notify || c.properties.indicate);
      const write = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (notify && write) return { service: svc, notify, write, name: `scan:${svc.uuid.slice(4, 8)}` };
    }
    return null;
  }

  async write(data: string): Promise<void> {
    const ch = this.writeChar;
    if (!ch) throw new Error('not connected');
    const bytes = this.encoder.encode(data);
    for (let i = 0; i < bytes.length; i += this.chunk) {
      const part = bytes.slice(i, i + this.chunk);
      if (ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === 'function') await ch.writeValueWithoutResponse(part);
      else await ch.writeValue(part);
    }
  }

  close(): void {
    this.closing = true;
    this.notifyChar?.removeEventListener('characteristicvaluechanged', this.listener);
    this.device.removeEventListener('gattserverdisconnected', this.disconnectListener);
    try {
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      /* already gone */
    }
  }
}
