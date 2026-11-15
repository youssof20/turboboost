// Browser-platform niceties: screen wake lock, fullscreen, install prompt, service worker.

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    /* denied (battery saver): the app keeps working, the screen may sleep */
  }
}

/** Keep the screen on; re-requested whenever the page becomes visible again. */
export function keepAwake(): void {
  wanted = true;
  void acquire();
}

export function allowSleep(): void {
  wanted = false;
  void sentinel?.release();
  sentinel = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void acquire();
});

export function goFullscreen(): void {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let installEvent: InstallPromptEvent | null = null;
const installListeners: (() => void)[] = [];

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallPromptEvent;
  installListeners.forEach((f) => f());
});

export function canInstall(): boolean {
  return installEvent !== null;
}
export function onInstallAvailable(f: () => void): void {
  installListeners.push(f);
}
export async function promptInstall(): Promise<void> {
  const e = installEvent;
  installEvent = null;
  if (e) await e.prompt();
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
}
