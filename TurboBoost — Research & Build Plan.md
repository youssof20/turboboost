# TurboBoost — Research & Build Plan

Nov 12, 2026 · @cheeseburger

## Verdict

Build a web app that runs in Chrome on an Android phone. Feed it from a Bluetooth Low Energy OBD-II adapter, and generate the turbo with your own synth engine, not a sample pack. Send the audio to the car by **wire**, not Bluetooth. Your real engine already makes the engine sound; the app only adds layers on top (turbo, blow-off valve, flutter, pops). That makes the problem much smaller than "simulate a supercar."

| Decision | Pick | Why |
| --- | --- | --- |
| Platform | Web app (PWA) in Chrome on Android | Fastest to build and iterate with Claude Code; Web Bluetooth + Web Audio are built in; no app store. iPhone → see Platform. |
| Adapter | BLE OBD-II (e.g. OBDLink CX, Vgate iCar Pro BLE) | The browser can only talk to Bluetooth **LE** devices. Cheap classic-Bluetooth ELM327 clones won't work. |
| Inputs | RPM + throttle/pedal + MAP (boost) | RPM sets pitch, throttle lift triggers the blow-off, MAP gives real boost if your car is turbo. |
| Turbo sound | Procedural synth (oscillators + filtered noise) driven by a virtual turbo model | A turbo is a lagging spinning wheel plus air. A few parameters describe it completely, and a synth follows it exactly. |
| Blow-off "pssh", pops | 6–10 real recorded one-shots, randomized, scaled by boost | Real valve character is hard to synthesize; one-shots don't need to track RPM. |
| Audio out | Aux / USB-C DAC into the head unit | Bluetooth audio adds 100–300 ms of lag, which kills the sync. |

The one open question that changes the plan: **Android or iPhone?** Everything below assumes Android unless noted.

## What we're mimicking (the real physics)

A turbo is an exhaust-driven turbine spinning a compressor wheel at 100,000–250,000 rpm. Every sound it makes comes from four things: how fast the shaft spins, how much air moves, how much pressure is stored, and what happens to that pressure when you lift. The research literature splits turbo noise into the same parts.

| Sound | What causes it | Frequency (measured) | What drives it in our model |
| --- | --- | --- | --- |
| Whistle / whine | Compressor blades passing the housing (blade-pass frequency, BPF = blades × shaft rpm ÷ 60) plus imbalance tones | Imbalance whistle 1.2–4.5 kHz; rotating noise up to 13 kHz; ported-shroud BPF tones around 10 kHz | Shaft speed |
| Buzz-saw | Shock waves at the blade tips at high speed, at multiples of shaft rotation | Shaft-order harmonics, appears near max speed | Shaft speed, only near full boost |
| Whoosh | Broadband flow separation off the blades, worst near surge | 1–4 kHz broadband | Airflow × throttle |
| Tip-clearance noise | Air leaking over blade tips | Around half the BPF (3–4 kHz in one study) | Shaft speed (optional detail) |
| Blow-off "pssh" | Valve vents boost when the throttle closes | Broadband hiss burst | Boost at the moment of lift |
| Flutter ("stu-tu-tu") | Compressor surge: no valve, so pressurized air pushes back through the still-spinning wheel in pulses | Pulsed; one rig measured surge content at 3.25 kHz | Boost at lift, decaying |

Key facts for the synth:

- **The real blade-pass tone is mostly ultrasonic.** With 12 blades at 150,000 rpm it would be 30 kHz. The whine you hear is lower tones and harmonics. So we map shaft speed to a perceptual range of about 1.5–8 kHz rather than copying physics literally.
- **Lag is inertia.** The wheel can't change speed instantly. Spool-up takes roughly 0.5–1.5 s and it coasts down for 1–3 s after lift. This lag is the most important thing to get right; it's what makes it sound real.
- **Boost scales with shaft speed squared.** Compressor pressure ratio rises roughly with the square of wheel speed, so boost comes on late, then fast.
- **Flutter and blow-off are alternatives.** A blow-off valve exists to *prevent* surge. Flutter is what you hear without one. Offer both as a setting.
- **Engine firing frequency** (for other layers): f = rpm ÷ 60 × cylinders ÷ 2 for a four-stroke. A 4-cylinder at 3,000 rpm fires at 100 Hz.

## What already exists

This idea has been done, in pieces, for 15 years. None of the existing products gives you a tunable, physically modeled turbo, and that's the gap worth building into.

| Product | How it works | What to steal / avoid |
| --- | --- | --- |
| [SoundRacer](https://www.edaboard.com/threads/soundracer-v8-v10-v12.245727/?amp=1) | Plug into the 12 V socket; reads RPM from alternator electrical noise; multiplies RPM rises for drama; sends audio over an FM transmitter | Proves RPM can be sensed without OBD, but reviewers report unreliable calibration and confusion at highway speeds. Steal the "exaggerate RPM changes" idea as a setting. |
| [RevHeadz Engine Sounds](https://dcmpx.remotevs.com/au/com/revheadz/www/PL) | Large sample-based app (Android + iOS) with OBD-II mode over Wi-Fi or Bluetooth; models gears, load, backfire, turbo | The benchmark for engine swaps. Turbo is an add-on, not the focus. |
| [OBD SOUND](https://apps.apple.com/app/id960839379) (iOS) | Wi-Fi ELM327 → engine sound + optional turbo toggle; recommends aux, Bluetooth or FM out | Low ratings (2.5–2.6); shows the hard part is responsiveness, not having sounds. |
| OEM Active Sound Design (BMW, VW Soundaktor, Ford, Acura) | Car's own computer plays sound through cabin speakers using RPM, throttle, gear and drive mode; BMW picks recordings by load and RPM | Same architecture we're building: live engine data → layered sound → cabin speakers. Validates the approach. |
| Racing-game audio (Forza, Wwise + Crankcase REV, AudioMotors/FMOD) | Crossfaded RPM loops or granular synthesis of recorded engine cycles | Granular is the right method *if* you later want a full engine swap. |
| [Engine Simulator](https://github.com/ange-yaghi/engine-sim) by AngeTheGreat | Physics simulation of the whole engine at \~80,000 steps/s, then convolution for exhaust acoustics | Amazing sound, but CPU-heavy and Windows-only. Use it to render reference loops, not at runtime on a phone. |

## Platform: web app vs native

On Android, a web app is the better choice: it's as capable as native here and much faster to build. On iPhone, go native.

|  | Web app (Chrome, Android) | Native iOS (Swift) | Native Android (Kotlin) |
| --- | --- | --- | --- |
| Bluetooth LE to adapter | Web Bluetooth, built in | CoreBluetooth | Android BLE API |
| Real-time audio | Web Audio + AudioWorklet (custom DSP on the audio thread) | AVAudioEngine / AudioUnit | Oboe / AAudio |
| Build + iterate speed | Fastest: save file, reload | Xcode, signing, cable | Android Studio |
| Develop on laptop | Yes — desktop Chrome also has Web Bluetooth, so you can sit in the car with a laptop | Needs Mac | Yes |
| Weak spots | Keep screen on (Wake Lock API); audio may pause in background | None that matter | More boilerplate |

**iPhone:** Safari has no Web Bluetooth, and every iOS browser uses Safari's engine. Workarounds exist (the Bluefy browser, and a 2026 WebBLE Safari extension), so you *could* prototype the web version on iPhone. For a daily-use car tool, write it natively in Swift. The architecture below stays the same; only the Bluetooth and audio layers change.

Practical rule: build the synth as a web page first on any platform. Sound design is 70% of this project, and it's fastest to tune with sliders in a browser.

## Data in: OBD-II over Bluetooth LE

Target 15–30 updates per second of RPM and throttle, then smooth and predict between updates. A stock ELM327 polls slowly, often only a few times a second. Tuned, it gets much faster. One forum user went from \~400 ms for 5 PIDs to about 10 ms per PID by turning off adaptive timing and shortening the timeout.

| PID | Value | Formula | Use |
| --- | --- | --- | --- |
| 01 0C | Engine RPM | (256A + B) ÷ 4 | Whine pitch, everything |
| 01 11 | Throttle position | A × 100 ÷ 255 % | Spool drive, lift detection |
| 01 49 | Accelerator pedal D | A × 100 ÷ 255 % | Better lift trigger on drive-by-wire cars (pedal moves before throttle) |
| 01 0B | Intake manifold pressure (MAP) | A kPa | Real boost = MAP − baro (turbo cars only; on most NA cars it never exceeds baro) |
| 01 33 | Barometric pressure | A kPa | Read once at start |
| 01 04 | Calculated load | A × 100 ÷ 255 % | Spool drive (exhaust energy proxy) |
| 01 0D | Vehicle speed | A km/h | Gear estimate, pops logic |

How to make it fast:

1. Init: `ATZ`, `ATE0` (echo off), `ATL0`, `ATS0` (no spaces), `ATH0`, `ATSP0` (auto protocol), then `ATAT0`/`ATST` with a short timeout once the protocol is known.
2. On CAN cars (most 2008+), ask for several PIDs in one request, e.g. `010C1149` → RPM + throttle + pedal in one round trip.
3. Poll RPM + pedal every cycle; MAP every cycle if turbo; load and speed every 3rd–5th cycle.
4. Timestamp every reply. Measure your real rate in the app and show it on screen.
5. Between samples, extrapolate RPM linearly from the last two readings for up to \~60 ms, then smooth (one-pole filter, \~30–50 ms). Never feed raw stepped values into the synth.

Advanced (later, car-specific): listen to the CAN bus passively (`ATMA` monitor mode, or an ESP32 CAN sniffer). Cars broadcast RPM continuously, often at 50 Hz or more, with no request lag. One DIY builder decoded a BMW's RPM at 50 Hz this way. It needs reverse-engineering your car's message IDs, so leave it for phase 6.

No-OBD fallbacks, ranked: (1) on-screen throttle demo mode, needed anyway for testing; (2) GPS speed + phone accelerometer + your gear ratios to estimate RPM; (3) SoundRacer-style alternator sensing needs extra hardware, so skip it. Microphone pitch tracking of the engine fails once your own speakers are playing.

## Sound out: latency and routing

Total lag from your foot to your ears must stay under \~150 ms or the illusion breaks. Bluetooth audio alone can eat all of that.

| Stage | Typical delay |
| --- | --- |
| OBD request → reply (tuned BLE adapter) | 20–60 ms |
| Smoothing filter | 30–50 ms (offset by prediction) |
| Web Audio output buffer | 10–40 ms |
| **Bluetooth A2DP to head unit** | **100–300 ms, drifting; up to 800 ms on some SBC/AAC systems** |
| Aux cable / USB-C DAC | \~0 ms |

Routing options, best first:

1. **Aux in** (USB-C → 3.5 mm dongle). Lowest lag, zero setup.
2. **USB audio into the head unit**, if it accepts USB audio devices.
3. **FM transmitter.** Low lag, lower quality, works in any car (SoundRacer's route).
4. **Bluetooth**, only with compensation. Measure the lag once with a tap test in the app, then trigger events early (fire the blow-off on pedal lift, before throttle closes) and lead pitch changes by the measured lag.

Good news on speakers: turbo sounds sit at 1–8 kHz, where even cheap door speakers are strong. A full engine swap (V8 rumble at 40–200 Hz) is a different matter and needs a subwoofer to sound convincing.

## Custom synth engine vs a big sample pack

Use a custom engine, with samples only for one-shot events. A sample pack can't follow a turbo, because a turbo's sound depends on its *history*, not just current RPM. The same 4,000 rpm sounds different 0.2 s into a pull, 2 s into a pull, and 0.5 s after a lift. You would need thousands of samples and still end up writing the blending engine. Game audio studios reached the same conclusion and moved to granular and procedural methods.

| Method | Best for | Pros | Cons | Use it? |
| --- | --- | --- | --- | --- |
| Procedural synth (oscillators + filtered noise) | Whine, whoosh, spool, flutter, supercharger | Follows state perfectly, infinitely varied, tiny, fully tweakable | Takes ear-tuning to avoid sounding "synthy" | **Yes — core** |
| One-shot samples (randomized) | Blow-off pssh, pops, bangs, shift crack | Real character instantly | Can't track continuous change | **Yes — events only** |
| Granular synthesis of a recorded RPM ramp | Full engine swap (V8 over your 4-cyl) | Best realism per effort for engines; light CPU at runtime | Needs a clean recorded ramp; some smearing on fast changes | Later, phase 5 |
| Crossfaded fixed-RPM loops | Engine swap, simple version | Easy | Muddy at low RPM, chipmunk at high | Only as a quick prototype |
| Physical engine simulation | Studying engines | Most accurate | Far too heavy for a phone | No (offline reference only) |

Why the synth will sound real: the realism comes from **behavior** (lag, coast-down, boost-scaled venting, tiny pitch wobble), not from timbre. Get the motion right and simple oscillators plus noise sound convincing. Spend your tuning time there. For extra realism, add a short convolution reverb from an impulse response of a real intake pipe, so the synth picks up a real room sound.

## The algorithm: virtual turbo model + DSP graph

Two layers. A **state model** turns car data into turbo state (shaft speed, boost, airflow, events), and a **sound graph** turns that state into audio. Keep them separate so you can tune the physics and the sound independently.

### 1. State model (runs every audio block, \~3 ms)

Inputs: `rpm`, `pedal` (0–1), optionally `mapKpa` and `baroKpa`. Outputs: `shaft` (0–1), `boost` (bar), `flow` (0–1), and events.

```typescript
// --- per-car profile (tune by ear) ---
const P = {
  rpmBoostStart: 2200, rpmFullBoost: 3800, // spool window
  maxBoost: 1.2,          // bar
  tauUp: 0.9,             // s, spool lag (bigger turbo = longer)
  tauDown: 2.2,           // s, coast-down after lift
  bovThreshold: 0.35,     // bar needed to fire a blow-off
  liftRate: -2.5,         // pedal units/s that counts as a lift
  mode: 'bov' as 'bov' | 'flutter',
};

function step(s: State, inp: Input, dt: number) {
  // exhaust energy available to drive the turbine
  const spool = smoothstep(P.rpmBoostStart, P.rpmFullBoost, inp.rpm);
  const drive = spool * (0.15 + 0.85 * inp.pedal);          // 0..1

  // shaft inertia: fast-ish up, slow down (freewheeling)
  const tau = drive > s.shaft ? P.tauUp : P.tauDown;
  s.shaft += (drive - s.shaft) * (1 - Math.exp(-dt / tau));

  // boost ~ shaft speed squared, only when throttle is open
  const virtualBoost = P.maxBoost * s.shaft ** 2 * Math.min(1, inp.pedal * 1.5);
  const realBoost = inp.mapKpa ? Math.max(0, (inp.mapKpa - inp.baroKpa) / 100) : null;
  s.boost = s.venting ? s.boost * Math.exp(-dt / 0.15) : (realBoost ?? virtualBoost);

  s.flow = s.shaft * inp.pedal;

  // lift detection: fast pedal drop while boost is stored
  const pedalRate = (inp.pedal - s.lastPedal) / dt;
  if (pedalRate < P.liftRate && s.boost > P.bovThreshold && !s.venting) {
    emit(P.mode === 'bov' ? 'bov' : 'flutter', { boost: s.boost });
    s.venting = true;            // boost drains quickly; shaft keeps coasting
  }
  if (inp.pedal > 0.3) s.venting = false;
  s.lastPedal = inp.pedal;
}
```

Note what this produces: on lift, the boost vents ("pssh") but the shaft keeps spinning down slowly, so the whine winds down *after* the blow-off. That "pssh… wheeee" overlap is the signature turbo sound, and it falls out of the physics for free.

### 2. Sound graph (Web Audio, custom DSP in an AudioWorklet)

| Voice | Recipe | Pitch / filter driven by | Gain driven by |
| --- | --- | --- | --- |
| Whine | 3 sine partials (1×, 2×, 0.5×) + slight FM, 0.2–0.5% random pitch wobble | f = 1,500 + shaft × 6,500 Hz (perceptual map; adjust range per turbo size) | shaft^1.5 × (0.3 + 0.7 × pedal) |
| Whoosh | Pink noise → band-pass, Q ≈ 1 | Center 1–4 kHz tracking shaft | flow |
| Spool chirp | Same as whine, extra gain on rising shaft | Whine pitch | max(0, d(shaft)/dt) |
| Blow-off (event) | Pick 1 of 6–10 samples, playback rate 0.9–1.1 × boost; synth fallback = white noise → high-pass 800 Hz + resonant peak 2–5 kHz | Boost at lift | Boost; length 0.25–0.9 s, 5 ms attack, exponential decay |
| Flutter (event) | Train of 20–40 ms noise bursts, band-pass 300–2,000 Hz, slight downward chirp per burst | Boost | Rate starts \~15 Hz and slows to \~6 Hz as boost drains; amplitude decays with boost (starting values, tune by ear) |
| Wastegate hiss | Quiet noise burst when boost hits max | — | (boost − 0.95 × maxBoost) |
| Master | Soft limiter → optional intake-pipe impulse response → output | — | Master volume + speed-based ducking (optional) |

Rules that prevent the "cheap app" sound:

- Ramp every parameter (`setTargetAtTime` or per-sample smoothing). Never jump values, or you'll hear zipper noise.
- Randomize everything a little: pitch wobble, which blow-off sample plays, burst timing. Repetition is what makes fakes sound fake.
- Layer, don't loudness. The whine should sit just above the cabin noise, not over the music.
- Calibrate with references: find YouTube clips of your target car (e.g. a GTI with an aftermarket blow-off valve) and A/B against your slider sandbox.

## Beyond turbos: other layers

Once the state model exists, every other forced-induction or exhaust sound is a new voice reading the same inputs. Ranked by payoff for the effort:

| Layer | Trigger logic | Method | Effort |
| --- | --- | --- | --- |
| Supercharger whine (Roots / twin-screw) | No lag: pitch = engine rpm × pulley ratio × lobes ÷ 60; gain by load | Synth (saw + band-pass), like the whine voice with tau = 0 | Low |
| Overrun pops and crackles | Pedal at 0, rpm > 3,000, decelerating → random bursts, density by rpm | 10–20 one-shot samples, random timing and pitch | Low |
| Twin / sequential turbo | Two turbo instances: small one spools early, big one takes over at higher rpm | Reuse the turbo voice twice | Low |
| Anti-lag bangs | Lift at high boost, "rally mode" on → bangs plus shaft stays spun up | Samples + keep shaft high on lift | Low |
| Induction roar | Flow-driven low-mid noise | Noise → low-pass 300–800 Hz | Low |
| Straight-cut gear whine | Pitch from vehicle speed × estimated gear | Synth | Medium |
| Downshift rev-match blip | RPM jumps up while speed holds | Sample + short pops | Medium |
| Full engine swap (V8, flat-6, rotary, V12) | Engine rpm and load | Granular synthesis of a recorded acceleration ramp (or loops rendered from Engine Simulator) | High, needs a subwoofer and enough volume to mask your real engine |
| EV / sci-fi sound | Speed and pedal | Pure synth | Low, just for fun |

## Making it sound real, not like filtered hiss

A turbo sounds like a turbo because of five cues. Cheap apps get one (pitch rises with RPM) and miss the rest. Build all five and the simplest oscillators become convincing; miss them and the best samples still sound like a kettle.

| Cue | What the ear is detecting | How to produce it |
| --- | --- | --- |
| 1. Motion with inertia | The pitch never jumps. It accelerates, overshoots slightly, and coasts down on its own after you lift | The shaft model (above) plus a tiny second-order lag so pitch has momentum, not just a one-pole smoothing |
| 2. Harmonic structure | A real whine is a fundamental + partials at 2×, 3×, and often a sub-harmonic at 0.5× (shaft imbalance), with the partials' balance changing with load | 4–6 sine partials with independent gain envelopes; raise 2×/3× with pedal, 0.5× with boost |
| 3. Fixed resonances ("body") | The intake pipe, airbox and intercooler plumbing are tubes with fixed resonant frequencies. The whine sweeps *through* them and gets louder at each one. This is the single biggest realism upgrade | A bank of 3–5 fixed resonant band-pass filters (modal synthesis). Pick centers like 480, 1,150, 2,300, 3,900 Hz with Q 8–20. Pass whine + whoosh through them in parallel with the dry signal |
| 4. Breath | Air, not a tone: broadband noise whose spectrum tilts brighter as flow rises, and which is amplitude-modulated by the engine's firing pulses | Pink noise → tilt filter (low-shelf cut + high-shelf boost by flow) → AM at firing frequency (rpm ÷ 60 × cyl ÷ 2) at 10–20% depth |
| 5. Imperfection | Nothing is steady. Real turbos have slow pitch drift, random flow turbulence, and events that never repeat the same way | Pitch wobble (0.3% random walk at 3–8 Hz), noise gain jitter, random sample selection and ±10% playback rate, never the same blow-off twice |

### Why it must not be "just high-frequency noise"

The measured compressor spectrum has energy in three zones: a tonal whine around 1–5 kHz, broadband whoosh at 1–4 kHz, and much higher tones near 10 kHz. But what you hear *in the cabin* is heavily low-passed by the firewall and hoses. An interior recording has most of its turbo energy between 400 Hz and 4 kHz. Two consequences:

- Low-pass the whole turbo bus at about 5–6 kHz with a gentle slope. This single filter removes 80% of the "synthy" quality.
- Give the sound a low-mid foundation: a quiet saw or pulse at the whine fundamental ÷ 4, low-passed at 600 Hz. This is the "hum" behind the whistle that samples have and naive synths lack.

### Techniques, ranked by realism per hour of work

1. **Modal resonator bank** (cue 3). One afternoon, biggest payoff.
2. **Interior low-pass + low-mid foundation.** One hour.
3. **Convolution with an intake impulse response.** Record a clap or balloon pop into any car's airbox or a length of pipe with a phone, trim to 100–300 ms, load into a ConvolverNode. Gives real room character. Two hours including recording.
4. **Soft saturation** (tanh) on the whine bus at 10–20% drive. Adds harmonics that move with level, like a real diaphragm. 30 minutes.
5. **Stereo placement.** Turbo slightly front-left or front-right (where the real one sits), blow-off centered, pops rear. Width via a 5–15 ms delay on one side. 30 minutes.
6. **Wavetable or sampled single cycle** for the whine instead of sines, taken from a real turbo recording. Optional.
7. **Granular layer** for the whoosh from a real spool recording, as racing games do. Optional, phase 5.

### The blow-off and flutter in detail

A blow-off "pssh" is three parts in 100–500 ms: a transient click as the valve opens (2–5 ms), a loud broadband burst whose pitch falls as pressure drops (chirp down over the burst), and a tail that is mostly the whine fading. Synth version: white noise → high-pass sweeping from 1.5 kHz down to 600 Hz over the burst → resonant peak at 2–4 kHz, Q 4 → exponential decay with time constant 0.08–0.25 s scaled by boost. Layer a real sample on top when available.

Flutter is a pulse train: a burst every 40–120 ms, each burst a short noise click band-passed around 500–1,500 Hz, the repetition rate slowing as boost drains and the band center dropping with it. Add a slight pitch dip to the whine on each pulse, because the wheel really does stall momentarily. Start values: 14 Hz slowing to 6 Hz over 0.6 s, 8–14 pulses.

## The custom sound engine

One AudioWorklet processor runs everything continuous; the main thread only sends it a small state packet and fires one-shot samples. Write the DSP in plain TypeScript first. Move to Faust or Rust/WebAssembly only if the phone's CPU can't keep up (it will keep up; this graph is light).

```text
main thread (60 Hz)                     audio thread (AudioWorklet, 128-sample blocks, ~2.9 ms at 44.1 kHz)
──────────────────────────────       ──────────────────────────────────────────────────────────────
 OBD / demo input                       TurboProcessor
   → predictor (extrapolate + smooth)     targets: rpm, pedal, boostReal  ← SharedArrayBuffer or postMessage
   → postMessage({rpm, pedal, map})       turbo state model (runs per block, dt = 128/sr)
                                          voices (per sample):
 events (bov, flutter, pop)                 whine  = Σ partials × env → saturate
   → AudioBufferSourceNode               whoosh = pink → tilt → bandpass(track) × AM(firing)
     (sample-accurate start time)         found  = pulse/4 → LP 600
                                          flutter = pulse-train noise bursts (synth)
                                          bovSynth = noise burst (fallback when no sample)
                                        → resonator bank (parallel) + dry
                                        → interior LP 5.5 kHz → stereo place → out

 Web Audio nodes after the worklet: ConvolverNode (IR, wet 15–30%) → DynamicsCompressorNode (limiter) → destination
```

### Design rules that keep it clean

| Rule | Why |
| --- | --- |
| One processor, few AudioParams | Chrome's per-parameter overhead is real; one profiler case cut render time by trimming 544 params to 96. Send state as a message, smooth inside the processor |
| Smooth every target inside `process()` with a one-pole per sample (`v += (t − v) × k`) | No zipper noise, no clicks, regardless of how jumpy the OBD data is |
| Pitch gets a *second* smoother (critically damped 2nd-order) | Gives momentum; pitch glides like a spinning mass |
| Pre-build wavetables for sines and pink noise | No `Math.sin` per sample per partial; keeps CPU under 5% on a mid-range phone |
| Events on the main thread via `AudioBufferSourceNode.start(ctx.currentTime + 0.005)` | Sample-accurate, zero jitter; the worklet simultaneously receives a "duck whine 20% for 300 ms" message |
| `new AudioContext({ latencyHint: 'interactive' })`, try `0` on Android and measure `ctx.outputLatency` | Lowest buffer the phone allows; show the number in the diagnostics screen |
| Resume the context from a tap, never automatically | Browser autoplay rules; also prevents a surprise blast on reload |
| Hot-reloadable profile JSON | Every number above lives in one object you can edit while driving |

### Profile schema (what a "turbo" is in this app)

```json
{
  "name": "Garrett GT28 on a 2.0 four",
  "engine": { "cylinders": 4, "redline": 6800, "idle": 800 },
  "turbo": { "rpmBoostStart": 2200, "rpmFullBoost": 3800, "maxBoost": 1.2,
              "tauUp": 0.9, "tauDown": 2.2, "whineHzMin": 1500, "whineHzMax": 8000,
              "partials": [1, 0.55, 0.3, 0.18, 0.25], "subHarmonic": 0.2 },
  "body": { "resonators": [[480, 10], [1150, 14], [2300, 12], [3900, 9]],
            "interiorLowPassHz": 5500, "irFile": "airbox_small.wav", "irWet": 0.2 },
  "lift": { "mode": "bov", "bovThreshold": 0.35, "liftRate": -2.5,
            "samples": ["bov_01", "bov_02", "bov_03"], "flutter": { "hzStart": 14, "hzEnd": 6, "pulses": 10 } },
  "mix": { "whine": 0.8, "whoosh": 0.6, "foundation": 0.4, "bov": 1.0, "pops": 0.7, "master": 0.9,
           "pan": -0.2, "width": 0.3 }
}
```

Ship 5–6 built-in profiles that differ in character, not just numbers: small turbo (quick spool, high whine, sharp pssh), big single (slow spool, deeper whine, long flutter), twin-scroll, rally anti-lag, supercharger (no lag), and "subtle OEM" (quiet, for daily use).

## Settings and customization

Three tiers. Tier 1 is on the drive screen. Tier 2 is a settings page you visit while parked. Tier 3 is the tuning lab with every slider, used in the driveway with headphones. Everything is saved per profile, exportable as JSON.

| Tier | Setting | What it does |
| --- | --- | --- |
| 1 Drive | Master volume | One big slider; also obeys the phone's volume buttons |
| 1 Drive | Profile picker | Swipe between turbos; big tiles, no text walls |
| 1 Drive | Mute / Sport / Full | Three-state toggle: off, quiet OEM-style, everything on |
| 2 Setup | Lift behavior: blow-off / flutter / both / recirc (muffled) | Changes the whole character on every gear change |
| 2 Setup | Blow-off sensitivity | How hard a lift must be and how much boost is needed before it fires. Fixes "it psshes every time I feather the pedal" |
| 2 Setup | Boost source: virtual / real MAP | Real MAP on turbo cars; virtual on NA cars |
| 2 Setup | RPM exaggeration (1.0–1.6×) | SoundRacer's trick: multiplies RPM *changes* so cruising at 2,000 rpm still sounds busy. Keep idle honest |
| 2 Setup | Redline / idle / cylinders | Pulled from the car where possible; sets firing-frequency AM and the spool window |
| 2 Setup | Speed ducking | Reduce volume above a speed, or raise it to beat road noise (choose) |
| 2 Setup | Pops on overrun: off / mild / rally | Density and loudness of overrun pops |
| 2 Setup | Audio latency compensation (ms) | Set by the tap test; events fire early by this amount |
| 2 Setup | Output check | Plays a test tone left/right and shows the measured output latency |
| 3 Lab | Whine: pitch range, partial mix, sub-harmonic, wobble amount | Timbre of the whistle |
| 3 Lab | Whoosh: tilt, bandwidth, AM depth | Breath character |
| 3 Lab | Body: resonator centers and Q, interior low-pass, IR file and wet amount | The "this car's intake" sound |
| 3 Lab | Spool: tauUp, tauDown, boost curve exponent, wastegate point | Motion feel |
| 3 Lab | Flutter: pulse rate start/end, pulse count, band | Flutter character |
| 3 Lab | Mix and placement: per-voice levels, pan, width, limiter ceiling | Balance |
| 3 Lab | Sample sets: import your own blow-off / pop WAVs | Drop files in, they're randomized automatically |
| 3 Lab | A/B reference player | Play a YouTube-ripped reference clip next to your synth at the same RPM |
| 3 Lab | Log replay with scrubber | Re-drive any logged trip at your desk and tune against it |

Quality-of-life features that cost little and matter a lot:

- **Auto-start on connect.** Open the app → it reconnects to the last adapter and resumes audio after one tap. No menu.
- **Idle hum off.** Below \~1,100 rpm and zero pedal the turbo is silent (a real one is). Prevents a constant whine at lights.
- **Shift detection.** RPM drops 20%+ in under 300 ms while speed holds → it's a shift, so the lift is a gear change: fire blow-off with full confidence and hold the whine's coast-down shorter.
- **Volume follows road noise** (optional): use the mic to estimate cabin loudness every few seconds and nudge master volume. Off by default.
- **Profile presets per car.** Store adapter ID → profile, so a different car auto-selects its own settings.
- **Headphone mode** for tuning at home: switches the interior low-pass to a "recording" curve so it's judged fairly.

## Flow and UI

The app has three screens and the driver only ever sees one. Everything else is reached while parked.

### Flow

1. **First run (parked, 2 minutes).** Open the URL → one screen: "Connect adapter" button. Tap → Chrome's Bluetooth picker → pick the adapter. App runs init, reads VIN and supported PIDs, shows "Reading 24 Hz, RPM 812" live. Then "Audio check": tap play, confirm you hear it in the car speakers, do the tap test for latency. Pick a starting profile. Add to Home Screen prompt.
2. **Every drive (0 taps).** Launch from the home icon → it auto-reconnects to the known adapter, asks for one tap to start audio (browser rule), goes full-screen, keeps the screen on, dims to a dark dashboard. Phone goes in the mount. Done.
3. **While driving.** Big RPM arc, boost bar, a pulse when blow-off fires, volume, profile swipe, and a mute button the size of your thumb. Nothing else. No text smaller than 20 px, no menus, no dialogs. If the adapter drops, a single banner "Reconnecting…" and audio fades out rather than stuttering.
4. **Parked tuning.** Settings and Lab screens unlock only when speed is 0 (or in demo mode). Headphone mode for the driveway.

### Screens

| Screen | Contents | Rule |
| --- | --- | --- |
| Drive | RPM arc, boost bar, shaft speed glow, profile name, volume, mute, connection dot | Readable at arm's length in sunlight; dark background, one accent color |
| Setup | Tier-2 settings as large toggles and steppers | Only reachable at 0 km/h |
| Lab | Tier-3 sliders in collapsible groups, live spectrum, A/B reference, log replay | Desktop-friendly too; this is where you spend evenings |
| Diagnostics | Poll rate, output latency, dropped frames, raw OBD log, export | Hidden behind a long-press |

### Design rules (so it doesn't look like AI slop)

- No tagline, no hero section, no "Unleash the power" copy. The first screen is a button and a status line.
- One typeface (a clean grotesk or a tabular-figure mono for numbers), two sizes for body, one display size for the RPM number. Tabular numerals so the RPM doesn't jitter in width.
- One accent color that means "boost". Everything else is near-black and gray. The accent gets brighter with boost, which is the only decoration.
- Motion only where it carries information: the arc, the boost bar, a 150 ms flash on blow-off. No page transitions, no bouncing.
- Touch targets at least 56 px. Sliders have a numeric readout and a double-tap-to-reset.
- Dark by default; a dim mode that drops to 20% brightness at night via the ambient light sensor or a toggle.
- Build the drive screen as a few DOM elements plus one canvas for the arc; no component library, no icon packs, no gradients that aren't the boost glow.
- Test it on the actual phone in the actual mount in daylight before polishing anything else.

## Hosting, PWA, and the backend question

Yes, host it on GitHub Pages. Web Bluetooth only works from HTTPS (or localhost), and GitHub Pages is HTTPS by default, which is exactly why hardware projects like the Espruino and Bangle.js tools ship on github.io. There is no backend. Everything the app needs lives on the phone.

| Concern | Answer |
| --- | --- |
| Hosting | GitHub Pages from a `gh-pages` branch via GitHub Actions on every push to `main`. Vite `base: '/turboboost/'`. Free, HTTPS, zero ops |
| Local dev | `npm run dev` on localhost (Web Bluetooth allowed on localhost). For phone testing on the LAN, use Vite with `--host` plus a `mkcert` certificate, or just push and test on Pages |
| Backend | None. No accounts, no server, no analytics. Profiles, logs, latency calibration and the adapter ID live in `localStorage` / IndexedDB |
| Samples | Static files in `public/samples/`, cached by the service worker so the app works with no signal in a parking garage |
| Offline | Service worker (vite-plugin-pwa) precaches the whole app. First load online, then it runs forever offline |
| Install | Web App Manifest with `display: standalone`, portrait lock, dark theme color. Chrome offers "Add to Home Screen" |
| Keep awake | Screen Wake Lock API, re-requested on visibility change |
| Updates | Service worker update check on launch; apply on next launch, never mid-drive |
| Backup / sync | "Export profile" writes a JSON file; "Import" reads one. If you want sync across phones later, a GitHub Gist token is enough; still no server |
| Privacy | VIN and logs never leave the phone unless you export them |
| SEO | Not needed for a personal tool. If you ever share it: one `index.html` with a real title, description, Open Graph image and a short plain-English paragraph is all a single-page app needs. Skip the SEO plugin |
| Custom domain | Optional; Pages supports it with HTTPS |

Repo layout that keeps this honest: `main` holds source, Actions builds and deploys, `samples/` and `profiles/` are plain files anyone can edit, and a `logs/` folder in the repo holds a few reference drives for replay tests.

## Reliability nitpicks

Everything that will go wrong in a car, and the fix. Build these in from phase 3, not after.

| Failure | Symptom | Fix |
| --- | --- | --- |
| Adapter drops BLE mid-drive | Sound freezes on last RPM | Watchdog: no OBD frame for 400 ms → fade audio to idle over 500 ms, reconnect loop with backoff; resume silently when frames return |
| Adapter is a clone with wrong UUIDs | Connect fails | Try the known UUID set (FFE0/FFE1, FFF0/FFF1, OBDLink's) in order; keep a terminal screen to send raw AT commands |
| Car ECU answers slowly | Poll rate 3–5 Hz | Multi-PID requests, `ATAT0`, `ATST` tuned; show the Hz counter; prediction covers gaps up to 60 ms |
| OBD reply garbled (`NO DATA`, `SEARCHING`, split frames) | Random RPM spikes | Validate: reject RPM deltas > 3,000 rpm per 100 ms, require two agreeing samples before accepting a jump |
| Phone screen locks | Audio keeps going but UI dead; or audio stops | Wake Lock; also set `navigator.mediaSession` so the OS treats it as media and keeps the audio thread alive |
| Tab backgrounded (call, map) | Audio stops | Accept it; resume on return. For true background on Android, that's the native-app line |
| AudioContext suspended on launch | Silence | Never auto-start; one big "Start" tap resumes the context and starts polling |
| Chrome resamples / changes output when the head unit connects | Pitch or latency shifts | Listen for `devicechange`, re-measure latency when output changes |
| Zipper noise on parameter change | Clicks | All smoothing inside the worklet; nothing sets a gain directly |
| Clipping when blow-off + whine + pops stack | Distortion | Limiter at −1 dBFS; per-voice headroom; the blow-off ducks the whine 20% |
| Cold-start CPU spike (worklet compiling) | First second glitches | Warm up: run the worklet silent for 500 ms before unmuting |
| GC pauses on the main thread | None for audio (it's on its own thread), but UI stutters | Reuse objects in the poll loop; no per-frame allocations |
| Blow-off fires on gentle pedal feathering | Annoying | Threshold needs both fast lift rate *and* stored boost; shift detection raises confidence |
| Whine audible at idle in a quiet car | Fake | Hard gate below idle threshold; shaft decays to true zero |
| Phone volume at 100% blasts on connect | Scary | Master starts at the last-used level; a soft 1 s fade-in on every start |
| Latency drifts over a drive (Bluetooth audio) | Sync gets worse | Don't use Bluetooth audio; if forced to, re-run the tap test from a parked menu |
| Profile JSON corrupted by a bad edit | App won't start | Validate on load with a schema; fall back to defaults and show which field failed |

Testing that is worth doing:

- Unit tests for `turbo.ts` with recorded RPM logs: assert blow-off fires on every real shift in a log and never during feathering. This is where most bugs live.
- An offline-render test that produces a 10 s WAV from a log so you can listen to a regression before and after a change.
- A fake-adapter mode that replays a log over a mock Bluetooth interface, so the full OBD stack is tested without a car.
- One real-car checklist run per phase: connect from cold, drive 10 minutes, kill the adapter, restore it, background the app, return.

## Build plan for Claude Code

Six phases. Each one ends with something you can hear. Phases 1–2 need no car and no adapter, so start tonight.

**Stack:** Vite + TypeScript, no UI framework (or Preact if you want one). DSP lives in an AudioWorklet. Installable as a PWA with Wake Lock.

```text
turboboost/
  src/
    audio/
      worklet.ts        # all DSP voices, runs on the audio thread
      engine.ts         # AudioContext setup, sample loading, routing, limiter
    model/
      turbo.ts          # state model (section above), pure + unit-testable
      profiles.ts       # per-car / per-turbo presets
    obd/
      ble.ts            # Web Bluetooth connect, notify/write characteristics
      elm327.ts         # init, multi-PID polling, parsing, timing stats
      predictor.ts      # extrapolation + smoothing
    input/
      demo.ts           # on-screen pedal + keyboard + CSV log replay
    ui/
      main.ts           # big gauges, sliders, mode toggles, latency test
  public/samples/       # bov_01..10.wav, pop_01..20.wav
```

- [ ] **Phase 0 — gear (1 day).** Buy a BLE OBD-II adapter (OBDLink CX or Vgate iCar Pro BLE) and a USB-C → 3.5 mm dongle + aux cable. Confirm your car has an aux or USB-audio input.
- [ ] **Phase 1 — synth sandbox (1–2 evenings).** Web page with RPM and pedal sliders driving `turbo.ts` + whine + whoosh + synth blow-off. Done when sliding the pedal up and snapping it to zero sounds like a real spool and "pssh… wheee" on headphones.
- [ ] **Phase 2 — demo driving (1 evening).** Keyboard or touch pedal with a fake engine (rpm rises with pedal, drops on lift, gear changes), plus replay of a recorded CSV log. Add flutter mode and the sample blow-off.
- [ ] **Phase 3 — OBD connection (2–3 evenings).** Web Bluetooth connect, ELM327 init, multi-PID polling, on-screen Hz counter and raw log export. Done when you see 15+ Hz RPM in the driveway.
- [ ] **Phase 4 — in the car (2 evenings).** Wire the audio out, add latency test + compensation, Wake Lock, auto-reconnect, per-car profile (redline, spool window, real vs virtual boost). Tune on real drives (passenger holds the phone).
- [ ] **Phase 5 — extra layers.** Supercharger, pops, twin-turbo, anti-lag, then the granular engine swap if you still want it.
- [ ] **Phase 6 — optional.** Native iOS port, or an ESP32 CAN sniffer for 50 Hz+ RPM with no polling.

First prompt to give Claude Code:

```text
Create a Vite + TypeScript web app called turboboost. Build a turbo sound
sandbox: an AudioWorklet synth with three voices (whine: 3 sine partials with
pitch wobble; whoosh: band-passed pink noise; blow-off: noise burst with
high-pass + resonant peak and exponential decay). Drive them from a pure
turbo state model in src/model/turbo.ts (shaft speed with separate spool-up and
coast-down time constants, boost ~ shaft^2, lift detection that fires a
blow-off event when the pedal drops fast with boost above a threshold).
UI: RPM slider, pedal slider, sliders for every model parameter, live readouts
of shaft/boost/flow. Smooth every audio parameter, no zipper noise.
```

## Claude Code setup: skills, permissions, working rules

Do this before the first prompt. It takes ten minutes and is the difference between "it compiles" and "it sounds right."

### Skills and plugins to install

| Install | Command in Claude Code | What it adds |
| --- | --- | --- |
| Superpowers (obra) | `/plugin marketplace add obra/superpowers-marketplace` then `/plugin install superpowers@superpowers-marketplace` | Brainstorm → plan → TDD → verify-before-completion workflow, systematic debugging, subagent-driven development. This is the engineering discipline layer |
| frontend-design (Anthropic) | `/plugin install frontend-design@claude-plugins-official` (or the built-in `frontend-design` skill if your Claude lists it) | Distinctive, restrained UI; stops the default "gradient hero + three feature cards" look |
| Playwright MCP | `claude mcp add playwright npx @playwright/mcp@latest` | Lets Claude open the app in a real Chromium, click, screenshot, and read the console. Essential for a UI it can't otherwise see |
| Project skill: `turbo-sound-review` | Write it yourself (template below) | Forces an offline render + spectrum check after every DSP change |

Skip: SEO plugins (personal tool), React/Next scaffolds, UI kits, any "awesome skills" mega-pack. More skills means more noise in context.

### Permissions

In `.claude/settings.json` allow: `npm`, `npx`, `node`, `git`, `gh`, file edits under the repo, and the Playwright MCP. Pre-approve `npm run build`, `npm test`, `npx vitest`. Keep `git push` on ask until the Pages deploy is trusted.

### CLAUDE.md for the repo (paste this)

```markdown
# TurboBoost
Personal web app: real-time turbo sound layered over my real engine, driven by OBD-II over BLE.
Deployed to GitHub Pages. No backend. One user: me.

## Non-negotiables
- DSP lives in src/audio/worklet.ts (AudioWorklet). Never put audio math on the main thread.
- Every audio parameter is smoothed inside the worklet. No direct gain/frequency sets.
- src/model/turbo.ts is pure and unit-tested against logs in logs/*.csv.
- After ANY change to model or DSP: run `npm run render` (offline 10 s WAV from logs/reference.csv)
  and `npm run spectrum` (prints band energies). Compare to the previous run before claiming done.
- UI: no taglines, no hero, one accent color, tabular numerals, 56 px touch targets. Drive screen
  must be usable at arm's length. Settings/Lab only at 0 km/h.
- Use superpowers: brainstorm before new features, write the test first, verify before completion.
- Use Playwright MCP to open http://localhost:5173, screenshot the drive screen, and check the
  console is clean before finishing UI work.
- Profile JSON is the source of truth for all tunable numbers; no magic constants in code.

## Commands
npm run dev | npm test | npm run render | npm run spectrum | npm run build | npm run deploy
```

### The `turbo-sound-review` skill (`.claude/skills/turbo-sound-review/SKILL.md`)

```markdown
---
name: turbo-sound-review
description: Run after any change to src/audio or src/model. Renders reference audio offline and checks it.
---
1. Run `npm run render` to produce out/reference.wav from logs/reference.csv.
2. Run `npm run spectrum` and compare band energies (0.2-0.6k, 0.6-2k, 2-5k, 5-10k) to out/baseline.json.
   Flag any band that moved more than 3 dB unless the task asked for it.
3. Run `npm test` (turbo.ts event tests: blow-off count must equal shift count in each log).
4. Check for clicks: count samples where |x[n]-x[n-1]| > 0.3; must be 0.
5. Report: what changed audibly, numbers before/after, and whether the baseline should be updated.
```

### Working rules for each session

1. Start every feature with `/brainstorm` (superpowers), agree the plan, then `/write-plan`.
2. One phase per session. Finish with the real-car checklist from Reliability, not with "should work."
3. When tuning sound, give Claude Code a *reference*: a 10 s clip of the target car plus its RPM trace. Ask it to match band energies and the spool timing, not "make it sound good."
4. Keep `logs/reference.csv` from a real drive as the regression fixture. Everything is judged against it.
5. Commit after every green test run; deploy to Pages at the end of every session so the phone always has the latest build.

## Skip list: what's a waste of time

| Skip | Why |
| --- | --- |
| Running a physics engine simulator on the phone | CPU-heavy, Windows-centric, and unnecessary: your real engine is already there |
| CFD-accurate blade-pass frequencies | The real tone is ultrasonic; a perceptual mapping sounds more real |
| Buying a huge sample library | Can't track spool history; you'd still have to build the engine |
| Classic-Bluetooth or Wi-Fi ELM327 adapters | Browsers can't open classic Bluetooth serial or raw TCP sockets; iOS can't use classic Bluetooth adapters either |
| Microphone-based RPM detection | Your own speakers pollute it |
| React Native / Flutter / cross-platform | You need one app on one phone |
| Accounts, backend, store listing, monetization | It's for you |
| External speakers outside the car | Noise rules and annoyed neighbors; keep it in the cabin |
| Perfecting CAN sniffing before the sound is good | Polling at 15–30 Hz plus prediction is enough to start |

One safety rule: set everything up before you drive, mount the phone, and make every in-drive control a single large button.

## Sources

- [Turbocharger surge noise, ICSV22 2015 — noise types and frequency ranges](https://core.ac.uk/download/288375143.pdf)
- [Acoustic characterisation of a ported-shroud compressor — BPF, buzz-saw, whoosh 1–4 kHz](https://core.ac.uk/download/237464674.pdf)
- [Broatch et al. — CFD model of whoosh noise (1–3 kHz)](<https://riunet.upv.es/bitstream/handle/10251/60321/PR-2014-41%202014,manuscript,BroatchEtAl,Methodology%20for%20experimental%20validation%20of%20a%20CFD%20model%20for%20predicting%20noise%20generation%20in%20centrifugal%20compressors%20(author%20version).pdf?sequence=3>)
- [Sriganesh & Selamet, SAE 2023-01-1088 — BPF tones near 10 kHz](https://saemobilus.sae.org/articles/experimental-investigation-acoustic-performance-a-high-frequency-silencer-turbocharger-compressors-2023-01-1088)
- [Pai thesis, Loughborough 2015 — surge noise at 3,250 Hz](https://dspace.lboro.ac.uk/2134/19449)
- [Blowoff valve — Wikipedia](https://Www.Wikipedia.org/wiki/Blowoff_valve)
- [GFB — The truth about compressor surge](https://gfb.com.au/?p=8895)
- [AudioMotors / FMOD — loops vs additive vs granular engine synthesis](https://mcvuk.com/?p=62403)
- [Designing Sound — Project CARS, Forza 5 and REV](https://designingsound.org/2014/08/11/vehicle-engine-design-project-cars-forza-motorsport-5-and-rev/)
- [Forza Horizon granular hybrid looping](https://gizmodo.com.au/?p=1711672)
- [SoundRacer — alternator-signal RPM detection](https://www.edaboard.com/threads/soundracer-v8-v10-v12.245727/?amp=1)
- [SoundRacer X user manual](https://www.scribd.com/document/471416202/SoundRacer-X-UserManual1910)
- [RevHeadz](https://dcmpx.remotevs.com/au/com/revheadz/www/PL)
- [OBD SOUND — App Store](https://apps.apple.com/app/id960839379)
- [Active sound design — Wikipedia](https://wikipedia.com/wiki/Active_sound_design)
- [Engine Simulator (AngeTheGreat) — GitHub](https://github.com/ange-yaghi/engine-sim)
- [SparkFun forum — ELM327 down to \~10 ms per PID](https://community.sparkfun.com/t/obd-ii-uart-speed/34663)
- [RaceChrono forum — ESP32 CAN sniffer, 50 Hz RPM](https://racechrono.com/forum/discussion/comment/13740)
- [A2DP adds 100–200 ms latency](https://applied-ee.github.io/embedded/docs/audio-projects/bluetooth-audio/a2dp-audio-streaming/)
- [AES — SBC/AAC latency 150–800 ms](https://secure.aes.org/forum/pubs/ebriefs/?elib=17406)
- [WebBLE — Web Bluetooth extension for iOS Safari](https://apps.apple.com/app/id6761301368)
