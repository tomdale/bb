import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { ThreadChatMessageReference } from "@get-bb/plugin-sdk/app";
import { extractSpeechText } from "./tts.js";

const MAX_ERROR_LENGTH = 240;
const MAX_CHUNK_CHARACTERS = 360;
const playListeners = new Set<(message: ThreadChatMessageReference) => void>();

type SpeechSegment = { url: string };
type ActivePlayback = {
  messageId: string;
  controller: AbortController;
  audio: HTMLAudioElement | null;
  urls: Set<string>;
  segments: string[];
  prefetched: Promise<SpeechSegment> | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  startedAt: number;
};
type PlaybackView = {
  messageId: string;
  state: "loading" | "playing" | "paused";
  progress: number;
  firstAudioMs: number | null;
};

export function splitSpeechText(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?:[”’\"]+)?|[^.!?]+$/g) ?? [text];
  const segments: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      if (word.length > MAX_CHUNK_CHARACTERS) {
        if (current) segments.push(current);
        current = "";
        for (
          let offset = 0;
          offset < word.length;
          offset += MAX_CHUNK_CHARACTERS
        ) {
          segments.push(word.slice(offset, offset + MAX_CHUNK_CHARACTERS));
        }
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > MAX_CHUNK_CHARACTERS && current) {
        segments.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function requestReadAloud(message: ThreadChatMessageReference): void {
  for (const listener of playListeners) listener(message);
}

function errorFromResponse(response: Response): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        return body.error.slice(0, MAX_ERROR_LENGTH);
      }
      return `Speech request failed (${response.status}).`;
    })
    .catch(() => `Speech request failed (${response.status}).`);
}

type WaveState = PlaybackView["state"] | "closing";

const CLIP_CENTER = "inset(0 50% 0 50%)";
const CLIP_FULL = "inset(0 0% 0 0%)";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

function springEasing(bounce: number): string {
  const damping = 1 - bounce;
  const frequency = 6.9 / damping;
  const damped = frequency * Math.sqrt(1 - damping * damping);
  const points: string[] = [];
  for (let step = 0; step <= 48; step += 1) {
    const time = step / 48;
    const decay = Math.exp(-damping * frequency * time);
    const value =
      step === 48
        ? 1
        : 1 -
          decay *
            (Math.cos(damped * time) +
              ((damping * frequency) / damped) * Math.sin(damped * time));
    points.push(value.toFixed(4));
  }
  return `linear(${points.join(", ")})`;
}

function springOrFallback(bounce: number): string {
  return typeof CSS !== "undefined" &&
    CSS.supports("transition-timing-function", "linear(0, 1)")
    ? springEasing(bounce)
    : EASE_OUT;
}

function canAnimate(element: HTMLElement | null): element is HTMLElement {
  return element !== null && typeof element.animate === "function";
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Waveform({
  analyser,
  progress,
  state,
}: {
  analyser: AnalyserNode | null;
  progress: number;
  state: WaveState;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const stateRef = useRef(state);
  useEffect(() => {
    progressRef.current = progress;
    stateRef.current = state;
  }, [progress, state]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const samples = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;
    const style = getComputedStyle(canvas);
    const player = canvas.closest<HTMLElement>(".tts-player");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const barWidth = 2;
    const gap = 2.5;
    const introStart = performance.now();
    let levels: number[] = [];
    let animation = 0;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * ratio);
      canvas.height = Math.round(canvas.clientHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      levels = Array.from(
        {
          length: Math.max(
            1,
            Math.floor((canvas.clientWidth + gap) / (barWidth + gap)),
          ),
        },
        () => 0,
      );
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    const draw = (time: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const bars = levels.length;
      const still = reducedMotion.matches;
      const current = stateRef.current;
      const playing = current === "playing";
      if (samples && playing) analyser?.getByteFrequencyData(samples);
      context.clearRect(0, 0, width, height);
      const ink = style.color;
      const played = Math.round((progressRef.current / 100) * bars);
      const front = (time - introStart - 240) / 700;
      let total = 0;
      for (let index = 0; index < bars; index += 1) {
        const mirrored = Math.abs(index - (bars - 1) / 2) / (bars / 2);
        let target = 0;
        if (current === "loading") {
          target = still
            ? 0
            : Math.max(0, Math.sin(time / 300 - mirrored * 6)) ** 6 * 0.3;
        } else if (samples && playing) {
          const bin = Math.floor(mirrored * samples.length * 0.45);
          target = ((samples[bin] ?? 0) / 255) ** 1.4;
        }
        if (!still && current !== "closing" && front > -0.2 && front < 1.3) {
          target = Math.max(
            target,
            Math.exp(-((mirrored - front) ** 2) / 0.004) * 0.7,
          );
        }
        const level = levels[index] ?? 0;
        const next = still ? target : level + (target - level) * 0.3;
        levels[index] = next;
        total += next;
        const barHeight = Math.max(2, next * height);
        context.fillStyle = ink;
        context.globalAlpha = index < played ? 0.9 : 0.24;
        context.beginPath();
        context.roundRect(
          index * (barWidth + gap),
          (height - barHeight) / 2,
          barWidth,
          barHeight,
          barWidth / 2,
        );
        context.fill();
      }
      context.globalAlpha = 1;
      player?.style.setProperty(
        "--tts-level",
        (bars > 0 ? total / bars : 0).toFixed(3),
      );
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      observer?.disconnect();
    };
  }, [analyser]);
  return (
    <canvas
      ref={canvasRef}
      className="tts-player__wave"
      role="img"
      aria-label={
        analyser ? "Live audio frequency visualization" : "Audio waveform"
      }
    />
  );
}

const PLAYER_STYLES = `
.tts-shell{width:min(100%,30rem);margin-inline:auto;overflow-anchor:none}
.tts-shell__inner{padding-block:1.25rem 2rem}
.tts-player{--tts-level:0;position:relative;isolation:isolate;height:2.75rem;color:var(--ink);font-size:.75rem;line-height:1}
.tts-player[data-closing]{pointer-events:none}
.tts-player__haze{position:absolute;z-index:-1;inset:-1rem -2rem;pointer-events:none;opacity:calc(.7 + var(--tts-level) * 1.6);transform:scale(calc(.97 + var(--tts-level) * .35))}
.tts-player__haze:before,.tts-player__haze:after{content:"";position:absolute;inset:0}
.tts-player__haze:before{background:radial-gradient(50% 50% at 50% 50%,color-mix(in oklab,var(--ink) 8%,transparent),transparent 100%);animation:tts-drift-a 9s ease-in-out infinite alternate}
.tts-player__haze:after{background:radial-gradient(28% 42% at 32% 50%,color-mix(in oklab,var(--ink) 6%,transparent),transparent 100%),radial-gradient(28% 42% at 68% 50%,color-mix(in oklab,var(--ink) 6%,transparent),transparent 100%);animation:tts-drift-b 12s ease-in-out infinite alternate}
.tts-player__body{display:flex;align-items:center;justify-content:center;gap:.75rem;height:100%}
.tts-player__body[data-kind=error]{animation:tts-content-in .32s ${EASE_OUT} both}
.tts-player__button{display:grid;place-items:center;flex:none;width:1.75rem;height:1.75rem;padding:0;border:0;border-radius:50%;background:transparent;color:color-mix(in oklab,var(--ink) 55%,transparent);cursor:pointer;transition:color .2s ease,background .2s ease,transform .15s ease}
.tts-player__button:hover{color:var(--ink);background:color-mix(in oklab,var(--ink) 6%,transparent)}
.tts-player__button:active{transform:scale(.9)}
.tts-player__button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.tts-player__button:disabled{cursor:default}
.tts-player__button:disabled:hover{color:color-mix(in oklab,var(--ink) 55%,transparent);background:transparent}
.tts-player__icon{width:.8rem;height:.8rem;animation:tts-icon-in .32s cubic-bezier(.34,1.56,.64,1) both}
.tts-player__spinner{animation:tts-icon-in .32s cubic-bezier(.34,1.56,.64,1) both,tts-spin .9s linear infinite}
.tts-player__wave{flex:1;min-width:0;height:1.5rem;color:var(--ink);mask-image:linear-gradient(90deg,transparent,black 16%,black 84%,transparent)}
.tts-player__status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.tts-player__error{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in oklab,var(--ink) 72%,transparent)}
@keyframes tts-content-in{from{opacity:0;filter:blur(4px)}}
@keyframes tts-icon-in{from{opacity:0;filter:blur(3px);transform:scale(.4)}}
@keyframes tts-spin{to{rotate:360deg}}
@keyframes tts-drift-a{to{transform:translateX(3%) scale(1.06,1.18)}}
@keyframes tts-drift-b{to{transform:translateX(-4%) scale(1.1,.94)}}
@media(prefers-reduced-motion:reduce){.tts-player__body,.tts-player__icon,.tts-player__spinner,.tts-player__haze:before,.tts-player__haze:after{animation:none}.tts-player__button{transition:none}}
`;

type SpaceHandoff = {
  settle: () => void;
  arm: () => void;
};

let releaseActiveHandoff: (() => void) | null = null;

function releaseSpaceHandoff(): void {
  releaseActiveHandoff?.();
  releaseActiveHandoff = null;
}

function pinnedTimelineContent(
  shell: HTMLElement,
): { content: HTMLElement; sentinel: HTMLElement } | null {
  for (let element = shell.parentElement; element;) {
    const sentinel = element.nextElementSibling;
    if (
      sentinel instanceof HTMLElement &&
      sentinel.classList.contains("scroll-bottom-anchor")
    ) {
      const scrollArea = sentinel.parentElement?.parentElement;
      if (!scrollArea) return null;
      const slack = scrollArea.scrollHeight - scrollArea.clientHeight;
      return slack > 0 && slack - scrollArea.scrollTop <= 4
        ? { content: element, sentinel }
        : null;
    }
    element = element.parentElement;
  }
  return null;
}

function handOffSpace(
  shell: HTMLElement,
  timing: KeyframeAnimationOptions | null,
): SpaceHandoff | null {
  const timeline = pinnedTimelineContent(shell);
  const row = shell.closest("[data-timeline-row-id]");
  if (!timeline || !row) return null;
  releaseSpaceHandoff();
  const height = shell.getBoundingClientRect().height;
  const spacer = document.createElement("div");
  spacer.dataset.ttsScrollSpacer = "";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText =
    "flex:none;height:0px;overflow-anchor:none;pointer-events:none";
  timeline.sentinel.before(spacer);
  const growth =
    timing && typeof spacer.animate === "function"
      ? spacer.animate([{ height: "0px" }, { height: `${height}px` }], {
          ...timing,
          fill: "forwards",
        })
      : null;
  let observer: ResizeObserver | null = null;
  const release = () => {
    observer?.disconnect();
    growth?.cancel();
    spacer.remove();
  };
  releaseActiveHandoff = release;
  return {
    settle() {
      spacer.style.height = `${height}px`;
      growth?.cancel();
    },
    arm() {
      if (typeof ResizeObserver === "undefined") {
        releaseSpaceHandoff();
        return;
      }
      const baseline = timeline.content.getBoundingClientRect().height;
      observer = new ResizeObserver(() => {
        if (!row.isConnected || !spacer.isConnected) {
          releaseSpaceHandoff();
          return;
        }
        const grown =
          timeline.content.getBoundingClientRect().height - baseline;
        const remaining = height - Math.max(0, grown);
        if (remaining <= 0.5) releaseSpaceHandoff();
        else spacer.style.height = `${remaining}px`;
      });
      observer.observe(timeline.content);
    },
  };
}

function usePlayerMotion(closing: boolean, onExited: () => void) {
  const shellRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hazeRef = useRef<HTMLSpanElement>(null);
  const onExitedRef = useRef(onExited);
  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const pill = pillRef.current;
    const body = bodyRef.current;
    const haze = hazeRef.current;
    if (!canAnimate(shell) || !canAnimate(pill)) return;
    if (prefersReducedMotion()) {
      pill.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: "ease-out",
      });
      return;
    }
    shell.style.overflow = "clip";
    const open = shell.animate(
      [{ height: "0px" }, { height: `${shell.offsetHeight}px` }],
      { duration: 300, easing: EASE_OUT },
    );
    void open.finished.then(
      () => shell.style.removeProperty("overflow"),
      () => undefined,
    );
    haze?.animate([{ opacity: 0, transform: "scale(0.3, 0.5)", offset: 0 }], {
      duration: 900,
      delay: 80,
      easing: EASE_OUT,
      fill: "backwards",
    });
    if (canAnimate(body)) {
      body.animate([{ clipPath: CLIP_CENTER }, { clipPath: CLIP_FULL }], {
        duration: 820,
        delay: 180,
        easing: springOrFallback(0.22),
        fill: "backwards",
      });
      body.animate(
        [
          { opacity: 0, filter: "blur(6px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        { duration: 420, delay: 180, easing: EASE_OUT, fill: "backwards" },
      );
    }
  }, []);

  useEffect(() => {
    if (!closing) return;
    const shell = shellRef.current;
    const pill = pillRef.current;
    let cancelled = false;
    let space: SpaceHandoff | null = null;
    let finished = false;
    const finish = () => {
      if (cancelled || finished) return;
      finished = true;
      space?.settle();
      onExitedRef.current();
      space?.arm();
    };
    if (!canAnimate(shell) || !canAnimate(pill)) {
      finish();
      return;
    }
    const animations: Animation[] = [];
    const collapse: KeyframeAnimationOptions = {
      duration: 280,
      delay: 520,
      easing: EASE_IN_OUT,
    };
    if (prefersReducedMotion()) {
      space = handOffSpace(shell, null);
      animations.push(
        pill.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 160,
          easing: "ease-in",
          fill: "forwards",
        }),
      );
    } else {
      const body = bodyRef.current;
      const haze = hazeRef.current;
      if (canAnimate(body)) {
        animations.push(
          body.animate([{ clipPath: CLIP_FULL }, { clipPath: CLIP_CENTER }], {
            duration: 380,
            delay: 120,
            easing: EASE_IN_OUT,
            fill: "forwards",
          }),
          body.animate(
            [
              { opacity: 1, filter: "blur(0px)" },
              { opacity: 0, filter: "blur(5px)" },
            ],
            { duration: 300, delay: 180, easing: "ease-in", fill: "forwards" },
          ),
        );
      }
      if (canAnimate(haze)) {
        animations.push(
          haze.animate([{ opacity: 0, transform: "scale(0.3, 0.5)" }], {
            duration: 420,
            delay: 220,
            easing: "ease-in",
            fill: "forwards",
          }),
        );
      }
      space = handOffSpace(shell, collapse);
      shell.style.overflow = "clip";
      animations.push(
        shell.animate(
          [
            { height: `${shell.getBoundingClientRect().height}px` },
            { height: "0px" },
          ],
          { ...collapse, fill: "forwards" },
        ),
      );
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(
      finish,
      finish,
    );
    return () => {
      if (!finished && space !== null) releaseSpaceHandoff();
      cancelled = true;
    };
  }, [closing]);

  return { shellRef, pillRef, bodyRef, hazeRef };
}

function PlayerCard({
  active,
  error,
  analyser,
  closing,
  onPause,
  onStop,
  onDismiss,
  onExited,
}: {
  active: PlaybackView | null;
  error: string;
  analyser: AnalyserNode | null;
  closing: boolean;
  onPause: () => void;
  onStop: () => void;
  onDismiss: () => void;
  onExited: () => void;
}) {
  const { shellRef, pillRef, bodyRef, hazeRef } = usePlayerMotion(
    closing,
    onExited,
  );
  const icon = {
    className: "tts-player__icon",
    viewBox: "0 0 16 16",
    fill: "currentColor",
    "aria-hidden": true,
  } as const;
  const iconKey = active?.state ?? "loading";
  return (
    <div ref={shellRef} className="tts-shell">
      <style>{PLAYER_STYLES}</style>
      <div className="tts-shell__inner">
        <section
          ref={pillRef}
          className="tts-player"
          aria-label="Read aloud player"
          data-closing={closing ? "" : undefined}
          title={
            active?.firstAudioMs == null
              ? undefined
              : `First audio in ${(active.firstAudioMs / 1000).toFixed(1)}s`
          }
        >
          <span ref={hazeRef} className="tts-player__haze" aria-hidden="true" />
          {error ? (
            <div
              ref={bodyRef}
              key="error"
              className="tts-player__body"
              data-kind="error"
            >
              <span className="tts-player__error" role="alert">
                {error}
              </span>
              <button
                className="tts-player__button"
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
              >
                <svg
                  className="tts-player__icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ) : active ? (
            <>
              <div ref={bodyRef} key="playback" className="tts-player__body">
                <button
                  className="tts-player__button"
                  type="button"
                  disabled={active.state === "loading"}
                  aria-label={
                    active.state === "paused"
                      ? "Resume reading response aloud"
                      : "Pause reading response aloud"
                  }
                  onClick={onPause}
                >
                  {active.state === "loading" ? (
                    <svg
                      key={iconKey}
                      className="tts-player__icon tts-player__spinner"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2a6 6 0 1 1-6 6" />
                    </svg>
                  ) : (
                    <svg key={iconKey} {...icon}>
                      {active.state === "paused" ? (
                        <path d="M4.5 2.5v11l9-5.5z" />
                      ) : (
                        <path d="M4 2.5h2.75v11H4zm5.25 0H12v11H9.25z" />
                      )}
                    </svg>
                  )}
                </button>
                <Waveform
                  analyser={analyser}
                  progress={active.progress}
                  state={closing ? "closing" : active.state}
                />
                <button
                  className="tts-player__button"
                  type="button"
                  aria-label="Stop reading response aloud"
                  onClick={onStop}
                >
                  <svg {...icon}>
                    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                  </svg>
                </button>
              </div>
              <span className="tts-player__status" aria-live="polite">
                {active.state === "loading"
                  ? "Preparing audio…"
                  : active.state === "paused"
                    ? "Paused"
                    : "Reading aloud"}
              </span>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ReadAloudAction() {
  const pluginId = "tts";
  const activeRef = useRef<ActivePlayback | null>(null);
  const [active, setActive] = useState<PlaybackView | null>(null);
  const [error, setError] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const portalTargetRef = useRef<HTMLElement | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [closing, setClosing] = useState(false);
  const [presentation, setPresentation] = useState(0);

  const release = useCallback(() => {
    const playback = activeRef.current;
    if (playback === null) return;
    activeRef.current = null;
    playback.controller.abort();
    playback.audio?.pause();
    if (playback.audio !== null) {
      playback.audio.removeAttribute("src");
      playback.audio.load();
    }
    for (const url of playback.urls) URL.revokeObjectURL(url);
    playback.audioContext?.close();
    setAnalyser(null);
  }, []);

  const finishClose = useCallback(() => {
    portalTargetRef.current?.remove();
    portalTargetRef.current = null;
    setPortalTarget(null);
    setActive(null);
    setError("");
    setClosing(false);
  }, []);

  const stop = useCallback(() => {
    release();
    setClosing(true);
  }, [release]);

  const fail = useCallback(
    (messageText: string) => {
      release();
      setActive(null);
      setError(messageText);
    },
    [release],
  );

  const play = useCallback(
    async (message: ThreadChatMessageReference) => {
      const previous = activeRef.current;
      if (previous?.messageId === message.id) {
        stop();
        return;
      }
      release();
      finishClose();
      setPresentation((count) => count + 1);
      const text = extractSpeechText(message.text);
      const controller = new AbortController();
      const playback: ActivePlayback = {
        messageId: message.id,
        controller,
        audio: null,
        urls: new Set(),
        segments: splitSpeechText(text),
        prefetched: null,
        audioContext: null,
        analyser: null,
        startedAt: performance.now(),
      };
      activeRef.current = playback;
      const timelineRow = Array.from(
        document.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      ).find((element) => element.dataset.timelineRowId === message.id);
      const messageColumn = timelineRow?.querySelector<HTMLElement>(
        "[data-message-column]",
      );
      if (messageColumn) {
        const mount = document.createElement("div");
        mount.dataset.ttsInlinePlayer = "";
        messageColumn.append(mount);
        portalTargetRef.current = mount;
        setPortalTarget(mount);
      } else {
        setPortalTarget(null);
      }
      if (text.length === 0) {
        fail("This response has no readable text.");
        return;
      }
      setActive({
        messageId: message.id,
        state: "loading",
        progress: 0,
        firstAudioMs: null,
      });
      const prefetchSegment = (index: number): Promise<SpeechSegment> => {
        const pending = fetchSegment(index);
        void pending.catch(() => undefined);
        return pending;
      };
      const fetchSegment = async (index: number): Promise<SpeechSegment> => {
        const response = await fetch(
          `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/speech`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              threadId: message.threadId,
              text: playback.segments[index],
            }),
          },
        );
        if (!response.ok) throw new Error(await errorFromResponse(response));
        const blob = await response.blob();
        if (activeRef.current !== playback || controller.signal.aborted) {
          throw new DOMException("Speech request cancelled", "AbortError");
        }
        const url = URL.createObjectURL(blob);
        playback.urls.add(url);
        return { url };
      };
      const playSegment = async (index: number, segment: SpeechSegment) => {
        if (activeRef.current !== playback || controller.signal.aborted) return;
        await playback.audioContext?.close();
        playback.audioContext = null;
        playback.analyser = null;
        const audio = new Audio(segment.url);
        playback.audio = audio;
        try {
          const audioContext = new AudioContext();
          const source = audioContext.createMediaElementSource(audio);
          const frequency = audioContext.createAnalyser();
          frequency.fftSize = 128;
          source.connect(frequency);
          frequency.connect(audioContext.destination);
          playback.audioContext = audioContext;
          playback.analyser = frequency;
          setAnalyser(frequency);
          if (audioContext.state === "suspended") void audioContext.resume();
        } catch {
          playback.audioContext?.close();
          playback.audioContext = null;
          playback.analyser = null;
          setAnalyser(null);
        }
        const setProgress = () => {
          if (activeRef.current !== playback) return;
          const fraction =
            audio.duration > 0 ? audio.currentTime / audio.duration : 0;
          setActive((view) =>
            view?.messageId === message.id
              ? {
                  ...view,
                  state: audio.paused ? view.state : "playing",
                  progress:
                    ((index + fraction) / playback.segments.length) * 100,
                }
              : view,
          );
        };
        const progressTimer = window.setInterval(setProgress, 180);
        audio.addEventListener("timeupdate", setProgress);
        audio.addEventListener(
          "ended",
          () => {
            window.clearInterval(progressTimer);
            playback.urls.delete(segment.url);
            URL.revokeObjectURL(segment.url);
            if (activeRef.current !== playback) return;
            if (index + 1 >= playback.segments.length) {
              stop();
              return;
            }
            const next = playback.prefetched;
            playback.prefetched = null;
            void (async () => {
              try {
                const ready = next ? await next : await fetchSegment(index + 1);
                if (activeRef.current !== playback) return;
                if (index + 2 < playback.segments.length) {
                  playback.prefetched = prefetchSegment(index + 2);
                }
                await playSegment(index + 1, ready);
              } catch (cause) {
                if (controller.signal.aborted || activeRef.current !== playback)
                  return;
                fail(
                  cause instanceof Error
                    ? cause.message
                    : "Speech generation failed.",
                );
              }
            })();
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            window.clearInterval(progressTimer);
            if (activeRef.current === playback) {
              fail("The generated audio could not be played.");
            }
          },
          { once: true },
        );
        await audio.play();
        if (activeRef.current === playback) {
          setActive((view) =>
            view?.messageId === message.id
              ? {
                  ...view,
                  state: "playing",
                  firstAudioMs:
                    view.firstAudioMs ?? performance.now() - playback.startedAt,
                }
              : view,
          );
        }
      };
      try {
        const first = await fetchSegment(0);
        if (activeRef.current !== playback) return;
        if (playback.segments.length > 1)
          playback.prefetched = prefetchSegment(1);
        await playSegment(0, first);
      } catch (cause) {
        if (controller.signal.aborted || activeRef.current !== playback) return;
        const messageText =
          cause instanceof Error ? cause.message : "Speech generation failed.";
        fail(messageText);
      }
    },
    [fail, finishClose, pluginId, release, stop],
  );

  const togglePause = useCallback(() => {
    const playback = activeRef.current;
    if (playback?.audio === null || playback === null) return;
    if (playback.audio.paused) {
      void playback.audio.play();
      setActive((view) => (view ? { ...view, state: "playing" } : view));
    } else {
      playback.audio.pause();
      setActive((view) => (view ? { ...view, state: "paused" } : view));
    }
  }, []);

  useEffect(() => {
    const onPlayRequest = (message: ThreadChatMessageReference) =>
      void play(message);
    playListeners.add(onPlayRequest);
    return () => {
      playListeners.delete(onPlayRequest);
    };
  }, [play]);

  useEffect(
    () => () => {
      portalTargetRef.current?.remove();
      portalTargetRef.current = null;
      releaseSpaceHandoff();
    },
    [],
  );

  useEffect(
    () => () => {
      const playback = activeRef.current;
      if (!playback) return;
      activeRef.current = null;
      playback.controller.abort();
      playback.audio?.pause();
      if (playback.audio) {
        playback.audio.removeAttribute("src");
        playback.audio.load();
      }
      for (const url of playback.urls) URL.revokeObjectURL(url);
      void playback.audioContext?.close();
    },
    [],
  );

  const player =
    active || error ? (
      <PlayerCard
        key={presentation}
        active={active}
        error={error}
        analyser={analyser}
        onPause={togglePause}
        closing={closing}
        onStop={stop}
        onDismiss={() => setClosing(true)}
        onExited={finishClose}
      />
    ) : null;
  if (!player) return null;
  return portalTarget ? (
    createPortal(player, portalTarget)
  ) : (
    <div
      className="fixed bottom-4 right-4 z-50 max-w-md"
      data-tts-player-fallback=""
    >
      {player}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "read-aloud",
    title: "Read response aloud / stop playback",
    icon: "Play",
    experimental_roles: ["assistant"],
    run({ message }) {
      if (message.role !== "assistant") return;
      requestReadAloud(message);
    },
  });
  app.slots.experimental_appOverlay({
    id: "playback",
    component: ReadAloudAction,
  });
});
