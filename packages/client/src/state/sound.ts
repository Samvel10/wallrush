/**
 * Sound.
 *
 * Synthesised with the Web Audio API rather than shipped as files: it keeps the
 * bundle tiny, works offline, and the tones can be tuned in code. Everything is
 * lazy — no AudioContext exists until the first sound is actually played, which
 * also keeps browsers' autoplay policies happy.
 */

let ctx: AudioContext | null = null;
let enabled = true;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

interface ToneOptions {
  freq: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  sweepTo?: number;
  delay?: number;
}

function tone({ freq, duration, type = 'sine', gain = 0.12, sweepTo, delay = 0 }: ToneOptions): void {
  const audio = context();
  if (!audio) return;
  const start = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function noise(duration: number, gain = 0.08): void {
  const audio = context();
  if (!audio) return;
  const frames = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Decaying noise burst — reads as a soft "thock".
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2.5;
  }
  const src = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const amp = audio.createGain();
  filter.type = 'lowpass';
  filter.frequency.value = 1400;
  amp.gain.value = gain;
  src.buffer = buffer;
  src.connect(filter).connect(amp).connect(audio.destination);
  src.start();
}

export const sounds = {
  step(): void {
    if (!enabled) return;
    tone({ freq: 520, duration: 0.09, type: 'triangle', gain: 0.09, sweepTo: 700 });
  },
  wall(): void {
    if (!enabled) return;
    noise(0.16, 0.11);
    tone({ freq: 160, duration: 0.1, type: 'square', gain: 0.05 });
  },
  jump(): void {
    if (!enabled) return;
    tone({ freq: 440, duration: 0.11, type: 'triangle', gain: 0.1, sweepTo: 880 });
  },
  yourTurn(): void {
    if (!enabled) return;
    tone({ freq: 660, duration: 0.1, type: 'sine', gain: 0.07 });
    tone({ freq: 880, duration: 0.12, type: 'sine', gain: 0.06, delay: 0.09 });
  },
  win(): void {
    if (!enabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone({ freq: f, duration: 0.26, type: 'triangle', gain: 0.1, delay: i * 0.1 }),
    );
  },
  lose(): void {
    if (!enabled) return;
    [440, 370, 294].forEach((f, i) =>
      tone({ freq: f, duration: 0.3, type: 'sine', gain: 0.09, delay: i * 0.13 }),
    );
  },
  error(): void {
    if (!enabled) return;
    tone({ freq: 200, duration: 0.13, type: 'sawtooth', gain: 0.06, sweepTo: 130 });
  },
  tick(): void {
    if (!enabled) return;
    tone({ freq: 1200, duration: 0.035, type: 'sine', gain: 0.04 });
  },
  join(): void {
    if (!enabled) return;
    tone({ freq: 587.33, duration: 0.12, type: 'sine', gain: 0.07 });
    tone({ freq: 880, duration: 0.14, type: 'sine', gain: 0.06, delay: 0.1 });
  },
};

export function vibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* not supported */
  }
}
