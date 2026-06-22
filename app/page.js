"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// --- Play field & gameplay constants (all in pixels / seconds) ---
const ROAD_W = 320;
const ROAD_H = 520;
const CAR_W = 46;
const CAR_H = 78;
const OBS_W = 46;
const OBS_H = 70;
const CAR_BOTTOM = 16; // gap between the car and the bottom edge
const CAR_Y = ROAD_H - CAR_BOTTOM - CAR_H; // car top (fixed)

const PLAYER_SPEED = 360; // px/s horizontal car speed
const BASE_FALL = 200; // px/s initial obstacle fall speed
const FALL_ACCEL = 14; // px/s gained per second (difficulty ramp)
const MAX_FALL = 560; // px/s cap
const BASE_SPAWN = 0.95; // s between spawns at the start
const MIN_SPAWN = 0.42; // s fastest spawn rate
const SPAWN_RAMP = 0.012; // s removed from the interval per second
const HIT_INSET = 7; // shrink hitboxes a touch so collisions feel fair

const OBS_COLORS = [
  "bg-rose-500",
  "bg-amber-400",
  "bg-emerald-400",
  "bg-sky-400",
  "bg-fuchsia-500",
];

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export default function Home() {
  const [status, setStatus] = useState("ready"); // "ready" | "playing" | "over"
  // Snapshot published once per frame for rendering.
  const [snapshot, setSnapshot] = useState({
    playerX: (ROAD_W - CAR_W) / 2,
    obstacles: [],
    score: 0,
  });
  const [best, setBest] = useState(0);

  // --- Authoritative mutable game state (refs => not reactive) ---
  const playerXRef = useRef((ROAD_W - CAR_W) / 2);
  const obstaclesRef = useRef([]);
  const scoreRef = useRef(0);
  const elapsedRef = useRef(0);
  const spawnAccRef = useRef(0);
  const idRef = useRef(0);
  const lastRef = useRef(0);
  const rafRef = useRef(0);
  const keysRef = useRef({ left: false, right: false });
  const statusRef = useRef(status);

  // --- Audio (Web Audio API, synthesized — no sound files needed) ---
  const [muted, setMuted] = useState(false);
  const audioCtxRef = useRef(null);
  const engineRef = useRef(null); // { osc, gain } for the engine hum
  const mutedRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Lazily create / resume the AudioContext (must follow a user gesture).
  const ensureAudio = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }, []);

  // One short synthesized note with an attack/decay envelope.
  const tone = useCallback(
    (freq, { dur = 0.12, type = "square", vol = 0.12, when = 0, sweepTo = 0 } = {}) => {
      if (mutedRef.current) return;
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const t = ctx.currentTime + when;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    },
    []
  );

  const playStart = useCallback(() => {
    // Rising C-E-G arpeggio.
    tone(523, { when: 0, dur: 0.1, vol: 0.1 });
    tone(659, { when: 0.09, dur: 0.1, vol: 0.1 });
    tone(784, { when: 0.18, dur: 0.16, vol: 0.1 });
  }, [tone]);

  const playDodge = useCallback(() => {
    tone(880, { dur: 0.07, type: "triangle", vol: 0.07 });
  }, [tone]);

  const playCrash = useCallback(() => {
    if (mutedRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    // Descending tone…
    tone(320, { dur: 0.5, type: "sawtooth", vol: 0.2, sweepTo: 55 });
    // …plus a decaying noise burst.
    const t = ctx.currentTime;
    const dur = 0.4;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g).connect(ctx.destination);
    src.start(t);
  }, [tone]);

  const startEngine = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || engineRef.current) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(70, ctx.currentTime);
    g.gain.setValueAtTime(mutedRef.current ? 0 : 0.05, ctx.currentTime);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    engineRef.current = { osc, gain: g };
  }, []);

  const stopEngine = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    try {
      e.osc.stop();
    } catch {
      // already stopped
    }
    e.osc.disconnect();
    e.gain.disconnect();
    engineRef.current = null;
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const e = engineRef.current;
    const ctx = audioCtxRef.current;
    if (e && ctx) e.gain.gain.setTargetAtTime(next ? 0 : 0.05, ctx.currentTime, 0.02);
  }, []);

  // Clean up audio on unmount.
  useEffect(() => {
    return () => {
      stopEngine();
      const ctx = audioCtxRef.current;
      if (ctx) {
        try {
          ctx.close();
        } catch {
          // ignore
        }
        audioCtxRef.current = null;
      }
    };
  }, [stopEngine]);

  const publish = useCallback(() => {
    setSnapshot({
      playerX: playerXRef.current,
      obstacles: obstaclesRef.current.map((o) => ({ ...o })),
      score: Math.floor(scoreRef.current),
    });
  }, []);

  const startGame = useCallback(() => {
    playerXRef.current = (ROAD_W - CAR_W) / 2;
    obstaclesRef.current = [];
    scoreRef.current = 0;
    elapsedRef.current = 0;
    spawnAccRef.current = 0;
    keysRef.current = { left: false, right: false };
    publish();
    ensureAudio();
    playStart();
    setStatus("playing");
  }, [publish, ensureAudio, playStart]);

  // --- Main game loop: runs only while playing ---
  useEffect(() => {
    if (status !== "playing") return;

    lastRef.current = performance.now();
    ensureAudio();
    startEngine();

    const loop = (now) => {
      const dt = Math.min((now - lastRef.current) / 1000, 0.05); // clamp big gaps
      lastRef.current = now;
      elapsedRef.current += dt;

      const elapsed = elapsedRef.current;
      const fall = Math.min(BASE_FALL + FALL_ACCEL * elapsed, MAX_FALL);
      const spawnInterval = Math.max(BASE_SPAWN - SPAWN_RAMP * elapsed, MIN_SPAWN);

      // Engine hum rises in pitch as the cars fall faster.
      const engine = engineRef.current;
      const ctx = audioCtxRef.current;
      if (engine && ctx) {
        const targetFreq = 70 + (fall - BASE_FALL) * 0.22;
        engine.osc.frequency.setTargetAtTime(targetFreq, ctx.currentTime, 0.1);
        engine.gain.gain.setTargetAtTime(mutedRef.current ? 0 : 0.05, ctx.currentTime, 0.05);
      }

      // Move the player from held keys.
      let px = playerXRef.current;
      if (keysRef.current.left) px -= PLAYER_SPEED * dt;
      if (keysRef.current.right) px += PLAYER_SPEED * dt;
      playerXRef.current = clamp(px, 0, ROAD_W - CAR_W);

      // Spawn new obstacles.
      spawnAccRef.current += dt;
      while (spawnAccRef.current >= spawnInterval) {
        spawnAccRef.current -= spawnInterval;
        idRef.current += 1;
        obstaclesRef.current.push({
          id: idRef.current,
          x: Math.random() * (ROAD_W - OBS_W),
          y: -OBS_H,
          color: OBS_COLORS[idRef.current % OBS_COLORS.length],
        });
      }

      // Move obstacles down; drop the ones that left the screen (+score for dodging).
      const next = [];
      for (const o of obstaclesRef.current) {
        const ny = o.y + fall * dt;
        if (ny > ROAD_H) {
          scoreRef.current += 30; // bonus for a dodged car
          playDodge();
          continue;
        }
        o.y = ny;
        next.push(o);
      }
      obstaclesRef.current = next;

      // Distance score (always ticking upward).
      scoreRef.current += dt * 12;

      // Collision detection (AABB with a small inset).
      const carL = playerXRef.current + HIT_INSET;
      const carR = playerXRef.current + CAR_W - HIT_INSET;
      const carT = CAR_Y + HIT_INSET;
      const carB = CAR_Y + CAR_H - HIT_INSET;
      let crashed = false;
      for (const o of obstaclesRef.current) {
        if (
          carL < o.x + OBS_W - HIT_INSET &&
          carR > o.x + HIT_INSET &&
          carT < o.y + OBS_H - HIT_INSET &&
          carB > o.y + HIT_INSET
        ) {
          crashed = true;
          break;
        }
      }

      if (crashed) {
        const finalScore = Math.floor(scoreRef.current);
        setBest((b) => (finalScore > b ? finalScore : b));
        stopEngine();
        playCrash();
        publish();
        setStatus("over");
        return; // stop the loop — no next frame requested
      }

      publish();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      stopEngine();
    };
  }, [status, publish, ensureAudio, startEngine, stopEngine, playDodge, playCrash]);

  // --- Keyboard controls ---
  useEffect(() => {
    const isLeft = (k) => k === "ArrowLeft" || k === "a" || k === "A";
    const isRight = (k) => k === "ArrowRight" || k === "d" || k === "D";

    const onKeyDown = (e) => {
      if (isLeft(e.key) || isRight(e.key)) {
        e.preventDefault();
        if (statusRef.current === "ready") startGame();
      }
      if (isLeft(e.key)) keysRef.current.left = true;
      if (isRight(e.key)) keysRef.current.right = true;
    };
    const onKeyUp = (e) => {
      if (isLeft(e.key)) keysRef.current.left = false;
      if (isRight(e.key)) keysRef.current.right = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startGame]);

  // On-screen touch buttons (mobile-friendly).
  const setDir = useCallback(
    (side, down) => {
      if (statusRef.current === "ready" && down) startGame();
      keysRef.current[side] = down;
    },
    [startGame]
  );

  const { playerX, obstacles, score } = snapshot;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-zinc-900 p-4 font-sans text-zinc-100 select-none">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-white">
          🏎️ 2D 賽車遊戲
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          用 ← → 鍵控制，閃避掉落的車子！
        </p>
      </header>

      {/* Scoreboard */}
      <div className="flex w-[320px] items-center justify-between rounded-lg bg-zinc-800 px-4 py-2 text-sm">
        <span>
          分數：<span className="font-mono text-lg font-bold text-emerald-400">{score}</span>
        </span>
        <span className="text-zinc-400">
          最佳：<span className="font-mono font-bold text-amber-400">{best}</span>
        </span>
        <button
          onClick={toggleMute}
          className="rounded-md bg-zinc-700 px-2 py-1 text-base leading-none transition-colors hover:bg-zinc-600"
          aria-label={muted ? "開啟音效" : "靜音"}
          title={muted ? "開啟音效" : "靜音"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>

      {/* Road / play area */}
      <div
        className="relative overflow-hidden rounded-xl border-4 border-zinc-700 shadow-2xl"
        style={{ width: ROAD_W, height: ROAD_H, backgroundColor: "#3f3f46" }}
      >
        {/* Side curbs */}
        <div className="absolute inset-y-0 left-0 w-2 bg-zinc-500/40" />
        <div className="absolute inset-y-0 right-0 w-2 bg-zinc-500/40" />

        {/* Animated dashed center line */}
        <div
          className={`absolute top-0 left-1/2 h-full w-1.5 -translate-x-1/2 ${
            status === "playing" ? "road-moving" : ""
          }`}
          style={{
            backgroundImage:
              "repeating-linear-gradient(to bottom, #fafafa 0 36px, transparent 36px 72px)",
            backgroundSize: "100% 72px",
          }}
        />

        {/* Obstacles (enemy cars) */}
        {obstacles.map((o) => (
          <div
            key={o.id}
            className={`absolute rounded-md ${o.color} shadow-md`}
            style={{ left: o.x, top: o.y, width: OBS_W, height: OBS_H }}
          >
            <div className="absolute inset-x-1.5 top-1.5 h-4 rounded-sm bg-black/30" />
            <div className="absolute inset-x-1.5 bottom-1.5 h-4 rounded-sm bg-black/30" />
            <div className="absolute -left-1 top-2 h-3 w-1.5 rounded-sm bg-zinc-900" />
            <div className="absolute -right-1 top-2 h-3 w-1.5 rounded-sm bg-zinc-900" />
            <div className="absolute -left-1 bottom-2 h-3 w-1.5 rounded-sm bg-zinc-900" />
            <div className="absolute -right-1 bottom-2 h-3 w-1.5 rounded-sm bg-zinc-900" />
          </div>
        ))}

        {/* Player car */}
        <div
          className="absolute rounded-lg bg-blue-500 shadow-lg"
          style={{ left: playerX, top: CAR_Y, width: CAR_W, height: CAR_H }}
        >
          <div className="absolute inset-x-1.5 top-2 h-5 rounded-sm bg-sky-200/80" />
          <div className="absolute inset-x-2 bottom-2 h-4 rounded-sm bg-sky-100/70" />
          <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-300" />
          <div className="absolute -left-1 top-3 h-4 w-1.5 rounded-sm bg-zinc-900" />
          <div className="absolute -right-1 top-3 h-4 w-1.5 rounded-sm bg-zinc-900" />
          <div className="absolute -left-1 bottom-3 h-4 w-1.5 rounded-sm bg-zinc-900" />
          <div className="absolute -right-1 bottom-3 h-4 w-1.5 rounded-sm bg-zinc-900" />
        </div>

        {/* Ready overlay */}
        {status === "ready" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 text-center backdrop-blur-sm">
            <p className="px-6 text-lg font-semibold">
              按 ← → 開始遊戲
            </p>
            <button
              onClick={startGame}
              className="rounded-full bg-emerald-500 px-6 py-2 font-bold text-white transition-colors hover:bg-emerald-400 active:scale-95"
            >
              開始
            </button>
          </div>
        )}

        {/* Game over overlay */}
        {status === "over" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center backdrop-blur-sm">
            <p className="text-3xl font-extrabold text-rose-400">Game Over</p>
            <p className="text-lg">
              得分：<span className="font-mono font-bold text-emerald-400">{score}</span>
            </p>
            <button
              onClick={startGame}
              className="mt-2 rounded-full bg-emerald-500 px-6 py-2 font-bold text-white transition-colors hover:bg-emerald-400 active:scale-95"
            >
              Restart
            </button>
          </div>
        )}
      </div>

      {/* On-screen controls + restart */}
      <div className="flex w-[320px] items-center justify-between gap-3">
        <button
          onPointerDown={() => setDir("left", true)}
          onPointerUp={() => setDir("left", false)}
          onPointerLeave={() => setDir("left", false)}
          className="h-14 flex-1 rounded-lg bg-zinc-700 text-2xl font-bold transition-colors hover:bg-zinc-600 active:bg-zinc-500"
          aria-label="左移"
        >
          ◀
        </button>
        <button
          onClick={startGame}
          className="h-14 rounded-lg bg-zinc-800 px-4 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-700"
        >
          {status === "over" ? "Restart" : "重新開始"}
        </button>
        <button
          onPointerDown={() => setDir("right", true)}
          onPointerUp={() => setDir("right", false)}
          onPointerLeave={() => setDir("right", false)}
          className="h-14 flex-1 rounded-lg bg-zinc-700 text-2xl font-bold transition-colors hover:bg-zinc-600 active:bg-zinc-500"
          aria-label="右移"
        >
          ▶
        </button>
      </div>
    </div>
  );
}
