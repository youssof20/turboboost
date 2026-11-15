import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the repo at /turboboost/. Locally and in tests the base is "/".
const base = process.env.TB_BASE ?? (process.env.GITHUB_ACTIONS ? '/turboboost/' : '/');

export default defineConfig({
  base,
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  plugins: [
    VitePWA({
      // new versions install in the background and take over on the next launch (never mid-drive)
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'TurboBoost',
        short_name: 'TurboBoost',
        description: 'Real-time turbo sound layered over your real engine.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#08090b',
        theme_color: '#08090b',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // samples, logs and icons are precached so the app works with no signal in a parking garage
        globPatterns: ['**/*.{js,css,html,wav,json,csv,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
