/**
 * Tiny synthesized sound effects (Web Audio oscillators, no audio assets to ship).
 * Muting is a per-browser preference, stored locally.
 */

export type SoundKind =
  | "draw"
  | "discard"
  | "swap"
  | "snapHit"
  | "snapMiss"
  | "cabo"
  | "power"
  | "turn";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone(freq: number, duration: number, opts: ToneOpts = {}): void {
  const audio = getCtx();
  if (!audio) return;
  const t0 = audio.currentTime + (opts.delay ?? 0);
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(opts.gain ?? 0.12, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

const STORAGE_KEY = "cabo:sound";

export function loadSoundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = loadSoundEnabled();

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private browsing or storage blocked - fine, it just won't persist */
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function playSound(kind: SoundKind): void {
  if (!enabled) return;
  switch (kind) {
    case "draw":
      tone(430, 0.08, { type: "triangle", gain: 0.07 });
      break;
    case "discard":
      tone(300, 0.1, { type: "triangle", gain: 0.07 });
      break;
    case "swap":
      tone(520, 0.09, { type: "sine", gain: 0.1 });
      tone(760, 0.11, { type: "sine", gain: 0.1, delay: 0.08 });
      break;
    case "snapHit":
      tone(1040, 0.14, { type: "square", gain: 0.1 });
      break;
    case "snapMiss":
      tone(160, 0.22, { type: "sawtooth", gain: 0.09 });
      break;
    case "cabo":
      tone(660, 0.12, { gain: 0.11 });
      tone(880, 0.2, { gain: 0.11, delay: 0.1 });
      break;
    case "power":
      tone(500, 0.09, { type: "sine", gain: 0.08 });
      break;
    case "turn":
      tone(600, 0.06, { type: "sine", gain: 0.06 });
      break;
  }
}
