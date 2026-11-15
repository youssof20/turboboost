# TurboBoost

Real-time turbo, blow-off, flutter and pop sounds layered over your real engine. A web app for Chrome on Android,
fed by a Bluetooth LE OBD-II adapter, with a synth engine running in an AudioWorklet. Full plan: `TurboBoost — Research & Build Plan.md`.

## Try it without a car
`npm install && npm run dev`, open http://localhost:5173, tap **Demo**, and **hold the big pad** (or Spacebar) to rev.
Release to lift: you get the blow-off while the whine coasts down. No gears in the demo; in a car the gear is shown and used by the sound engine.
**Fake adapter** runs the whole OBD stack against a pretend ELM327 replaying `logs/reference.csv`, gear included.

## Phases
| Phase | Status |
| --- | --- |
| 0 Gear | You: BLE adapter (OBDLink CX / Vgate iCar Pro BLE), USB-C to 3.5 mm dongle + aux cable |
| 1 Synth sandbox | Done: Lab has RPM/pedal sliders, every parameter, live spectrum |
| 2 Demo driving | Done: hold-throttle demo, CSV replay with scrubber, flutter mode, blow-off samples |
| 3 OBD connection | Done, untested on a real car: Web Bluetooth, ELM327 init, multi-PID polling, Hz counter, raw log export, terminal |
| 4 In the car | Built: latency tap test + compensation, wake lock, auto-reconnect, watchdog fade, per-car profile. Needs tuning on real drives |
| 5 Extra layers | Done: supercharger, pops, twin turbo, anti-lag, gear whine, rev-match blips. Granular engine swap not built |
| 6 Optional | Not built (iOS port, CAN sniffer) |

## Samples are placeholders
`public/samples/` holds synthesised blow-offs and pops (`npm run samples`), not recordings. Drop real WAVs over the same names,
or import yours in Lab, to replace them.

## Deploy
Push to `main`; the Action tests, builds and publishes to Pages. One-time: repo Settings -> Pages -> Source: **GitHub Actions**.
Web Bluetooth needs HTTPS, which Pages provides.

## Real-car checklist (every phase)
Connect from cold, drive 10 minutes, kill the adapter, restore it, background the app, return. Set everything up before you drive.

## Commands
`npm run dev | test | render | spectrum | build | check:worklet | ci`
